import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
async function open(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
}
async function edit(page: Page, text: string) {
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inknest-tab-close-')); const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true }); const page = await app.firstWindow()
  // Force snapshots to be handled by the real close path, rather than racing timer autosave.
  await app.evaluate(({ ipcMain, dialog, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents; const send = contents.send.bind(contents); Reflect.set(globalThis, 'workspaceCloseEvents', []); Reflect.set(globalThis, 'openedCloseRefs', [])
    contents.send = (channel, ...args) => { if (channel === 'document:event' && args[0].type === 'document-opened') Reflect.get(globalThis, 'openedCloseRefs').push({ docId: args[0].document.docId, epoch: args[0].document.epoch }); if (channel === 'document:event' && ['workspace-freeze', 'workspace-thaw'].includes(args[0].type)) Reflect.get(globalThis, 'workspaceCloseEvents').push(args[0]); send(channel, ...args) }
    const save = Reflect.get(ipcMain, '_invokeHandlers').get('document:save')
    ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', (event, request) => request.trigger === 'auto' ? { status: 'cancelled' } : save(event, request))
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    const complete = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close'); Reflect.set(globalThis, 'closeResults', [])
    ipcMain.removeHandler('document:complete-close'); ipcMain.handle('document:complete-close', async (...args) => { const result = await complete(...args); Reflect.get(globalThis, 'closeResults').push(result); return result })
  })
  return { root, a, b, app, page, cleanup: async () => { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) } }
}
test('fixed close API and background close button save A only; shortcut closes last tab to welcome', async () => {
  const f = await fixture()
  try {
    expect(await f.page.evaluate(() => typeof window.inknest.closeDocument)).toBe('function')
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await open(f.app, f.page, f.b)
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.locator('.document-tabs [role=tab]')).toHaveCount(1)
    await expect(f.page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    expect(await readFile(f.a, 'utf8')).toBe('# A complete latest'); expect(await readFile(f.b, 'utf8')).toBe('# B')
    await f.page.keyboard.press('ControlOrMeta+w'); await expect(f.page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
    expect(f.app.windows()).toHaveLength(1)
  } finally { await f.cleanup() }
})
test('single save failure retains A full text and B; explicit discard needs the separate confirmation', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await open(f.app, f.page, f.b)
    await writeFile(f.a, '# external A')
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'closeResults'))).toMatchObject([{ status: 'error' }])
    await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest'); await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(f.page.locator('.document-tabs [role=tab]')).toHaveCount(2)
    expect(await readFile(f.a, 'utf8')).toBe('# external A'); expect(await readFile(f.b, 'utf8')).toBe('# B')
    await f.app.evaluate(({ dialog }) => { let calls = 0; dialog.showMessageBox = async (...args) => ({ response: calls++ === 0 ? (args.at(-1) as { buttons: string[] }).buttons.indexOf('丢弃并关闭…') : 0, checkboxChecked: false }) })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'closeResults').length)).toBe(2)
    await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest')
    await f.app.evaluate(({ dialog }) => { let calls = 0; dialog.showMessageBox = async (...args) => ({ response: calls++ === 0 ? (args.at(-1) as { buttons: string[] }).buttons.indexOf('丢弃并关闭…') : 1, checkboxChecked: false }) })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.locator('.document-tabs [role=tab]')).toHaveCount(1)
    expect(await readFile(f.a, 'utf8')).toBe('# external A')
  } finally { await f.cleanup() }
})
test('native whole-window A save then B failure retains all full texts and A remains on disk', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await open(f.app, f.page, f.b); await edit(f.page, ' complete latest')
    await chmod(f.b, 0o444)
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'closeResults').length)).toBe(2)
    await expect(f.page.locator('.document-tabs [role=tab]')).toHaveCount(2)
    await expect(f.page.getByRole('textbox')).toHaveText('# B complete latest'); await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await f.page.getByRole('tab', { name: 'a.md', exact: true }).click(); await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest')
    expect(await readFile(f.a, 'utf8')).toBe('# A complete latest'); expect(await readFile(f.b, 'utf8')).toBe('# B'); expect(f.app.windows()).toHaveLength(1)
  } finally { await f.cleanup() }
})
test('pending SaveAs cancels native window close immediately and matching thaw leaves its document frozen until picker cancellation', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest')
    await f.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => new Promise(resolve => Reflect.set(globalThis, 'cancelPicker', () => resolve({ canceled: true, filePath: undefined }))) })
    await f.page.keyboard.press('ControlOrMeta+Shift+s')
    await expect.poll(() => f.app.evaluate(() => typeof Reflect.get(globalThis, 'cancelPicker'))).toBe('function')
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'workspaceCloseEvents').filter((event: { type: string }) => event.type === 'workspace-thaw').length), { timeout: 1500 }).toBe(1)
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await f.app.evaluate(() => Reflect.get(globalThis, 'cancelPicker')())
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest'); expect(await readFile(f.a, 'utf8')).toBe('# A'); expect(f.app.windows()).toHaveLength(1)
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'closeResults'))).toEqual([])
  } finally { await f.cleanup() }
})
test('native window timeout rejects old epoch/late replies and preserves complete A/B text after matching thaw', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await open(f.app, f.page, f.b); await edit(f.page, ' complete latest')
    await f.app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close'); ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', (event, requestId, state) => { Reflect.set(globalThis, 'oldClose', { requestId, state }); return new Promise(resolve => Reflect.set(globalThis, 'lateClose', async () => resolve(await original(event, requestId, state)))) })
    })
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => f.app.evaluate(() => typeof Reflect.get(globalThis, 'lateClose'))).toBe('function')
    await expect(f.page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeDisabled()
    const guardedRefs = await f.app.evaluate(() => Reflect.get(globalThis, 'openedCloseRefs') as { docId: string; epoch: string }[])
    for (const [index, ref] of guardedRefs.entries()) expect(await f.page.evaluate(({ ref, index }) => window.inknest.reconcileExternal({ ref, snapshot: { ...ref, revision: 1, text: index === 0 ? '# A complete latest' : '# B complete latest' } }), { ref, index })).toEqual({ status: 'cancelled' })
    await expect(f.page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeEnabled({ timeout: 7000 })
    const oldRef = await f.app.evaluate(() => Reflect.get(globalThis, 'oldClose').state.ref as { docId: string; epoch: string })
    expect(await f.page.evaluate(ref => window.inknest.closeDocument({ ...ref, epoch: crypto.randomUUID() }), oldRef)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
    await f.app.evaluate(() => Reflect.get(globalThis, 'lateClose')())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'closeResults'))).toMatchObject([{ status: 'error', error: { code: 'INVALID_REQUEST' } }])
    await f.page.getByRole('tab', { name: /a.md/ }).click(); await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest')
    await f.page.getByRole('tab', { name: /b.md/ }).click(); await expect(f.page.getByRole('textbox')).toHaveText('# B complete latest'); await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    expect(await readFile(f.a, 'utf8')).toBe('# A'); expect(await readFile(f.b, 'utf8')).toBe('# B'); expect(f.app.windows()).toHaveLength(1)
  } finally { await f.cleanup() }
})

test('pending conflict confirmation cancels native exit and preserves its complete document until cancellation', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await writeFile(f.a, '# external A')
    await f.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => new Promise(resolve => Reflect.set(globalThis, 'cancelConflict', () => resolve({ response: 0, checkboxChecked: false }))) })
    await f.page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click()
    await expect.poll(() => f.app.evaluate(() => typeof Reflect.get(globalThis, 'cancelConflict'))).toBe('function')
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'workspaceCloseEvents').filter((event: { type: string }) => event.type === 'workspace-thaw').length), { timeout: 1500 }).toBe(1)
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await f.app.evaluate(() => Reflect.get(globalThis, 'cancelConflict')())
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true'); await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest')
    expect(await readFile(f.a, 'utf8')).toBe('# external A'); expect(f.app.windows()).toHaveLength(1); expect(await f.app.evaluate(() => Reflect.get(globalThis, 'closeResults'))).toEqual([])
  } finally { await f.cleanup() }
})
test('missing readonly document cancels whole-window exit and can explicitly close without recreating its source', async () => {
  const f = await fixture()
  try {
    await writeFile(f.a, Buffer.from([35, 32, 255])); await open(f.app, f.page, f.a)
    await expect(f.page.locator('.preview')).toContainText('�')
    const text = await f.page.locator('.preview').innerText(); await rm(f.a)
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'closeResults').length)).toBe(1)
    await expect(f.page.locator('.preview')).toHaveText(text); await expect(f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true })).toBeEnabled()
    await f.app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const buttons = (args.at(-1) as { buttons: string[] }).buttons; return { response: buttons.findIndex(value => value.startsWith('丢弃并关闭')), checkboxChecked: false } } })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.getByRole('heading', { name: '打开一份文档' })).toBeVisible(); expect(f.app.windows()).toHaveLength(1)
    await expect(readFile(f.a)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('external events respect a held single close, reconcile other refs once, and drain only retained text', async () => {
  const f = await fixture()
  try {
    await open(f.app, f.page, f.a); await edit(f.page, ' complete latest'); await open(f.app, f.page, f.b)
    await f.page.getByRole('tab', { name: /a.md/ }).click()
    await f.app.evaluate(({ ipcMain, dialog, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents; const send = contents.send.bind(contents)
      Reflect.set(globalThis, 'fixReconciles', [])
      contents.send = (channel, ...args) => { if (channel === 'document:event' && args[0].type === 'prepare-close') Reflect.set(globalThis, 'fixChallenge', args[0]); send(channel, ...args) }
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:reconcile')
      ipcMain.removeHandler('document:reconcile'); ipcMain.handle('document:reconcile', async (event, state) => {
        const calls = Reflect.get(globalThis, 'fixReconciles'); calls.push(state)
        // Bound a defective retry loop while preserving the real first calls.
        if (calls.length > 4) return new Promise(() => {})
        return original(event, state)
      })
      dialog.showMessageBox = async () => new Promise(resolve => Reflect.set(globalThis, 'fixCancelClose', () => resolve({ response: 0, checkboxChecked: false })))
    })
    await chmod(f.a, 0o444)
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect.poll(() => f.app.evaluate(() => typeof Reflect.get(globalThis, 'fixCancelClose'))).toBe('function')
    const aRef = await f.app.evaluate(() => Reflect.get(globalThis, 'fixChallenge').ref as { docId: string; epoch: string })
    await f.app.evaluate(({ BrowserWindow }, ref) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      contents.send('document:event', { type: 'external-change', ref, diskStatus: 'changed' })
      contents.send('document:event', { type: 'external-change', ref: Reflect.get(globalThis, 'openedCloseRefs')[1], diskStatus: 'changed' })
      contents.send('document:event', { type: 'close-error', requestId: Reflect.get(globalThis, 'fixChallenge').requestId, ref, error: { code: 'RECOVERY_FAILED', message: 'close identity retained', retryable: true } })
    }, aRef)
    await expect(f.page.getByText('close identity retained', { exact: true })).toBeVisible()
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles').length)).toBe(1)
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles')[0].ref)).not.toEqual(aRef)
    await f.app.evaluate(() => Reflect.get(globalThis, 'fixCancelClose')())
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles').length)).toBe(2)
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true'); await expect(f.page.getByRole('textbox')).toHaveText('# A complete latest')
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles')[1].snapshot.text)).toBe('# A complete latest')
    await chmod(f.a, 0o644)
    await f.page.evaluate(ref => window.inknest.reconcileExternal({ ref, snapshot: { ...ref, revision: 1, text: '# A complete latest' } }), aRef)
    await f.app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close'); ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', (...args) => new Promise(resolve => Reflect.set(globalThis, 'fixReleaseSave', async () => resolve(await original(...args)))))
    })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect.poll(() => f.app.evaluate(() => typeof Reflect.get(globalThis, 'fixReleaseSave'))).toBe('function')
    await f.app.evaluate(({ BrowserWindow }, ref) => BrowserWindow.getAllWindows()[0]!.webContents.send('document:event', { type: 'external-change', ref, diskStatus: 'changed' }), aRef)
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    const count = await f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles').length)
    await f.app.evaluate(() => Reflect.get(globalThis, 'fixReleaseSave')())
    await expect(f.page.locator('.document-tabs [role=tab]')).toHaveCount(1)
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'fixReconciles').length)).toBe(count)
    expect(await readFile(f.a, 'utf8')).toBe('# A complete latest')
  } finally { await f.cleanup() }
})
