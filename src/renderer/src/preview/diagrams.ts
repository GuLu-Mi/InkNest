import DOMPurify from 'dompurify'
import { diagramProblem, safeDiagramDeclaration } from './rich-policy'

let nextId = 0
let tail: Promise<void> = Promise.resolve()
let library: Promise<typeof import('mermaid')> | undefined

function safeSvg(source: string, id: string, dark: boolean): SVGSVGElement {
  const fragment = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['foreignObject', 'image', 'use', 'a', 'script', 'animate', 'set', 'animateMotion', 'animateTransform'],
    FORBID_ATTR: ['href', 'xlink:href'], ALLOW_DATA_ATTR: false
  })
  const svg = fragment.querySelector('svg')
  if (!svg || svg.id !== id || !svg.getAttribute('viewBox')) throw new Error('图表输出无效')
  const styles = [...svg.querySelectorAll('style')]
  for (const style of styles) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(style.textContent ?? '')
    const accepted: string[] = []
    for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSStyleRule)) continue
      // Scope every selector to this diagram; do not accept sibling escapes,
      // at-rules, CSS URLs, custom properties or caller-controlled stylesheet.
      if (!rule.selectorText.split(',').every(selector => {
        const value = selector.trim()
        return (value === `#${id}` || value.startsWith(`#${id} `) || value.startsWith(`#${id}:`)) && !/[+~\\]/u.test(value)
      })) continue
      const declarations: string[] = []
      for (const property of rule.style) {
        const value = rule.style.getPropertyValue(property)
        if (safeDiagramDeclaration(property, value)) declarations.push(`${property}:${value}`)
      }
      if (declarations.length) accepted.push(`${rule.selectorText}{${declarations.join(';')}}`)
    }
    style.textContent = accepted.join('\n')
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="inknest-style-nonce"]')?.content
    if (nonce) style.setAttribute('nonce', nonce)
  }
  for (const element of [svg, ...svg.querySelectorAll<SVGElement>('*')]) {
    const raw = element.getAttribute('style')
    element.removeAttribute('style')
    if (raw) {
      const probe = document.createElement('span'); probe.style.cssText = raw
      for (const property of probe.style) {
        const value = probe.style.getPropertyValue(property)
        if (safeDiagramDeclaration(property, value)) element.style.setProperty(property, value)
      }
    }
    for (const attr of [...element.attributes]) {
      if (/url\s*\(/iu.test(attr.value) && !/^url\(["']?#[a-zA-Z0-9_.:-]+["']?\)$/u.test(attr.value)) element.removeAttribute(attr.name)
    }
  }
  svg.classList.add('mermaid-svg')
  // Mermaid gives journey headings the same section class as their background.
  // Its section fill would otherwise paint the text in the background color.
  for (const heading of svg.querySelectorAll<SVGElement>('text.journey-section')) heading.style.fill = dark ? '#e5e7eb' : '#24292f'
  svg.style.width = `${Math.min(svg.viewBox.baseVal.width, 12000)}px`
  svg.setAttribute('role', 'img')
  if (!svg.hasAttribute('aria-label') && !svg.hasAttribute('aria-labelledby')) svg.setAttribute('aria-label', 'Mermaid 图表')
  return svg
}

/** Mermaid has global configuration: serialize renders and discard stale work. */
export function renderDiagram(source: string, dark: boolean, signal: AbortSignal): Promise<SVGSVGElement> {
  const operation = tail.then(async () => {
    signal.throwIfAborted()
    const problem = diagramProblem(source)
    if (problem) throw new Error(problem)
    library ??= import('mermaid')
    const { default: mermaid } = await library
    signal.throwIfAborted()
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default', fontFamily: 'Arial, sans-serif', fontSize: 16,
      htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 20_000, maxEdges: 200,
      deterministicIds: false, secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'themeCSS', 'fontFamily', 'flowchart'] })
    const id = `inknest-diagram-${++nextId}`
    const container = document.createElement('div')
    container.className = 'diagram-measure'; container.setAttribute('aria-hidden', 'true')
    document.body.append(container)
    try {
      const result = await mermaid.render(id, source, container)
      signal.throwIfAborted()
      return safeSvg(result.svg, id, dark)
    } finally { container.remove() }
  })
  tail = operation.then(() => {}, () => {})
  return operation
}
