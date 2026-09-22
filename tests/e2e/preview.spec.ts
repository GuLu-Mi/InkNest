import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

test('preview resolves resources only for initial render, content revisions and document identity changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-preview-revisions-'))
  const first = join(root, 'first.md'); const second = join(root, 'second.md')
  await writeFile(first, '# First\n\n![sample](missing.png)')
  await writeFile(second, '# Second\n\n![sample](missing.png)')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    // Observe preview's IPC boundary without changing its Vue/CodeMirror lifecycle.
    await app.evaluate(({ ipcMain, dialog }) => {
      Reflect.set(globalThis, 'previewRequests', [])
      ipcMain.removeHandler('document:resources')
      ipcMain.handle('document:resources', (_event, ref, refs) => {
        Reflect.get(globalThis, 'previewRequests').push(ref)
        return { status: 'ok', value: refs.map((item: { key: string }) => ({ key: item.key, url: null, blockedReason: 'unavailable' })) }
      })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    const requests = () => app.evaluate(() => Reflect.get(globalThis, 'previewRequests') as { docId: string; epoch: string }[])
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, first)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: 'First' })).toBeVisible()
    expect(await requests()).toHaveLength(1)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    // Exceed the preview debounce so an unwanted resource request cannot hide in a timer.
    await page.waitForTimeout(300)
    expect(await requests()).toHaveLength(1)
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('\n\nChanged content')
    await page.waitForTimeout(300)
    expect(await requests()).toHaveLength(1)
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.preview')).toContainText('Changed content')
    expect(await requests()).toHaveLength(2)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, second)
    await openDocumentPicker(page)
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Second' })).toBeVisible()
    const calls = await requests()
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[2]!.docId).not.toBe(calls[0]!.docId)
    expect(calls[2]!.epoch).not.toBe(calls[0]!.epoch)
    const current = await page.evaluate(() => window.inknest.openFile())
    if (current.status !== 'ok') throw new Error('Expected current document')
    // A new epoch alone must refresh even if docId and revision are unchanged.
    await app.evaluate(({ BrowserWindow }, document) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('document:event', {
        type: 'document-opened', document: { ...document, epoch: '11111111-1111-4111-8111-111111111111', text: '# New epoch\n\n![sample](missing.png)' }
      })
    }, current.value)
    await expect(page.getByRole('heading', { name: 'New epoch' })).toBeVisible()
    expect(await requests()).toHaveLength(4)
    // A duplicate open event deliberately does not restart selection; activate the registered ref.
    expect(await page.evaluate(document => window.inknest.activateDocument({ docId: document.docId, epoch: document.epoch }), current.value)).toMatchObject({ status: 'ok' })
    await expect(page.getByRole('heading', { name: 'Second' })).toBeVisible()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('opens Chinese Markdown, displays authorized PNG, blocks remote requests and preserves failed additive opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-preview-'))
  let hits = 0
  const server = createServer((_req, res) => { hits++; res.end('tracked') })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', '图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64'))
  const document = join(root, 'docs', '中文.md')
  await writeFile(document, `# 本地阅读\n\n![合法](图.png)\n\n![越界](../secret.png)\n\n![远程](http://127.0.0.1:${address.port}/track.png)\n\n<script>window.pwned=true</script>\n\n<img src=x onerror=alert(1)>`)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, document)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: '本地阅读' })).toBeVisible()
    await expect(page.getByAltText('合法')).toBeVisible()
    await expect.poll(() => page.getByAltText('合法').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
    expect(await page.locator('.preview img').count()).toBe(1)
    await expect(page.getByText('远程图片未加载', { exact: false }).first()).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined()
    await page.screenshot({ path: test.info().outputPath('preview.png') })
    const oldUrl = await page.getByAltText('合法').getAttribute('src')
    expect(await app.evaluate(async ({ net }, url) => (await net.fetch(url!, { cache: 'no-store' })).status, oldUrl)).toBe(200)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(root, 'missing.md'))
    await openDocumentPicker(page)
    await expect(page.getByRole('alert')).toContainText('文件不存在')
    await expect(page.getByRole('heading', { name: '本地阅读' })).toBeVisible()
    const next = join(root, 'next.md'); await writeFile(next, '# 第二份')
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, next)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: '第二份' })).toBeVisible()
    expect(await app.evaluate(async ({ net }, url) => (await net.fetch(url!, { cache: 'no-store' })).status, oldUrl)).toBe(200)
    await page.waitForTimeout(200)
    expect(hits).toBe(0)
  } finally {
    app.process().kill('SIGKILL'); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true })
  }
})

test('reports size and encoding limits, allows scrolling, and treats picker cancellation as normal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-limits-'))
  const large = join(root, 'large.md'); await writeFile(large, '# large\n' + 'line\n'.repeat(430000))
  const unsupported = join(root, 'bad.md'); await writeFile(unsupported, Buffer.from([0xff, 0xfe, 0x41, 0]))
  const huge = join(root, 'huge.md'); await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, large)
    await openDocumentPicker(page)
    await expect(page.getByRole('status')).toContainText('只读 · 文件过大')
    await expect(page.locator('.plain-document')).toBeVisible()
    expect(await page.locator('.document-stage').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await openDocumentPicker(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.plain-document')).toBeVisible()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, huge)
    await openDocumentPicker(page)
    await expect(page.getByRole('alert')).toContainText('文件过大')
    await expect(page.locator('.plain-document')).toBeVisible()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, unsupported)
    await openDocumentPicker(page)
    await expect(page.locator('.document-status')).toContainText('此文件的编码暂不支持编辑')
    const current = await page.evaluate(() => window.inknest.openFile())
    if (current.status !== 'ok') throw new Error('No session')
    const ref = { docId: current.value.docId, epoch: current.value.epoch }
    expect(await page.evaluate((ref) => window.inknest.resolveResources({ ...ref, epoch: '00000000-0000-0000-0000-000000000000' }, []), ref)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
    expect(await page.evaluate((ref) => Reflect.apply(window.inknest.resolveResources, null, [{ ...ref, extra: true }, []]), ref)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('clears previous document preview during a new session render and keeps it cleared on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-preview-transition-'))
  const first = join(root, 'first.md'); await writeFile(first, '# 旧文档正文')
  const next = join(root, 'next.md'); await writeFile(next, '# 新文档正文\n\n![图片](missing.png)')
  const final = join(root, 'final.md'); await writeFile(final, '# 最后文档')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, first)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: '旧文档正文' })).toBeVisible()
    // Fault injection remains in the Playwright main process, outside the production bridge.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('document:resources')
      ipcMain.handle('document:resources', () => new Promise((_resolve, reject) => {
        Reflect.set(globalThis, 'rejectPreviewForTest', () => reject(new Error('Injected preview failure')))
      }))
    })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, next)
    await openDocumentPicker(page)
    await expect(page.getByRole('tab', { selected: true })).toContainText('next.md')
    await expect(page.getByText('正在生成预览…')).toBeVisible()
    await expect(page.getByRole('heading', { name: '旧文档正文' })).toHaveCount(0)
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'rejectPreviewForTest'))).toBe('function')
    await app.evaluate(() => { Reflect.get(globalThis, 'rejectPreviewForTest')() })
    await expect(page.getByRole('alert')).toContainText('预览失败')
    await expect(page.locator('.preview')).toBeEmpty()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, final)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: '最后文档' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
