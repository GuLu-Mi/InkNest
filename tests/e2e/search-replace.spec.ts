import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
async function find(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents, modifiers: ('meta' | 'control')[] = [process.platform === 'darwin' ? 'meta' : 'control']
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers })
  })
}
async function fixture(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-replace-'))), file = join(root, 'sample.md')
  await writeFile(file, source)
  const exe = process.env.INKNEST_PACKAGED_EXECUTABLE
  const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`, file], chromiumSandbox: true })
  const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('.reading-pane')).toHaveAttribute('aria-busy', 'false')
  // Explicit test-only OS boundary; these runs do not count as native fullscreen acceptance.
  if (process.env.INKNEST_PRESENTATION_TEST_DRIVER === 'controlled') await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; let fullscreen = false; w.isFullScreen = () => fullscreen; w.setFullScreen = value => { setTimeout(() => { fullscreen = value; w.emit(value ? 'enter-full-screen' : 'leave-full-screen') }, 30) } })
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]!.focus() })
  const query = page.locator('.search-bar input:not(.replacement-input)'), replacement = page.getByRole('textbox', { name: '替换为', exact: true }), editor = page.getByRole('textbox', { name: 'Markdown 源码', exact: true }), count = page.locator('.search-count')
  return { app, page, root, file, source, errors, query, replacement, editor, count, cleanup: async () => { const exit = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exit; await rm(root, { recursive: true, force: true }) } }
}
async function screen(app: ElectronApplication, name: string) { await writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()]))) }

test('shortcut toggles cached search without moving reading position; toolbar controls remain fixed', async () => {
  const f = await fixture('# Top\n\n' + 'middle text\n\n'.repeat(150) + 'Needle Needle')
  try {
    const { page, app } = f
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
    const geometry = () => page.locator('.document-toolbar > *, .document-stage').evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }))
    const toolbarBefore = await geometry()
    await find(app); await expect(f.query).toBeFocused(); await f.query.fill('Needle'); await expect(f.count).toHaveText('1 / 2')
    expect(await geometry()).toEqual(toolbarBefore)
    const toolbar = await page.locator('.document-toolbar').boundingBox(), overlay = await page.locator('.search-bar').boundingBox()
    expect(overlay!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height)
    await find(app); await expect(f.query).toHaveCount(0)
    await page.locator('.document-stage').evaluate(node => { node.scrollTop = 450 }); const before = await page.locator('.document-stage').evaluate(node => node.scrollTop)
    await find(app); await expect(f.query).toHaveValue('Needle'); await expect(f.count).toHaveText('1 / 2'); await page.waitForTimeout(250)
    expect(await page.locator('.document-stage').evaluate(node => node.scrollTop)).toBe(before)
    await screen(app, 'toolbar-search.png')
    await f.query.press('Enter'); expect(await page.locator('.document-stage').evaluate(node => node.scrollTop)).toBeGreaterThan(before + 500)
    await find(app); await expect(f.query).toHaveCount(0)
    expect(await readFile(f.file, 'utf8')).toBe(f.source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test(`${process.env.INKNEST_PRESENTATION_TEST_DRIVER === 'controlled' ? 'controlled boundary' : 'native fullscreen'}: editor-only replacement supports one/all, literal text, deletion, case and one-step undo`, async () => {
  const f = await fixture('cat CAT cat')
  try {
    const { page, app } = f
    await find(app); await expect(f.replacement).toHaveCount(0)
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await expect(f.replacement).toHaveCount(0); await page.getByRole('tab', { name: '替换', exact: true }).click(); await expect(f.replacement).toBeVisible()
    await f.query.fill('cat'); await expect(f.count).toHaveText('1 / 3')
    await f.replacement.fill('dog'); await page.getByRole('button', { name: '替换', exact: true }).click()
    await expect(f.editor).toHaveText('dog CAT cat'); await expect(f.count).toHaveText('1 / 2'); await expect(page.locator('.replacement-notice')).toHaveText('已替换 1 处')
    await f.replacement.fill('$&\\$1'); await page.getByRole('button', { name: '全部替换', exact: true }).click(); await expect(f.editor).toHaveText('dog $&\\$1 $&\\$1')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(f.file, 'utf8')).toBe('dog $&\\$1 $&\\$1')
    await f.editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(f.editor).toHaveText('dog CAT cat')
    await page.keyboard.press('ControlOrMeta+z'); await expect(f.editor).toHaveText('cat CAT cat')
    await page.getByRole('button', { name: '区分大小写' }).click(); await expect(f.count).toHaveText('1 / 2')
    await f.replacement.fill(''); await page.getByRole('button', { name: '全部替换', exact: true }).click(); await expect(f.editor).toHaveText(' CAT ')
    await f.editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(f.editor).toHaveText('cat CAT cat')
    await page.getByRole('button', { name: '预览', exact: true }).click(); await expect(f.replacement).toHaveCount(0)
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation')).toBeVisible({ timeout: 12000 })
    await find(app); await expect(f.query).toBeVisible(); await expect(f.replacement).toHaveCount(0); await f.query.press('Escape'); await page.keyboard.press('Escape')
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('editor cached search preserves selection and viewport; replacement keeps edits on save failure', async () => {
  const f = await fixture('Needle\n\n' + 'body\n'.repeat(150))
  try {
    const { app, page } = f; await page.getByRole('button', { name: '编辑', exact: true }).click(); await find(app); await f.query.fill('Needle'); await expect(f.count).toHaveText('1 / 1'); await find(app)
    await f.editor.focus(); await page.keyboard.press('ControlOrMeta+End')
    const geometry = () => page.evaluate(() => { const view = Reflect.get(document.querySelector('.cm-content')!, 'cmTile').root.view; return { top: view.scrollDOM.scrollTop, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head } })
    await page.waitForTimeout(100); const before = await geometry(); await find(app); await expect(f.count).toHaveText('1 / 1'); expect(await geometry()).toEqual(before)
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', () => ({ status: 'error', error: { code: 'DISK_FULL', message: '替换保存失败测试，内容已保留。' } })) })
    await page.getByRole('tab', { name: '替换', exact: true }).click(); await f.replacement.fill('Changed'); await page.getByRole('button', { name: '全部替换', exact: true }).click(); await expect.poll(() => page.evaluate(() => Reflect.get(document.querySelector('.cm-content')!, 'cmTile').root.view.state.doc.toString())).toContain('Changed')
    await page.keyboard.press('ControlOrMeta+s'); await expect(page.getByRole('alert')).toContainText('替换保存失败测试')
    expect(await readFile(f.file, 'utf8')).toBe(f.source)
    await f.editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect.poll(() => page.evaluate(() => Reflect.get(document.querySelector('.cm-content')!, 'cmTile').root.view.state.doc.toString())).toContain('Needle'); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('replacement is disabled during IME/search and remains reachable at 800px and 200 percent', async () => {
  const f = await fixture('中文 中文')
  try {
    const { app, page } = f; await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await find(app); await f.query.fill('中文'); await expect(f.count).toHaveText('1 / 2')
    await page.getByRole('tab', { name: '替换', exact: true }).click(); await f.replacement.dispatchEvent('compositionstart'); await f.replacement.fill('你好'); await f.replacement.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(page.getByRole('button', { name: '全部替换', exact: true })).toBeDisabled(); await expect(f.editor).toHaveText('中文 中文')
    await page.getByRole('tab', { name: '查找', exact: true }).click(); await expect(page.getByRole('tab', { name: '替换', exact: true })).toHaveAttribute('aria-selected', 'true')
    await f.replacement.dispatchEvent('compositionend'); await expect(f.count).toHaveText('1 / 2')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2)); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    const bar = await page.locator('.search-bar').boundingBox(), body = await page.locator('body').boundingBox()
    expect(bar!.x).toBeGreaterThanOrEqual(0); expect(bar!.x + bar!.width).toBeLessThanOrEqual(body!.width)
    await screen(app, 'replace-dark-200.png')
    await page.getByRole('button', { name: '全部替换', exact: true }).click(); await expect(f.editor).toHaveText('你好 你好')
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})


test('find/replace tabs match the reference layout and never move toolbar controls across viewport sizes', async () => {
  const f = await fixture('Alpha Alpha 中文')
  try {
    const { page, app } = f
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const bounds = () => page.locator('.document-toolbar > *, .document-stage').evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return [b.x, b.y, b.width, b.height] }))
    for (const [width, height, zoom] of [[2200, 900, 1], [1440, 900, 1], [800, 600, 1], [800, 600, 2]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(size.width, size.height); w.webContents.setZoomFactor(size.zoom) }, { width, height, zoom })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      const before = await bounds()
      await find(app); await expect(page.getByRole('tab', { name: '查找', exact: true })).toHaveAttribute('aria-selected', 'true')
      expect(await bounds()).toEqual(before); await expect(f.replacement).toHaveCount(0)
      await f.query.fill('Alpha'); await expect(f.count).toHaveText('1 / 2')
      const count = await f.count.boundingBox(), field = await f.query.boundingBox()
      expect(count!.x).toBeGreaterThan(field!.x); expect(count!.x + count!.width).toBeLessThan(field!.x + field!.width)
      if (width === 1440) { await screen(app, 'find-tab.png'); await page.locator('.search-bar').screenshot({ path: test.info().outputPath('find-panel.png') }) }
      await page.getByRole('tab', { name: '查找', exact: true }).focus(); await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('tab', { name: '替换', exact: true })).toBeFocused(); await expect(f.replacement).toBeVisible()
      expect(await bounds()).toEqual(before); await expect(f.query).toHaveValue('Alpha')
      if (width === 1440) { await screen(app, 'replace-tab.png'); await f.replacement.focus(); await page.locator('.search-bar').screenshot({ path: test.info().outputPath('replace-panel.png') }) }
      if (zoom === 2) { await page.getByRole('button', { name: '全部替换', exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByRole('button', { name: '全部替换', exact: true })).toBeInViewport({ ratio: 1 }) }
      await page.getByRole('tab', { name: '替换', exact: true }).focus(); await page.keyboard.press('Home'); await expect(f.replacement).toHaveCount(0)
      await page.getByRole('button', { name: '关闭搜索' }).focus(); await page.keyboard.press('Enter'); await expect(f.query).toHaveCount(0)
      expect(await bounds()).toEqual(before)
    }
    expect(await readFile(f.file, 'utf8')).toBe(f.source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})
