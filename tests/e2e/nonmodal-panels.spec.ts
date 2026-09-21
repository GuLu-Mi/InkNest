import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('side panels leave the document scrollable selectable and editable at small widths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-nonmodal-')); const file = join(root, 'doc.md')
  await writeFile(file, '# Reading\n\n' + 'Readable text that remains accessible.\n\n'.repeat(120))
  const executablePath = process.env.INKNEST_TEST_EXECUTABLE
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    for (const [width, zoom] of [[1200, 1], [800, 1], [800, 2]] as const) {
      await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(width, 800); w.webContents.setZoomFactor(zoom) }, { width, zoom })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      for (const [trigger, panelName, close] of [['文档目录', '文档目录面板', '关闭目录'], ['历史版本', '历史版本', '关闭历史']]) {
        await page.getByRole('button', { name: trigger, exact: true }).click()
        await expect(page.locator('dialog:modal')).toHaveCount(0)
        const panel = page.getByRole('complementary', { name: panelName, exact: true }); await expect(panel).toBeVisible()
        const stage = page.locator('.document-stage'); const before = await stage.evaluate(el => el.scrollTop)
        const box = await stage.boundingBox(); await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.wheel(0, 240)
        await expect.poll(() => stage.evaluate(el => el.scrollTop)).toBeGreaterThan(before)
        const paragraph = page.locator('.preview p').first()
        await paragraph.dblclick()
        await expect.poll(() => page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0)
        await expect(panel).toBeVisible()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await writeFile(test.info().outputPath(`${trigger}-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
        const bounds = await panel.boundingBox(); expect(bounds!.y).toBeGreaterThanOrEqual(40)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.getByRole('button', { name: close, exact: true }).click()
      }
    }
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('\nStill editable')
    await expect(page.getByRole('textbox')).toContainText('Still editable')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('textbox')).not.toContainText('Still editable')
    await expect(page.getByRole('complementary', { name: '历史版本', exact: true })).toBeVisible()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
