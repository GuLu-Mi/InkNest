import { EventEmitter } from 'node:events'
import { PresentationController } from '../../src/main/presentation-controller'
import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { HistoryStore } from '../../src/main/documents/history-store'
import { RecoveryStore } from '../../src/main/documents/recovery-store'
import { atomicWrite, type AtomicWriter } from '../../src/main/documents/atomic-writer'
import { FileLifecycle } from '../../src/main/documents/file-lifecycle'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import type { HistoryRestoreRequest } from '../../src/shared/contracts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(options: { writer?: AtomicWriter; historical?: Buffer; beforeManifest?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inknest-restore-')); roots.push(root)
  const path = join(root, 'source.md'); await writeFile(path, '\ufeffA\r\n')
  const registry = new DocumentRegistry(); await registry.open(path, 1); const session = registry.current!
  const renderer = new DocumentSession({ ...session.document }); renderer.dispatch({ changes: { from: 0, to: renderer.state.doc.length, insert: 'B\n' } })
  const history = new HistoryStore(join(root, 'history'), { beforeManifest: options.beforeManifest })
  const recovery = new RecoveryStore(join(root, 'recovery'), registry)
  await recovery.checkpoint(session, renderer.snapshot())
  await history.captureBeforeWrite(session, options.historical ?? Buffer.from('C\n'), 'manual', Date.now())
  const [entry] = (await history.list(session)).entries; const selected = await history.inspect(session, entry!.id)
  const saves = new SaveCoordinator(registry, options.writer ?? atomicWrite, { history, recovery, confirmWithoutHistory: async () => true })
  const request: HistoryRestoreRequest = { requestId: randomUUID(), snapshot: renderer.snapshot(), expectedDiskToken: session.document.diskToken, historyId: selected.id, expectedContentHash: selected.contentHash }
  const restore = (input = request, confirm = async () => true, owner = 1) => {
    expect(saves.restoreHistory).toBeTypeOf('function')
    return saves.restoreHistory(input, owner, history, confirm)
  }
  return { root, path, registry, session, renderer, history, recovery, saves, request, selected, restore }
}
async function historyTexts(f: Awaited<ReturnType<typeof fixture>>) { return Promise.all(((await f.history.list(f.session)).entries).map(async entry => (await f.history.read(f.session, entry.id)).toString('utf8'))) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

test('restore preserves A and dirty B, installs C with the current BOM/CRLF, and replays only its small receipt', async () => {
  const f = await fixture(); f.renderer.setFrozen(true)
  expect(f.renderer.captureHistoryRestore).toBeTypeOf('function'); f.renderer.captureHistoryRestore(f.request.requestId, f.selected)
  const result = await f.restore()
  expect(result).toMatchObject({ status: 'ok', value: { kind: 'restored', previousRevision: 1, preservedCurrent: { savedRevision: 1 }, restored: { savedRevision: 2 } } })
  if (result.status !== 'ok' || result.value.kind !== 'restored') throw new Error('restore failed')
  expect(f.renderer.acceptHistoryRestore(result.value)).toBe(true)
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n'); expect(f.renderer.snapshot()).toMatchObject({ text: 'C\n', revision: 2 }); expect(f.renderer.dirty).toBe(false)
  expect(await historyTexts(f)).toEqual(expect.arrayContaining(['\ufeffA\r\n', '\ufeffB\r\n', 'C\n']))
  expect(await f.restore()).toEqual(result)
  expect(JSON.stringify(result)).not.toContain('"text"')
  expect(await f.restore({ ...f.request, expectedContentHash: '0'.repeat(64) })).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  for (const revision of [1, 3]) expect(await f.saves.save({ requestId: randomUUID(), snapshot: { ...f.request.snapshot, revision }, expectedDiskToken: f.request.expectedDiskToken, trigger: 'auto' }, 1)).toMatchObject({ status: 'error' })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
})

test.each(['presave-write', 'presave-history', 'saved-current-history', 'restore-write', 'postwrite'] as const)('%s failure reports the exact completed preservation and retains B', async phase => {
  let manifests = 0; let armed = false
  const f = await fixture({ beforeManifest: async () => { if (armed && ++manifests === (phase === 'saved-current-history' ? 2 : 1) && phase.endsWith('history')) throw new Error('injected history failure') }, writer: async (path, bytes, check) => {
    const text = Buffer.from(bytes).toString('utf8')
    if (phase === 'presave-write' && text.includes('B') || phase === 'restore-write' && text.includes('C')) throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' })
    const identity = await atomicWrite(path, bytes, check)
    return phase === 'postwrite' && text.includes('C') ? { dev: identity.dev, ino: identity.ino + 1 } : identity
  } }); armed = true
  const result = await f.restore()
  expect(result.status).toBe('error')
  if (result.status !== 'error') throw new Error('expected failure')
  const preserved = !phase.startsWith('presave')
  expect(result.preservedCurrent?.savedRevision ?? null).toBe(preserved ? 1 : null)
  expect(result.diskUncertain).toBe(phase === 'postwrite')
  expect(await readFile(f.path, 'utf8')).toBe(phase === 'postwrite' ? '\ufeffC\r\n' : preserved ? '\ufeffB\r\n' : '\ufeffA\r\n')
  expect(f.renderer.snapshot().text).toBe('B\n'); expect(await historyTexts(f)).toContain('C\n')
  if (phase === 'postwrite') expect(f.session.diskStatus).not.toBe('current')
})

test('history failure after confirmed restored C returns restored with warning and preserves B', async () => {
  let writtenC = false
  const f = await fixture({ beforeManifest: async () => { if (writtenC) throw Error('C history unavailable') }, writer: async (path, bytes, check) => {
    const identity = await atomicWrite(path, bytes, check)
    writtenC = Buffer.from(bytes).toString().includes('C')
    return identity
  } })
  const result = await f.restore()
  expect(result).toMatchObject({ status: 'ok', value: { kind: 'restored', preservedCurrent: { history: { state: 'recorded' } }, restored: { history: { state: 'failed' } } } })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
  expect(f.session.document.text).toBe('C\n'); expect(f.session.diskStatus ?? 'current').toBe('current')
  expect(await historyTexts(f)).toContain('\ufeffB\r\n')
})

test.each(['cancel', 'external', 'revision', 'history'] as const)('confirmation %s leaves the complete current buffer and no application write', async phase => {
  const f = await fixture()
  const result = await f.restore(f.request, async () => {
    if (phase === 'external') await writeFile(f.path, 'external')
    if (phase === 'revision') f.session.latestSnapshot = { ...f.request.snapshot, text: 'newer B', revision: 2 }
    if (phase === 'history') { const [dir] = await readdir(join(f.root, 'history')); await writeFile(join(f.root, 'history', dir!, `${f.selected.id}.bin`), 'bad') }
    return phase !== 'cancel'
  })
  expect(result.status).toBe(phase === 'cancel' ? 'cancelled' : 'error')
  expect(await readFile(f.path, 'utf8')).toBe(phase === 'external' ? 'external' : '\ufeffA\r\n'); expect(f.renderer.snapshot().text).toBe('B\n')
})

test.each(['owner', 'epoch', 'hash', 'readonly', 'pending', 'changed', 'other-file', 'oversize', 'format', 'serialized-size'] as const)('server refuses %s even when renderer asks to restore', async kind => {
  const historical = kind === 'oversize' ? Buffer.alloc(2 * 1024 * 1024 + 1, 97) : kind === 'format' ? Buffer.from('C\r\nx\n') : kind === 'serialized-size' ? Buffer.from('\n'.repeat(1024 * 1024)) : undefined
  const f = await fixture({ historical }); const request = { ...f.request, snapshot: { ...f.request.snapshot } }
  if (kind === 'epoch') request.snapshot.epoch = randomUUID()
  if (kind === 'hash') request.expectedContentHash = '0'.repeat(64)
  if (kind === 'readonly') f.session.document.readOnlyReason = 'permission'
  if (kind === 'pending') f.session.recoveryPending = true
  if (kind === 'changed') f.session.diskStatus = 'changed'
  if (kind === 'other-file') { const other = join(f.root, 'other.md'); await writeFile(other, 'Other'); await f.registry.open(other, 1); request.snapshot = { ...request.snapshot, docId: f.registry.current!.document.docId, epoch: f.registry.current!.document.epoch }; request.expectedDiskToken = f.registry.current!.document.diskToken }
  expect(await f.restore(request, async () => true, kind === 'owner' ? 2 : 1)).toMatchObject({ status: 'error', preservedCurrent: null, diskUncertain: false })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffA\r\n'); expect(f.renderer.snapshot().text).toBe('B\n')
})

test('equal logical historical text is a validated no-op and does not disable later autosave', async () => {
  const f = await fixture({ historical: Buffer.from('B\n') })
  expect(await f.restore()).toMatchObject({ status: 'ok', value: { kind: 'unchanged', revision: 1 } })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffA\r\n')
  expect((await f.saves.save({ requestId: randomUUID(), snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'auto' }, 1)).status).toBe('ok')
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffB\r\n')
})

test('restore gate rejects competing lifecycle/clear/saveAs and allows another document to save', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred()
  const other = join(f.root, 'other.md'); await writeFile(other, 'other'); await f.registry.open(other, 1); const s = f.registry.current!
  const restoring = f.restore(f.request, async () => { entered.resolve(); await release.promise; return true }); await entered.promise
  const lifecycle = new FileLifecycle(f.registry, f.saves, { choosePath: async () => join(f.root, 'copy.md'), confirm: async () => true })
  try {
    expect((await f.restore({ ...f.request, requestId: randomUUID() })).status).toBe('error')
    expect((await lifecycle.reconcileExternal({ ref: f.session.document, snapshot: f.request.snapshot }, 1)).status).not.toBe('ok')
    expect((await lifecycle.resolveConflict(f.session.document, 'overwrite', f.request.snapshot, 1)).status).not.toBe('ok')
    expect((await lifecycle.saveAs({ requestId: randomUUID(), snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'manual' }, 1)).status).not.toBe('ok')
    await expect(f.history.clear()).rejects.toMatchObject({ appError: { code: 'FILE_BUSY' } })
    expect((await f.saves.save({ requestId: randomUUID(), snapshot: { docId: s.document.docId, epoch: s.document.epoch, revision: 1, text: 'other edit' }, expectedDiskToken: s.document.diskToken, trigger: 'manual' }, 1)).status).toBe('ok')
    expect(await readFile(other, 'utf8')).toBe('other edit')
  } finally { release.resolve() }
  expect((await restoring).status).toBe('ok'); expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
})

test('already accepted autosave settles before restore and later old-chain save is refused', async () => {
  const writing = deferred(); const release = deferred(); let once = true
  const f = await fixture({ writer: async (path, bytes, check) => { if (once) { once = false; writing.resolve(); await release.promise }; return atomicWrite(path, bytes, check) } })
  const auto = f.saves.save({ requestId: randomUUID(), snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'auto' }, 1); await writing.promise
  const restoring = f.restore()
  const late = await f.saves.save({ requestId: randomUUID(), snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'auto' }, 1)
  expect(late.status).not.toBe('ok'); release.resolve()
  expect((await auto).status).toBe('ok'); expect(await restoring).toMatchObject({ status: 'ok', value: { kind: 'restored', preservedCurrent: null } })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n'); expect(await historyTexts(f)).toContain('\ufeffB\r\n')
})

test('native cleanup confirmation holds a gate that rejects restoration until cleanup completes', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred()
  const clearing = f.history.clearConfirmed(async () => { entered.resolve(); await release.promise; return true }); await entered.promise
  try { expect(await f.restore()).toMatchObject({ status: 'error', error: { code: 'FILE_BUSY' } }); expect(await readFile(f.path, 'utf8')).toBe('\ufeffA\r\n') }
  finally { release.resolve() }
  expect(await clearing).toBe(true); expect((await f.history.list(f.session)).entries).toEqual([])
})

test('single and whole-window close retain all sessions during restore and close admission blocks restore in reverse', async () => {
  const { CloseCoordinator } = await import('../../src/main/documents/close-coordinator')
  const { WorkspaceCloseCoordinator } = await import('../../src/main/documents/workspace-close-coordinator')
  const f = await fixture(); const events: import('../../src/shared/contracts').AppEvent[] = []
  const close = new CloseCoordinator(f.registry, e => events.push(e), async () => 'cancel', f.saves, f.recovery)
  const workspace = new WorkspaceCloseCoordinator(f.registry, 1, e => events.push(e), close, f.saves, f.recovery)
  const entered = deferred(); const release = deferred()
  const restoring = workspace.lifecycle(f.session.document, () => f.restore(f.request, async () => { entered.resolve(); await release.promise; return true })); await entered.promise
  try {
    expect(await workspace.closeDocument(f.session.document)).toEqual({ status: 'cancelled' }); expect(await workspace.closeWindow()).toBe(false)
    expect(f.registry.has(f.session)).toBe(true); expect(events.some(e => e.type === 'document-closed')).toBe(false)
  } finally { release.resolve() }
  expect((await restoring).status).toBe('ok')
  const closing = workspace.closeDocument(f.session.document)
  expect(await workspace.lifecycle(f.session.document, () => f.restore({ ...f.request, requestId: randomUUID() }))).toEqual({ status: 'cancelled' })
  close.finish(); await closing; expect(f.registry.has(f.session)).toBe(true)
})

test('UUID identity includes operation kind and the shared completion cache remains bounded', async () => {
  const f = await fixture({ historical: Buffer.from('B\n') })
  expect((await f.restore()).status).toBe('ok')
  expect(await f.saves.save({ requestId: f.request.requestId, snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'manual' }, 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  const saveId = randomUUID()
  expect((await f.saves.save({ requestId: saveId, snapshot: f.request.snapshot, expectedDiskToken: f.request.expectedDiskToken, trigger: 'manual' }, 1)).status).toBe('ok')
  expect(await f.restore({ ...f.request, requestId: saveId })).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  for (let i = 0; i < 260; i++) expect((await f.restore({ ...f.request, requestId: randomUUID(), expectedDiskToken: f.session.document.diskToken })).status).toBe('ok')
  const queue = (Reflect.get(f.saves, 'queues') as WeakMap<object, { requests: Map<string, unknown>; tokens: Set<string> }>).get(f.session)!
  expect(queue.requests.size).toBeLessThanOrEqual(256); expect(queue.tokens.size).toBeLessThanOrEqual(257)
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffB\r\n')
})

test('unconfirmed presave replacement retains B and A backup without claiming a preserved receipt', async () => {
  const f = await fixture({ writer: async (path, bytes, check) => { await atomicWrite(path, bytes, check); throw new Error('directory fsync failed after rename') } })
  expect(await f.restore()).toMatchObject({ status: 'error', preservedCurrent: null, diskUncertain: true })
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffB\r\n'); expect(f.renderer.snapshot().text).toBe('B\n'); expect(await historyTexts(f)).toContain('\ufeffA\r\n')
  const [draft] = await f.recovery.list(); expect(await f.recovery.inspect(draft!.id)).toBe('B\n'); expect(f.session.diskStatus).toBe('changed')
})

test('historical final newline is used independently of the current BOM and CRLF', async () => {
  const f = await fixture({ historical: Buffer.from('旧版\n没有结尾换行') })
  expect((await f.restore()).status).toBe('ok'); expect(await readFile(f.path, 'utf8')).toBe('\ufeff旧版\r\n没有结尾换行')
})

test('useWorkspace waits for composition, freezes the real session and accepts the real restore transaction', async () => {
  const { createSSRApp, ref } = await import('vue'); const { renderToString } = await import('vue/server-renderer')
  const { useWorkspace } = await import('../../src/renderer/src/documents/use-workspace')
  const f = await fixture(); const composition = deferred(); const confirming = deferred(); const releaseConfirm = deferred()
  const formerWindow = Reflect.get(globalThis, 'window')
  Reflect.set(globalThis, 'window', { inknest: { onEvent: () => () => {}, checkpoint: (snapshot: import('../../src/shared/contracts').ContentSnapshot) => f.recovery.checkpoint(f.session, snapshot), restoreHistory: (request: HistoryRestoreRequest) => f.restore(request, async () => { confirming.resolve(); await releaseConfirm.promise; return true }) } })
  let controller!: ReturnType<typeof useWorkspace>
  try {
    await renderToString(createSSRApp({ setup() { controller = useWorkspace(ref({ settleComposition: async () => { await composition.promise; return true }, setFrozen: () => {} })); return () => null } }))
    controller.workspace.install({ ...f.session.document }); const session = controller.session.value!
    session.dispatch({ changes: { from: 0, to: session.state.doc.length, insert: 'B\n' } })
    const restoring = controller.restoreHistory(f.selected)
    expect(session.frozen).toBe(false); expect(f.saves.isRestoring(f.session)).toBe(false); expect(await readFile(f.path, 'utf8')).toBe('\ufeffA\r\n')
    composition.resolve(); await confirming.promise
    expect(session.frozen).toBe(true); expect(f.saves.isRestoring(f.session)).toBe(true)
    session.dispatch({ changes: { from: 0, insert: 'blocked' } }); expect(session.snapshot().text).toBe('B\n')
    releaseConfirm.resolve(); expect(await restoring).toBe(true)
    expect(session.frozen).toBe(false); expect(session.snapshot()).toMatchObject({ text: 'C\n', revision: 2 }); expect(session.dirty).toBe(false); expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
  } finally { composition.resolve(); releaseConfirm.resolve(); controller?.workspace.dispose(); if (formerWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else Reflect.set(globalThis, 'window', formerWindow) }
})

test('lost successful restore reply can be replayed exactly before unchanged-buffer conflict and Save As rescue', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const actions = await import('../../src/renderer/src/documents/history-actions')
  const f = await fixture(); const workspace = new WorkspaceModel(); workspace.install({ ...f.session.document })
  const tab = workspace.getTab(f.session.document)!; const renderer = tab.session!
  renderer.dispatch({ changes: { from: 0, to: renderer.state.doc.length, insert: 'B\n' } }); tab.frozen = true; renderer.setFrozen(true)
  let captured!: HistoryRestoreRequest
  expect(await actions.restoreHistory(workspace, tab, f.selected, async request => {
    captured = structuredClone(request)
    expect((await f.saves.restoreHistory(request, 1, f.history, async () => true)).status).toBe('ok')
    throw new Error('successful IPC response lost')
  })).toBe(false)
  expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n'); expect(f.session.latestSnapshot).toMatchObject({ revision: 2, text: 'C\n' })
  expect(renderer.snapshot()).toMatchObject({ revision: 1, text: 'B\n' }); expect(await historyTexts(f)).toContain('\ufeffB\r\n')
  expect(await f.saves.save({ requestId: randomUUID(), snapshot: renderer.snapshot(), expectedDiskToken: captured.expectedDiskToken, trigger: 'auto' }, 1)).toMatchObject({ status: 'error' })
  expect(actions.retryHistoryRestoreReceipt).toBeTypeOf('function')
  expect(await actions.retryHistoryRestoreReceipt(workspace, tab, async request => {
    expect(request).toEqual(captured)
    return f.saves.restoreHistory(request, 1, f.history, async () => { throw new Error('replay must not confirm again') })
  })).toBe(true)
  expect(renderer.snapshot()).toMatchObject({ revision: 2, text: 'C\n' }); expect(renderer.dirty).toBe(false)
  const destination = join(f.root, 'rescued.md'); const lifecycle = new FileLifecycle(f.registry, f.saves, { choosePath: async () => destination, confirm: async () => true })
  expect(await lifecycle.resolveConflict(renderer.document, 'inspect', renderer.snapshot(), 1)).toMatchObject({ status: 'ok', value: { kind: 'inspection', text: 'C\n' } })
  // A real undo, not a synthetic revision bump, recovers protected B for a separate copy.
  const { undo } = await import('@codemirror/commands'); renderer.setFrozen(false)
  expect(undo({ state: renderer.state, dispatch: transaction => renderer.apply([transaction]) })).toBe(true)
  expect(renderer.snapshot()).toMatchObject({ revision: 3, text: 'B\n' })
  expect((await lifecycle.saveAs({ requestId: randomUUID(), snapshot: renderer.snapshot(), expectedDiskToken: renderer.document.diskToken, trigger: 'manual' }, 1)).status).toBe('ok')
  expect(await readFile(destination, 'utf8')).toBe('\ufeffB\r\n'); expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
  workspace.dispose()
})

test('registered restore receipt remains replayable through the real IPC handler during close admission', async () => {
  const { CloseCoordinator } = await import('../../src/main/documents/close-coordinator')
  const { WorkspaceCloseCoordinator } = await import('../../src/main/documents/workspace-close-coordinator')
  const { ResourceService } = await import('../../src/main/security/resource-protocol')
  const f = await fixture(); const original = await f.restore(); expect(original.status).toBe('ok')
  const close = new CloseCoordinator(f.registry, () => {}, async () => 'cancel', f.saves, f.recovery)
  const workspaceClose = new WorkspaceCloseCoordinator(f.registry, 1, () => {}, close, f.saves, f.recovery)
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  // Only Electron's native IPC registration/window shell is substituted; admission,
  // cached receipt, restore, registry and temporary filesystem are production objects.
  vi.doMock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }, dialog: { showMessageBox: () => { throw new Error('replay opened native confirmation') } } }))
  const frame = { url: 'inknest://app/' }; const sender = { id: 1, mainFrame: frame, send: () => {} }
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isFullScreen: () => false, setFullScreen: () => {} })
  const presentation = new PresentationController(window, ref => f.registry.matches(ref, 1), () => workspaceClose.active, () => {})
  const { registerDocumentHandlers } = await import('../../src/main/ipc/handlers')
  registerDocumentHandlers(window as unknown as import('electron').BrowserWindow, f.registry, new ResourceService(f.registry), workspaceClose, f.saves, f.recovery, f.history, presentation)
  const closing = workspaceClose.closeWindow()
  try {
    expect(workspaceClose.isBlocked(f.session.document)).toBe(true)
    const restore = handlers.get('backup:restore-history')!
    expect(await restore({ sender, senderFrame: frame }, f.request)).toEqual(original)
    expect(await restore({ sender, senderFrame: frame }, { ...f.request, requestId: randomUUID() })).toEqual({ status: 'cancelled' })
    expect(await restore({ sender, senderFrame: frame }, { ...f.request, expectedContentHash: '0'.repeat(64) })).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
    expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
  } finally { close.finish(); await closing; window.emit('closed'); vi.doUnmock('electron') }
})

test('controller retains edit-only uncertainty while another tab activates/saves and repeated retries use one receipt', async () => {
  const { createSSRApp, ref } = await import('vue'); const { renderToString } = await import('vue/server-renderer')
  const { useWorkspace } = await import('../../src/renderer/src/documents/use-workspace')
  const f = await fixture(); const otherPath = join(f.root, 'other.md'); await writeFile(otherPath, 'Other'); await f.registry.open(otherPath, 1); const other = f.registry.current!
  const originalWindow = Reflect.get(globalThis, 'window'); const requests: HistoryRestoreRequest[] = []; let lost = 2
  Reflect.set(globalThis, 'window', { inknest: {
    onEvent: () => () => {}, checkpoint: async (snapshot: import('../../src/shared/contracts').ContentSnapshot) => ({ status: 'ok', value: await f.recovery.checkpoint(f.registry.get(snapshot, 1)!, snapshot) }),
    restoreHistory: async (request: HistoryRestoreRequest) => { requests.push(structuredClone(request)); const result = await f.saves.restoreHistory(request, 1, f.history, async () => true); if (lost-- > 0) throw new Error('lost after commit'); return result },
    activateDocument: async (ref: import('../../src/shared/contracts').SessionRef) => { f.registry.activate(ref, 1); return { status: 'ok', value: undefined } },
    save: (request: import('../../src/shared/contracts').SaveRequest) => f.saves.save(request, 1)
  } })
  let controller!: ReturnType<typeof useWorkspace>
  try {
    await renderToString(createSSRApp({ setup() { controller = useWorkspace(ref({ settleComposition: async () => true, setFrozen: () => {} })); return () => null } }))
    controller.workspace.register({ ...other.document }); controller.workspace.install({ ...f.session.document }); const source = controller.session.value!
    source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: 'B\n' } })
    expect(await controller.restoreHistory(f.selected)).toBe(false)
    expect(controller.historyRestorePending.value?.ref.docId).toBe(f.session.document.docId); expect(controller.frozen.value).toBe(false); expect(controller.editingFrozen.value).toBe(true)
    source.dispatch({ changes: { from: 0, insert: 'blocked' } }); expect(source.snapshot()).toMatchObject({ text: 'B\n', revision: 1 })
    await controller.activate(other.document); expect(controller.tab.value!.document.docId).toBe(other.document.docId); expect(controller.editingFrozen.value).toBe(false)
    controller.session.value!.dispatch({ changes: { from: 0, to: 5, insert: 'Other saved' } }); await controller.save(); expect(await readFile(otherPath, 'utf8')).toBe('Other saved')
    expect(await controller.retryHistoryRestoreReceipt()).toBe(false); expect(source.snapshot().text).toBe('B\n'); expect(source.frozen).toBe(true)
    expect(await controller.retryHistoryRestoreReceipt()).toBe(true); expect(source.snapshot()).toMatchObject({ text: 'C\n', revision: 2 }); expect(source.frozen).toBe(false)
    expect(controller.historyRestorePending.value).toBeNull(); expect(requests).toHaveLength(3); expect(requests[1]).toEqual(requests[0]); expect(requests[2]).toEqual(requests[0])
    const lifecycle = new FileLifecycle(f.registry, f.saves, { choosePath: async () => null, confirm: async () => true })
    expect(await lifecycle.resolveConflict(source.document, 'use-disk', source.snapshot(), 1)).toMatchObject({ status: 'ok', value: { kind: 'opened', document: { text: 'C\n' } } })
    expect(await readFile(f.path, 'utf8')).toBe('\ufeffC\r\n')
  } finally { controller?.workspace.dispose(); if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else Reflect.set(globalThis, 'window', originalWindow) }
})
