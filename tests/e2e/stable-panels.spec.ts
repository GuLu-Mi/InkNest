import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('wide panel toggles preserve body geometry and scroll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-stable-panels-')); const file = join(root, 'doc.md')
  await writeFile(file, '# Stable\n\n' + 'A paragraph that keeps the reading position.\n\n'.repeat(120))
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    const screenshot = async (name: string) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    }
    await app.evaluate(({ BrowserWindow, dialog }, file) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await openDocumentPicker(page)
    await expect(page.locator('.preview h1')).toHaveText('Stable')
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    const geometry = () => page.locator('.document-content').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width, height: r.height, scroll: document.querySelector('.document-stage')!.scrollTop } })
    await page.locator('.document-stage').evaluate(el => { el.scrollTop = 400 })
    const before = await geometry()
    for (const label of ['文档目录', '历史版本', '关闭目录', '关闭历史']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      expect(await geometry()).toEqual(before)
      if (label === '历史版本') await screenshot('stable-both-panels.png')
    }
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(page.getByText('自动保存按1分钟合并，手动保存保留独立节点。', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '关闭历史', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // CodeMirror refines virtual document height after mounting; compare the
    // actual reading viewport and horizontal content geometry, not that estimate.
    const editorGeometry = () => page.locator('.cm-content').evaluate(el => {
      const rect = el.getBoundingClientRect(); const viewport = el.closest('.cm-scroller')!
      return { x: rect.x, width: rect.width, top: viewport.scrollTop, height: viewport.clientHeight }
    })
    const editor = await editorGeometry()
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    expect(await editorGeometry()).toEqual(editor)
    await page.getByRole('button', { name: '关闭历史', exact: true }).click()
    await page.getByRole('button', { name: '预览', exact: true }).click()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('scroll edges follow the viewport and history while narrow reflow preserves visible text', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-scroll-edges-')); const file = join(root, 'doc.md')
  await writeFile(file, '# Scroll boundaries\n\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ${'Readable words keep their place across narrower lines. '.repeat(12)}\n\n`).join(''))
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await openDocumentPicker(page)
    await expect(page.locator('.preview h1')).toHaveText('Scroll boundaries')
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const closePanels = async () => {
      for (const label of ['关闭目录', '关闭历史']) if (await page.getByRole('button', { name: label, exact: true }).count()) await page.getByRole('button', { name: label, exact: true }).click()
    }
    const checkEdge = async (selector: string) => {
      await settle()
      const edge = await page.locator(selector).evaluate(el => ({ right: el.getBoundingClientRect().right, expected: document.querySelector('.history-sidebar')?.getBoundingClientRect().left ?? innerWidth }))
      expect(Math.abs(edge.right - edge.expected)).toBeLessThanOrEqual(1)
    }
    for (const [width, zoom] of [[1920, 1], [1200, 1], [800, 1], [1920, 2], [800, 2]] as const) {
      await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(width, 900); w.webContents.setZoomFactor(zoom) }, { width, zoom })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      for (const theme of ['浅色主题', '深色主题']) {
        await page.getByRole('radio', { name: theme, exact: true }).click()
        for (const panels of [[], ['文档目录'], ['历史版本'], ['文档目录', '历史版本']]) {
          await closePanels()
          for (const label of panels) await page.getByRole('button', { name: label, exact: true }).click()
          await checkEdge('.document-stage')
          await page.getByRole('button', { name: '编辑', exact: true }).click()
          await checkEdge('.cm-scroller')
          expect(await page.locator('.document-stage').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true)
          await page.getByRole('button', { name: '预览', exact: true }).click()
        }
      }
    }
    await closePanels()
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(1200, 900); w.webContents.setZoomFactor(1) })
    await settle()
    await page.locator('.preview p').nth(30).evaluate(el => { const stage = document.querySelector('.document-stage')!; stage.scrollTop += el.getBoundingClientRect().top - stage.getBoundingClientRect().top + 55 })
    await settle()
    const anchor = await page.evaluateHandle(() => {
      const stage = document.querySelector('.document-stage')!.getBoundingClientRect()
      const body = document.querySelector('.document-content')!.getBoundingClientRect()
      const point = document.caretPositionFromPoint(body.left + 8, stage.top + 8)!
      const range = document.createRange(); range.setStart(point.offsetNode, point.offset); range.setEnd(point.offsetNode, Math.min(point.offset + 1, point.offsetNode.textContent!.length)); return range
    })
    const top = await anchor.evaluate(range => range.getBoundingClientRect().top)
    // Repeated round trips must keep the original character, not accumulate a
    // line of drift by choosing a new left-edge character after each reflow.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const label of ['文档目录', '关闭目录']) {
        await page.getByRole('button', { name: label, exact: true }).click()
        await settle()
        expect(Math.abs(await anchor.evaluate(range => range.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1)
      }
    }
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
