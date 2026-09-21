import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
async function select(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
}

test('Cmd/Ctrl+S saves raw Markdown while keeping undo history and conflict content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-e2e-save-')); const path = join(root, 'save.md')
  await writeFile(path, '# old\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox'); await editor.click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('<script>raw</script>\n')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('status')).toContainText('已保存')
    expect(await readFile(path, 'utf8')).toBe('<script>raw</script>\n# old\n')
    await page.keyboard.press('ControlOrMeta+z'); await expect(page.getByRole('status')).toContainText('待保存')
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(page.getByRole('status')).toContainText('已保存')
    await page.keyboard.insertText('local'); await writeFile(path, 'external')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('alert')).toContainText('外部更改')
    await expect(page.getByRole('status')).toContainText('修改尚未保存')
    await expect(editor).toContainText('local'); expect(await readFile(path, 'utf8')).toBe('external')
    await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); BrowserWindow.getAllWindows()[0]!.close() })
    await expect(editor).toHaveAttribute('contenteditable', 'true'); expect(app.windows()).toHaveLength(1)
    await expect(editor).toContainText('local')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('earlier close receipt stays clean when later tab fails, and native close succeeds after repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-e2e-close-save-')); const path = join(root, 'old.md'); const next = join(root, 'next.md')
  await writeFile(path, '# old\n'); await writeFile(next, '# next\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('saved before close\n')
    await app.evaluate(({ ipcMain }) => {
      Reflect.set(globalThis, 'originalSaveHandler', Reflect.get(ipcMain, '_invokeHandlers').get('document:save'))
      ipcMain.removeHandler('document:save')
      ipcMain.handle('document:save', () => ({ status: 'error', error: { code: 'DISK_FULL', message: '临时保存失败', retryable: true } }))
    })
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('status')).toContainText('修改尚未保存')
    await expect(page.getByRole('alert').locator('span')).toHaveText('临时保存失败')
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', Reflect.get(globalThis, 'originalSaveHandler')) })
    await select(app, page, next)
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.insertText('cancel next\n')
    await chmod(next, 0o444)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close'); Reflect.set(globalThis, 'closeResults', [])
      ipcMain.removeHandler('document:complete-close'); ipcMain.handle('document:complete-close', async (...args) => { const result = await original(...args); Reflect.get(globalThis, 'closeResults').push(result); return result })
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'closeResults').length)).toBe(2)
    await expect(page.getByRole('textbox')).toHaveText('cancel next# next')
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect.poll(() => readFile(path, 'utf8')).toBe('saved before close\n# old\n')
    await expect(page.getByRole('tab', { name: 'old.md', exact: true })).toBeEnabled()
    await page.getByRole('tab', { name: 'old.md', exact: true }).click()
    await expect(page).not.toHaveTitle(/\*/u)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveText('saved before close# old')
    await expect(page.getByRole('status')).toContainText('已保存')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page).toHaveTitle(/\*/u)
    await chmod(next, 0o644)
    await page.getByRole('tab', { name: /next.md/ }).click()
    await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveText('cancel next# next')
    await app.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); BrowserWindow.getAllWindows()[0]!.close() })
    await expect.poll(() => app.windows().length).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('# old\n')
    expect(await readFile(next, 'utf8')).toContain('cancel next')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('older overlapping success cannot erase a later same-revision conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-save-response-order-')); const path = join(root, 'overlap.md')
  await writeFile(path, '# original')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:save')
      const requests: { requestId: string; revision: number }[] = []
      Reflect.set(globalThis, 'orderedSaveRequests', requests)
      ipcMain.removeHandler('document:save')
      ipcMain.handle('document:save', async (event, request) => {
        const first = requests.length === 0
        requests.push({ requestId: request.requestId, revision: request.snapshot.revision })
        const result = await original(event, request)
        if (!first) return result
        return new Promise(resolve => { Reflect.set(globalThis, 'releaseFirstSave', () => resolve(result)) })
      })
    })
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseFirstSave'))).toBe('function')
    expect(await readFile(path, 'utf8')).toBe('# original local')
    await writeFile(path, '# external')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('alert')).toContainText('外部更改')
    const requests = await app.evaluate(() => Reflect.get(globalThis, 'orderedSaveRequests') as { requestId: string; revision: number }[])
    expect(requests).toHaveLength(2)
    expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId)
    expect(requests[0]!.revision).toBe(requests[1]!.revision)
    await app.evaluate(() => Reflect.get(globalThis, 'releaseFirstSave')())
    await expect(page.getByRole('status')).toContainText('修改尚未保存')
    await expect(page.getByRole('alert')).toContainText('外部更改')
    await expect(page.getByRole('tab', { name: /overlap.md.*出错/ })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveText('# original local')
    expect(await readFile(path, 'utf8')).toBe('# external')
    // The delayed success may make dirty false; known disk conflict must still stop a clean close.
    await app.evaluate(({ ipcMain, BrowserWindow, dialog }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close')
      ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', async (...args) => { const result = await original(...args); Reflect.set(globalThis, 'conflictCloseResult', result); return result })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'conflictCloseResult'))).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
    expect(app.windows()).toHaveLength(1); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    expect(await readFile(path, 'utf8')).toBe('# external')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

for (const resolution of ['save-as', 'overwrite'] as const) test(`old EXTERNAL_CHANGE arriving after successful ${resolution} cannot revive conflict`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-stale-failure-')); const path = join(root, 'original.md'); const copy = join(root, 'copy.md')
  await writeFile(path, '# original')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path); await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox'); await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:save'); let first = true
      ipcMain.removeHandler('document:save')
      ipcMain.handle('document:save', async (...args) => {
        const held = first; first = false; const result = await original(...args)
        if (!held) return result
        Reflect.set(globalThis, 'heldFailure', result)
        return new Promise(resolve => Reflect.set(globalThis, 'releaseOldFailure', () => resolve(result)))
      })
    })
    await writeFile(path, '# external'); await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'heldFailure'))).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, copy)
    await page.getByRole('button', { name: resolution === 'save-as' ? '另存为…' : '覆盖磁盘版本', exact: true }).click()
    const destination = resolution === 'save-as' ? copy : path
    await expect.poll(() => readFile(destination, 'utf8').catch(() => null)).toBe('# original local')
    await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0)
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await app.evaluate(() => Reflect.get(globalThis, 'releaseOldFailure')())
    // The held ordinary save keeps saving > 0 until its renderer continuation finishes.
    await expect(page.locator('.document-status')).toContainText('已保存')
    await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0)
    await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' edit'); await page.keyboard.press('ControlOrMeta+s')
    await expect(page.locator('.document-status')).toContainText('已保存'); expect(await readFile(destination, 'utf8')).toBe('# original local edit')
    if (resolution === 'save-as') expect(await readFile(path, 'utf8')).toBe('# external')
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => { throw new Error('resolved clean document must not prompt') }
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.windows().length).toBe(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
