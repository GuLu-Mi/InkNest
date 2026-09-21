import { findShortcut } from './system/find-shortcut'
import { ThemeStore } from './theme-store'
import { registerThemeHandlers } from './ipc/theme'
import { hasWindowDialog, runWindowDialog } from './window-dialogs'
import { PresentationController } from './presentation-controller'
import { copy } from '../shared/copy'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { app, BrowserWindow, dialog, Menu, protocol, session, nativeTheme } from 'electron'

import { RecoveryStore } from './documents/recovery-store'
import { HistoryStore } from './documents/history-store'
import { atomicWrite } from './documents/atomic-writer'
import { SaveCoordinator } from './documents/save-coordinator'
import { WorkspaceCloseCoordinator } from './documents/workspace-close-coordinator'
import { CloseCoordinator } from './documents/close-coordinator'
import { PRODUCTION_CSP, STYLE_NONCE_PLACEHOLDER } from '../shared/csp'
import { registerDocumentHandlers } from './ipc/handlers'
import { DocumentRegistry } from './documents/registry'
import { ResourceService, isResourceUrl } from './security/resource-protocol'
import { commandLineFiles, SystemOpenQueue } from './system/open-events'
import type { DocumentHost } from './ipc/handlers'

type WindowHost = DocumentHost & { window: BrowserWindow }
let windowHost: WindowHost | null = null
let windowCreation: Promise<WindowHost> | null = null
const systemOpens = new SystemOpenQueue(async paths => {
  const host = await ensureWindow()
  if (host.window.isDestroyed()) return
  if (host.window.isMinimized()) host.window.restore()
  host.window.show(); host.window.focus()
  await host.openSystemFiles(paths)
}, () => { dialog.showErrorBox(copy.openFailed, copy.openFailedRetained) })
// OS events can arrive before Electron ready or before the renderer subscribes.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else {
  app.on('open-file', (event, path) => { event.preventDefault(); systemOpens.enqueue([path]) })
  app.on('second-instance', (_event, argv, cwd) => { systemOpens.enqueue(commandLineFiles(argv, cwd, !!process.defaultApp)) })
  const initialFiles = commandLineFiles(process.argv, process.cwd(), !!process.defaultApp)
  if (initialFiles.length) systemOpens.enqueue(initialFiles)
}

const themes = new ThemeStore(join(app.getPath('userData'), 'theme.json'))
const registry = new DocumentRegistry()
const recovery = new RecoveryStore(join(app.getPath('userData'), 'recovery'), registry, {
  confirmEviction: async count => { const window = BrowserWindow.getAllWindows()[0]; if (!window) return false; const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message: copy.recoverySpaceFull, detail: copy.evictRecoveryDetail(count), buttons: [copy.cancel, copy.clearDrafts], defaultId: 0, cancelId: 0, noLink: true })); return result.response === 1 && !window.isDestroyed() },
  didEvict: count => { const window = BrowserWindow.getAllWindows()[0]; if (window) void runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'info', message: copy.evictedRecovery(count), detail: copy.evictedRecoveryDetail, buttons: [copy.acknowledge] })).catch(() => {}) }
})
const history = new HistoryStore(join(app.getPath('userData'), 'history'), {
  changed: (path, generation) => {
    const source = registry.findPath(path)
    if (!source) return
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === source.ownerId)
    window?.webContents.send('document:event', { type: 'history-changed', displayPath: path, ref: { docId: source.document.docId, epoch: source.document.epoch }, generation })
  },
  maintenanceChanged: (path, failed) => {
    const source = registry.findPath(path); if (!source) return
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === source.ownerId)
    window?.webContents.send('document:event', { type: 'history-maintenance', displayPath: path, ref: { docId: source.document.docId, epoch: source.document.epoch }, failed })
  }
})
const saves = new SaveCoordinator(registry, atomicWrite, { history, recovery,
  confirmWithoutHistory: async name => { const window = BrowserWindow.getAllWindows()[0]; if (!window) return false; const result = await runWindowDialog(window, () => dialog.showMessageBox(window, { type: 'warning', message: copy.historyUnavailable(name), detail: copy.skipHistoryDetail, buttons: [copy.cancel, copy.continueWithoutHistory], defaultId: 0, cancelId: 0, noLink: true })); return result.response === 1 && !window.isDestroyed() },
  maintenanceFailed: session => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.id === session.ownerId); window?.webContents.send('document:event', { type: 'recovery-status', ref: { docId: session.document.docId, epoch: session.document.epoch }, revision: session.latestSnapshot?.revision ?? session.document.revision, state: 'error' }) }
})
let resourceOwnerId = -1
const resources = new ResourceService(registry, () => resourceOwnerId)

declare const __INKNEST_DEVELOPMENT__: boolean

const APP_SCHEME = 'inknest'
const APP_HOST = 'app'
const styleNonce = randomBytes(24).toString('base64')
const csp = PRODUCTION_CSP.replaceAll(STYLE_NONCE_PLACEHOLDER, styleNonce)

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
})

protocol.registerSchemesAsPrivileged([
  { scheme: 'inknest-resource', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
])

function notFound(): Response {
  return new Response(null, { status: 404 })
}

async function registerApplicationProtocol(): Promise<void> {
  const rendererRoot = join(__dirname, '../renderer')

  await protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== APP_HOST || url.username || url.password || url.port) return notFound()

    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return notFound()
    }

    if (pathname.includes('\0') || pathname.includes('\\')) return notFound()

    const requestedPath = pathname === '/' ? 'index.html' : pathname.slice(1)
    const absolutePath = join(rendererRoot, requestedPath)
    const relativePath = relative(rendererRoot, absolutePath)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return notFound()

    const contentType = MIME_TYPES[extname(absolutePath)]
    if (!contentType) return notFound()

    try {
      const content = await readFile(absolutePath)
      return new Response(extname(absolutePath) === '.html' ? content.toString('utf8').replaceAll(STYLE_NONCE_PLACEHOLDER, styleNonce) : new Uint8Array(content), {
        headers: {
          'Content-Security-Policy': csp,
          'Content-Type': contentType,
          'Cross-Origin-Opener-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return notFound()
    }
  })
}

function isAllowedRequest(rawUrl: string, developmentUrl: string | undefined): boolean {
  try {
    const url = new URL(rawUrl)
    if (isResourceUrl(rawUrl)) return true
    if (!developmentUrl) return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST

    const allowed = new URL(developmentUrl)
    if (url.origin === allowed.origin) return true

    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      url.hostname === allowed.hostname &&
      url.port === allowed.port
    )
  } catch {
    return false
  }
}

function getTrustedDevelopmentUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined

  try {
    const url = new URL(rawUrl)
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'

    if (!isHttp || !isLoopback || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

async function loadApplication(mainWindow: BrowserWindow, close: WorkspaceCloseCoordinator, presentation: PresentationController): Promise<DocumentHost> {
  if (__INKNEST_DEVELOPMENT__ && !app.isPackaged) {
    const developmentUrl = getTrustedDevelopmentUrl(process.env.ELECTRON_RENDERER_URL)
    if (developmentUrl) {
      configureSessionSecurity(developmentUrl)
      registerThemeHandlers(mainWindow, themes, developmentUrl)
      const host = registerDocumentHandlers(mainWindow, registry, resources, close, saves, recovery, history, presentation, developmentUrl)
      await mainWindow.loadURL(developmentUrl)
      await host.ready
      return host
    }
  }

  configureSessionSecurity(undefined)
  registerThemeHandlers(mainWindow, themes)
  const host = registerDocumentHandlers(mainWindow, registry, resources, close, saves, recovery, history, presentation)
  await mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/`)
  await host.ready
  return host
}

function configureSessionSecurity(developmentUrl: string | undefined): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, developmentUrl) })
  })
}

async function ensureWindow(): Promise<WindowHost> {
  if (windowCreation) return windowCreation
  if (windowHost && !windowHost.window.isDestroyed()) return windowHost
  windowCreation = createWindow()
  try { windowHost = await windowCreation; return windowHost }
  finally { windowCreation = null }
}

async function createWindow(): Promise<WindowHost> {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1f23' : '#ffffff',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    title: 'InkNest',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  const send = (event: import('../shared/contracts').AppEvent): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('document:event', event)
  }
  const documentClose = new CloseCoordinator(registry, send, async (name, error, canSaveAs, canRetry) => {
    const buttons = [copy.cancelClose, ...(canRetry ? [copy.retry] : []), ...(canSaveAs ? [copy.saveAs] : []), copy.discardCloseMore]
    const result = await runWindowDialog(mainWindow, () => dialog.showMessageBox(mainWindow, {
      type: 'warning', title: copy.closeBlocked, message: copy.closeFailureTitle(name), detail: canRetry ? `${copy.closeFailureDetail(name)}\n${error.message}` : error.message,
      buttons, defaultId: 0, cancelId: 0, noLink: true
    }))
    if (mainWindow.isDestroyed()) return 'cancel'
    return buttons[result.response] === copy.retry ? 'save' : buttons[result.response] === copy.saveAs ? 'save-as' : buttons[result.response] === copy.discardCloseMore ? 'discard' : 'cancel'
  }, saves, recovery, async name => {
    const result = await runWindowDialog(mainWindow, () => dialog.showMessageBox(mainWindow, {
      type: 'warning', message: copy.discardCloseQuestion(name),
      detail: copy.discardCloseDetail,
      buttons: [copy.cancel, copy.discardClose], defaultId: 0, cancelId: 0, noLink: true
    }))
    return result.response === 1 && !mainWindow.isDestroyed()
  }, async name => {
    const result = await runWindowDialog(mainWindow, () => dialog.showMessageBox(mainWindow, { type: 'warning', message: copy.historyCloseQuestion, detail: name, buttons: [copy.cancelClose, copy.historyCloseAnyway], defaultId: 0, cancelId: 0, noLink: true }))
    return result.response === 1 && !mainWindow.isDestroyed()
  })
  const close = new WorkspaceCloseCoordinator(registry, mainWindow.webContents.id, send, documentClose, saves, recovery)
  const presentation = new PresentationController(mainWindow, ref => registry.matches(ref, mainWindow.webContents.id), () => hasWindowDialog(mainWindow) || close.active || registry.list(mainWindow.webContents.id).some(session => saves.isRestoring(session)), send)
  let closing = false
  let allowQuit = false
  resourceOwnerId = mainWindow.webContents.id
  const requestClose = async (quit: boolean): Promise<void> => {
    if (closing || close.active) return
    closing = true
    try {
      if (!await close.closeWindow() || mainWindow.isDestroyed()) return
      mainWindow.destroy()
      if (quit) { allowQuit = true; app.quit() }
    } finally { close.finish(); closing = false }
  }
  const beforeQuit = (event: Electron.Event): void => {
    if (allowQuit || mainWindow.isDestroyed()) return
    event.preventDefault()
    void requestClose(true)
  }
  app.on('before-quit', beforeQuit)
  mainWindow.on('close', (event) => { event.preventDefault(); void requestClose(false) })
  mainWindow.on('closed', () => { app.removeListener('before-quit', beforeQuit) })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'n' && (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta) && !input.alt && !input.shift) {
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat && canCreate()) send({ type: 'menu-command', command: 'new' })
      return
    }
    const command = findShortcut(input, process.platform)
    if (command) {
      // Consuming here also prevents the native accelerator from dispatching twice.
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat && canPresent()) send({ type: 'menu-command', command })
      return
    }
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) event.preventDefault()
  })
  const canPresent = () => !mainWindow.isDestroyed() && !!registry.current && !hasWindowDialog(mainWindow) && !close.active && !registry.list(mainWindow.webContents.id).some(session => saves.isRestoring(session))
  const canCreate = () => !mainWindow.isDestroyed() && !hasWindowDialog(mainWindow) && !close.active && !presentation.active && !registry.list(mainWindow.webContents.id).some(session => saves.isRestoring(session))
  const applicationMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'InkNest', submenu: [{ role: 'about' as const, label: copy.about }, { type: 'separator' as const }, { role: 'hide' as const, label: copy.hide }, { role: 'hideOthers' as const, label: copy.hideOthers }, { role: 'unhide' as const, label: copy.showAll }, { type: 'separator' as const }, { role: 'quit' as const, label: copy.quit }] }] : []),
    { label: copy.fileMenu, submenu: [{ id: 'new-document', label: copy.newDocument, accelerator: 'CmdOrCtrl+N', click: () => { if (canCreate()) send({ type: 'menu-command', command: 'new' }) } }, { label: copy.openDocument, accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('document:event', { type: 'menu-command', command: 'open' }) }, { label: copy.immediateSave, accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('document:event', { type: 'menu-command', command: 'save' }) }, { label: copy.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('document:event', { type: 'menu-command', command: 'save-as' }) }, { label: copy.backups, click: () => mainWindow.webContents.send('document:event', { type: 'menu-command', command: 'backups' }) }, { label: copy.closeDocument, accelerator: 'CmdOrCtrl+W', click: () => mainWindow.webContents.send('document:event', { type: 'menu-command', command: 'close' }) }, { role: 'quit', label: copy.quit }] },
    { label: copy.viewMenu, submenu: [{ label: copy.presentation, click: () => { if (canPresent()) send({ type: 'menu-command', command: 'presentation' }) } }] },
    { label: copy.edit, submenu: [{ role: 'undo', label: copy.undo }, { role: 'redo', label: copy.redo }, { type: 'separator' }, { role: 'cut', label: copy.cut }, { role: 'copy', label: copy.copyText }, { role: 'paste', label: copy.paste }, { role: 'selectAll', label: copy.selectAll }, { type: 'separator' },
      { id: 'find', label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => { if (canPresent()) send({ type: 'menu-command', command: 'find' }) } },
      { id: 'find-next', label: '查找下一处', accelerator: process.platform === 'darwin' ? 'Cmd+G' : 'F3', click: () => { if (canPresent()) send({ type: 'menu-command', command: 'find-next' }) } },
      { id: 'find-previous', label: '查找上一处', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+G' : 'Shift+F3', click: () => { if (canPresent()) send({ type: 'menu-command', command: 'find-previous' }) } }
    ] }
  ])
  const fileMenu = applicationMenu.items.find(item => item.label === copy.fileMenu)!.submenu!
  fileMenu.on('menu-will-show', () => { applicationMenu.getMenuItemById('new-document')!.enabled = canCreate() })
  fileMenu.on('menu-will-close', () => { applicationMenu.getMenuItemById('new-document')!.enabled = true })
  const viewMenu = applicationMenu.items.find(item => item.label === copy.viewMenu)!.submenu!
  viewMenu.on('menu-will-show', () => { viewMenu.items[0]!.enabled = canPresent() })
  const editMenu = applicationMenu.items.find(item => item.label === copy.edit)!.submenu!
  editMenu.on('menu-will-show', () => { for (const id of ['find', 'find-next', 'find-previous']) applicationMenu.getMenuItemById(id)!.enabled = canPresent() })
  editMenu.on('menu-will-close', () => { for (const id of ['find', 'find-next', 'find-previous']) applicationMenu.getMenuItemById(id)!.enabled = true })
  Menu.setApplicationMenu(applicationMenu)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())

  const host = await loadApplication(mainWindow, close, presentation)
  return { window: mainWindow, ...host }
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return
  nativeTheme.themeSource = (await themes.load()).theme
  await registerApplicationProtocol()
  await protocol.handle('inknest-resource', (request) => resources.respond(request))
  await ensureWindow()
  systemOpens.start()

  app.on('activate', () => {
    systemOpens.enqueue([])
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
