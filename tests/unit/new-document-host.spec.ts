import { createRenderer, ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import type { AppEvent, OpenDocument, Result, SaveReceipt, SaveRequest } from '../../src/shared/contracts'
import { useWorkspace, type ActiveEditor } from '../../src/renderer/src/documents/use-workspace'
import { RecoveryScheduler } from '../../src/renderer/src/documents/recovery-scheduler'
import { WorkspaceModel } from '../../src/renderer/src/documents/workspace'

const document: OpenDocument = { docId: 'draft', epoch: 'epoch', displayName: '未命名-1', displayPath: null, text: '', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: null, readOnlyReason: null, recovered: false, readingPosition: null }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture() {
  let event!: (event: AppEvent) => Promise<void>
  const create = vi.fn(async (): Promise<Result<OpenDocument>> => {
    const value = structuredClone(document)
    await event({ type: 'document-created', document: value })
    return { status: 'ok', value }
  })
  const saveAs = vi.fn(async (request: SaveRequest): Promise<Result<SaveReceipt>> => ({
    status: 'ok', value: { requestId: request.requestId, ref: { docId: request.snapshot.docId, epoch: request.snapshot.epoch }, savedRevision: request.snapshot.revision, diskToken: 'a'.repeat(64), savedAt: 'now', displayName: 'saved.md', displayPath: '/saved.md', history: { state: 'recorded', generation: 1, error: null } }
  }))
  const save = vi.fn()
  vi.stubGlobal('window', { inknest: { onEvent: (fn: typeof event) => { event = fn; return () => {} }, createDocument: create, saveAs, save, checkpoint: vi.fn() } })
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const editor = ref<ActiveEditor>({ settleComposition: async () => true, setFrozen() {}, focus() {} })
  let ws!: ReturnType<typeof useWorkspace>
  const app = renderer.createApp({ setup() { ws = useWorkspace(editor); return () => null } })
  app.mount({}); cleanups.push(() => app.unmount())
  return { ws, editor, create, saveAs, save, event: (e: AppEvent) => event(e) }
}

test('one create intent installs one editing tab despite event, invocation result and late duplicate', async () => {
  const f = fixture()
  await Promise.all([f.ws.createDocument(), f.ws.createDocument()])
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.ws.workspace.refs).toHaveLength(1)
  expect(f.ws.mode.value).toBe('edit'); expect(f.ws.dirty.value).toBe(false)
  const session = f.ws.session.value!
  session.dispatch({ changes: { from: 0, insert: 'text' }, selection: { anchor: 2 } })
  await f.event({ type: 'document-created', document: structuredClone(document) })
  expect(f.ws.session.value).toBe(session); expect(session.state.selection.main.head).toBe(2)
  expect(session.snapshot().text).toBe('text')
})

test('creation waits for IME settlement, preserves original session and aborts when composition cannot settle', async () => {
  const f = fixture()
  f.ws.workspace.install({ ...document, docId: 'original', epoch: 'original', displayPath: '/old.md', displayName: 'old.md', text: 'old' })
  const original = f.ws.session.value!
  original.dispatch({ changes: { from: 3, insert: '候选' } })
  f.editor.value.settleComposition = async () => false
  await f.ws.createDocument()
  expect(f.create).not.toHaveBeenCalled()
  f.editor.value.settleComposition = async () => true
  await f.ws.createDocument()
  expect(f.ws.workspace.getSession({ docId: 'original', epoch: 'original' })).toBe(original)
  expect(original.snapshot().text).toBe('old候选')
})

test('closing an event-created tab before the invocation reply cannot resurrect it', async () => {
  const f = fixture()
  let reply!: (result: Result<OpenDocument>) => void
  f.create.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  const creating = f.ws.createDocument()
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
  await f.event({ type: 'document-created', document: structuredClone(document) })
  await f.event({ type: 'document-closed', ref: document })
  reply({ status: 'ok', value: structuredClone(document) }); await creating
  await f.event({ type: 'document-created', document: structuredClone(document) })
  expect(f.ws.workspace.refs).toHaveLength(0)
})

test('manual first save preserves EditorState and undo, while preview never invokes formal save', async () => {
  const f = fixture(); await f.ws.createDocument()
  const session = f.ws.session.value!
  session.dispatch({ changes: { from: 0, insert: '# source\n' }, selection: { anchor: 3 } })
  await f.ws.setMode('read')
  expect(f.save).not.toHaveBeenCalled(); expect(f.saveAs).not.toHaveBeenCalled()
  const state = session.state
  await f.ws.save()
  expect(f.saveAs).toHaveBeenCalledTimes(1)
  expect(session.state).toBe(state); expect(f.ws.mode.value).toBe('read')
  expect(session.document.displayPath).toBe('/saved.md'); expect(session.dirty).toBe(false)
  undo({ state: session.state, dispatch: tx => session.apply([tx]) })
  expect(session.snapshot().text).toBe(''); expect(session.dirty).toBe(true)
})

test('lost first-save receipt freezes source and retries identical request without a new snapshot', async () => {
  const f = fixture(); await f.ws.createDocument()
  const session = f.ws.session.value!
  session.dispatch({ changes: { from: 0, insert: 'keep' } })
  f.saveAs.mockRejectedValueOnce(new Error('reply lost'))
  await f.ws.save()
  const original = structuredClone(f.saveAs.mock.calls[0]![0])
  expect(session.frozen).toBe(true)
  session.dispatch({ changes: { from: 0, insert: 'blocked' } })
  expect(session.snapshot().text).toBe('keep')
  await f.ws.save()
  expect(f.saveAs.mock.calls[1]![0]).toEqual(original)
  expect(session.document.displayPath).toBe('/saved.md')
  expect(session.frozen).toBe(false); expect(session.dirty).toBe(false)
})

test('late success only confirms A while newer B remains dirty', () => {
  const workspace = new WorkspaceModel(); workspace.install(structuredClone(document))
  const session = workspace.getSession(document)!
  session.dispatch({ changes: { from: 0, insert: 'A' } })
  const captured = session.captureSave('request')
  session.dispatch({ changes: { from: 1, insert: 'B' } })
  expect(workspace.acceptSave({ requestId: 'request', ref: document, savedRevision: captured.revision, diskToken: 'a'.repeat(64), displayName: 'saved.md', displayPath: '/saved.md', savedAt: 'now', history: { state: 'recorded', generation: 1, error: null } }, captured.text)).toBe(true)
  expect(session.snapshot().text).toBe('AB'); expect(session.dirty).toBe(true)
})

test.each([false, true])('empty draft maintenance follows a completed or in-flight nonempty checkpoint (in flight %s)', async inFlight => {
  vi.useFakeTimers()
  const workspace = new WorkspaceModel(); workspace.install(structuredClone(document))
  let finish!: () => void
  const texts: string[] = []
  const scheduler = new RecoveryScheduler(workspace, async snapshot => {
    texts.push(snapshot.text)
    if (inFlight && texts.length === 1) await new Promise<void>(resolve => { finish = resolve })
    return { status: 'ok', value: { revision: snapshot.revision, savedAt: 'now' } }
  })
  cleanups.push(() => scheduler.dispose())
  const session = workspace.getSession(document)!
  await vi.advanceTimersByTimeAsync(10000); expect(texts).toEqual([])
  session.dispatch({ changes: { from: 0, insert: 'old recovery' } })
  await vi.advanceTimersByTimeAsync(2000)
  session.dispatch({ changes: { from: 0, to: session.state.doc.length, insert: '' } })
  expect(session.dirty).toBe(false)
  if (inFlight) finish()
  await vi.advanceTimersByTimeAsync(2000)
  expect(texts).toEqual(['old recovery', ''])
  session.dispatch({ changes: { from: 0, insert: 'next' } })
  await vi.advanceTimersByTimeAsync(2000)
  expect(texts).toEqual(['old recovery', '', 'next'])
})
