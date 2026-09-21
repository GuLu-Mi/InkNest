import { createSSRApp, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { useWorkspace, type ActiveEditor } from '../../src/renderer/src/documents/use-workspace'
import type { AppEvent, ContentSnapshot, InkNestAPI, OpenDocument, Result, SaveReceipt, SaveRequest } from '../../src/shared/contracts'
const document: OpenDocument = { docId: 'a', epoch: 'epoch-a', displayName: 'a.md', displayPath: '/a.md', text: 'original', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'token0', readOnlyReason: null, recovered: false, readingPosition: null }
let cleanup = () => {}
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
function receipt(request: SaveRequest, displayPath = '/a.md'): Result<SaveReceipt> { return { status: 'ok', value: { requestId: request.requestId, ref: request.snapshot, savedRevision: request.snapshot.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: `token-${request.requestId}`, savedAt: '', displayName: displayPath.split('/').at(-1)!, displayPath } } }
async function setup(overrides: Partial<InkNestAPI> = {}) {
  vi.useFakeTimers(); let listener!: (event: AppEvent) => void; let controller!: ReturnType<typeof useWorkspace>
  const save = vi.fn(async (request: SaveRequest) => receipt(request)); const completeClose = vi.fn(async () => ({ status: 'cancelled' as const }))
  const api = { save, completeClose, checkpoint: async (snapshot: ContentSnapshot) => ({ status: 'ok' as const, value: { revision: snapshot.revision, savedAt: '' } }), saveAs: async (request: SaveRequest) => receipt(request, '/copy.md'), resolveConflict: async (_ref: unknown, _action: unknown, snapshot: ContentSnapshot) => ({ status: 'ok' as const, value: { kind: 'saved' as const, receipt: (receipt({ requestId: crypto.randomUUID(), snapshot, expectedDiskToken: 'token', trigger: 'manual' }) as { status: 'ok'; value: SaveReceipt }).value } }), ...overrides, onEvent: (callback: typeof listener) => { listener = callback; return () => {} } }
  vi.stubGlobal('window', { inknest: api })
  const editor = ref<ActiveEditor>({ settleComposition: async () => true, setFrozen: () => {} })
  await renderToString(createSSRApp({ setup() { controller = useWorkspace(editor); return () => null } }))
  cleanup = () => controller.workspace.dispose()
  return { controller, editor, save, completeClose, emit: (event: AppEvent) => listener(event) }
}
for (const action of ['save-as', 'overwrite'] as const) for (const reply of ['success', 'error', 'rejected'] as const) test(`obsolete auto ${reply} after newer ${action} cannot pause future automatic edits`, async () => {
  let finish!: (result: Result<SaveReceipt>) => void; let reject!: (error: Error) => void; let held!: SaveRequest; const submitted: SaveRequest[] = []
  const { controller } = await setup({ save: request => {
    submitted.push(request)
    if (submitted.length > 1) return Promise.resolve(receipt(request, action === 'save-as' ? '/copy.md' : '/a.md'))
    held = request; return new Promise((resolve, fail) => { finish = resolve; reject = fail })
  } })
  controller.workspace.install({ ...document }); const session = controller.workspace.getSession(document)!
  session.dispatch({ changes: { from: 0, insert: 'A ' } }); await vi.advanceTimersByTimeAsync(1000); expect(submitted).toHaveLength(1)
  if (action === 'save-as') await controller.saveAs()
  else { controller.workspace.getTab(document)!.diskStatus = 'changed'; await controller.resolveConflict('overwrite') }
  expect(session.dirty).toBe(false)
  if (reply === 'success') finish(receipt(held))
  else if (reply === 'error') finish({ status: 'error', error: { code: 'EXTERNAL_CHANGE', message: 'old failure', retryable: true } })
  else reject(new Error('old rejected IPC'))
  await vi.advanceTimersByTimeAsync(0); expect(controller.workspace.getTab(document)!.saveFailure).toBeNull()
  session.dispatch({ changes: { from: 0, insert: 'new ' } }); await vi.advanceTimersByTimeAsync(1000)
  expect(submitted).toHaveLength(2); expect(submitted[1]!.snapshot.text).toBe('new A original'); expect(session.dirty).toBe(false)
})
test('global preparation timeout resumes background dirty work and an old thaw cannot unlock a new freeze', async () => {
  const { controller, editor, save, completeClose, emit } = await setup(); const b = { ...document, docId: 'b', epoch: 'epoch-b', displayName: 'b.md', displayPath: '/b.md' }
  controller.workspace.install(b); const sessionB = controller.workspace.getSession(b)!; sessionB.dispatch({ changes: { from: 0, insert: 'B pending ' } })
  controller.workspace.install({ ...document }); let settle!: (ok: boolean) => void
  editor.value.settleComposition = () => new Promise(resolve => { settle = resolve })
  await emit({ type: 'workspace-freeze', requestId: 'freeze-old' }); void emit({ type: 'prepare-close', requestId: 'close-old', ref: b })
  await vi.advanceTimersByTimeAsync(5000); expect(save).not.toHaveBeenCalled(); expect(sessionB.snapshot().text).toBe('B pending original')
  settle(false); await emit({ type: 'workspace-thaw', requestId: 'freeze-old' }); await vi.advanceTimersByTimeAsync(1000)
  expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]![0].snapshot.text).toBe('B pending original'); expect(sessionB.dirty).toBe(false); expect(completeClose).not.toHaveBeenCalled()
  sessionB.dispatch({ changes: { from: 0, insert: 'latest ' } }); await emit({ type: 'workspace-freeze', requestId: 'freeze-new' })
  await emit({ type: 'workspace-thaw', requestId: 'freeze-old' }); await vi.advanceTimersByTimeAsync(5000)
  expect(save).toHaveBeenCalledTimes(1); expect(controller.frozen.value).toBe(true)
  settle(false); await emit({ type: 'workspace-thaw', requestId: 'freeze-new' }); await vi.advanceTimersByTimeAsync(1000)
  expect(save).toHaveBeenCalledTimes(2); expect(sessionB.snapshot().text).toBe('latest B pending original'); expect(sessionB.dirty).toBe(false)
})

for (const oldReply of ['success', 'error', 'rejected'] as const) test(`obsolete auto ${oldReply} cannot clear or retry a newer visible conflict`, async () => {
  let finish!: (result: Result<SaveReceipt>) => void; let reject!: (error: Error) => void; let held!: SaveRequest; const submitted: SaveRequest[] = []
  const failure = { status: 'error' as const, error: { code: 'EXTERNAL_CHANGE' as const, message: 'new conflict remains', retryable: true } }
  const { controller } = await setup({ save: request => { submitted.push(request); held = request; return new Promise((resolve, fail) => { finish = resolve; reject = fail }) }, resolveConflict: async () => failure })
  controller.workspace.install({ ...document }); const tab = controller.workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, insert: 'A ' } }); await vi.advanceTimersByTimeAsync(1000); await controller.resolveConflict('overwrite')
  if (oldReply === 'success') finish(receipt(held)); else if (oldReply === 'error') finish(failure); else reject(new Error('old rejection'))
  await vi.advanceTimersByTimeAsync(0); expect(tab.saveFailure).toBe('conflict'); expect(tab.diskStatus).toBe('changed'); expect(tab.saveError).toBe('new conflict remains')
  session.dispatch({ changes: { from: 0, insert: 'kept ' } }); await vi.advanceTimersByTimeAsync(20000)
  expect(submitted).toHaveLength(1); expect(session.snapshot().text).toBe('kept A original'); expect(session.dirty).toBe(true)
})

test('confirmed save with failed history stays clean, pauses auto and resumes only after explicit repair', async () => {
  let broken = true; const requests: SaveRequest[] = []
  const { controller } = await setup({ save: async request => {
    requests.push(request); const result = receipt(request)
    if (result.status === 'ok') result.value.history = broken ? { state: 'failed', generation: 1, error: { code: 'HISTORY_FAILED', message: 'history down', retryable: true } } : { state: 'recorded', generation: 2, error: null }
    return result
  } })
  controller.workspace.install({ ...document }); const tab = controller.workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, insert: 'A ' } }); await vi.advanceTimersByTimeAsync(1000)
  expect(session.dirty).toBe(false); expect(tab.historyAttention?.state).toBe('failed'); expect(tab.saveFailure).toBeNull()
  session.dispatch({ changes: { from: 0, insert: 'B ' } }); await vi.advanceTimersByTimeAsync(20000)
  expect(requests).toHaveLength(1); expect(session.dirty).toBe(true)
  broken = false; await controller.save(); expect(tab.historyAttention).toBeNull(); expect(session.dirty).toBe(false)
  session.dispatch({ changes: { from: 0, insert: 'C ' } }); await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toHaveLength(3); expect(session.dirty).toBe(false)
})
test('history notifications ignore earlier generations and paths after Save As', async () => {
  const { controller, emit } = await setup(); controller.workspace.install({ ...document }); const tab = controller.workspace.getTab(document)!
  await emit({ type: 'history-changed', ref: document, displayPath: '/a.md', generation: 9 }); expect(tab.historyGeneration).toBe(9)
  await emit({ type: 'history-changed', ref: document, displayPath: '/a.md', generation: 8 }); expect(tab.historyGeneration).toBe(9)
  await controller.saveAs(); expect(tab.document.displayPath).toBe('/copy.md'); expect(tab.historyGeneration).toBe(0)
  await emit({ type: 'history-changed', ref: document, displayPath: '/a.md', generation: 10 }); expect(tab.historyGeneration).toBe(0)
  await emit({ type: 'history-changed', ref: document, displayPath: '/copy.md', generation: 1 }); expect(tab.historyGeneration).toBe(1)
})
