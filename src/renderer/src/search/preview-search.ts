import { Text as DocumentText } from '@codemirror/state'
import { revealCodeRange } from '../preview/code-folding'
import { findMatches, Matches, pause, type Match, type SearchSurface } from './search-model'
interface Run { node: Text; from: number; to: number; start: number; end: number }
interface HighlightSet { set(key: string, value: unknown): void; delete(key: string): void }
const highlightRegistry = () => (CSS as unknown as { highlights: HighlightSet }).highlights
const highlight = (ranges: Range[]) => new (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight(...ranges)

export function previewSearchSurface(root: HTMLElement): SearchSurface {
  const scroll = root.closest<HTMLElement>('.document-stage')!
  const name = `inknest-find-${crypto.randomUUID()}`
  // Fixed CSS names are shared only by the active surface; ownership is checked on disposal.
  let runs: Run[] = [], documentText: DocumentText | null = null, matches = new Matches(), active = -1, disposed = false
  let frame = 0
  async function index(signal: AbortSignal): Promise<DocumentText> {
    if (documentText) return documentText
    const parts: string[] = [], built: Run[] = []
    let offset = 0, previousBlock: Element | null = null, lastSpace = true, tick = performance.now()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: node => {
      const element = node instanceof Element ? node : node.parentElement
      if (element?.closest('[data-search-ignore], [hidden], [aria-hidden="true"], button,script,style,defs,title,desc,annotation')) return NodeFilter.FILTER_REJECT
      const folded = element?.closest('details:not([open])')
      if (folded && element !== folded && !folded.querySelector(':scope > summary')?.contains(element ?? null)) return NodeFilter.FILTER_REJECT
      return node.nodeType === Node.TEXT_NODE || (node instanceof HTMLBRElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    } })
    let next: Node | null
    while ((next = walker.nextNode())) {
      if (next instanceof HTMLBRElement) { parts.push('\n'); offset++; lastSpace = true; continue }
      const node = next as Text, parent = node.parentElement!
      const block = parent.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote,summary,dt,dd,text') ?? root
      if (block !== previousBlock) { parts.push('\n'); offset++; previousBlock = block; lastSpace = true }
      const pre = !!parent.closest('pre')
      const raw = node.data
      for (let base = 0; base < raw.length; base += 16384) {
        signal.throwIfAborted()
        const chunk = raw.slice(base, base + 16384)
        const tokens = pre ? [{ 0: chunk, index: 0 }] : chunk.matchAll(/[ \t\r\n\f]+|[^ \t\r\n\f]+/gu)
        for (const token of tokens) {
          const value = token[0], whitespace = !pre && /^[ \t\r\n\f]/u.test(value)
          if (whitespace && lastSpace) continue
          const text = whitespace ? ' ' : value
          built.push({ node, from: offset, to: offset + text.length, start: base + token.index, end: base + token.index + value.length })
          parts.push(text); offset += text.length; lastSpace = whitespace
        }
        if (performance.now() - tick >= 8) { await pause(signal); tick = performance.now() }
      }
    }
    signal.throwIfAborted()
    const text = DocumentText.of(parts.join('').split('\n'))
    if (disposed) throw new DOMException('Disposed', 'AbortError')
    runs = built; documentText = text
    return text
  }
  function runAt(offset: number, end: boolean): Run | undefined {
    let low = 0, high = runs.length
    while (low < high) { const mid = (low + high) >>> 1; if (end ? runs[mid]!.to < offset : runs[mid]!.to <= offset) low = mid + 1; else high = mid }
    return runs[low]
  }
  function range(hit: Match): Range | null {
    const first = runAt(hit.from, false), last = runAt(hit.to, true)
    if (!first || !last || !root.contains(first.node) || !root.contains(last.node)) return null
    const result = document.createRange()
    result.setStart(first.node, first.start + Math.min(hit.from - first.from, first.end - first.start))
    result.setEnd(last.node, last.to - last.from === 1 ? last.end : last.start + hit.to - last.from)
    return result
  }
  function offsetAt(x: number, y: number): number | null {
    const point = document.caretPositionFromPoint(x, y)
    if (!point || !root.contains(point.offsetNode)) return null
    const run = runs.find(run => run.node === point.offsetNode && point.offset >= run.start && point.offset <= run.end)
    return run ? run.from + Math.min(point.offset - run.start, run.to - run.from) : null
  }
  function viewport(): { from: number; to: number } {
    const rect = scroll.getBoundingClientRect(), body = root.getBoundingClientRect()
    const left = Math.max(rect.left + 4, body.left + 2), right = Math.min(rect.right - 16, body.right - 2)
    const top = Math.max(rect.top + 4, body.top + 2), bottom = Math.min(rect.bottom - 4, body.bottom - 2)
    const from = offsetAt(left, top) ?? offsetAt(left, Math.min(top + 24, bottom)) ?? 0
    const to = offsetAt(right, bottom) ?? Math.min(documentText?.length ?? 0, from + 16000)
    return { from: Math.max(0, from - 256), to: Math.max(from, to) + 256 }
  }
  function paint(): void {
    if (disposed || !matches.length || !root.isConnected || !highlightRegistry()) return
    const bounds = viewport(), ranges: Range[] = []
    for (let i = Math.max(0, matches.after(bounds.from) - 1); i < matches.length && ranges.length < 4096; i++) {
      const hit = matches.at(i)
      if (hit.from > bounds.to) break
      const value = range(hit)
      if (value) ranges.push(value)
    }
    const selected = active >= 0 && active < matches.length ? range(matches.at(active)) : null
    // CSS registry has document scope. Mark ownership so an old surface cannot clear a new one.
    Reflect.set(root.ownerDocument, 'inknestSearchOwner', name)
    highlightRegistry().set('inknest-search', highlight(ranges))
    highlightRegistry().set('inknest-search-current', highlight(selected ? [selected] : []))
  }
  const repaint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint) }
  scroll.addEventListener('scroll', repaint, true)
  const observer = new ResizeObserver(repaint); observer.observe(root); observer.observe(scroll)
  const clear = () => {
    cancelAnimationFrame(frame); matches = new Matches(); active = -1; runs = []; documentText = null
    if (Reflect.get(root.ownerDocument, 'inknestSearchOwner') === name) {
      highlightRegistry()?.delete('inknest-search'); highlightRegistry()?.delete('inknest-search-current')
      Reflect.deleteProperty(root.ownerDocument, 'inknestSearchOwner')
    }
  }
  return {
    scan: async (query, sensitive, signal) => findMatches(await index(signal), query, sensitive, signal),
    paint: (value, selected) => { matches = value; active = selected; paint() },
    reveal: hit => {
      const selected = range(hit); if (!selected) return
      revealCodeRange(selected)
      let rect = selected.getBoundingClientRect()
      const horizontal = selected.startContainer.parentElement?.closest<HTMLElement>('pre,.table-scroll,.diagram-view,.math-display')
      if (horizontal && horizontal.scrollWidth > horizontal.clientWidth) {
        const host = horizontal.getBoundingClientRect()
        if (rect.left < host.left || rect.right > host.right) horizontal.scrollLeft += rect.left - host.left - 24
        rect = selected.getBoundingClientRect()
      }
      const host = scroll.getBoundingClientRect()
      const overlay = scroll.closest('.document-center,.presentation')?.querySelector<HTMLElement>('.search-bar')?.getBoundingClientRect()
      const inset = overlay ? overlay.bottom - host.top + 16 : 32
      scroll.scrollTop += rect.top - host.top - Math.max(inset, Math.min(scroll.clientHeight / 2, 180))
      repaint()
    },
    position: () => viewport().from,
    selection: () => { const selected = document.getSelection(); return selected?.rangeCount && root.contains(selected.anchorNode) && root.contains(selected.focusNode) ? selected.toString() : '' },
    focus: () => { root.tabIndex = -1; root.focus({ preventScroll: true }) },
    clear,
    dispose: () => { clear(); disposed = true; observer.disconnect(); scroll.removeEventListener('scroll', repaint, true) }
  }
}
