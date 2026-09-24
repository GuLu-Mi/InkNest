import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { openDocumentPicker } from './open-document'

const frame = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const offset = (page: Page) => page.getByText('返回后继续阅读这一段。', { exact: true }).evaluate(node => node.getBoundingClientRect().top - node.closest('.document-stage')!.getBoundingClientRect().top)

test('linked tabs and edit preview retain reading content, disclosures and inner code scroll after rich layout settles', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-reading-position-')), file = join(root, 'reading.md')
  const code = Array.from({ length: 130 }, (_, i) => `// line ${i}: ${'wrapped-code-'.repeat(18)}`).join('\n')
  const source = '# 阅读位置\n\n```mermaid\nflowchart TD\n A[开始] --> B[阅读] --> C[继续]\n```\n\n<details>\n<summary>展开的阅读内容</summary>\n\n' + '上面的展开内容。\n\n'.repeat(20) + '\n```text\n' + code + '\n```\n\n返回后继续阅读这一段。\n\n[查看其他文档](other.md)\n\n' + '后续段落。\n\n'.repeat(40) + '</details>\n'
  await writeFile(file, source); await writeFile(join(root, 'other.md'), '# 其他文档\n\n另一份内容。')
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`, file], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 900))
    await expect(page.locator('.diagram-view svg')).toHaveCount(1)
    await page.getByText('展开的阅读内容', { exact: true }).click()
    const block = page.locator('.code-block').nth(1), content = block.locator('.code-content')
    await expect(block.getByRole('button', { name: '展开代码', exact: true })).toBeVisible()
    await content.scrollIntoViewIfNeeded(); await frame(page)
    const stageTop = await page.locator('.document-stage').evaluate(node => node.scrollTop)
    const box = await content.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 240)
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(100)
    await frame(page)
    expect(await page.locator('.document-stage').evaluate(node => node.scrollTop)).toBe(stageTop)
    // A focused code viewport is also scrollable using the keyboard.
    await content.focus(); const beforeKey = await content.evaluate(node => node.scrollTop)
    await page.keyboard.press('PageDown')
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeKey)
    // Wait for Chromium's native keyboard scroll animation before arranging a bookmark.
    let lastTop = -1, stableFrames = 0
    await expect.poll(async () => {
      const top = await content.evaluate(node => node.scrollTop)
      stableFrames = top === lastTop ? stableFrames + 1 : 0; lastTop = top
      return stableFrames
    }).toBeGreaterThanOrEqual(2)
    await content.evaluate(node => { node.scrollTop = 640 })
    await page.getByText('返回后继续阅读这一段。', { exact: true }).evaluate(node => {
      const stage = node.closest('.document-stage')!
      stage.scrollTop += node.getBoundingClientRect().top - stage.getBoundingClientRect().top - 90
    })
    await frame(page)
    const previousOffset = await offset(page)
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('link', { name: '查看其他文档', exact: true }).click({ modifiers: ['ControlOrMeta'] })
      await expect(page.getByRole('heading', { name: '其他文档', exact: true })).toBeVisible()
      await page.getByRole('tab', { name: 'reading.md', exact: true }).click()
      await expect(page.locator('.diagram-view svg')).toHaveCount(1)
      await expect(page.locator('details')).toHaveAttribute('open', '')
      await expect.poll(async () => Math.abs(await offset(page) - previousOffset)).toBeLessThan(2)
      await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(640)
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      if (cycle === 1) {
        const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
        await editor.focus(); await page.keyboard.press('ControlOrMeta+Home')
        await page.keyboard.insertText('插入在阅读位置之前的新段落。\n\n'.repeat(15))
      }
      await page.getByRole('button', { name: '预览', exact: true }).click()
      await expect(page.locator('.diagram-view svg')).toHaveCount(1)
      await expect(page.locator('details')).toHaveAttribute('open', '')
      await expect.poll(async () => Math.abs(await offset(page) - previousOffset)).toBeLessThan(2)
      await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(640)
    }
    // Expanded code and diagram source mode also change the height above the reading point.
    await block.getByRole('button', { name: '展开代码', exact: true }).click()
    await page.getByRole('button', { name: '查看源码', exact: true }).click()
    await page.getByText('返回后继续阅读这一段。', { exact: true }).evaluate(node => {
      const stage = node.closest('.document-stage')!
      stage.scrollTop += node.getBoundingClientRect().top - stage.getBoundingClientRect().top - 90
    })
    await frame(page)
    const expandedOffset = await offset(page)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(block.getByRole('button', { name: '收起代码', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '查看图表', exact: true })).toBeVisible()
    await expect.poll(async () => Math.abs(await offset(page) - expandedOffset)).toBeLessThan(2)
    // Leave in the same task as a scroll, before the queued scroll event runs.
    await page.evaluate(() => {
      document.querySelector('.document-stage')!.scrollTop += 100
      ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '编辑')!.click()
    })
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.getByRole('button', { name: '查看图表', exact: true })).toBeVisible()
    await expect.poll(async () => Math.abs(await offset(page) - (expandedOffset - 100))).toBeLessThan(2)
    await frame(page)
    await writeFile(test.info().outputPath('reading-restored.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    expect(await readFile(join(root, 'other.md'), 'utf8')).toBe('# 其他文档\n\n另一份内容。')
    // Removing the original block falls back to the available document bounds.
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox', { name: 'Markdown 源码' }).focus()
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# 替换后的短文档\n\n新内容。')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.getByRole('heading', { name: '替换后的短文档', exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.document-stage').evaluate(node => node.scrollTop)).toBe(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('a delayed local image does not shift the restored reading paragraph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-reading-image-')), file = join(root, 'image.md')
  const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#dceeff' } }).png().toBuffer()
  await writeFile(join(root, 'image.png'), png)
  const source = '# 图片加载与阅读位置\n\n![延迟图片](image.png)\n\n' + Array.from({ length: 65 }, (_, i) => `段落 ${i}：继续阅读这里的内容。\n\n`).join('')
  await writeFile(file, source)
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    // Control only image response timing in this isolated process; parsing,
    // resource authorization, decoding and layout still use the application.
    await app.evaluate(({ protocol, dialog }, { file, bytes }) => {
      const pending: (() => void)[] = []
      let released = false
      const response = () => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
      protocol.unhandle('inknest-resource')
      protocol.handle('inknest-resource', () => released ? response() : new Promise<Response>(resolve => pending.push(() => resolve(response()))))
      Reflect.set(globalThis, 'finishReadingImage', () => { released = true; pending.splice(0).forEach(finish => finish()) })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, { file, bytes: [...png] })
    await openDocumentPicker(page)
    const target = page.getByText('段落 35：继续阅读这里的内容。', { exact: true })
    await expect(target).toBeVisible()
    await target.evaluate(node => { const stage = node.closest('.document-stage')!; stage.scrollTop += node.getBoundingClientRect().top - stage.getBoundingClientRect().top - 40 })
    await frame(page)
    const top = () => target.evaluate(node => node.getBoundingClientRect().top - node.closest('.document-stage')!.getBoundingClientRect().top)
    const savedTop = await top()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect.poll(async () => Math.abs(await top() - savedTop)).toBeLessThan(2)
    await app.evaluate(() => Reflect.get(globalThis, 'finishReadingImage')())
    await expect.poll(() => page.locator('.preview img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(600)
    await frame(page)
    expect(Math.abs(await top() - savedTop)).toBeLessThan(2)
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
