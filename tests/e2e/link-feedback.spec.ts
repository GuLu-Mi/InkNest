import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('parent documents, explicit anchors and Finder targets open directly; failures are transient overlays', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-link-feedback-')))
  await mkdir(join(root, 'docs')); await mkdir(join(root, 'data'))
  const source = join(root, 'docs/compatibility.md')
  await writeFile(source, '# 兼容性\n\n[使用指南](../GETTING_STARTED.md)\n\n[后续验收](validation.md#acceptance)\n\n[不存在章节](validation.md#not-present)\n\n[不存在文件](missing.md)\n\n[附件](' + join(root, 'data/android-app-labels.json') + ')\n\n[目录](../data)')
  await writeFile(join(root, 'GETTING_STARTED.md'), '# 使用指南\n\n指南正文')
  await writeFile(join(root, 'docs/validation.md'), '# 验收\n\n' + '验收说明\n\n'.repeat(100) + '<a id="acceptance"></a>\n## 后续真机验收\n\n验收内容\n\n' + '更多说明\n\n'.repeat(30))
  await writeFile(join(root, 'data/android-app-labels.json'), '{}')
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog, shell }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      Reflect.set(globalThis, 'fileCalls', [])
      shell.showItemInFolder = path => { Reflect.get(globalThis, 'fileCalls').push(['reveal', path]) }
      shell.openPath = async path => { Reflect.get(globalThis, 'fileCalls').push(['directory', path]); return '' }
    }, source)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: '兼容性', exact: true })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('Link must not launch a picker') } })
    const modifiers = [process.platform === 'darwin' ? 'Meta' as const : 'Control' as const]
    await page.getByRole('link', { name: '使用指南', exact: true }).click({ modifiers })
    await expect(page.getByRole('tab', { name: 'GETTING_STARTED.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: '使用指南', exact: true })).toBeVisible()
    const back = async () => { await page.getByRole('tab', { name: 'compatibility.md', exact: true }).click() }
    await back()
    await page.getByRole('link', { name: '后续验收', exact: true }).click({ modifiers })
    await expect(page.getByRole('tab', { name: 'validation.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: '后续真机验收', exact: true })).toBeInViewport()
    await expect(page.locator('.toast-notice')).toHaveCount(0)
    await back()
    await page.getByRole('link', { name: '不存在章节', exact: true }).click({ modifiers })
    const toast = page.locator('.toast-notice')
    await expect(toast).toHaveText('未找到对应章节')
    await expect(toast).toHaveCSS('position', 'fixed')
    await expect(toast).toHaveCount(0, { timeout: 3500 })
    await back()
    const outline = page.getByRole('button', { name: '文档目录', exact: true })
    if (await outline.getAttribute('aria-expanded') !== 'true') await outline.click()
    const bodyBefore = await page.locator('.document-stage').boundingBox()
    await page.getByRole('link', { name: '不存在文件', exact: true }).click({ modifiers })
    await expect(toast).toContainText('文件不存在')
    expect(await page.locator('.document-stage').boundingBox()).toEqual(bodyBefore)
    await expect(page.locator('.reading-pane')).not.toContainText('文件不存在')
    await page.waitForTimeout(1700)
    // A repeated failure restarts the lifetime instead of inheriting the old timer.
    await page.getByRole('link', { name: '不存在文件', exact: true }).click({ modifiers })
    await page.waitForTimeout(1100)
    await expect(toast).toBeVisible()
    await expect(toast).toHaveCount(0, { timeout: 2500 })
    await page.getByRole('link', { name: '附件', exact: true }).click({ modifiers })
    await page.getByRole('link', { name: '目录', exact: true }).click({ modifiers })
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'fileCalls'))).toEqual([['reveal', join(root, 'data/android-app-labels.json')], ['directory', join(root, 'data')]])
    await page.getByRole('link', { name: '不存在文件', exact: true }).click({ modifiers })
    await expect(toast).toBeVisible()
    await expect(toast).toHaveCSS('opacity', '1')
    await writeFile(test.info().outputPath('link-toast.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
  } finally {
    const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve()))
    app.process().kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true })
  }
})
