import { createSSRApp, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { useWorkspace, type ActiveEditor } from '../../src/renderer/src/documents/use-workspace'
import type { AppEvent, CurrentState, OpenDocument, ReconcileOutcome, Result } from '../../src/shared/contracts'
const document: OpenDocument = { docId: 'a', epoch: 'a-epoch', displayName: 'a.md', displayPath: '/a.md', text: 'A complete', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'token', readOnlyReason: null, recovered: false, readingPosition: null }
let cleanup = () => {}
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function setup() {
  vi.useFakeTimers(); let listener!: (event: AppEvent) => void; let controller!: ReturnType<typeof useWorkspace>
  const complete = vi.fn<(id: string, state: CurrentState) => Promise<Result<void>>>(async () => ({ status: 'cancelled' }))
  const reconcile = vi.fn<(state: CurrentState) => Promise<Result<ReconcileOutcome>>>(async () => ({ status: 'ok', value: { kind: 'unchanged' } }))
  const api = { reconcileExternal: reconcile, onEvent: (callback: typeof listener) => { listener = callback; return () => {} }, completeClose: complete, save: vi.fn(async () => ({ status: 'cancelled' as const })) }
  vi.stubGlobal('window', { inknest: api }); const editor = ref<ActiveEditor>({ settleComposition: async () => true, setFrozen: vi.fn() })
  await renderToString(createSSRApp({ setup() { controller = useWorkspace(editor); return () => null } }))
  cleanup = () => controller.workspace.dispose()
  controller.workspace.install({ ...document })
  return { controller, editor, complete, reconcile, emit: (event: AppEvent) => listener(event) }
}
test('single-tab challenge freezes its own session and returns the complete snapshot without a global freeze', async () => {
  const f = await setup(); const session = f.controller.workspace.getSession(document)!
  session.dispatch({ changes: { from: 0, insert: 'latest ' } })
  await f.emit({ type: 'prepare-close', requestId: 'single', ref: document })
  expect(f.complete).toHaveBeenCalledWith('single', { ref: document, snapshot: { docId: document.docId, epoch: document.epoch, text: 'latest A complete', revision: 1 } })
  expect(f.controller.frozen.value).toBe(true)
  await f.emit({ type: 'close-finished', requestId: 'single', message: null })
  expect(f.controller.frozen.value).toBe(false); expect(session.snapshot().text).toBe('latest A complete')
})
test('single-tab preparation timeout invalidates a delayed composition reply and leaves text editable', async () => {
  const f = await setup(); let finish!: (value: boolean) => void
  f.editor.value.settleComposition = () => new Promise(resolve => { finish = resolve })
  const waiting = f.emit({ type: 'prepare-close', requestId: 'old', ref: document })
  await f.emit({ type: 'close-finished', requestId: 'old', message: 'timed out' })
  finish(true); await waiting
  expect(f.complete).not.toHaveBeenCalled(); expect(f.controller.frozen.value).toBe(false)
  f.controller.workspace.getSession(document)!.dispatch({ changes: { from: 0, insert: 'after ' } })
  expect(f.controller.workspace.getSession(document)!.snapshot().text).toBe('after A complete')
})

test('a duplicated finished single-tab challenge cannot refreeze a live document', async () => {
  const f = await setup()
  await f.emit({ type: 'prepare-close', requestId: 'done', ref: document })
  await f.emit({ type: 'close-finished', requestId: 'done', message: null })
  await f.emit({ type: 'prepare-close', requestId: 'done', ref: document })
  expect(f.complete).toHaveBeenCalledTimes(1); expect(f.controller.frozen.value).toBe(false)
})

test('old close error and location events cannot override a newer close, explicit save or epoch', async () => {
  const f = await setup(); const b = { ...document, docId: 'b', epoch: 'b-epoch', displayName: 'b.md' }; f.controller.workspace.install(b)
  await f.emit({ type: 'workspace-freeze', requestId: 'old' }); await f.emit({ type: 'workspace-thaw', requestId: 'old' })
  await f.emit({ type: 'workspace-freeze', requestId: 'new' }); await f.emit({ type: 'workspace-thaw', requestId: 'new' })
  const error = { code: 'IO_ERROR' as const, message: 'old failure', retryable: true }
  await f.emit({ type: 'close-error', requestId: 'old', ref: document, error })
  await f.emit({ type: 'close-blocked', requestId: 'old', ref: document, action: 'locate' })
  expect(f.controller.workspace.active?.docId).toBe('b'); expect(f.controller.workspace.getTab(document)!.error).toBe('')
  await f.emit({ type: 'close-error', requestId: 'new', ref: document, error }); expect(f.controller.workspace.getTab(document)!.error).toBe('old failure')
  await f.controller.save()
  await f.emit({ type: 'close-error', requestId: 'new', ref: b, error }); expect(f.controller.workspace.getTab(b)!.error).toBe('')
  f.controller.workspace.replace(document, { ...document, epoch: 'replacement' })
  await f.emit({ type: 'close-error', requestId: 'new', ref: document, error })
  expect(f.controller.workspace.getTab({ ...document, epoch: 'replacement' })!.error).toBe('')
})

test('identity-only readonly close failures stay visible without a writable save request', async () => {
  const f = await setup(); const readonly: OpenDocument = { ...document, epoch: 'readonly-epoch', readOnlyReason: 'size' }; f.controller.workspace.replace(document, readonly)
  expect(f.controller.workspace.getSession(readonly)).toBeNull()
  f.complete.mockResolvedValueOnce({ status: 'error', error: { code: 'EXTERNAL_CHANGE', message: '原文件不可用，已保留只读内容。', retryable: true } })
  await f.emit({ type: 'prepare-close', requestId: 'readonly', ref: readonly })
  expect(f.controller.error.value).toBe('原文件不可用，已保留只读内容。')
})

const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
test('external events defer behind their single close without losing identity; matching cancellation reconciles latest text once', async () => {
  const f = await setup(); let finish!: (result: Result<void>) => void
  f.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  // Bound the old cancelled retry defect so the RED cannot loop forever.
  f.reconcile.mockResolvedValueOnce({ status: 'cancelled' }).mockImplementationOnce(() => new Promise(() => {}))
  const waiting = f.emit({ type: 'prepare-close', requestId: 'held', ref: document }); await microtasks()
  await f.emit({ type: 'external-change', ref: document, diskStatus: 'changed' }); await microtasks()
  expect(f.reconcile).not.toHaveBeenCalled(); expect(f.controller.frozen.value).toBe(true)
  expect(f.editor.value.setFrozen).not.toHaveBeenCalledWith(false)
  await f.emit({ type: 'close-finished', requestId: 'stale', message: null }); expect(f.controller.frozen.value).toBe(true)
  await f.emit({ type: 'close-error', requestId: 'held', ref: document, error: { code: 'RECOVERY_FAILED', message: 'marker failed', retryable: true } })
  expect(f.controller.error.value).toBe('marker failed')
  f.reconcile.mockReset().mockResolvedValue({ status: 'ok', value: { kind: 'unchanged' } })
  await f.emit({ type: 'close-finished', requestId: 'held', message: null })
  f.controller.workspace.getSession(document)!.dispatch({ changes: { from: 0, insert: 'latest ' } })
  const b = { ...document, docId: 'b', epoch: 'b-epoch' }; f.controller.workspace.install(b)
  await f.emit({ type: 'close-blocked', requestId: 'held', ref: document, action: 'locate' }); await microtasks()
  expect(f.controller.workspace.active?.docId).toBe('a'); expect(f.reconcile).toHaveBeenCalledTimes(1)
  expect(f.reconcile.mock.calls[0]![0].snapshot?.text).toBe('latest A complete')
  finish({ status: 'cancelled' }); await waiting
})
test('successful release drops deferred external work and a background ref can reconcile independently', async () => {
  const f = await setup(); f.complete.mockImplementationOnce(() => new Promise(() => {}))
  void f.emit({ type: 'prepare-close', requestId: 'held', ref: document }); await microtasks()
  // Held promise bounds the pre-fix lifecycle entry without waiting for it.
  f.reconcile.mockImplementationOnce(() => new Promise(() => {}))
  void f.emit({ type: 'external-change', ref: document, diskStatus: 'changed' }); await microtasks()
  expect(f.reconcile).not.toHaveBeenCalled()
  f.reconcile.mockReset().mockResolvedValue({ status: 'ok', value: { kind: 'unchanged' } })
  const b = { ...document, docId: 'b', epoch: 'b-epoch' }; f.controller.workspace.install(b)
  await f.emit({ type: 'external-change', ref: b, diskStatus: 'changed' }); await microtasks()
  expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.reconcile.mock.calls[0]![0].ref).toEqual({ docId: 'b', epoch: 'b-epoch' })
  await f.emit({ type: 'document-closed', ref: document }); await f.emit({ type: 'close-finished', requestId: 'held', message: null })
  await f.emit({ type: 'workspace-freeze', requestId: 'window' }); await f.emit({ type: 'workspace-thaw', requestId: 'window' }); await microtasks()
  expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.controller.frozen.value).toBe(false)
})
test('cancelled reconciliation waits for a later event rather than spinning IPC', async () => {
  const f = await setup(); f.reconcile.mockResolvedValueOnce({ status: 'cancelled' }).mockImplementationOnce(() => new Promise(() => {}))
  await f.emit({ type: 'external-change', ref: document, diskStatus: 'changed' }); await microtasks()
  expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.controller.frozen.value).toBe(false)
  f.reconcile.mockReset().mockResolvedValue({ status: 'ok', value: { kind: 'unchanged' } })
  await f.emit({ type: 'external-change', ref: document, diskStatus: 'changed' }); await microtasks()
  expect(f.reconcile).toHaveBeenCalledTimes(1)
})

test('matching close location on the already active composing document preserves the timeout explanation', async () => {
  const f = await setup()
  await f.emit({ type: 'prepare-close', requestId: 'timeout', ref: document })
  await f.emit({ type: 'close-finished', requestId: 'timeout', message: '未收到最新编辑状态' })
  f.editor.value.settleComposition = async () => false
  await f.emit({ type: 'close-blocked', requestId: 'timeout', ref: document, action: 'locate' })
  expect(f.controller.error.value).toBe('未收到最新编辑状态')
})
