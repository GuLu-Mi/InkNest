import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('outline safely shares heading IDs, navigates reading and original editor undo, and defers composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-outline-')); const file = join(root, 'outline.md')
  const source = '# 中文\n\n### 子节\n\n' + 'paragraph\n\n'.repeat(60) + '# 中文\n\n## 最后 `code` [链接](https://example.com)\n\n```md\n# 非标题\n```\n\n<h1 id="injected">bad</h1>'
  await writeFile(file, source)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    const outline = page.getByRole('navigation', { name: '文档目录', exact: true })
    await expect(outline).toBeVisible()
    await expect(outline.getByRole('button', { name: '中文', exact: true })).toHaveCount(2)
    await expect(outline).not.toContainText('非标题')
    expect(await page.locator('.preview :is(h1,h2,h3)').evaluateAll(nodes => nodes.map(node => node.id))).toEqual(['inknest-heading-0', 'inknest-heading-1', 'inknest-heading-2', 'inknest-heading-3'])
    await expect(page.locator('.preview [href], .preview #injected')).toHaveCount(0)
    await outline.getByRole('button', { name: '最后 code 链接', exact: true }).click()
    await expect(outline.getByRole('button', { name: '最后 code 链接', exact: true })).toHaveAttribute('aria-current', 'location')
    expect(await page.locator('.document-stage').evaluate(node => node.scrollTop)).toBeGreaterThan(500)
    await outline.getByRole('button', { name: '收起 中文', exact: true }).last().click()
    await expect(outline.getByRole('button', { name: '最后 code 链接', exact: true })).toHaveCount(0)
    await expect(outline.getByRole('button', { name: '中文', exact: true }).last()).toHaveAttribute('aria-current', 'location')
    await outline.getByRole('button', { name: '展开 中文', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
    await outline.getByRole('button', { name: '最后 code 链接', exact: true }).click()
    await expect(editor).toBeFocused()
    await page.keyboard.insertText('INSERT')
    await expect(editor).toContainText('INSERT## 最后')
    await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('INSERT')
    await editor.dispatchEvent('compositionstart')
    await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('# 延后\n\n')
    await page.waitForTimeout(300)
    await expect(outline.getByRole('button', { name: '延后', exact: true })).toHaveCount(0)
    await expect(editor).toBeFocused()
    await editor.dispatchEvent('compositionend'); await expect(outline.getByRole('button', { name: '延后', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('延后')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect.poll(() => readFile(file, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('current and historical outlines preserve folds, reading positions and responsive sidebar preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-outline-layout-')); const file = join(root, 'source.md'); const other = join(root, 'other.md')
  const historical = '# Historical\n\n' + Array.from({ length: 45 }, (_, i) => `## Old ${i}\n\nParagraph ${i}.\n\n`).join('')
  const current = historical.replace('# Historical', '# Current').replaceAll('## Old', '## New')
  await writeFile(file, historical); await writeFile(other, '# Other\n\n## Child')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })

  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    for (const path of [other, file]) {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
      await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path)
    }
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(current)
    await page.getByRole('button', { name: '预览', exact: true }).click(); await expect.poll(() => readFile(file, 'utf8')).toBe(current)
    const nav = page.getByRole('navigation', { name: '文档目录', exact: true })
    await expect(nav.getByRole('button', { name: 'New 0', exact: true })).toBeVisible()
    await nav.evaluate(node => { node.scrollTop = 300 }); await expect.poll(() => nav.evaluate(node => node.scrollTop)).toBe(300)
    await page.getByRole('tab', { name: 'other.md', exact: true }).click()
    await expect(nav.getByRole('button', { name: 'Other', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'source.md', exact: true }).click()
    await expect.poll(() => nav.evaluate(node => node.scrollTop)).toBe(300)
    await nav.getByRole('button', { name: '收起 Current', exact: true }).click()
    await expect(nav.getByRole('button', { name: 'New 0', exact: true })).toHaveCount(0)
    // Explicitly keep this document's outline open when shrinking below the default-open width.
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    await page.getByRole('button', { name: '文档目录', exact: true }).click()
    for (const [width, height, zoom] of [[1920, 1080, 1], [1200, 800, 1], [800, 600, 1], [800, 600, 2]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom) }, { width, height, zoom })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      await page.getByRole('button', { name: '历史版本', exact: true }).click()
      const list = page.getByRole('complementary', { name: '历史版本', exact: true })
      await expect(list).toBeVisible()
      await list.getByRole('button', { name: '预览', exact: true }).last().click()
      await expect(page.locator('.preview h1')).toHaveText('Historical')
      if (width / zoom < 960) { await expect(nav).toHaveCount(0); await page.getByRole('button', { name: '文档目录', exact: true }).click() }
      await expect(nav.getByRole('button', { name: 'Old 0', exact: true })).toBeVisible()
      await expect(nav).not.toContainText('Current')
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, outline: document.querySelector('.document-outline')!.getBoundingClientRect().width, history: document.querySelector('.history-sidebar')?.getBoundingClientRect().width ?? 0, bodyHeight: document.querySelector('.document-stage')!.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth }))
      expect(geometry.outline).toBe(Math.min(280, width / zoom * 0.3))
      expect(geometry.history).toBe(width / zoom >= 960 ? 300 : 0); expect(geometry.overflow).toBe(false); expect(geometry.bodyHeight).toBeGreaterThanOrEqual(100)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(`outline-history-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
      await nav.getByRole('button', { name: 'Old 20', exact: true }).click()
      await expect(nav).toBeVisible()
      await expect(page.locator('.preview h1')).toHaveText('Historical')
      await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(`outline-navigated-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
      await page.getByRole('button', { name: '返回当前文档', exact: true }).click()
      if (width / zoom >= 960) await page.getByRole('button', { name: '关闭历史', exact: true }).click()
      await expect(page.locator('.preview h1')).toHaveText('Current')
      await expect(nav.getByRole('button', { name: '展开 Current', exact: true })).toBeVisible()
    }
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.webContents.setZoomFactor(1); window.setSize(1920, 1080) })
    await expect(nav).toBeVisible()
    await page.getByRole('button', { name: '关闭目录', exact: true }).click(); await expect(nav).toHaveCount(0)
    await page.getByRole('tab', { name: 'other.md', exact: true }).click(); await expect(nav).toBeVisible()
    await page.getByRole('tab', { name: 'source.md', exact: true }).click(); await expect(nav).toHaveCount(0)
    await page.getByRole('button', { name: '文档目录', exact: true }).click(); await expect(nav).toBeVisible()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('heading-free and oversized documents do not reserve a sidebar and explain explicit outline opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-outline-empty-')); const file = join(root, 'empty.md'); const large = join(root, 'large.md')
  await writeFile(file, 'No headings'); await writeFile(large, '# Large\n' + 'plain\n'.repeat(360000))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    for (const [path, message] of [[file, '此文档没有标题'], [large, '大文件使用纯文本阅读，目录暂不可用']]) {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path!] }) }, path)
      await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path!)
      const nav = page.getByRole('navigation', { name: '文档目录', exact: true }); await expect(nav).toHaveCount(0)
      await page.getByRole('button', { name: '文档目录', exact: true }).click(); await expect(nav).toContainText(message!)
      await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    }
    await expect(page.locator('.plain-document')).toBeVisible(); await expect(page.locator('.preview')).toHaveCount(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('reading navigation waits for the authorized preview render and cancels across source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-outline-delayed-')); const file = join(root, 'source.md'); const other = join(root, 'other.md')
  await writeFile(file, '# Start\n\n' + 'paragraph\n\n'.repeat(80) + '# Target\n\n![wait](missing.png)\n\n' + 'tail\n\n'.repeat(30)); await writeFile(other, '# Other')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('document:resources')
      ipcMain.handle('document:resources', () => new Promise(resolve => Reflect.set(globalThis, 'releaseOutlineRender', () => resolve({ status: 'ok', value: [] }))))
    })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    const target = page.getByRole('navigation', { name: '文档目录', exact: true }).getByRole('button', { name: 'Target', exact: true })
    await expect(target).toBeVisible(); await expect(page.locator('.preview')).toBeEmpty()
    await target.click()
    await app.evaluate(() => Reflect.get(globalThis, 'releaseOutlineRender')())
    await expect(page.getByRole('heading', { name: 'Target', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(target).toHaveAttribute('aria-current', 'location')
    // Remount with another pending render; an old navigation must not move the next tab.
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('button', { name: '预览', exact: true }).click()
    await target.click()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, other)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Other', exact: true })).toBeVisible()
    await app.evaluate(() => Reflect.get(globalThis, 'releaseOutlineRender')())
    await expect(page.locator('.document-stage')).toHaveJSProperty('scrollTop', 0)
    await expect(page.locator('.preview h1')).toHaveText('Other')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
