import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('reader controls preserve edits, wrap code and keep wide tables locally scrollable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-reading-ui-'))
  const path = join(root, '团队 文档说明.md')
  await writeFile(path, '# 阅读文档\n\n| ID | 名称 | 配置 |\n| --- | --- | --- |\n| A2 | Apple | `' + 'long_identifier_'.repeat(60) + '` |\n\n```ts\n' + 'code_'.repeat(100) + '\n```\n\n| '+Array.from({length: 16},(_,i)=>`Column${i}`).join(' | ')+' |\n| '+Array(16).fill('---').join(' | ')+' |\n| '+Array(16).fill('Apple').join(' | ')+' |\n\n![示例](missing.png)\n\n<script>window.untrusted = true</script>')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
    await page.getByRole('button', { name: '打开文档', exact: true }).last().click()
    await expect(page.getByRole('tablist')).toBeVisible()
    await expect(page.locator('.document-save-group')).toHaveCount(0)
    await expect(page.locator('.quick-save')).toHaveCount(0)
    await expect(page.getByText('仅在本机', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
    await expect(page.locator('.preview')).toContainText('图片不存在')
    expect(await page.evaluate(() => Reflect.get(window, 'untrusted'))).toBeUndefined()
    const overflow = await page.evaluate(() => {
      const table = [...document.querySelectorAll<HTMLElement>('.table-scroll')].at(-1)!
      const code = document.querySelector<HTMLElement>('.preview pre')!
      return { page: document.documentElement.scrollWidth <= innerWidth, table: table.scrollWidth > table.clientWidth, code: code.scrollWidth > code.clientWidth, focus: table.tabIndex }
    })
    expect(overflow).toEqual({ page: true, table: true, code: false, focus: 0 })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByRole('button', { name: '预览', exact: true })).toBeVisible()
    await expect(page.locator('.document-toolbar').getByRole('button', { name: '保存当前文档：团队 文档说明.md', exact: true })).toBeVisible()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('\n保留修改')
    await page.locator('.document-save-more').click()
    await expect(page.locator('.document-save-menu')).toBeVisible()
    // Semantic click without a pointer/focus event also has to dismiss the old menu.
    await page.getByRole('button', { name: '预览', exact: true }).dispatchEvent('click')
    await expect(page.locator('.preview')).toContainText('保留修改')
    await expect(page.locator('.document-save-group')).toHaveCount(0)
    await expect.poll(() => readFile(path, 'utf8')).toContain('保留修改')
    await expect(page.getByRole('button', { name: '另存为…', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.locator('.document-save')).toBeVisible()
    await expect(page.locator('.document-save-menu')).toHaveCount(0)
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(page.getByRole('complementary', { name: '历史版本', exact: true })).toBeVisible()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})


test('reader layout stays usable across sizes, dark mode and zoom; duplicate tabs expose paths and keyboard actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-reading-layout-'))
  const fixture = await readFile('tests/fixtures/reader-layout.md', 'utf8')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
    for (let index = 0; index < 2; index++) {
      const dir = join(root, String(index)); await mkdir(dir)
      const file = join(dir, '团队 文档说明—同名与超长名称.md'); await writeFile(file, fixture)
      await app.evaluate(({ dialog, Menu }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
        const item = Menu.getApplicationMenu()!.items.find(item => item.label === '文件')!.submenu!.items.find(item => item.label === '打开文档')!
        item.click()
      }, file)
      await expect(page.getByRole('tab')).toHaveCount(index + 1)
      await expect(page.locator('.preview h1')).toHaveText('项目发布清单')
    }
    expect(await page.getByRole('tab').nth(0).getAttribute('title')).not.toBe(await page.getByRole('tab').nth(1).getAttribute('title'))
    for (const [width, height, theme, zoom] of [[800, 600, 'light', 1], [1200, 800, 'light', 1], [1920, 1080, 'light', 1], [1200, 800, 'dark', 1], [800, 600, 'dark', 2], [1200, 800, 'light', 2]] as const) {
      await app.evaluate(({ BrowserWindow, nativeTheme }, { width, height, theme, zoom }) => {
        nativeTheme.themeSource = theme
        const window = BrowserWindow.getAllWindows()[0]!
        window.setSize(width, height); window.webContents.setZoomFactor(zoom)
      }, { width, height, theme, zoom })
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForFunction(theme => matchMedia('(prefers-color-scheme: dark)').matches === (theme === 'dark'), theme)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      const outline = page.getByRole('navigation', { name: '文档目录', exact: true })
      if (width / zoom >= 1688) await expect(outline).toBeVisible(); else await expect(outline).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => { const tab = document.querySelector('[role=tab][aria-selected=true]')!.getBoundingClientRect(); const strip = document.querySelector('.document-tabs')!.getBoundingClientRect(); return tab.left >= strip.left - 1 && tab.right <= strip.right + 1 })).toBe(true)
      await expect.poll(() => page.locator('.shell').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(theme === 'dark' ? 'rgb(29, 31, 35)' : 'rgb(255, 255, 255)')
      const geometry = await page.evaluate(() => {
        const bounds = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        const table = document.querySelectorAll('table')[1]!
        const bodyCells = [...table.querySelectorAll('td')]
        const tokens = [...document.querySelectorAll('td')].filter(cell => ['A2', 'Apple'].includes(cell.textContent!.trim())).map(cell => { const range = document.createRange(); range.selectNodeContents(cell); return range.getClientRects().length })
        const selected = bounds('[role=tab][aria-selected=true]'); const strip = bounds('.document-tabs')
        const plus = bounds('.open-tab'); const toolbar = bounds('.document-toolbar'); const content = bounds('.document-content')
        return { activeVisible: selected.left >= strip.left - 1 && selected.right <= strip.right + 1, noPageOverflow: document.documentElement.scrollWidth <= innerWidth, plus: plus.left >= 0 && plus.right <= innerWidth, toolbar: toolbar.right <= innerWidth, toolbarAligned: Math.abs(toolbar.right - content.right) < 1, contentWidth: content.width, viewport: innerWidth, outlineWidth: document.querySelector('.document-outline')?.getBoundingClientRect().width ?? 0, tokens, rowHeight: table.querySelector('tbody tr')!.getBoundingClientRect().height, resultWidth: bodyCells[3]!.getBoundingClientRect().width, dark: getComputedStyle(document.querySelector('.shell')!).backgroundColor }
      })
      expect(geometry.activeVisible).toBe(true); expect(geometry.noPageOverflow).toBe(true); expect(geometry.plus).toBe(true); expect(geometry.toolbar).toBe(true); expect(geometry.toolbarAligned).toBe(true)
      expect(geometry.outlineWidth).toBe(geometry.viewport >= 1688 ? 280 : 0)
      expect(geometry.contentWidth).toBe(Math.min(1080, geometry.viewport - 48)); expect(geometry.tokens.every(count => count === 1)).toBe(true)
      expect(geometry.resultWidth).toBeGreaterThan(75); expect(geometry.rowHeight).toBeLessThan(220)
      expect(geometry.dark).toBe(theme === 'dark' ? 'rgb(29, 31, 35)' : 'rgb(255, 255, 255)')
      await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
    }
    await page.getByRole('tab', { selected: true }).focus(); await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: '编辑', exact: true }).focus(); await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '进入演示', exact: true })).toBeFocused(); await page.keyboard.press('Tab')
    const history = page.getByRole('button', { name: '历史版本', exact: true }); await expect(history).toBeFocused()
    expect(await history.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: '历史版本', exact: true })).toBeVisible()
    await page.keyboard.press('Escape'); await expect(history).toBeFocused()

  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('combined real backup, save and conflict errors keep controls and retained content reachable at 200%', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-reading-errors-'))
  const profile = join(root, 'profile'); await mkdir(profile)
  await writeFile(join(profile, 'recovery'), 'blocked recovery directory')
  await writeFile(join(profile, 'history'), 'blocked history directory')
  const file = join(root, '故障阅读样本.md'); await writeFile(file, '# 保留正文')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await openDocumentPicker(page)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox')
    await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    const recoveryError = page.getByRole('alert').filter({ hasText: '未能备份最近的修改' })
    await expect(recoveryError).toBeVisible({ timeout: 7000 })
    await expect(page.getByRole('alert').filter({ hasText: '未能备份旧版本' })).toBeVisible()
    await writeFile(file, '# 外部版本')
    const conflict = page.getByRole('region', { name: '文档问题', exact: true })
    await expect(conflict).toContainText('文件已被其他程序修改')
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = 'light'; const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 600); window.webContents.setZoomFactor(2) })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => innerWidth === 400 && innerHeight === 300)
    const layout = async () => page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const toolbar = rect('.document-toolbar'); const stage = rect('.document-stage'); const editor = rect('.editor-pane')
      return { viewport: innerHeight, toolbarTop: toolbar.top, toolbarBottom: toolbar.bottom, stageTop: stage.top, stageBottom: stage.bottom, stageHeight: stage.height, editorHeight: editor.height, editorBottom: editor.bottom }
    })
    const bounds = await layout()
    expect(bounds.toolbarTop).toBeGreaterThanOrEqual(48)
    expect(bounds.toolbarBottom).toBeLessThanOrEqual(bounds.viewport)
    expect(bounds.stageBottom).toBeLessThanOrEqual(bounds.viewport)
    expect(bounds.stageHeight).toBeGreaterThanOrEqual(100)
    expect(bounds.editorHeight).toBeGreaterThanOrEqual(72)
    expect(bounds.editorBottom).toBeLessThanOrEqual(bounds.viewport)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await writeFile(test.info().outputPath('combined-errors.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    await writeFile(test.info().outputPath('combined-errors.json'), JSON.stringify({ bounds, native: await app.evaluate(({ BrowserWindow, nativeTheme }) => { const window = BrowserWindow.getAllWindows()[0]!; return { size: window.getSize(), zoom: window.webContents.getZoomFactor(), theme: nativeTheme.themeSource } }), notices: await page.locator('.document-notices').evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, background: getComputedStyle(document.querySelector('.shell')!).backgroundColor, darkMedia: matchMedia('(prefers-color-scheme: dark)').matches })) }, null, 2))

    await recoveryError.getByRole('button', { name: '本地备份…', exact: true }).click()
    const backups = page.getByRole('dialog', { name: '本地备份', exact: true })
    await expect(backups).toContainText('文档保存在你选择的位置')
    expect((await layout()).editorHeight).toBeGreaterThanOrEqual(72)
    await page.getByRole('button', { name: '关闭本地备份', exact: true }).click()
    await conflict.getByRole('button', { name: '查看磁盘版本', exact: true }).click()
    await expect(page.getByLabel('磁盘版本', { exact: true })).toHaveText('# 外部版本')
    await expect(conflict.getByRole('button', { name: '查看磁盘版本', exact: true })).toBeInViewport({ ratio: 1 })
    await rm(join(profile, 'recovery')); await mkdir(join(profile, 'recovery'))
    await recoveryError.getByRole('button', { name: '重试', exact: true }).click()
    await expect(recoveryError).toHaveCount(0)
    await expect(page.locator('.document-status')).toContainText('草稿已备份')
    await expect(conflict).toContainText('文件已被其他程序修改')
    await expect(page.getByRole('alert').filter({ hasText: '未能备份旧版本' })).toBeVisible()
    await expect(editor).toHaveText('# 保留正文 local')
    expect(await readFile(file, 'utf8')).toBe('# 外部版本')
    await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' retained')
    await expect(editor).toHaveText('# 保留正文 local retained')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.preview')).toContainText('保留正文 local retained')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await editor.click(); await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveText('# 保留正文 local')
    const stillUsable = await layout()
    expect(stillUsable.toolbarBottom).toBeLessThanOrEqual(stillUsable.viewport)
    expect(stillUsable.editorHeight).toBeGreaterThanOrEqual(72)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
