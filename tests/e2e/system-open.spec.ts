import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function launch(root: string, paths: string[] = []): Promise<ElectronApplication> {
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  return electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`, ...paths], chromiumSandbox: true })
}
async function deliver(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ app }, files) => { for (const path of files) app.emit('open-file', { preventDefault() {} }, path) }, paths)
}

test('cold argv, hot OS open, repeated dirty activation and window recreation preserve documents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-system-')))
  const a = join(root, '中文 #100%.MD'), b = join(root, 'second.markdown')
  await writeFile(a, '# First'); await writeFile(b, '# Second')
  const app = await launch(root, [a])
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'First', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' changed')
    await deliver(app, [b]); await expect(page.getByRole('heading', { name: 'Second', exact: true })).toBeVisible()
    await deliver(app, [a]); await expect(page.getByRole('textbox')).toHaveText('# First changed')
    await expect(page.getByRole('tab')).toHaveCount(2)
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('textbox')).toHaveText('# First')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
    await deliver(app, [b]); await expect(page.getByRole('heading', { name: 'Second', exact: true })).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false)
    if (process.platform === 'darwin') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
      const nextWindow = app.waitForEvent('window')
      await deliver(app, [b]); page = await nextWindow
      await expect(page.getByRole('heading', { name: 'Second', exact: true })).toBeVisible()
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    }
    expect(await readFile(a, 'utf8')).toBe('# First')
    expect(await readFile(b, 'utf8')).toBe('# Second')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('multi-file choice/cancel and invalid paths retain the workspace; readiness IPC is restricted', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-system-errors-')))
  const a = join(root, 'a.md'), b = join(root, 'b.md')
  await writeFile(a, '# Keep'); await writeFile(b, '# Selected')
  const app = await launch(root, [a])
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Keep', exact: true })).toBeVisible()
    await app.evaluate(({ dialog }) => {
      Reflect.set(globalThis, 'openDialogs', [])
      Reflect.set(globalThis, 'choice', 0)
      dialog.showMessageBox = async (_window, options) => { Reflect.get(globalThis, 'openDialogs').push(options); return { response: Reflect.get(globalThis, 'choice'), checkboxChecked: false } }
    })
    await deliver(app, [a, b])
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'openDialogs').length)).toBe(1)
    await expect(page.getByRole('tab')).toHaveCount(1)
    await app.evaluate(() => Reflect.set(globalThis, 'choice', 2)); await deliver(app, [a, b])
    await expect(page.getByRole('heading', { name: 'Selected', exact: true })).toBeVisible()
    await deliver(app, [join(root, 'missing.md')])
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'openDialogs').length)).toBe(3)
    await deliver(app, [join(root, 'unsupported.txt')])
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'openDialogs').length)).toBe(4)
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Selected', exact: true })).toBeVisible()
    const statuses = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handler = Reflect.get(ipcMain, '_invokeHandlers').get('document:renderer-ready')
      const sender = BrowserWindow.getAllWindows()[0]!.webContents
      return [
        await handler({ sender, senderFrame: sender.mainFrame }, 'extra'),
        await handler({ sender, senderFrame: { url: 'inknest://app/' } }),
        await handler({ sender: {}, senderFrame: sender.mainFrame }),
        await handler({ sender: { mainFrame: { url: 'https://untrusted.example/' } }, senderFrame: null }),
        await handler({ sender, senderFrame: sender.mainFrame })
      ].map(result => result.status)
    })
    expect(statuses).toEqual(['error', 'error', 'error', 'error', 'ok'])
    expect(await readFile(a, 'utf8')).toBe('# Keep'); expect(await readFile(b, 'utf8')).toBe('# Selected')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('a real second process forwards to the single existing window', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-second-instance-')))
  const a = join(root, 'first.md'), b = join(root, 'second.md')
  await writeFile(a, '# Primary'); await writeFile(b, '# Forwarded')
  const app = await launch(root, [a])
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Primary', exact: true })).toBeVisible()
    const executable = await app.evaluate(() => process.execPath)
    const args = [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`, b]
    await promisify(execFile)(executable, args, { timeout: 10000 })
    await expect(page.getByRole('heading', { name: 'Forwarded', exact: true })).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(2)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('system opens respect the 20-tab limit and an in-progress close barrier', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-system-barrier-')))
  const paths = Array.from({ length: 21 }, (_, i) => join(root, `${i}.md`))
  await Promise.all(paths.map((path, i) => writeFile(path, `# Document ${i}`)))
  const app = await launch(root, [paths[0]!])
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Document 0', exact: true })).toBeVisible()
    await app.evaluate(({ dialog }) => {
      Reflect.set(globalThis, 'openErrors', [])
      dialog.showMessageBox = async (_window, options) => { Reflect.get(globalThis, 'openErrors').push(options.detail); return { response: 0, checkboxChecked: false } }
    })
    for (let i = 1; i < 20; i++) {
      await deliver(app, [paths[i]!])
      await expect(page.getByRole('heading', { name: `Document ${i}`, exact: true })).toBeVisible()
    }
    await deliver(app, [paths[20]!])
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'openErrors').length)).toBe(1)
    await expect(page.getByRole('tab')).toHaveCount(20)
    await expect(page.getByRole('heading', { name: 'Document 19', exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close')
      ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', (...args) => new Promise(resolve => { Reflect.set(globalThis, 'continueClose', async () => resolve(await original(...args))) }))
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'continueClose'))).toBe('function')
    await deliver(app, [paths[0]!])
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'openErrors').length)).toBe(2)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'openErrors')[1])).toBe('正在确认关闭，请稍候。')
    await expect(page.getByRole('tab')).toHaveCount(20)
    expect(await readFile(paths[0]!, 'utf8')).toBe('# Document 0')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
