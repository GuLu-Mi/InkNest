import { openDocumentPicker } from './open-document'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
async function select(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  await openDocumentPicker(page)
}
test('external clean reload and background conflict retain current tab; real SaveAs preserves editor undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-conflicts-')); const a = join(root, 'a.md'); const b = join(root, 'b.md'); const copy = join(root, 'copy.md')
  await writeFile(a, '# disk1'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, a); await expect(page.getByRole('heading', { name: 'disk1', exact: true })).toBeVisible(); await writeFile(a, '# disk2')
    await expect(page.getByRole('heading', { name: 'disk2', exact: true })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('status')).toContainText('文件已更新')
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await select(app, page, b); await writeFile(a, '# disk3')
    await expect(page.getByRole('tab', { name: /a.md.*出错/u })).toBeVisible(); await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: /a.md/u }).click(); await expect(page.getByRole('textbox')).toContainText('# disk2 local')
    await page.getByRole('button', { name: '查看磁盘版本', exact: true }).click(); await expect(page.getByLabel('磁盘版本', { exact: true })).toHaveText('# disk3')
    await page.screenshot({ path: test.info().outputPath('conflict-panel.png') })
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }, copy)
    await page.getByRole('button', { name: '另存为…', exact: true }).click()
    await expect.poll(() => readFile(copy, 'utf8').catch(() => null)).toBe('# disk2 local'); expect(await readFile(a, 'utf8')).toBe('# disk3')
    await expect(page.getByRole('tab', { name: 'copy.md', exact: true })).toBeVisible(); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page.getByRole('textbox')).toHaveText('# disk2')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('overwrite rejects a version changed during native confirmation; use-disk defaults cancel and successful overwrite accepts its bound receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-conflict-confirm-')); const path = join(root, 'a.md'); await writeFile(path, '# disk1')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await writeFile(path, '# disk2'); await page.getByRole('button', { name: '查看磁盘版本', exact: true }).click()
    await expect(page.getByLabel('磁盘版本', { exact: true })).toHaveText('# disk2')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => {
        Reflect.set(globalThis, 'confirmDefault', [options.defaultId, options.cancelId, options.detail])
        return new Promise(resolve => Reflect.set(globalThis, 'confirmResponse', (response: number) => resolve({ response, checkboxChecked: false })))
      }
    })
    await page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click()
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'confirmResponse'))).toBe('function')
    expect(await app.evaluate(() => Reflect.get(globalThis, 'confirmDefault').slice(0, 2))).toEqual([0, 0])
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await writeFile(path, '# disk3'); await app.evaluate(() => Reflect.get(globalThis, 'confirmResponse')(1))
    await expect(page.getByRole('alert')).toContainText('外部更改'); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    expect(await readFile(path, 'utf8')).toBe('# disk3'); await expect(page.getByRole('textbox')).toHaveText('# disk1 local')
    await page.getByRole('button', { name: '查看磁盘版本', exact: true }).click(); await expect(page.getByLabel('磁盘版本', { exact: true })).toHaveText('# disk3')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await page.getByRole('button', { name: '使用磁盘版本', exact: true }).click(); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true'); await expect(page.getByRole('textbox')).toHaveText('# disk1 local')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.getByRole('button', { name: '使用磁盘版本', exact: true }).click(); await expect(page.getByRole('textbox')).toHaveText('# disk3')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' newest')
    await writeFile(path, '# disk4'); await page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click()
    await expect.poll(() => readFile(path, 'utf8')).toBe('# disk3 newest')
    await expect(page.getByRole('status')).toContainText('已保存'); await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0)
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page.getByRole('textbox')).toHaveText('# disk3'); await expect(page.getByRole('status')).toContainText('待保存')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('SaveAs cancel, opened target and real invalid-parent failure keep A editable and both original files intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-saveas-fail-')); const a = join(root, 'a.md'); const b = join(root, 'b.md'); await writeFile(a, 'A'); await writeFile(b, 'B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, a); await select(app, page, b); await page.getByRole('tab', { name: 'a.md', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }) })
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true'); await expect(page.getByRole('alert')).toHaveCount(0)
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, b)
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('alert')).toContainText('另一文档中打开')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, join(root, 'missing-parent', 'copy.md'))
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(page.getByRole('textbox')).toHaveText('A local'); expect(await readFile(a, 'utf8')).toBe('A'); expect(await readFile(b, 'utf8')).toBe('B')
    await page.getByRole('textbox').focus(); await page.keyboard.insertText(' editable'); await expect(page.getByRole('textbox')).toContainText('editable')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('SaveAs in reading mode changes relative image root and asks before crossing directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-saveas-images-')); const a = join(root, 'a.md'); const target = join(root, 'next', 'copy.md')
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(root, 'next'))
  await writeFile(a, '![pixel](pixel.png)')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(root, 'pixel.png'), png); await writeFile(join(root, 'next', 'pixel.png'), png)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, a); const image = page.getByRole('button', { name: 'pixel', exact: true }); await expect(image).toBeVisible(); await expect(image).toHaveJSProperty('naturalWidth', 1); const before = await image.getAttribute('src')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      dialog.showMessageBox = async (_window, options) => { Reflect.set(globalThis, 'directoryWarning', options.message); return { response: 1, checkboxChecked: false } }
    }, target)
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('tab', { name: 'copy.md', exact: true })).toBeVisible()
    expect(await app.evaluate(() => Reflect.get(globalThis, 'directoryWarning'))).toBe('相对图片和链接将按新目录解析')
    await expect(image).not.toHaveAttribute('src', before!); await expect(image).toBeVisible(); await expect(image).toHaveJSProperty('naturalWidth', 1)
    expect(await readFile(target, 'utf8')).toBe('![pixel](pixel.png)')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('readonly hard-link SaveAs cancellation and failure preserve source; verified copy can be edited and saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-readonly-copy-')); const original = join(root, 'original.md'); const alias = join(root, 'alias.md'); const copy = join(root, 'copy.md')
  const { link } = await import('node:fs/promises'); await writeFile(original, '# linked'); await link(original, alias)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, alias); await expect(page.locator('.document-status')).toContainText('只读 · 链接文件暂不支持编辑')
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }) })
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, original)
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('alert')).toContainText('不能写回')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, copy)
    await page.keyboard.press('ControlOrMeta+Shift+s'); await expect(page.getByRole('tab', { name: 'copy.md', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' copy edit')
    await page.keyboard.press('ControlOrMeta+s'); await expect(page.getByRole('status')).toContainText('已保存')
    expect(await readFile(copy, 'utf8')).toBe('# linked copy edit'); expect(await readFile(original, 'utf8')).toBe('# linked'); expect(await readFile(alias, 'utf8')).toBe('# linked')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('readable permission-readonly file stays available after focus and reconcile and closes normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-readonly-focus-')); const path = join(root, 'readonly.md')
  await writeFile(path, '# readonly'); await chmod(path, 0o444)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path)
    await expect(page.locator('.document-status')).toContainText('没有写入权限')
    const result = await page.evaluate(async () => {
      const opened = await window.inknest.openFile()
      if (opened.status !== 'ok') throw new Error('missing opened document')
      return window.inknest.reconcileExternal({ ref: { docId: opened.value.docId, epoch: opened.value.epoch }, snapshot: null })
    })
    expect(result).toEqual({ status: 'ok', value: { kind: 'unchanged' } })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.emit('focus') })
    await expect(page.getByRole('heading', { name: 'readonly', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0)
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => { throw new Error('clean readonly must not prompt') }
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.windows().length).toBe(0); expect(await readFile(path, 'utf8')).toBe('# readonly')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
