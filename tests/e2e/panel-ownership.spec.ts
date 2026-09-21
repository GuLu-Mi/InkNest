import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('panels belong to each document and historical navigation always retains access to other versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-panel-owners-')); const a = join(root, 'a.md'); const b = join(root, 'b.md')
  const original = '# Original\n\n' + Array.from({ length: 40 }, (_, i) => `## ${i} 订阅应付金额 payable_amount 测试说明\n\n${'Reading content. '.repeat(15)}\n\n`).join('')
  await writeFile(a, original); await writeFile(b, '# Other\n\nOther document')
  const executablePath = process.env.INKNEST_TEST_EXECUTABLE
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    const open = async (file: string) => { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file); await page.getByRole('button', { name: '打开文档', exact: true }).first().click() }
    await open(a); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('\nrevision-two')
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.flatMap(x => x.submenu?.items ?? []).find(x => x.label === '立即保存')!.click() })
    await expect.poll(() => readFile(a, 'utf8')).toContain('revision-two')
    await page.getByRole('button', { name: '预览', exact: true }).click(); await open(b)
    const outline = page.getByRole('complementary', { name: '文档目录面板', exact: true }); const history = page.getByRole('complementary', { name: '历史版本', exact: true })
    await page.getByRole('tab', { name: 'a.md', exact: true }).click()
    await page.getByRole('button', { name: '文档目录', exact: true }).click(); await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(outline).toBeVisible(); await expect(history).toBeVisible()
    const bounds = await outline.boundingBox(); expect(bounds!.width).toBe(280)
    const list = await outline.getByRole('navigation').boundingBox(); expect(bounds!.x + bounds!.width - list!.x - list!.width).toBeLessThanOrEqual(2)
    await page.getByRole('tab', { name: 'b.md', exact: true }).click(); await expect(outline).toHaveCount(0); await expect(history).toHaveCount(0)
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('tab', { name: 'a.md', exact: true }).click(); await expect(outline).toBeVisible(); await expect(history).toBeVisible()
    await page.getByRole('button', { name: '关闭历史', exact: true }).click()
    await page.getByRole('tab', { name: 'b.md', exact: true }).click(); await expect(history).toBeVisible(); await expect(outline).toHaveCount(0)
    await page.getByRole('tab', { name: 'a.md', exact: true }).click(); await expect(history).toHaveCount(0); await expect(outline).toBeVisible()
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await history.getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview')).not.toContainText('revision-two')
    await expect(page.locator('.history-preview-actions button').last()).toHaveText('历史版本')
    await expect(page.getByRole('button', { name: '还原此版本', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    await page.getByRole('button', { name: '文档目录', exact: true }).click(); await expect(history).toBeVisible(); await expect(outline).toBeVisible()
    await history.getByRole('button', { name: '预览', exact: true }).first().click(); await expect(page.locator('.preview')).toContainText('revision-two')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await writeFile(test.info().outputPath('history-outline-1200.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 800))
    await expect(outline).toHaveCount(0)
    await page.getByRole('button', { name: '文档目录', exact: true }).click(); await expect(outline).toBeVisible(); await expect(history).toHaveCount(0)
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await expect(history).toBeVisible(); await expect(outline).toHaveCount(0)
    await history.getByRole('button', { name: '预览', exact: true }).last().click(); await expect(page.locator('.preview')).not.toContainText('revision-two')
    await expect(page.locator('.history-preview-actions button').last()).toHaveText('历史版本')
    await expect(page.getByRole('button', { name: '还原此版本', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toBeVisible()
    await expect(page.locator('dialog:modal')).toHaveCount(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
