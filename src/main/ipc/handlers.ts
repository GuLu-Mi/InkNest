import { registerLinkHandlers } from './links'
import { hasWindowDialog, runWindowDialog } from '../window-dialogs'
import { join } from 'node:path'
import type { PresentationController } from '../presentation-controller'
import { copy } from '../../shared/copy'
import type { RecoveryStore } from '../documents/recovery-store'
import type { HistoryStore } from '../documents/history-store'
import { BackupCoordinator } from '../documents/backup-coordinator'
import { fail } from '../documents/reader'
import { validPresentationArgs, validCheckpointArgs, validRecordIdArgs, validHistoryArgs, validHistoryRestoreArgs } from './validation'
import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { OpenDocument, Result } from '../../shared/contracts'
import { FileLifecycle } from '../documents/file-lifecycle'
import { DirectoryWatcher } from '../documents/watcher'
import { SaveCoordinator } from '../documents/save-coordinator'
import { WorkspaceCloseCoordinator } from '../documents/workspace-close-coordinator'
import { DocumentRegistry } from '../documents/registry'
import { safeError } from '../documents/reader'
import { ResourceService } from '../security/resource-protocol'
import { isTrustedCaller, validActivateArgs, validConflictArgs, validReconcileArgs, validCloseArgs, validResourceArgs, validSaveArgs } from './validation'

const invalid: Result<never> = { status: 'error', error: { code: 'INVALID_REQUEST', message: copy.invalidRequest, retryable: false } }
export interface DocumentHost { ready: Promise<void>; openSystemFiles(paths: string[]): Promise<void> }
export function registerDocumentHandlers(window: BrowserWindow, registry: DocumentRegistry, resources: ResourceService, close: WorkspaceCloseCoordinator, saves: SaveCoordinator, recovery: RecoveryStore, history: HistoryStore, presentation: PresentationController, developmentUrl?: string): DocumentHost {
  let rendererReady!: () => void
  const ready = new Promise<void>(resolve => { rendererReady = resolve })
  ipcMain.handle('document:renderer-ready', (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || args.length) return invalid
    rendererReady()
    return { status: 'ok', value: undefined }
  })
  ipcMain.handle('window:presentation', (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validPresentationArgs(args)) return invalid
    return presentation.set(args[0])
  })
  const watcher = new DirectoryWatcher(registry, event => { if (!window.isDestroyed()) window.webContents.send('document:event', event) })
  registerLinkHandlers(window, registry, resources, close, () => watcher.sync(window.webContents.id), developmentUrl)
  close.onRelease(() => { watcher.sync(window.webContents.id); presentation.checkSource() })
  const lifecycle = new FileLifecycle(registry, saves, {
    choosePath: async (name, initial) => {
      const result = await runWindowDialog(window, () => dialog.showSaveDialog(window, { title: initial ? copy.initialSaveTitle : copy.saveAsTitle, defaultPath: initial ? join(registry.suggestedDirectory ?? app.getPath('documents'), name) : name, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }))
      return result.canceled || !result.filePath || window.isDestroyed() ? null : result.filePath
    },
    confirm: async (kind, name, modifiedAt) => {
      const messages = {
        replace: [copy.replaceQuestion(name), copy.replaceDetail, copy.replace],
        directory: [copy.directoryChange, copy.directoryChangeDetail, copy.continueSaveAs],
        overwrite: [copy.overwriteQuestion(name), copy.overwriteDetail, copy.overwrite],
        'use-disk': [copy.useDiskQuestion, copy.useDiskDetail, copy.useDisk]
      } as const
      const [message, detail, button] = messages[kind]
      const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message, detail: modifiedAt ? copy.diskModifiedDetail(detail, modifiedAt) : detail, buttons: [copy.cancel, button], defaultId: 0, cancelId: 0, noLink: true }))
      return result.response === 1 && !window.isDestroyed()
    }
  }, recovery)
  close.configureUntitled({
    choose: async name => {
      const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'question', message: copy.untitledCloseQuestion(name), detail: copy.untitledCloseDetail, buttons: [copy.initialSave, copy.dontSave, copy.cancel], defaultId: 2, cancelId: 2, noLink: true }))
      return window.isDestroyed() ? 'cancel' : result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel'
    },
    save: async (request, ownerId) => { try { return await lifecycle.saveAs(request, ownerId) } finally { watcher.sync(ownerId) } }
  })
  const backups = new BackupCoordinator(registry, saves, recovery, history, {
    choosePath: async name => { const result = await runWindowDialog(window, () => dialog.showSaveDialog(window, { title: copy.exportHistoryTitle, defaultPath: name, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })); return result.canceled || !result.filePath || window.isDestroyed() ? null : result.filePath },
    confirm: async (kind, name) => { const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message: kind === 'directory' ? copy.directoryChange : copy.replaceQuestion(name), detail: kind === 'directory' ? copy.directoryChangeDetail : copy.exportHistoryDetail, buttons: [copy.cancel, kind === 'directory' ? copy.continueSaveAs : copy.replace], defaultId: 0, cancelId: 0, noLink: true })); return result.response === 1 && !window.isDestroyed() }
  })
  const backupChannels: string[] = []
  function backupHandle(channel: string, validate: (args: unknown[]) => boolean, operation: (args: unknown[], ownerId: number) => Promise<unknown>): void {
    backupChannels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validate(args)) return invalid
      if (close.active && channel !== 'backup:checkpoint') return { status: 'cancelled' }
      try { return { status: 'ok', value: await operation(args, event.sender.id) } } catch (error) { return { status: 'error', error: safeError(error) } }
    })
  }
  const getSession = (ref: unknown, ownerId: number) => { const session = registry.get(ref as import('../../shared/contracts').SessionRef, ownerId); if (!session) fail('STALE_SESSION', copy.staleSession); return session }
  backupHandle('backup:checkpoint', validCheckpointArgs, async (args, ownerId) => {
    const snapshot = args[0] as import('../../shared/contracts').ContentSnapshot
    const session = getSession(snapshot, ownerId)
    saves.assertAvailable(session)
    const result = await recovery.checkpoint(session, snapshot)
    if (!window.isDestroyed()) window.webContents.send('document:event', { type: 'recovery-status', ref: { docId: snapshot.docId, epoch: snapshot.epoch }, revision: result.revision, state: 'backed-up' })
    return result
  })
  backupHandle('backup:list-recovery', args => args.length === 0, () => recovery.list())
  backupHandle('backup:inspect-recovery', validRecordIdArgs, args => recovery.inspect(args[0] as string))
  backupHandle('backup:restore-recovery', validRecordIdArgs, async (args, ownerId) => {
    const result = await close.admission(() => backups.restore(args[0] as string, ownerId))
    watcher.sync(ownerId)
    if (result.status === 'error') {
      if (result.error.code === 'TARGET_OPEN' && registry.current) window.webContents.send('document:event', { type: 'document-activated', ref: { docId: registry.current.document.docId, epoch: registry.current.document.epoch } })
      fail(result.error.code, result.error.message)
    }
    if (result.status !== 'ok') fail('RECOVERY_FAILED', copy.restoreIncomplete)
    window.webContents.send('document:event', { type: 'document-opened', document: result.value })
    const session = registry.get(result.value, ownerId)!
    if (session.diskStatus !== 'current') window.webContents.send('document:event', { type: 'external-change', ref: { docId: result.value.docId, epoch: result.value.epoch }, diskStatus: session.diskStatus })
    return result.value
  })
  async function confirmCleanup(message: string): Promise<boolean> { const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message, detail: copy.cleanupDetail, buttons: [copy.cancel, copy.cleanup], defaultId: 0, cancelId: 0, noLink: true })); return result.response === 1 && !window.isDestroyed() }
  // Keep cancellation a Result, not a successful cleanup receipt.
  for (const channel of ['backup:discard-recovery', 'backup:clear', 'backup:export-history']) {
    backupChannels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const valid = channel === 'backup:discard-recovery' ? validRecordIdArgs(args) : channel === 'backup:export-history' ? validHistoryArgs(args) : args.length === 1 && ['recovery', 'history'].includes(args[0] as string)
      if (!isTrustedCaller(event, window.webContents, developmentUrl) || !valid) return invalid
      if (close.active) return { status: 'cancelled' }
      try {
        if (channel === 'backup:export-history') return backups.exportHistory(args[0] as import('../../shared/contracts').SessionRef, args[1] as string, event.sender.id)
        if (channel === 'backup:clear' && args[0] === 'history') {
          const cleared = await history.clearConfirmed(() => confirmCleanup(copy.cleanupQuestion))
          return cleared ? { status: 'ok', value: undefined } : { status: 'cancelled' }
        }
        if (!await confirmCleanup(channel === 'backup:clear' ? copy.cleanupQuestion : copy.discardDraftQuestion)) return { status: 'cancelled' }
        if (channel === 'backup:discard-recovery') await recovery.discard(args[0] as string)
        else if (args[0] === 'recovery') await recovery.clear()
        else await history.clear()
        return { status: 'ok', value: undefined }
      } catch (error) { return { status: 'error', error: safeError(error) } }
    })
  }
  backupHandle('backup:list-history', validActivateArgs, (args, ownerId) => history.list(getSession(args[0], ownerId)))
  backupHandle('backup:inspect-history', validHistoryArgs, async (args, ownerId) => {
    const session = getSession(args[0], ownerId)
    const snapshot = await history.inspect(session, args[1] as string)
    if (getSession(args[0], ownerId) !== session) fail('STALE_SESSION', copy.staleSession)
    return snapshot
  })
  backupChannels.push('backup:restore-history')
  ipcMain.handle('backup:restore-history', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validHistoryRestoreArgs(args)) return { ...invalid, preservedCurrent: null, diskUncertain: false }
    const replay = saves.replayHistoryRestore(args[0], event.sender.id)
    if (replay) return replay
    if (close.isBlocked(args[0].snapshot)) return { status: 'cancelled' }
    return close.lifecycle(args[0].snapshot, () => saves.restoreHistory(args[0], event.sender.id, history, async () => {
      const source = registry.get(args[0].snapshot, event.sender.id)
      if (!source) return false
      const entry = (await history.list(source)).entries.find(entry => entry.id === args[0].historyId)
      if (!entry) return false
      const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message: copy.restoreHistoryQuestion(entry.savedAt), detail: copy.restoreHistoryDetail, buttons: [copy.cancel, copy.restoreHistory], defaultId: 0, cancelId: 0, noLink: true }))
      return result.response === 1 && !window.isDestroyed()
    }))
  })
  window.on('focus', () => { if (!close.active) watcher.checkAll(window.webContents.id) })
  let opening = false
  ipcMain.handle('document:create', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || args.length) return invalid
    if (opening || close.active || presentation.active || hasWindowDialog(window) || registry.list(event.sender.id).some(session => saves.isRestoring(session))) return { status: 'error', error: { code: 'FILE_BUSY', message: copy.processingWait, retryable: true } }
    return close.admission(async () => {
      if (window.isDestroyed() || close.active) return { status: 'cancelled' }
      const result = registry.create(event.sender.id)
      if (result.status === 'ok') window.webContents.send('document:event', { type: 'document-created', document: result.value })
      return result
    })
  })
  async function openPath(path: string, system: boolean): Promise<Result<OpenDocument>> {
    if (window.isDestroyed()) return { status: 'cancelled' }
    if (close.active) return { status: 'error', error: { code: 'FILE_BUSY', message: copy.closingWait, retryable: true } }
    const result = await close.admission(() => registry.open(path, window.webContents.id, () => !window.isDestroyed() && !close.active))
    if (window.isDestroyed()) return { status: 'cancelled' }
    watcher.sync(window.webContents.id)
    if (result.status === 'ok') window.webContents.send('document:event', { type: system ? 'system-document-opened' : 'document-opened', document: result.value })
    return result
  }
  async function openSystemFiles(paths: string[]): Promise<void> {
    if (!paths.length || window.isDestroyed()) return
    let result: Result<OpenDocument>
    if (opening || close.active) result = { status: 'error', error: { code: 'FILE_BUSY', message: close.active ? copy.closingWait : copy.openingWait, retryable: true } }
    else {
      opening = true
      try {
        let path = paths[0]!
        if (paths.length > 1) {
          const selected = await runWindowDialog(window, () => dialog.showMessageBox(window, {
            type: 'question', message: copy.chooseSystemDocument, detail: copy.chooseSystemDocumentDetail,
            buttons: [copy.cancel, ...paths], defaultId: 0, cancelId: 0, noLink: true
          }))
          if (selected.response < 1 || selected.response > paths.length) return
          path = paths[selected.response - 1]!
        }
        result = await openPath(path, true)
      } catch (error) { result = { status: 'error', error: safeError(error) } }
      finally { opening = false }
    }
    if (result.status === 'error' && !window.isDestroyed()) await runWindowDialog(window, () => dialog.showMessageBox(window, {
      type: 'error', message: copy.openFailed, detail: result.error.message, buttons: [copy.acknowledge]
    }))
  }
  ipcMain.handle('document:open', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || args.length) return invalid
    if (opening || close.windowActive) return { status: 'error', error: { code: 'FILE_BUSY', message: copy.openingWait, retryable: true } }
    opening = true
    try {
      const selected = await runWindowDialog(window, () => dialog.showOpenDialog(window, { title: copy.openDocument, properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }))
      if (selected.canceled || selected.filePaths.length !== 1) return { status: 'cancelled' }
      if (window.isDestroyed() || close.active) return { status: 'cancelled' }
      return await openPath(selected.filePaths[0]!, false)
    } catch (error) { return { status: 'error', error: safeError(error) } }
    finally { opening = false }
  })
  ipcMain.handle('document:activate', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validActivateArgs(args)) return invalid
    if (opening || close.windowActive) return { status: 'error', error: { code: 'FILE_BUSY', message: copy.processingWait, retryable: true } }
    if (!registry.activate(args[0], event.sender.id)) return { status: 'error', error: { code: 'STALE_SESSION', message: copy.staleSession, retryable: false } }
    window.webContents.send('document:event', { type: 'document-activated', ref: args[0] })
    watcher.sync(event.sender.id); void watcher.check(registry.get(args[0], event.sender.id)!)
    return { status: 'ok', value: undefined }
  })
  ipcMain.handle('document:save', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validSaveArgs(args) || args[0].trigger === 'close') return invalid
    if (close.isBlocked(args[0].snapshot) && args[0].trigger === 'auto') return { status: 'cancelled' }
    if (close.isBlocked(args[0].snapshot)) return { status: 'error', error: { code: 'FILE_BUSY', message: copy.closingWait, retryable: true } }
    return saves.save(args[0], event.sender.id)
  })
  ipcMain.handle('document:save-as', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validSaveArgs(args) || args[0].trigger !== 'manual') return invalid
    if (close.active) return { status: 'cancelled' }
    try { return await close.lifecycle(args[0].snapshot, () => lifecycle.saveAs(args[0], event.sender.id)) } finally { watcher.sync(event.sender.id); presentation.checkSource() }
  })
  ipcMain.handle('document:reconcile', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validReconcileArgs(args)) return invalid
    if (close.isBlocked(args[0].ref)) return { status: 'cancelled' }
    try { return await close.lifecycle(args[0].ref, () => lifecycle.reconcileExternal(args[0], event.sender.id)) } finally { watcher.sync(event.sender.id); presentation.checkSource() }
  })
  ipcMain.handle('document:conflict', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validConflictArgs(args)) return invalid
    if (close.active) return { status: 'cancelled' }
    try { return await close.lifecycle(args[0], () => lifecycle.resolveConflict(...args, event.sender.id)) } finally { watcher.sync(event.sender.id); presentation.checkSource() }
  })
  ipcMain.handle('document:close', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validActivateArgs(args)) return invalid
    return close.closeDocument(args[0])
  })
  ipcMain.handle('document:complete-close', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validCloseArgs(args)) return invalid
    return close.complete(...args)
  })
  ipcMain.handle('document:resources', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validResourceArgs(args)) return invalid
    const [ref, refs] = args
    const session = registry.get(ref, event.sender.id)
    if (!session) return { status: 'error', error: { code: 'STALE_SESSION', message: copy.staleSession, retryable: false } }
    return { status: 'ok', value: await resources.resolve(session, refs) }
  })
  window.on('closed', () => {
    rendererReady()
    ipcMain.removeHandler('document:renderer-ready')
    presentation.dispose()
    ipcMain.removeHandler('window:presentation')
    for (const channel of backupChannels) ipcMain.removeHandler(channel)
    watcher.dispose()
    close.finish()
    registry.close()
    ipcMain.removeHandler('document:save-as')
    ipcMain.removeHandler('document:reconcile')
    ipcMain.removeHandler('document:conflict')
    ipcMain.removeHandler('document:open')
    ipcMain.removeHandler('document:create')
    ipcMain.removeHandler('document:save')
    ipcMain.removeHandler('document:activate')
    ipcMain.removeHandler('document:close')
    ipcMain.removeHandler('document:complete-close')
    ipcMain.removeHandler('document:resources')
  })
  return { ready, openSystemFiles }
}
