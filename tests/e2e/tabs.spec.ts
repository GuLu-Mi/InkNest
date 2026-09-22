import { openDocumentPicker } from './open-document'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
async function select(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
  await openDocumentPicker(page)
}
test('A/B retain text, selection, undo, mode and scroll across 100 switches without accumulating editors', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-tabs-'))
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  const aText = '# A\n\n' + 'Paragraph\n\n'.repeat(200)
  await writeFile(a, aText); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, a)
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    await page.locator('.document-stage').evaluate(element => { element.scrollTop = 500 })
    await page.waitForTimeout(50)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('changed ')
    await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+ArrowRight')
    const scroller = page.locator('.cm-scroller')
    const settledTop = await scroller.evaluate(async element => {
      const view = Reflect.get(element.querySelector('.cm-content')!, 'cmTile').root.view
      // Selection commands schedule CodeMirror scroll measurement. Let that finish
      // before arranging the independent manual-scroll bookmark under test.
      const measured = () => new Promise<void>(resolve => view.requestMeasure({ read: () => null, write: () => resolve() }))
      await measured()
      element.scrollTop = 360
      await measured()
      return element.scrollTop
    })
    expect(settledTop).toBe(360)
    await select(app, page, b)
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    await page.getByRole('tab', { name: 'a.md', exact: false }).click()
    await expect(page.locator('.cm-scroller')).toBeVisible()
    await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop)).toBe(360)
    await editor.focus(); expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('c')
    const viewMetrics = () => page.locator('.cm-editor').evaluate(element => {
      const view = Reflect.get(element.querySelector('.cm-content')!, 'cmTile').root.view
      return { plugins: view.plugins.length, styles: document.querySelectorAll('style').length }
    })
    const baseline = await viewMetrics()
    for (let i = 0; i < 100; i++) {
      await page.getByRole('tab', { name: 'b.md', exact: true }).click()
      await page.getByRole('tab', { name: 'a.md', exact: false }).click()
    }
    await expect(page.locator('.cm-editor')).toHaveCount(1)
    expect(await viewMetrics()).toEqual(baseline)
    await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toContainText('# A'); await expect(page.getByRole('status')).toContainText('已保存')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.preview')).toContainText('Paragraph')
    await expect.poll(() => page.locator('.document-stage').evaluate(element => element.scrollTop)).toBeGreaterThan(400)
    await page.getByRole('tab', { name: 'b.md', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    expect(await readFile(b, 'utf8')).toBe('# B'); expect(await readFile(a, 'utf8')).toBe(aText)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('inactive dirty A survives whole-window save failure and is located with B preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-tabs-close-'))
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, a); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' latest')
    await select(app, page, b)
    await chmod(a, 0o444)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close'); Reflect.set(globalThis, 'closeResults', [])
      ipcMain.removeHandler('document:complete-close'); ipcMain.handle('document:complete-close', async (...args) => { const result = await original(...args); Reflect.get(globalThis, 'closeResults').push(result); return result })
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'closeResults').length)).toBe(1)
    await expect(page.getByRole('textbox')).toHaveText('# A latest')
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await page.getByRole('tab', { name: 'b.md', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await chmod(a, 0o644)
    await writeFile(a, '# external A')
    await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); BrowserWindow.getAllWindows()[0]!.close() })
    await expect(page.getByRole('tab', { name: /a.md.*出错/ })).toBeEnabled()
    expect(app.windows()).toHaveLength(1)
    await expect(page.locator('.document-tabs [role=tab]')).toHaveCount(2)
    await page.getByRole('tab', { name: /a.md.*出错/ }).click()
    await expect(page.getByRole('textbox')).toHaveText('# A latest')
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(page.getByRole('alert')).toContainText('外部')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('textbox')).toHaveText('# A')
    expect(await readFile(a, 'utf8')).toBe('# external A'); expect(await readFile(b, 'utf8')).toBe('# B')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('composition timeout keeps A active until composition commits, then switching is safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-tabs-composition-'))
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, b); await select(app, page, a)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox')
    // Synthetic composition tests timing and routing; real OS IME acceptance remains separate.
    await editor.dispatchEvent('compositionstart', { data: '拼' })
    await page.getByRole('tab', { name: 'b.md', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('输入尚未完成', { timeout: 7000 })
    await expect(page.getByRole('tab', { name: /a.md/ })).toHaveAttribute('aria-selected', 'true')
    await expect(editor).toHaveText('# A')
    await editor.dispatchEvent('compositionend', { data: '拼' })
    await page.getByRole('tab', { name: 'b.md', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    expect(await readFile(a, 'utf8')).toBe('# A')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('background manual save errors remain on their originating tab and selection never saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-tabs-save-'))
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, b); await select(app, page, a)
    await app.evaluate(({ ipcMain }) => {
      Reflect.set(globalThis, 'saveCalls', 0)
      ipcMain.removeHandler('document:save')
      ipcMain.handle('document:save', () => new Promise(resolve => {
        Reflect.set(globalThis, 'saveCalls', Reflect.get(globalThis, 'saveCalls') + 1)
        Reflect.set(globalThis, 'failSave', () => resolve({ status: 'error', error: { code: 'DISK_FULL', message: '测试写入失败', retryable: true } }))
      }))
    })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight')
    await page.waitForTimeout(300)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'saveCalls'))).toBe(0)
    await page.keyboard.insertText('edited'); await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('status')).toContainText('保存中')
    await page.getByRole('tab', { name: 'b.md', exact: true }).click()
    await app.evaluate(() => Reflect.get(globalThis, 'failSave')())
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('已保存')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('tab', { name: /a.md.*出错/ }).click()
    await expect(page.getByRole('alert').locator('span')).toHaveText('测试写入失败')
    await expect(page.getByRole('status')).toContainText('修改尚未保存')
    await expect(page.getByRole('textbox')).toContainText('edited')
    expect(await readFile(a, 'utf8')).toBe('# A'); expect(await readFile(b, 'utf8')).toBe('# B')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
for (const order of ['event-first', 'result-first'] as const) test(`successful delayed open stays registered after composition timeout (${order})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-tabs-open-composition-'))
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, a); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' latest')
    await expect(page.getByRole('textbox')).toHaveText('# A latest')
    await app.evaluate(({ dialog, BrowserWindow }, { path, order }) => {
      dialog.showOpenDialog = async () => new Promise(resolve => { Reflect.set(globalThis, 'finishPicker', () => resolve({ canceled: false, filePaths: [path] })) })
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      const send = contents.send.bind(contents)
      Reflect.set(globalThis, 'closeRefs', [])
      contents.send = (channel, ...args) => {
        const event = args[0]
        if (channel === 'document:event' && event.type === 'document-opened') {
          Reflect.set(globalThis, 'openedB', event.document)
          if (order === 'result-first') { Reflect.set(globalThis, 'flushOpened', () => send(channel, ...args)); return }
        }
        if (channel === 'document:event' && event.type === 'prepare-close') Reflect.get(globalThis, 'closeRefs').push(event.ref)
        send(channel, ...args)
      }
    }, { path: b, order })
    await openDocumentPicker(page)
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'finishPicker'))).toBe('function')
    await page.getByRole('textbox').dispatchEvent('compositionstart', { data: '拼' })
    await app.evaluate(() => Reflect.get(globalThis, 'finishPicker')())
    await expect(page.getByRole('alert')).toContainText('输入尚未完成', { timeout: 7000 })
    await expect(page.getByRole('button', { name: '返回首页', exact: true })).toBeEnabled()
    await expect(page.locator('.document-tabs [role=tab]')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /a.md/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox')).toHaveText('# A latest')
    await page.getByRole('textbox').dispatchEvent('compositionend', { data: '拼' })
    if (order === 'result-first') await app.evaluate(() => Reflect.get(globalThis, 'flushOpened')())
    await expect(page.getByRole('tab', { name: /a.md/ })).toHaveAttribute('aria-selected', 'true')
    const openedB = await app.evaluate(() => Reflect.get(globalThis, 'openedB') as { docId: string; epoch: string })
    await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); BrowserWindow.getAllWindows()[0]!.close() })
    await expect.poll(() => app.windows().length).toBe(0)
    const refs = await app.evaluate(() => Reflect.get(globalThis, 'closeRefs') as { docId: string; epoch: string }[])
    expect(refs).toHaveLength(2); expect(refs).toContainEqual({ docId: openedB.docId, epoch: openedB.epoch })
    expect(await readFile(a, 'utf8')).toBe('# A latest'); expect(await readFile(b, 'utf8')).toBe('# B')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
