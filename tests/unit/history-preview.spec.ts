import { expect, test, vi } from 'vitest'
import { undo, redo } from '@codemirror/commands'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import { HistoryPreviewController, type HistoryPreviewContext } from '../../src/renderer/src/documents/history-preview'
import type { HistorySnapshot, OpenDocument, Result } from '../../src/shared/contracts'

const document: OpenDocument = { docId: 'doc', epoch: 'epoch', displayName: 'test.md', displayPath: '/test.md', text: 'current', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'disk', readOnlyReason: null, recovered: false, readingPosition: null }
const historical = (id: string): HistorySnapshot => ({ id, savedAt: '2026-09-17T00:00:00.000Z', byteLength: 3, contentHash: 'a'.repeat(64), text: `history ${id}`, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, restorable: true, source: 'manual' as const, sealed: true })
function fixture() {
  const session = new DocumentSession({ ...document })
  session.dispatch({ changes: { from: 0, insert: 'edited ' }, selection: { anchor: 4 } })
  const before = session.snapshot(); const editorState = session.state
  let live: HistoryPreviewContext | null = { ref: { docId: 'doc', epoch: 'epoch' }, pathGeneration: 0, view: { mode: 'edit', reading: { top: 120, ratio: 0.4, revision: 1 }, editorTop: 60 } }
  const pending: { id: string; resolve: (value: Result<HistorySnapshot>) => void; reject: (reason: unknown) => void }[] = []
  const save = vi.fn()
  const api = { inspectHistory: vi.fn((_ref, id: string) => new Promise<Result<HistorySnapshot>>((resolve, reject) => pending.push({ id, resolve, reject }))), save }
  // A real session notification would feed saving; observing creates no session transaction.
  const unsubscribe = session.subscribe(() => save(session.snapshot()))
  const preview = new HistoryPreviewController({ api, current: () => live })
  const unchanged = () => { expect(session.snapshot()).toEqual(before); expect(session.state).toBe(editorState); expect(session.dirty).toBe(true); expect(save).not.toHaveBeenCalled() }
  return { session, preview, api, pending, unchanged, unsubscribe, live: () => live!, setLive: (value: HistoryPreviewContext | null) => { live = value } }
}

test('late A never replaces B and observation preserves real text, revision, selection and undo', async () => {
  const f = fixture(); const ref = f.live().ref
  const first = f.preview.enter(ref, 'A'); const second = f.preview.enter(ref, 'B')
  f.pending[1]!.resolve({ status: 'ok', value: historical('B') }); await second
  f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await first
  expect(f.preview.selectedId).toBe('B'); expect(f.preview.state?.snapshot?.text).toBe('history B'); f.unchanged()
  expect(f.preview.exit()).toEqual({ mode: 'edit', reading: { top: 120, ratio: 0.4, revision: 1 }, editorTop: 60 })
  expect(f.preview.state).toBeNull(); f.unchanged(); f.unsubscribe()
  expect(undo({ state: f.session.state, dispatch: t => f.session.apply([t]) })).toBe(true)
  expect(f.session.snapshot().text).toBe('current')
  expect(redo({ state: f.session.state, dispatch: t => f.session.apply([t]) })).toBe(true)
  expect(f.session.snapshot().text).toBe('edited current')
})

test.each(['tab', 'epoch', 'migration', 'closed'] as const)('%s changes reject pending receipts using live ownership even without explicit invalidation', async kind => {
  const f = fixture(); const pending = f.preview.enter(f.live().ref, 'A'); const old = f.live()
  f.setLive(kind === 'closed' ? null : { ...old, ref: kind === 'tab' ? { docId: 'other', epoch: 'other' } : kind === 'epoch' ? { ...old.ref, epoch: 'replacement' } : old.ref, pathGeneration: kind === 'migration' ? 1 : 0 })
  f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await pending
  expect(f.preview.selectedId).toBeNull(); expect(f.preview.state).toBeNull(); expect(f.preview.exit()).toBeNull(); f.unchanged()
})

test('explicit invalidation releases loaded history and rejects a pending read after switching away and back', async () => {
  const f = fixture(); const first = f.preview.enter(f.live().ref, 'A')
  f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await first
  const second = f.preview.enter(f.live().ref, 'B'); f.preview.invalidate()
  expect(f.preview.state).toBeNull(); f.pending[1]!.resolve({ status: 'ok', value: historical('B') }); await second
  expect(f.preview.selectedId).toBeNull(); f.unchanged()
})

test('loaded history is released on same-ref path migration and an inactive ref cannot start a read', async () => {
  const f = fixture(); const pending = f.preview.enter(f.live().ref, 'A')
  f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await pending
  f.setLive({ ...f.live(), pathGeneration: 1 }); expect(f.preview.state).toBeNull()
  await f.preview.enter({ docId: 'other', epoch: 'epoch' }, 'B'); expect(f.api.inspectHistory).toHaveBeenCalledTimes(1); f.unchanged()
})

test.each(['INVALID_REQUEST', 'CORRUPT_DATA'] as const)('removed or damaged record (%s) clears old body, exposes error, and leaves current document intact', async code => {
  const f = fixture(); const a = f.preview.enter(f.live().ref, 'A'); f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await a
  const b = f.preview.enter(f.live().ref, 'B'); expect(f.preview.state?.snapshot).toBeNull()
  f.pending[1]!.resolve({ status: 'error', error: { code, message: 'unavailable', retryable: true } }); await b
  expect(f.preview.state?.error?.code).toBe(code); expect(f.preview.state?.snapshot).toBeNull(); expect(f.preview.state?.loading).toBe(false); f.unchanged()
})

test('wrong history ID and rejected transport never install a body', async () => {
  const f = fixture(); const first = f.preview.enter(f.live().ref, 'A'); f.pending[0]!.resolve({ status: 'ok', value: historical('wrong') }); await first
  expect(f.preview.state?.error?.code).toBe('INVALID_REQUEST'); expect(f.preview.state?.snapshot).toBeNull()
  const second = f.preview.enter(f.live().ref, 'B'); f.pending[1]!.reject(new Error('transport')); await second
  expect(f.preview.state?.error?.code).toBe('IO_ERROR'); expect(f.preview.state?.loading).toBe(false); f.unchanged()
})

test('exit cancels outstanding reads and retains a detached copy of the original view', async () => {
  const f = fixture(); const pending = f.preview.enter(f.live().ref, 'A'); f.live().view.reading.top = 999
  expect(f.preview.exit()?.reading.top).toBe(120)
  f.pending[0]!.resolve({ status: 'ok', value: historical('A') }); await pending
  expect(f.preview.state).toBeNull(); f.unchanged()
})

test('cancelled B and a late A error retain the initial entry bookmark and remain safely exitable', async () => {
  const f = fixture(); const first = f.preview.enter(f.live().ref, 'A')
  f.live().view.mode = 'read'; f.live().view.reading.top = 800
  const second = f.preview.enter(f.live().ref, 'B')
  f.pending[1]!.resolve({ status: 'cancelled' }); await second
  f.pending[0]!.resolve({ status: 'error', error: { code: 'CORRUPT_DATA', message: 'old error', retryable: false } }); await first
  expect(f.preview.selectedId).toBe('B'); expect(f.preview.state).toMatchObject({ snapshot: null, error: null, loading: false })
  expect(f.preview.exit()).toEqual({ mode: 'edit', reading: { top: 120, ratio: 0.4, revision: 1 }, editorTop: 60 }); f.unchanged()
})

test('a late previous-tab failure cannot cancel the new tab preview', async () => {
  const f = fixture(); const first = f.preview.enter(f.live().ref, 'A')
  f.preview.invalidate(); f.setLive({ ...f.live(), ref: { docId: 'other', epoch: 'new' } })
  const second = f.preview.enter(f.live().ref, 'B'); f.pending[1]!.resolve({ status: 'ok', value: historical('B') }); await second
  f.pending[0]!.resolve({ status: 'error', error: { code: 'CORRUPT_DATA', message: 'old owner', retryable: false } }); await first
  expect(f.preview.selectedId).toBe('B'); expect(f.preview.state?.snapshot?.text).toBe('history B'); f.unchanged()
})
