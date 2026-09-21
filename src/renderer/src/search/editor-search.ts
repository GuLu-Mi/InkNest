import { isolateHistory } from '@codemirror/commands'
import { buildReplacement } from './replacement'
import { StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { findMatches, type Matches, type SearchSurface } from './search-model'
const setMarks = StateEffect.define<{ matches: Matches; index: number } | null>()
const marks = StateField.define<{ matches: Matches; index: number } | null>({
  create: () => null,
  update(value, transaction) { if (transaction.docChanged) value = null; for (const effect of transaction.effects) if (effect.is(setMarks)) value = effect.value; return value }
})
function decorations(view: EditorView): DecorationSet {
  const state = view.state.field(marks, false)
  if (!state) return Decoration.none
  const ranges = []
  for (const visible of view.visibleRanges) {
    for (let i = Math.max(0, state.matches.after(visible.from) - 1); i < state.matches.length; i++) {
      const hit = state.matches.at(i)
      if (hit.from > visible.to) break
      if (hit.to > visible.from) ranges.push(Decoration.mark({ class: i === state.index ? 'search-current' : 'search-match' }).range(hit.from, hit.to))
    }
  }
  return Decoration.set(ranges, true)
}
// A view plugin restricts decorations to CodeMirror's virtual viewport.
export const editorSearchExtension = [marks, ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = decorations(view) }
  update(update: import('@codemirror/view').ViewUpdate): void { if (update.docChanged || update.viewportChanged || update.transactions.some(t => t.effects.some(e => e.is(setMarks)))) this.decorations = decorations(update.view) }
}, { decorations: value => value.decorations })]
export function editorSearchSurface(view: EditorView, writable: () => boolean, failure: () => string): SearchSurface {
  let scannedDoc: Text | null = null, scannedMatches: Matches | null = null, disposed = false
  const clear = () => { if (view.state.field(marks, false)) view.dispatch({ effects: setMarks.of(null) }) }
  return {
    scan: async (query, sensitive, signal) => {
      const doc = view.state.doc, matches = await findMatches(doc, query, sensitive, signal)
      if (!disposed && !signal.aborted && view.state.doc === doc) { scannedDoc = doc; scannedMatches = matches }
      return matches
    },
    replace: async (matches, index, replacement, signal) => {
      const state = view.state
      const allowed = () => !disposed && !signal.aborted && writable() && !view.state.readOnly && view.state.facet(EditorView.editable) && !view.composing && view.state.doc === state.doc
      if (!allowed() || scannedDoc !== state.doc || scannedMatches !== matches) return { status: 'cancelled' }
      const plan = await buildReplacement(state, matches, index, replacement, signal)
      if (!allowed()) return { status: 'cancelled' }
      if (plan.count) {
        view.dispatch({ changes: plan.changes, annotations: isolateHistory.of('full'), userEvent: 'input.replace' })
        if (view.state.doc === state.doc) return { status: 'error', message: failure() || '当前文档暂时不能替换' }
      }
      return { status: 'ok', count: plan.count, nextFrom: plan.nextFrom }
    },
    paint: (matches, index) => view.dispatch({ effects: setMarks.of({ matches, index }) }),
    reveal: match => view.dispatch({ selection: { anchor: match.from, head: match.to }, effects: EditorView.scrollIntoView(match.from, { y: 'center', x: 'nearest' }) }),
    position: () => view.state.selection.main.from,
    selection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus: () => view.focus(), clear, dispose: () => { clear(); disposed = true; scannedDoc = null; scannedMatches = null }
  }
}
