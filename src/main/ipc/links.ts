import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { DocumentRegistry } from '../documents/registry'
import type { ResourceService } from '../security/resource-protocol'
import type { WorkspaceCloseCoordinator } from '../documents/workspace-close-coordinator'
import { LinkRouter } from '../documents/link-router'
import { isTrustedCaller, validLinkArgs } from './validation'
export function registerLinkHandlers(window: BrowserWindow, registry: DocumentRegistry, resources: ResourceService, close: WorkspaceCloseCoordinator, sync: () => void, developmentUrl?: string): void {
  let opening = false
  const router = new LinkRouter(registry, resources, {
    blocked: () => window.isDestroyed() || close.active,
    external: url => shell.openExternal(url), directory: path => shell.openPath(path), reveal: path => shell.showItemInFolder(path)
  })
  ipcMain.handle('document:link', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || !validLinkArgs(args)) return { status: 'error', error: { code: 'INVALID_REQUEST', message: '无效的链接请求', retryable: false } }
    if (opening || close.active) return { status: 'cancelled' }
    opening = true
    const request = args[0]
    try {
      const result = await close.admission(() => router.open(request.ref, request.rawTarget, window.webContents.id))
      sync()
      if (result.status === 'ok' && result.value.kind === 'document' && !window.isDestroyed()) window.webContents.send('document:event', { type: 'link-opened', requestId: request.requestId, document: result.value.document })
      return result
    } finally { opening = false }
  })
  window.once('closed', () => ipcMain.removeHandler('document:link'))
}
