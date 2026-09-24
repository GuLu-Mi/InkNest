import DOMPurify from 'dompurify'
import type { MermaidConfig } from 'mermaid'
import { diagramProblem, safeDiagramDeclaration } from './rich-policy'

let nextId = 0
let tail: Promise<void> = Promise.resolve()
let library: Promise<typeof import('mermaid')> | undefined

const palette = (dark: boolean) => dark
  ? { blue: '#72b9ff', node: '#213c55', border: '#486078', line: '#9ca6b1', surface: '#1d1f23', text: '#e5e7eb' }
  : { blue: '#339cff', node: '#e6f2ff', border: '#cfdae5', line: '#8e8f90', surface: '#ffffff', text: '#24292f' }

const diagramFont = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const mindmapColors = (dark: boolean) => dark
  ? [['#243e5b', '#b7d7ff', '#6a9edc'], ['#3c3156', '#dec9ff', '#aa89d9'], ['#244738', '#b2e5c8', '#70b392'], ['#504021', '#f4dda7', '#c5a468'], ['#4d3040', '#f1c4dc', '#cd8cb0'], ['#23464d', '#b6e6eb', '#70b9c2']]
  : [['#e5efff', '#234d80', '#87afe0'], ['#eee5fb', '#5d3c89', '#b69bd9'], ['#e4f3e9', '#285e40', '#8dbda0'], ['#fff1d5', '#77541c', '#d3b36e'], ['#fbe7ef', '#85405e', '#d79eb8'], ['#e2f3f5', '#275f67', '#87bfc7']]

function mindmapTheme(dark: boolean): Record<string, string | number | boolean> {
  const colors = mindmapColors(dark)
  const theme: Record<string, string | number | boolean> = { darkMode: dark, fontSize: '18px', git0: dark ? '#80b7ff' : '#2865bb', gitBranchLabel0: dark ? '#172b45' : '#ffffff' }
  for (let index = 0; index < 12; index++) {
    const [fill, text, accent] = colors[(index + colors.length - 1) % colors.length]!
    theme[`cScale${index}`] = fill!; theme[`cScaleLabel${index}`] = text!; theme[`cScaleInv${index}`] = accent!
  }
  return theme
}

function styleMindmap(svg: SVGSVGElement, container: HTMLElement, dark: boolean): void {
  // Measure sanitized SVG in the existing offscreen container. SVG-only labels
  // on circular nodes can arrive with a left edge at the node center.
  container.append(svg)
  for (const node of svg.querySelectorAll<SVGGElement>('.mindmap-node')) {
    const shape = node.querySelector<SVGGraphicsElement>(':scope > circle,:scope > rect,:scope > path,:scope > polygon,:scope > ellipse')
    const label = node.querySelector<SVGGElement>(':scope > .label')
    if (!shape || !label) continue
    const box = shape.getBBox(), text = label.getBBox()
    label.setAttribute('transform', `translate(${box.x + box.width / 2 - text.x - text.width / 2}, ${box.y + box.height / 2 - text.y - text.height / 2})`)
  }
  const colors = mindmapColors(dark)
  for (const edge of svg.querySelectorAll<SVGElement>('.edge')) {
    const section = [...edge.classList].map(name => /^section-edge-(\d+)$/u.exec(name)).find(Boolean)
    if (section) edge.style.stroke = colors[Number(section[1]) % colors.length]![2]!
  }
  svg.remove()
}

/** Application-owned decoration after sanitization; retain source text and nonrectangular symbols. */
function styleFlowchart(svg: SVGSVGElement, dark: boolean): void {
  const colors = palette(dark)
  for (const rect of svg.querySelectorAll<SVGRectElement>('.node > rect.basic.label-container:not([rx])')) {
    rect.setAttribute('rx', '18'); rect.setAttribute('ry', '18')
  }
  // Expand the existing SVG label background; text stays in Mermaid's measured position.
  for (const rect of svg.querySelectorAll<SVGRectElement>('.edgeLabel rect.background')) {
    const width = rect.width.baseVal.value, height = rect.height.baseVal.value
    if (width <= 0 || height <= 0) continue
    rect.x.baseVal.value -= 6; rect.y.baseVal.value -= 4
    rect.width.baseVal.value = width + 12; rect.height.baseVal.value = height + 8
    rect.setAttribute('rx', String((height + 8) / 2))
    rect.style.fill = colors.surface; rect.style.stroke = colors.blue
    rect.style.strokeWidth = '1.2px'; rect.style.opacity = '1'
  }
  for (const text of svg.querySelectorAll<SVGElement>('.node text, .edgeLabel text, .node tspan[font-weight="normal"], .edgeLabel tspan[font-weight="normal"]')) {
    text.style.fill = colors.blue; text.style.fontWeight = '600'
  }
  // Only the ordinary point arrow becomes open; diamonds, circles and other markers keep their meaning.
  for (const marker of svg.querySelectorAll<SVGElement>('marker[id$="-pointEnd"] path')) {
    marker.setAttribute('d', 'M 1 1 L 9 5 L 1 9')
    marker.style.fill = 'none'; marker.style.stroke = colors.line
    marker.style.strokeWidth = '1.4px'; marker.style.strokeLinecap = 'round'; marker.style.strokeLinejoin = 'round'
  }
  const box = svg.viewBox.baseVal
  svg.setAttribute('viewBox', `${box.x - 12} ${box.y - 6} ${box.width + 24} ${box.height + 12}`)
  svg.style.width = `${Math.min(svg.viewBox.baseVal.width, 12000)}px`
}

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
    const options: MermaidConfig = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default', fontFamily: 'Arial, sans-serif', fontSize: 16,
      htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 20_000, maxEdges: 200,
      deterministicIds: false, secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'themeCSS', 'fontFamily', 'flowchart'] }
    mermaid.initialize(options)
    // Use Mermaid's own detector so comments and alternate graph declarations work alike.
    // Other diagram families retain their categorical colors and symbols.
    const type = mermaid.detectType(source)
    if (['flowchart', 'flowchart-v2'].includes(type)) {
      const colors = palette(dark)
      mermaid.initialize({ ...options, theme: 'base', look: 'classic',
        fontFamily: diagramFont,
        themeVariables: { darkMode: dark, background: colors.surface, primaryColor: colors.node, primaryTextColor: colors.blue,
          primaryBorderColor: colors.border, lineColor: colors.line, textColor: colors.text,
          secondaryColor: dark ? '#293a4d' : '#edf5ff', tertiaryColor: dark ? '#30363e' : '#f6f8fb',
          secondaryTextColor: colors.text, tertiaryTextColor: colors.text, edgeLabelBackground: colors.surface,
          nodeTextColor: colors.blue, nodeBorder: colors.border, defaultLinkColor: colors.line,
          fontSize: '16px', strokeWidth: 1.2 },
        flowchart: { htmlLabels: false, padding: 24, wrappingWidth: 320, nodeSpacing: 48, rankSpacing: 68, curve: 'rounded' } })
    } else if (type === 'mindmap') {
      mermaid.initialize({ ...options, theme: 'base', look: 'classic', fontFamily: diagramFont, fontSize: 18,
        themeVariables: mindmapTheme(dark), mindmap: { padding: 22 } })
    }
    const id = `inknest-diagram-${++nextId}`
    const container = document.createElement('div')
    container.className = 'diagram-measure'; container.setAttribute('aria-hidden', 'true')
    document.body.append(container)
    try {
      const result = await mermaid.render(id, source, container)
      signal.throwIfAborted()
      const svg = safeSvg(result.svg, id, dark)
      if (result.diagramType === 'flowchart' || result.diagramType === 'flowchart-v2') styleFlowchart(svg, dark)
      if (result.diagramType === 'mindmap') styleMindmap(svg, container, dark)
      return svg
    } finally { container.remove() }
  })
  tail = operation.then(() => {}, () => {})
  return operation
}
