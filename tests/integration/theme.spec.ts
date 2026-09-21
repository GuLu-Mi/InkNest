import { expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeStore } from '../../src/main/theme-store'

test('theme IPC only accepts the owning main frame and exact light/dark choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-theme-ipc-'))
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const nativeTheme = { themeSource: 'system' }
  vi.doMock('electron', () => ({ nativeTheme, ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } }))
  const frame = { url: 'inknest://app/' }; const sender = { mainFrame: frame }
  const window = Object.assign(new EventEmitter(), { webContents: sender, setBackgroundColor: vi.fn() })
  try {
    const { registerThemeHandlers } = await import('../../src/main/ipc/theme')
    registerThemeHandlers(window as unknown as import('electron').BrowserWindow, new ThemeStore(join(root, 'theme.json')))
    const get = handlers.get('settings:theme')!; const set = handlers.get('settings:set-theme')!; const caller = { sender, senderFrame: frame }
    for (const args of [[], ['system'], ['dark', 'extra'], [{ theme: 'dark' }], ['../file']]) expect(await set(caller, ...args)).toMatchObject({ status: 'error' })
    for (const bad of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: {} }]) { expect(await get(bad)).toMatchObject({ status: 'error' }); expect(await set(bad, 'dark')).toMatchObject({ status: 'error' }) }
    expect(await get(caller, 'extra')).toMatchObject({ status: 'error' })
    expect(await set(caller, 'dark')).toMatchObject({ status: 'ok', value: { theme: 'dark', warning: '' } })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(await get(caller)).toMatchObject({ status: 'ok', value: { theme: 'dark' } })
    window.emit('closed'); expect(handlers.size).toBe(0)
  } finally { vi.doUnmock('electron'); await rm(root, { recursive: true, force: true }) }
})
