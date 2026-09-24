import type { ReadingAnchor, ReadingDisclosure } from '../../../shared/contracts'
import { setCodeExpanded } from './code-folding'

// Index the sanitized source DOM before rich rendering changes its text/geometry.
// Content keys survive unrelated edits above a block; occurrence disambiguates repeats.
function fingerprint(text: string): string {
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i) }
  return `${text.length}-${a >>> 0}-${b >>> 0}`
}

export class ReadingState {
  private nodes = new Map<string, HTMLElement>()
  private keys = new WeakMap<HTMLElement, string>()
  constructor(private root: HTMLElement) {
    const counts = new Map<string, number>()
    for (const node of root.querySelectorAll<HTMLElement>('p,li,pre,h1,h2,h3,h4,h5,h6,img,table,details,summary,dt,dd')) {
      const text = node instanceof HTMLDetailsElement ? node.querySelector('summary')?.textContent : node instanceof HTMLImageElement ? node.alt : node.textContent
      const base = `${node.tagName}-${fingerprint(text ?? '')}`
      const count = counts.get(base) ?? 0; counts.set(base, count + 1)
      const key = `${base}-${count}`; this.nodes.set(key, node); this.keys.set(node, key)
    }
  }

  private block(node: Node): HTMLElement | undefined {
    let element = node instanceof HTMLElement ? node : node.parentElement
    // Generated diagram labels belong to their original code block.
    const diagram = element?.closest('.diagram-view')
    if (diagram) return diagram.closest('.code-block')?.querySelector('pre') ?? undefined
    while (element && element !== this.root) {
      if (this.keys.has(element) && !(element instanceof HTMLDetailsElement)) return element
      element = element.parentElement
    }
    return undefined
  }

  private displayed(node: HTMLElement): HTMLElement {
    if (node instanceof HTMLPreElement) {
      if (node.hidden) return node.closest<HTMLElement>('.code-block') ?? node
      if (node.closest('.code-collapsed')) return node.closest<HTMLElement>('.code-content') ?? node
    }
    return node
  }

  capture(stage: HTMLElement): ReadingAnchor | undefined {
    const viewport = stage.getBoundingClientRect(), bounds = this.root.getBoundingClientRect()
    const point = document.caretPositionFromPoint(bounds.left + 8, viewport.top + 8)
    const block = point && this.root.contains(point.offsetNode) ? this.block(point.offsetNode) : undefined
    if (point && block && point.offsetNode.nodeType === Node.TEXT_NODE && block.contains(point.offsetNode) && !block.querySelector('math')) {
      const range = document.createRange(); range.selectNodeContents(block); range.setEnd(point.offsetNode, point.offset)
      const textOffset = range.toString().length
      range.setStart(point.offsetNode, point.offset); range.setEnd(point.offsetNode, Math.min(point.offset + 1, point.offsetNode.textContent?.length ?? 0))
      const rect = range.getBoundingClientRect()
      if (rect.height > 0) return { key: this.keys.get(block)!, textOffset, offset: rect.top - viewport.top, atStart: stage.scrollTop < 1 }
    }
    for (const [key, node] of this.nodes) {
      if (node instanceof HTMLDetailsElement) continue
      const rect = this.displayed(node).getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > viewport.top) return { key, offset: rect.top - viewport.top, atStart: stage.scrollTop < 1 }
    }
    return undefined
  }

  resolve(anchor: ReadingAnchor): Range | HTMLElement | undefined {
    const node = this.nodes.get(anchor.key)
    if (!node) return undefined
    if (anchor.textOffset !== undefined && !node.hidden) {
      let offset = anchor.textOffset
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const length = text.textContent?.length ?? 0
        if (offset <= length) {
          const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, Math.min(offset + 1, length))
          return range
        }
        offset -= length
      }
    }
    return this.displayed(node)
  }

  captureDisclosures(): ReadingDisclosure[] {
    const result: ReadingDisclosure[] = []
    for (const [key, node] of this.nodes) {
      if (node instanceof HTMLDetailsElement) result.push({ key, open: node.open })
      else if (node instanceof HTMLPreElement) {
        const wrapper = node.closest<HTMLElement>('.code-block'), content = wrapper?.querySelector('.code-content'), graphic = wrapper?.querySelector('.diagram-view')
        if (wrapper) result.push({ key, expanded: wrapper.classList.contains('code-expanded'), top: content?.scrollTop ?? 0, ...(graphic ? { source: !node.hidden, original: graphic.classList.contains('diagram-original') } : {}) })
      }
    }
    return result
  }

  restoreDisclosures(states: ReadingDisclosure[]): void {
    for (const state of states) {
      const node = this.nodes.get(state.key)
      if (node instanceof HTMLDetailsElement && state.open !== undefined) {
        if (node.open !== state.open) node.open = state.open
      } else if (node instanceof HTMLPreElement) {
        const wrapper = node.closest<HTMLElement>('.code-block')
        if (!wrapper) continue
        setCodeExpanded(wrapper, state.expanded ?? false)
        const graphic = wrapper.querySelector<HTMLElement>('.diagram-view')
        if (graphic && state.source !== undefined) {
          node.hidden = !state.source; graphic.hidden = state.source
          const toggle = wrapper.querySelector('[data-code-action="source"]')
          if (toggle) toggle.textContent = state.source ? '查看图表' : '查看源码'
          graphic.classList.toggle('diagram-original', !!state.original)
          const size = wrapper.querySelector('[data-code-action="size"]'), svg = graphic.querySelector('svg')
          if (size) size.textContent = state.original ? '适应宽度' : '原始大小'
          if (state.original && svg) svg.style.width = `${Math.min(svg.viewBox.baseVal.width, 12000)}px`
        }
        const content = wrapper.querySelector('.code-content')
        if (content) content.scrollTop = state.top ?? 0
      }
    }
  }
}
