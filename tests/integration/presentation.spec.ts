import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { RecoveryStore } from '../../src/main/documents/recovery-store'
import { HistoryStore } from '../../src/main/documents/history-store'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { CloseCoordinator } from '../../src/main/documents/close-coordinator'
import { WorkspaceCloseCoordinator } from '../../src/main/documents/workspace-close-coordinator'
import { ResourceService } from '../../src/main/security/resource-protocol'
import { PresentationController } from '../../src/main/presentation-controller'
import { hasWindowDialog, runWindowDialog } from '../../src/main/window-dialogs'
import type { AppEvent } from '../../src/shared/contracts'
test('fixed presentation IPC enforces frame/owner/schema, native dialog admission and accepts old-ref exit only for its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-presentation-ipc-')); const path = join(root, 'source.md'); await writeFile(path, '# source')
  const registry = new DocumentRegistry(); const opened = await registry.open(path, 1); if (opened.status !== 'ok') throw new Error('fixture failed')
  const recovery = new RecoveryStore(join(root, 'recovery'), registry); const history = new HistoryStore(join(root, 'history')); const saves = new SaveCoordinator(registry)
  const events: AppEvent[] = []; const send = (event: AppEvent) => events.push(event)
  const close = new CloseCoordinator(registry, send, async () => 'cancel', saves, recovery)
  const workspaceClose = new WorkspaceCloseCoordinator(registry, 1, send, close, saves, recovery)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  vi.doMock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), removeHandler: (channel: string) => handlers.delete(channel) }, dialog: {} }))
  const frame = { url: 'inknest://app/' }; const sender = { id: 1, mainFrame: frame, send: (_channel: string, event: AppEvent) => send(event) }
  let fullscreen = false
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isFullScreen: () => fullscreen, setFullScreen: () => {} })
  const controller = new PresentationController(window, ref => registry.matches(ref, 1), () => hasWindowDialog(window) || workspaceClose.active, send)
  const { registerDocumentHandlers } = await import('../../src/main/ipc/handlers')
  registerDocumentHandlers(window as unknown as import('electron').BrowserWindow, registry, new ResourceService(registry), workspaceClose, saves, recovery, history, controller)
  try {
    const invoke = handlers.get('window:presentation')!; const caller = { sender, senderFrame: frame }; const ref = { docId: opened.value.docId, epoch: opened.value.epoch }; const request = { requestId: randomUUID(), ref, enabled: true }
    for (const invalidCaller of [{ sender: { ...sender }, senderFrame: frame }, { sender, senderFrame: { ...frame } }]) expect(await invoke(invalidCaller, request)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
    expect(await invoke(caller, { ...request, force: true })).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
    expect(await invoke(caller, { ...request, ref: { ...ref, epoch: randomUUID() } })).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
    await runWindowDialog(window, async () => { expect(await invoke(caller, request)).toMatchObject({ status: 'error', error: { code: 'FILE_BUSY' } }) })
    expect(await invoke(caller, request)).toEqual({ status: 'ok', value: undefined }); expect(events).toEqual([])
    fullscreen = true; window.emit('enter-full-screen'); expect(events.at(-1)).toMatchObject({ type: 'presentation-state', enabled: true, fullscreen: true })
    registry.release(ref, 1)
    expect(await invoke(caller, { requestId: randomUUID(), ref: { ...ref, epoch: randomUUID() }, enabled: false })).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
    expect(await invoke(caller, { requestId: randomUUID(), ref, enabled: false })).toEqual({ status: 'ok', value: undefined })
    fullscreen = false; window.emit('leave-full-screen'); expect(events.at(-1)).toMatchObject({ enabled: false, fullscreen: false })
  } finally { window.emit('closed'); vi.doUnmock('electron'); await rm(root, { recursive: true, force: true }) }
  expect(handlers.has('window:presentation')).toBe(false)
})
