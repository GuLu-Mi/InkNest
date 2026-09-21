import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import type { ThemeStore } from '../theme-store'
import { isTrustedCaller } from './validation'
const invalid = { status: 'error', error: { code: 'INVALID_REQUEST', message: '无效的主题请求', retryable: false } } as const
export function registerThemeHandlers(window: BrowserWindow, store: ThemeStore, developmentUrl?: string): void {
  ipcMain.handle('settings:theme', (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || args.length) return invalid
    return { status: 'ok', value: store.current }
  })
  ipcMain.handle('settings:set-theme', async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, window.webContents, developmentUrl) || args.length !== 1 || (args[0] !== 'light' && args[0] !== 'dark')) return invalid
    nativeTheme.themeSource = args[0]
    window.setBackgroundColor(args[0] === 'dark' ? '#1d1f23' : '#ffffff')
    return { status: 'ok', value: await store.set(args[0]) }
  })
  window.once('closed', () => { ipcMain.removeHandler('settings:theme'); ipcMain.removeHandler('settings:set-theme') })
}
