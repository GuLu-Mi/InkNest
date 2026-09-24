import DOMPurify from 'dompurify'
import { MAX_DIAGRAMS, MAX_FORMULAS, MAX_HIGHLIGHT_CHARS, MAX_MATH_CHARS } from './rich-policy'
import { renderDiagram } from './diagrams'
import { observeCodeFolding, setCodeExpanded } from './code-folding'

let highlighter: Promise<typeof import('highlight.js/lib/common')> | undefined
let mathLibrary: Promise<typeof import('katex')> | undefined
const button = (text: string, action: string): HTMLButtonElement => {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.dataset.codeAction = action
  return node
}

/** Runs only on sanitized, mounted Markdown. All controls are application-owned. */
export async function enhancePreview(root: HTMLElement, dark: boolean, signal: AbortSignal, changed: () => void): Promise<void> {
  const observeCode = observeCodeFolding(signal)
  let formulas = 0, diagrams = 0, highlighted = 0
  for (const node of root.querySelectorAll<HTMLElement>('.math-source:not(.math-error)')) {
    signal.throwIfAborted()
    const source = node.textContent ?? ''
    try {
      if (++formulas > MAX_FORMULAS || source.length > MAX_MATH_CHARS) throw new Error('公式超过显示限制，已保留源码')
      mathLibrary ??= import('katex')
      const { default: katex } = await mathLibrary
      signal.throwIfAborted()
      const rendered = katex.renderToString(source, { displayMode: node.classList.contains('math-display'), output: 'mathml', throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20, macros: {} })
      const content = DOMPurify.sanitize(rendered, { USE_PROFILES: { mathMl: true }, RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['annotation-xml'], FORBID_ATTR: ['href', 'style'], ALLOW_DATA_ATTR: false })
      for (const annotation of content.querySelectorAll('annotation')) annotation.setAttribute('data-search-ignore', '')
      node.replaceChildren(content); node.classList.add('math-rendered'); node.classList.remove('math-source')
    } catch (error) {
      signal.throwIfAborted()
      node.classList.add('math-error'); node.title = error instanceof Error ? error.message : '公式无法显示，已保留源码'
      const hint = document.createElement('span'); hint.className = 'math-error-hint'; hint.dataset.searchIgnore = ''
      hint.textContent = '（公式无法显示，已保留源码）'; node.append(hint)
    }
  }
  changed()
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre')) {
    signal.throwIfAborted()
    const code = pre.querySelector('code')
    if (!code) continue
    const source = code.textContent ?? ''
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9).toLowerCase() ?? ''
    const previous = pre.closest<HTMLElement>('.code-block')
    if (previous && language !== 'mermaid') { observeCode(previous, pre); continue }
    const wrapper = previous ?? document.createElement('div'); wrapper.classList.add('code-block')
    const toolbar = previous?.querySelector<HTMLElement>('.code-toolbar') ?? document.createElement('div')
    if (!previous) {
      toolbar.className = 'code-toolbar'; toolbar.dataset.searchIgnore = ''
      const label = document.createElement('span'); label.textContent = language || '纯文本'
      toolbar.append(label, button('复制', 'copy'))
      pre.replaceWith(wrapper); wrapper.append(toolbar, pre)
    }
    observeCode(wrapper, pre)
    if (language === 'mermaid') {
      wrapper.classList.remove('diagram-failed')
      const toggle = toolbar.querySelector<HTMLButtonElement>('[data-code-action="source"]') ?? button('查看源码', 'source')
      const fit = toolbar.querySelector<HTMLButtonElement>('[data-code-action="size"]') ?? button('原始大小', 'size')
      if (!previous) { toggle.hidden = true; fit.hidden = true; toolbar.append(toggle, fit) }
      const oldGraphic = wrapper.querySelector<HTMLElement>('.diagram-view')
      const showSource = oldGraphic && !pre.hidden
      const graphic = document.createElement('div'); graphic.className = 'diagram-view'; graphic.tabIndex = 0; graphic.setAttribute('aria-label', '图表，可横向滚动')
      graphic.hidden = !!showSource
      if (oldGraphic?.classList.contains('diagram-original')) graphic.classList.add('diagram-original')
      wrapper.querySelector('.rich-status')?.remove()
      const status = document.createElement('p'); status.className = 'rich-status'; status.textContent = '正在绘制图表…'; status.dataset.searchIgnore = ''; status.setAttribute('role', 'status')
      wrapper.insertBefore(status, pre.parentElement)
      try {
        if (++diagrams > MAX_DIAGRAMS) throw new Error('图表数量超过显示限制，已保留源码')
        const svg = await renderDiagram(source, dark, signal)
        signal.throwIfAborted()
        graphic.append(svg); oldGraphic?.remove(); wrapper.insertBefore(graphic, pre.parentElement); pre.hidden = !showSource
        status.remove(); toggle.hidden = false; fit.hidden = false
      } catch (error) {
        signal.throwIfAborted()
        status.textContent = error instanceof Error && /已保留源码/u.test(error.message) ? error.message : '图表无法绘制，请检查语法；源码已保留'
        status.title = error instanceof Error ? error.message : ''
        oldGraphic?.remove(); pre.hidden = false; toggle.hidden = true; fit.hidden = true
        wrapper.classList.add('diagram-failed')
      }
      changed()
    } else if (language && source.length <= MAX_HIGHLIGHT_CHARS && (highlighted += source.length) <= 256_000) {
      try {
        highlighter ??= import('highlight.js/lib/common')
        const { default: hljs } = await highlighter
        signal.throwIfAborted()
        if (hljs.getLanguage(language)) {
          const result = hljs.highlight(source, { language, ignoreIllegals: true })
          code.innerHTML = DOMPurify.sanitize(result.value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false })
          code.classList.add('hljs')
        }
      } catch { signal.throwIfAborted() /* Other blocks keep rendering if this highlighter fails. */ }
    }
  }
  changed()
}

export async function codeAction(target: Element, announce: (message: string) => void, changed: () => void): Promise<boolean> {
  const trigger = target.closest<HTMLButtonElement>('button[data-code-action]')
  const wrapper = trigger?.closest<HTMLElement>('.code-block')
  if (!trigger || !wrapper) return false
  const pre = wrapper.querySelector('pre')!
  const graphic = wrapper.querySelector<HTMLElement>('.diagram-view')
  if (trigger.dataset.codeAction === 'copy') {
    try {
      // Keep copying inside the user's gesture. The app denies Chromium's
      // general clipboard permission; this selection-based command needs none.
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const selection = document.getSelection()
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
      const input = document.createElement('textarea')
      input.className = 'code-copy-target'; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true')
      input.value = pre.querySelector('code')?.textContent ?? ''
      ;(trigger.closest('dialog') ?? document.body).append(input)
      let copied = false
      try { input.focus({ preventScroll: true }); input.select(); copied = document.execCommand('copy') }
      finally {
        input.remove(); active?.focus({ preventScroll: true }); selection?.removeAllRanges()
        for (const range of ranges) selection?.addRange(range)
      }
      if (!copied) throw new Error('Copy unavailable')
      announce('代码已复制')
    }
    catch { announce('复制失败，请选择代码后复制') }
  } else if (trigger.dataset.codeAction === 'source' && graphic) {
    pre.hidden = !pre.hidden; graphic.hidden = !pre.hidden
    trigger.textContent = pre.hidden ? '查看源码' : '查看图表'; changed()
  } else if (trigger.dataset.codeAction === 'size' && graphic) {
    const svg = graphic.querySelector('svg')
    if (svg) {
      const original = graphic.classList.toggle('diagram-original')
      svg.style.width = `${Math.min(svg.viewBox.baseVal.width, 12000)}px`
      trigger.textContent = original ? '适应宽度' : '原始大小'
    }
  } else if (trigger.dataset.codeAction === 'fold') {
    const expanded = !wrapper.classList.contains('code-expanded')
    setCodeExpanded(wrapper, expanded)
    if (!expanded) trigger.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return true
}
