import { expect, test } from 'vitest'
import { isolateHistory, undo, redo } from '@codemirror/commands'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import type { OpenDocument } from '../../src/shared/contracts'
import { findMatches } from '../../src/renderer/src/search/search-model'
import { buildReplacement } from '../../src/renderer/src/search/replacement'
const document: OpenDocument = { docId: 'doc', epoch: 'epoch', displayName: 'test.md', displayPath: '/test.md', text: '', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'disk', readOnlyReason: null, recovered: false, readingPosition: null }
const historyTarget = (session: DocumentSession) => ({ state: session.state, dispatch: (transaction: Parameters<DocumentSession['apply']>[0][number]) => session.apply([transaction]) })
async function plan(session: DocumentSession, query: string, replacement: string, index: number | null = null, sensitive = false) {
  const signal = new AbortController().signal
  return buildReplacement(session.state, await findMatches(session.state.doc, query, sensitive, signal), index, replacement, signal)
}
const apply = (session: DocumentSession, result: Awaited<ReturnType<typeof plan>>) => session.dispatch({ changes: result.changes, annotations: isolateHistory.of('full'), userEvent: 'input.replace' })
test('all replacements are literal and one isolated undo restores the previous unsaved edit', async () => {
  const s = new DocumentSession({ ...document, text: 'cat CAT cat' })
  s.dispatch({ changes: { from: s.state.doc.length, insert: ' unsaved' } })
  const changes = await plan(s, 'cat', '$&\\$1'); expect(changes.count).toBe(3); apply(s, changes)
  expect(s.snapshot().text).toBe('$&\\$1 $&\\$1 $&\\$1 unsaved'); expect(s.currentRevision).toBe(2)
  expect(undo(historyTarget(s))).toBe(true); expect(s.snapshot().text).toBe('cat CAT cat unsaved')
  expect(undo(historyTarget(s))).toBe(true); expect(s.snapshot().text).toBe('cat CAT cat')
  expect(redo(historyTarget(s))).toBe(true); expect(redo(historyTarget(s))).toBe(true); expect(s.snapshot().text).toContain('$&\\$1')
})
test('single, deletion, case-sensitive and composed Unicode use original source offsets', async () => {
  const s = new DocumentSession({ ...document, text: '甲😀e\u0301乙 😀é AA aa' })
  const first = await plan(s, '😀é', '图', 0); apply(s, first); expect(s.snapshot().text).toBe('甲图乙 😀é AA aa')
  const next = await plan(s, 'aa', '', null, true); expect(next.count).toBe(1); apply(s, next); expect(s.snapshot().text).toBe('甲图乙 😀é AA ')
  expect((await plan(s, 'AA', 'AA')).count).toBe(0)
})
test('oversized UTF-16 expansion fails before dispatch and UTF-8 byte overflow is rejected atomically', async () => {
  const s = new DocumentSession({ ...document, text: 'a'.repeat(1024 * 1024) })
  await expect(plan(s, 'a', 'xxxx')).rejects.toThrow()
  expect(s.currentRevision).toBe(0)
  const changes = await plan(s, 'a', '中'); apply(s, changes)
  expect(s.currentRevision).toBe(0); expect(s.dirty).toBe(false); expect(s.snapshot().text).toBe(document.text + 'a'.repeat(1024 * 1024)); expect(s.error).not.toBe('')
}, 15000)
test.each(['frozen', 'read-only'] as const)('a prepared replacement respects a newly %s session', async mode => {
  const source = { ...document, text: 'a a a' }, s = new DocumentSession(source), changes = await plan(s, 'a', 'b')
  if (mode === 'frozen') s.setFrozen(true); else source.readOnlyReason = 'permission'
  apply(s, changes); expect(s.snapshot().text).toBe('a a a'); expect(s.currentRevision).toBe(0)
})
test('cancelled planning leaves source and revision untouched', async () => {
  const s = new DocumentSession({ ...document, text: 'a '.repeat(100000) }), signal = new AbortController().signal
  const matches = await findMatches(s.state.doc, 'a', true, signal), cancellation = new AbortController()
  const pending = buildReplacement(s.state, matches, null, 'b', cancellation.signal); cancellation.abort()
  expect(await pending.then(() => 'completed', error => error.name)).toBe('AbortError'); expect(s.currentRevision).toBe(0)
})
