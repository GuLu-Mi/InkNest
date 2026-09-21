import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => { const item = Menu.getApplicationMenu()!.getMenuItemById(id)!; item.click() }, id)
async function fixture(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-search-'))), file = join(root, 'search.md')
  await writeFile(file, source)
  const exe = process.env.INKNEST_PACKAGED_EXECUTABLE
  const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`, file], chromiumSandbox: true })
  const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.log('renderer error:', error.message) })
  await expect(page.locator('.reading-pane')).toBeVisible()
  await expect(page.locator('.reading-pane')).toHaveAttribute('aria-busy', 'false')
  // Explicit test-only OS boundary; these runs do not count as native fullscreen acceptance.
  if (process.env.INKNEST_PRESENTATION_TEST_DRIVER === 'controlled') await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; let fullscreen = false; w.isFullScreen = () => fullscreen; w.setFullScreen = value => { setTimeout(() => { fullscreen = value; w.emit(value ? 'enter-full-screen' : 'leave-full-screen') }, 30) } })
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]!.focus() })
  const count = page.locator('.search-count'), input = page.locator('.search-bar input:not(.replacement-input)')
  return { root, file, source, app, page, errors, count, input, cleanup: async () => { const exit = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exit; await rm(root, { recursive: true, force: true }) } }
}
async function query(page: Page, text: string, count: string) { await page.locator('.search-bar input:not(.replacement-input)').fill(text); await expect(page.locator('.search-count')).toHaveText(count) }
const highlighted = (page: Page) => page.evaluate(() => [...(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('inknest-search-current') ?? []].map(range => range.toString()))

test('Electron key input, visible text boundaries, literal Unicode, focus, wrapping and unchanged document', async () => {
  const f = await fixture('# Search\n\nAlpha **beta** Alpha beta\n\nALPHA beta\n\n甲😀e\u0301乙\n\nline  \nbreak\n\n![noisy](missing.png)\n\n[caption](hidden-url.md)\n\n| one | two |\n|---|---|\n| cell | text |')
  try {
    const { page, app } = f; const before = await page.locator('.document-stage').boundingBox()
    await app.evaluate(({ BrowserWindow }) => { const contents = BrowserWindow.getAllWindows()[0]!.webContents; const modifiers: ('meta' | 'control')[] = [process.platform === 'darwin' ? 'meta' : 'control']; contents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers }) }); await expect(f.input).toBeFocused()
    expect(await page.locator('.document-stage').boundingBox()).toEqual(before)
    await query(page, 'Alpha beta', '1 / 3'); expect(await highlighted(page)).toEqual(['Alpha beta'])
    await f.input.press('Enter'); await expect(f.count).toHaveText('2 / 3'); await expect(f.input).toBeFocused()
    await menu(app, 'find-next'); await expect(f.count).toHaveText('3 / 3')
    await f.input.press('Enter'); await expect(f.count).toHaveText('1 / 3'); await expect(page.locator('.search-wrap')).toHaveText('已回到开头')
    await page.getByRole('button', { name: '区分大小写' }).click(); await expect(f.count).toHaveText('1 / 2')
    await query(page, '😀é', '1 / 1'); expect(await highlighted(page)).toEqual(['😀e\u0301'])
    for (const word of ['图片不存在', 'missing.png', 'hidden-url', 'one two', 'line break', 'beta ALPHA', '<img onerror=x>']) await query(page, word, '无结果')
    await query(page, 'caption', '1 / 1'); await f.input.press('Escape'); await expect(f.input).toHaveCount(0)
    expect(await highlighted(page)).toEqual([]); expect(await readFile(f.file, 'utf8')).toBe(f.source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('tab queries, unsaved source search, IME events and undo survive mode changes', async () => {
  const f = await fixture('# Alpha\n\nAlpha **beta**')
  try {
    const { page, app } = f; await menu(app, 'find'); await query(page, 'Alpha', '1 / 2')
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await expect(f.count).toHaveText('1 / 2')
    const editor = page.getByRole('textbox', { name: 'Markdown 源码', exact: true }); await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' UNSAVED')
    await f.input.focus(); await query(page, 'UNSAVED', '1 / 1'); expect(await editor.textContent()).toContain('UNSAVED')
    await f.input.dispatchEvent('compositionstart'); await f.input.fill('Alpha'); await f.input.dispatchEvent('keydown', { key: 'Enter', isComposing: true }); await expect(f.count).toHaveText('正在搜索…')
    await f.input.dispatchEvent('compositionend'); await expect(f.count).toHaveText('1 / 2')
    await f.input.press('Escape'); await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('UNSAVED')
    await menu(app, 'find'); await query(page, '**', '1 / 2')
    await page.getByRole('button', { name: '预览', exact: true }).click(); await expect(f.count).toHaveText('无结果')
    const other = join(f.root, 'other.md'); await writeFile(other, '# Beta'); await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), other)
    await expect(page.locator('.preview h1')).toHaveText('Beta'); await expect(f.input).toHaveCount(0)
    await menu(app, 'find'); await query(page, 'Beta', '1 / 1')
    await page.getByRole('tab', { name: /search.md/ }).click(); await expect(f.input).toHaveValue('**'); await expect(f.count).toHaveText('无结果')
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('image diagnostics and explicit exact-file opening pause search behind the viewer', async () => {
  const f = await fixture('# Images')
  try {
    const { app, page } = f; const photo = join(f.root, 'UPPER.PNG'), doc = join(f.root, 'docs', 'images.md')
    await mkdir(join(f.root, 'docs')); await writeFile(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64'))
    const source = `# Pictures\n\n![合法](<${photo}> "标题")\n\n![错误](<${photo} "示例">)`; await writeFile(doc, source)
    await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), doc)
    await expect(page.locator('.preview')).toContainText('图片地址包含标题'); await expect(page.getByRole('link', { name: '打开图片', exact: true })).toHaveCount(1)
    await menu(app, 'find'); await query(page, '图片路径', '无结果'); await query(page, 'Pictures', '1 / 1')
    await page.getByRole('link', { name: '打开图片', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '图片查看器' }); await expect(viewer).toBeVisible(); await expect(f.input).toHaveCount(0)
    await expect.poll(() => viewer.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1)
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0); await expect(f.input).toHaveValue('Pictures'); await expect(f.count).toHaveText('1 / 1')
    expect(await readFile(doc, 'utf8')).toBe(source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('offscreen code results scroll horizontally; overlay adapts to 800px, zoom and dark mode', async () => {
  const f = await fixture('# Layout\n\n' + 'filler paragraph\n\n'.repeat(120) + '```\n' + 'x'.repeat(240) + 'NEEDLE\n```')
  try {
    const { app, page } = f; await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 600) })
    await menu(app, 'find'); await query(page, 'NEEDLE', '1 / 1'); expect(await highlighted(page)).toEqual(['NEEDLE'])
    expect(await page.locator('.document-stage').evaluate(node => node.scrollTop)).toBeGreaterThan(1000)
    expect(await page.locator('.preview pre').evaluate(node => node.scrollLeft)).toBeGreaterThan(100)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2))
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await expect(f.input).toBeVisible(); const bar = await page.locator('.search-bar').boundingBox(); expect(bar!.x).toBeGreaterThanOrEqual(0); expect(bar!.width).toBeLessThanOrEqual(380)
    await writeFile(test.info().outputPath('search-dark-200.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test(`${process.env.INKNEST_PRESENTATION_TEST_DRIVER === 'controlled' ? 'controlled boundary' : 'native fullscreen'}: presentation has a separate query and Escape closes only the search layer`, async () => {
  const f = await fixture('# Snapshot\n\nAlpha Alpha Beta')
  try {
    const { app, page } = f; await menu(app, 'find'); await query(page, 'Alpha', '1 / 2')
    await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation')).toBeVisible({ timeout: 12000 }); await expect(f.input).toHaveCount(0)
    await menu(app, 'find'); await query(page, 'Beta', '1 / 1'); await f.input.press('Escape'); await expect(page.locator('.presentation')).toBeVisible(); await expect(f.input).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(page.locator('.presentation')).toHaveCount(0); await expect(f.input).toHaveValue('Alpha'); await expect(f.count).toHaveText('1 / 2')
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('history searches only the displayed version and restores the current query', async () => {
  const f = await fixture('# Earlier\n\nHistoricalOnly')
  try {
    const { app, page } = f
    await page.getByRole('button', { name: '编辑', exact: true }).click(); const editor = page.getByRole('textbox', { name: 'Markdown 源码', exact: true })
    await editor.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# Current\n\nCurrentOnly'); await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readFile(f.file, 'utf8')).toBe('# Current\n\nCurrentOnly')
    await menu(app, 'find'); await query(page, 'CurrentOnly', '1 / 1')
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('Earlier'); await expect(f.input).toHaveCount(0)
    await menu(app, 'find'); await query(page, 'CurrentOnly', '无结果'); await query(page, 'HistoricalOnly', '1 / 1')
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await expect(f.input).toHaveValue('CurrentOnly'); await expect(f.count).toHaveText('1 / 1')
    await f.input.press('Escape'); await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(editor).toContainText('HistoricalOnly')
    expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

for (const bytes of [100 * 1024, 2 * 1024 * 1024, 10 * 1024 * 1024]) test(`search pressure ${bytes} bytes: full counts, cancellation and bounded highlights`, async () => {
  test.setTimeout(120000)
  const row = 'a'.repeat(127) + '\n', f = await fixture(row.repeat(bytes / 128))
  try {
    const { app, page } = f; await menu(app, 'find')
    await page.evaluate(() => {
      const durations: number[] = []; Reflect.set(window, 'searchLongTasks', durations)
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) durations.push(entry.duration) }); observer.observe({ type: 'longtask' }); Reflect.set(window, 'searchTaskObserver', observer)
    })
    const elapsed = await page.evaluate(async () => {
      const start = performance.now(), input = document.querySelector<HTMLInputElement>('.search-bar input:not(.replacement-input)')!
      input.value = 'a'; input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise<void>(resolve => { const check = () => { if (/\d+ \/ \d+/u.test(document.querySelector('.search-count')!.textContent!)) { observer.disconnect(); resolve() } }; const observer = new MutationObserver(check); observer.observe(document.querySelector('.search-count')!, { childList: true, characterData: true, subtree: true }); check() })
      return performance.now() - start
    })
    const total = (bytes / 128) * 127
    await expect(f.count).toHaveText(`1 / ${total}`)
    const ranges = await page.evaluate(() => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('inknest-search')!.size)
    expect(ranges).toBeLessThanOrEqual(4096)
    const navStart = Date.now(); await f.input.press('Shift+Enter'); await expect(f.count).toHaveText(`${total} / ${total}`); const navigationMs = Date.now() - navStart
    expect(await highlighted(page)).toEqual(['a'])
    await f.input.fill('aa'); if (bytes === 10 * 1024 * 1024) { await page.waitForTimeout(180); await expect(f.count).toHaveText('正在搜索…') }; await f.input.press('Escape'); await expect(f.input).toHaveCount(0)
    await page.waitForTimeout(250); expect(await highlighted(page)).toEqual([])
    const longTasks = await page.evaluate(() => { Reflect.get(window, 'searchTaskObserver').disconnect(); return Reflect.get(window, 'searchLongTasks') as number[] })
    const evidence = { bytes, total, elapsedMs: elapsed, navigationIncludingDriverMs: navigationMs, ranges, longTasks, maxLongTaskMs: Math.max(0, ...longTasks) }
    console.log('SEARCH_METRIC', JSON.stringify(evidence)); await writeFile(test.info().outputPath(`search-${bytes}.json`), JSON.stringify(evidence, null, 2))
    expect(await readFile(f.file, 'utf8')).toBe(f.source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})

test('100 open/close and tab cycles release results and do not issue save or checkpoint requests', async () => {
  test.setTimeout(120000)
  const f = await fixture('# Alpha\n\nAlpha Alpha')
  try {
    const { page, app } = f; const other = join(f.root, 'other.md'); await writeFile(other, '# Beta')
    await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), other); await expect(page.locator('.preview h1')).toHaveText('Beta')
    await app.evaluate(({ ipcMain }) => {
      const counts: Record<string, number> = {}; Reflect.set(globalThis, 'searchWrites', counts)
      for (const name of ['document:save', 'backup:checkpoint']) {
        const handler = Reflect.get(ipcMain, '_invokeHandlers').get(name); if (!handler) throw new Error(name)
        ipcMain.removeHandler(name); ipcMain.handle(name, (...args) => { counts[name] = (counts[name] ?? 0) + 1; return handler(...args) })
      }
    })
    for (let i = 0; i < 100; i++) {
      await page.getByRole('tab', { name: i % 2 ? 'other.md' : 'search.md', exact: true }).click()
      await menu(app, 'find'); await query(page, i % 2 ? 'Beta' : 'Alpha', i % 2 ? '1 / 1' : '1 / 3')
      await f.input.press('Escape'); expect(await highlighted(page)).toEqual([])
    }
    expect(await app.evaluate(() => Reflect.get(globalThis, 'searchWrites'))).toEqual({})
    expect(await readFile(f.file, 'utf8')).toBe(f.source); expect(f.errors).toEqual([])
  } finally { await f.cleanup() }
})
