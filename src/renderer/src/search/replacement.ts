import { ChangeSet, type ChangeSpec, type EditorState } from '@codemirror/state'
import { EDITABLE_DOCUMENT_MAX_BYTES } from '../../../shared/limits'
import { copy } from '../../../shared/copy'
import { pause, type Matches } from './search-model'

/** Plan against one immutable CodeMirror document; the caller rechecks ownership before dispatch. */
export async function buildReplacement(state: EditorState, matches: Matches, index: number | null, replacement: string, signal: AbortSignal) {
  await pause(signal)
  const insert = state.toText(replacement).toString()
  const start = index ?? 0, end = index === null ? matches.length : index + 1
  if (start < 0 || start >= matches.length || end > matches.length) throw new Error('搜索结果已变化，请重新搜索')
  let length = state.doc.length, previous = -1, tick = performance.now()
  for (let i = start; i < end; i++) {
    const hit = matches.at(i)
    if (hit.from < previous || hit.from < 0 || hit.to <= hit.from || hit.to > state.doc.length) throw new Error('搜索结果已变化，请重新搜索')
    previous = hit.to; length += insert.length - (hit.to - hit.from)
    if (i % 512 === 0 && performance.now() - tick >= 8) { await pause(signal); tick = performance.now() }
  }
  // UTF-8 bytes are never fewer than UTF-16 code units; final byte/format limits remain in DocumentSession.
  if (length > EDITABLE_DOCUMENT_MAX_BYTES) throw new Error(copy.editLimit)
  const changes: ChangeSpec[] = []
  let count = 0, group: { from: number; to: number; count: number } | null = null
  function flush(): void { if (group) { changes.push({ from: group.from, to: group.to, insert: insert.repeat(group.count) }); group = null } }
  for (let i = start; i < end; i++) {
    const hit = matches.at(i)
    if (state.sliceDoc(hit.from, hit.to) !== insert) {
      count++
      if (group?.to === hit.from) { group.to = hit.to; group.count++ }
      else { flush(); group = { ...hit, count: 1 } }
    }
    if (i % 512 === 0 && performance.now() - tick >= 8) { await pause(signal); tick = performance.now() }
  }
  flush(); signal.throwIfAborted()
  return { changes: ChangeSet.of(changes, state.doc.length), count, nextFrom: index === null ? 0 : matches.at(index).from + insert.length }
}
