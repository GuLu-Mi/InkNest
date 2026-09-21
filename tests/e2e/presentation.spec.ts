import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Test-only native boundary driver; never used by production, never native acceptance.
const controlled = process.env.INKNEST_PRESENTATION_TEST_DRIVER === 'controlled'
const title = (name: string) => `${controlled ? 'controlled native boundary' : 'actual native fullscreen'}: ${name}`

const screenshot = async (app: ElectronApplication, name: string) => writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
const native = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())
const menu = (app: ElectronApplication, label: string) => app.evaluate(({ Menu }, label) => { const item = Menu.getApplicationMenu()!.items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === label)!; item.click() }, label)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inknest-presentation-')); const file = join(root, 'source.md')
  const source = '# 演示正文\n\n' + Array.from({ length: 45 }, (_, i) => `## Section ${i}\n\n${'Continuous content '.repeat(20)}\n\n`).join('')
  await writeFile(file, source)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
  if (controlled) await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; let fullscreen = false; w.isFullScreen = () => fullscreen; w.setFullScreen = value => { setTimeout(() => { fullscreen = value; w.emit(value ? 'enter-full-screen' : 'leave-full-screen') }, 30) } })
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]!.focus() })
  page.on('pageerror', error => console.log('renderer error:', error.message))
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; const events: string[] = []; (w as unknown as { testNativeEvents: string[] }).testNativeEvents = events; w.on('enter-full-screen', () => events.push('enter')); w.on('leave-full-screen', () => events.push('leave')) })
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
  await expect(page.locator('.preview h1')).toHaveText('演示正文')
  return { app, page, file, source, root, cleanup: async () => { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) } }
}
test(title('continuously scrolls, temporary outline and restores reading panels/scroll'), async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.locator('.document-stage').evaluate(node => { node.scrollTop = 420 })
    await expect.poll(() => page.locator('.document-stage').evaluate(node => node.scrollTop)).toBe(420)
    await page.getByRole('button', { name: '进入演示', exact: true }).click()
    await expect(page.getByRole('region', { name: '全屏连续阅读' })).toBeVisible({ timeout: 12000 }); await expect.poll(() => native(app)).toBe(true)
    await expect(page.locator('.document-tabs')).toHaveCount(0); await expect(page.locator('.cm-editor')).toHaveCount(0); await expect(page.locator('.preview')).toHaveCount(1)
    const stage = page.locator('.presentation-stage'); await stage.focus(); await page.keyboard.press('End')
    await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBeGreaterThan(1000)
    await page.keyboard.press('Home'); await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBe(0)
    await page.keyboard.press('Space'); await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBeGreaterThan(100)
    await page.keyboard.press('Shift+Space'); await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBe(0)
    await page.getByRole('button', { name: '演示目录', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '文档目录面板', exact: true }); await expect(drawer).toBeVisible(); await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); expect(await native(app)).toBe(true)
    await page.getByRole('button', { name: '演示目录', exact: true }).click(); await drawer.getByRole('button', { name: 'Section 30', exact: true }).click(); await expect(drawer).toHaveCount(0)
    await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBeGreaterThan(1000)
    await page.getByRole('button', { name: '退出演示', exact: true }).focus(); await page.waitForTimeout(3100)
    expect(await page.locator('.presentation-controls').evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    await stage.focus(); await expect(stage).toBeFocused()
    await expect.poll(() => page.locator('.presentation-controls').evaluate(node => getComputedStyle(node).opacity), { timeout: 8000 }).toBe('0')
    await page.mouse.move(60, 20); await expect(page.getByRole('button', { name: '退出演示', exact: true })).toBeInViewport()
    await screenshot(app, controlled ? 'presentation-controlled.png' : 'presentation-native.png')
    await page.keyboard.press('Escape'); await expect(page.locator('.presentation-stage')).toHaveCount(0); await expect.poll(() => native(app)).toBe(false)
    await expect(page.getByRole('complementary', { name: '历史版本', exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.document-stage').evaluate(node => node.scrollTop)).toBe(420)
    expect(await readFile(f.file, 'utf8')).toBe(f.source)
  } finally { await f.cleanup() }
})
test(title('View entry keeps original editor undo and preexisting system fullscreen'), async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '编辑', exact: true }).click(); const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('UNSAVED ')
    await menu(app, '进入演示'); await expect(page.locator('.presentation-stage')).toBeVisible(); await expect(page.locator('.preview')).toContainText('UNSAVED')
    await menu(app, '立即保存'); await expect.poll(() => readFile(f.file, 'utf8')).toBe('UNSAVED ' + f.source)
    await page.keyboard.press('Escape'); await expect(editor).toBeVisible(); await expect.poll(() => native(app)).toBe(false)
    await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('UNSAVED')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true)); await expect.poll(() => native(app)).toBe(true)
    // isFullScreen can become true before macOS transition completes; wait for the native event explicitly.
    await page.waitForTimeout(1200)
    await menu(app, '进入演示'); await expect(page.locator('.presentation-stage')).toBeVisible(); await page.keyboard.press('Escape'); await expect(editor).toBeVisible(); expect(await native(app)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false)); await expect.poll(() => native(app)).toBe(false)
  } finally { await f.cleanup() }
})
test(title('open selects new source and epoch invalidation exits'), async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible()
    await writeFile(f.file, '# Externally updated\n'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('focus'))
    await expect(page.locator('.presentation-stage')).toHaveCount(0); await expect(page.locator('.preview h1')).toHaveText('Externally updated'); await expect.poll(() => native(app)).toBe(false)
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible()
    const other = join(f.root, 'other.md'); await writeFile(other, '# Other source')
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, other)
    await menu(app, '打开文档'); await expect(page.locator('.presentation-stage')).toHaveCount(0); await expect(page.locator('.preview h1')).toHaveText('Other source'); await expect.poll(() => native(app)).toBe(false)
  } finally { await f.cleanup() }
})

test('unresponsive native boundary: pending Esc cancellation and ten-second UI recovery preserve text', async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setFullScreen = () => {}; w.isFullScreen = () => false })
    const enter = page.getByRole('button', { name: '进入演示', exact: true })
    await enter.click(); await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible(); await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0); await expect(enter).toBeEnabled(); await expect(page.locator('.presentation-stage')).toHaveCount(0)
    await enter.click(); await expect(page.getByRole('alert')).toHaveText('未能进入全屏演示，文档内容已保留。', { timeout: 12000 })
    await expect(enter).toBeEnabled(); await expect(page.locator('.preview h1')).toHaveText('演示正文'); expect(await readFile(f.file, 'utf8')).toBe(f.source)
    await screenshot(app, 'presentation-timeout-controlled.png')
  } finally { await f.cleanup() }
})

test(title('narrow 200% keyboard controls, button semantics and historical native menu gate'), async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('CURRENT ')
    await menu(app, '立即保存'); await expect.poll(() => readFile(f.file, 'utf8')).toBe('CURRENT ' + f.source)
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('演示正文'); await menu(app, '进入演示'); await expect(page.locator('.presentation-stage')).toHaveCount(0); expect(await native(app)).toBe(false)
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await page.getByRole('button', { name: '关闭历史', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(800, 600); w.webContents.setZoomFactor(2) })
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible()
    await expect(page.getByRole('button', { name: '退出演示', exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.locator('.markdown-body').evaluate(node => ({ font: getComputedStyle(node).fontSize, line: getComputedStyle(node).lineHeight }))).toEqual({ font: '20px', line: '36px' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const directory = page.getByRole('button', { name: '演示目录', exact: true }); await directory.focus(); await page.keyboard.press('Space')
    await expect(page.getByRole('dialog', { name: '文档目录面板', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '关闭目录', exact: true })).toBeInViewport({ ratio: 1 })
    await screenshot(app, controlled ? 'presentation-200-controlled.png' : 'presentation-200-native.png')
    await page.keyboard.press('Escape'); await expect(page.locator('.presentation-stage')).toBeVisible(); await expect(directory).toBeFocused()
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    await screenshot(app, controlled ? 'presentation-200-dark-controlled.png' : 'presentation-200-dark-native.png')
    await page.keyboard.press('Escape'); await expect(page.getByRole('textbox')).toBeVisible(); await expect.poll(() => native(app)).toBe(false)
  } finally { await f.cleanup() }
})

test(title('fixed dirty snapshot survives external conflict and closing still protects the live session'), async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '编辑', exact: true }).click(); const editor = page.getByRole('textbox')
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('LOCAL ')
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible()
    await writeFile(f.file, '# External conflict\n'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('focus'))
    await expect(page.locator('.presentation-notice')).toBeVisible(); await expect(page.locator('.presentation-stage')).toBeVisible(); await expect(page.locator('.preview')).toContainText('LOCAL')
    await app.evaluate(({ dialog }, root) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); dialog.showSaveDialog = async () => ({ canceled: true, filePath: root }) }, f.root)
    await menu(app, '关闭当前文档'); await expect(page.locator('.presentation-stage')).toBeVisible()
    await page.keyboard.press('Escape'); await expect(editor).toContainText('LOCAL'); expect(await readFile(f.file, 'utf8')).toBe('# External conflict\n')
  } finally { await f.cleanup() }
})

test('controlled native boundary: pending entry yields to history and ignores late native confirmation', async () => {
  const f = await fixture(); const { app, page } = f
  try {
    await page.getByRole('button', { name: '编辑', exact: true }).click(); const editor = page.getByRole('textbox')
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('CURRENT ')
    await menu(app, '立即保存'); await expect.poll(() => readFile(f.file, 'utf8')).toBe('CURRENT ' + f.source)
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!; let fullscreen = false
      w.isFullScreen = () => fullscreen
      w.setFullScreen = value => { if (!value) { fullscreen = false; w.emit('leave-full-screen') } }
      w.once('test-late-enter' as 'enter-full-screen', () => { fullscreen = true; w.emit('enter-full-screen') })
    })
    await page.getByRole('button', { name: '进入演示', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('演示正文')
    await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('test-late-enter' as 'enter-full-screen'))
    await menu(app, '进入演示')
    await expect(page.locator('.presentation-stage')).toHaveCount(0); await expect.poll(() => native(app)).toBe(false)
    await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toBeVisible()
    await expect(page.locator('.preview h1')).toHaveText('演示正文'); expect(await readFile(f.file, 'utf8')).toBe('CURRENT ' + f.source)
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await expect(editor).toContainText('CURRENT')
    await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('CURRENT')
  } finally { await f.cleanup() }
})
