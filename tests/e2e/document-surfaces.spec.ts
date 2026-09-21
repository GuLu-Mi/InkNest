import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalListenerCounts, installSurfaceProbe, surfaceMetrics, trackEditor } from './support/surface-probe'

const menu = (app: ElectronApplication, label: string) => app.evaluate(({ Menu }, label) => { Menu.getApplicationMenu()!.items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === label)!.click() }, label)
async function open(app: ElectronApplication, page: Page, file: string) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click(); await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', file)
}
async function fixture(text = '# Original\n\n## Child\n\n' + 'A readable paragraph.\n\n'.repeat(80)) {
  const root = await mkdtemp(join(tmpdir(), 'inknest-surfaces-')); const file = join(root, 'source.md'); await writeFile(file, text)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true }); const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) }); await expect(page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeVisible()
  // Deliberately controlled native boundary; all document/UI/lifecycle code remains real.
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; let fullscreen = false; w.isFullScreen = () => fullscreen; w.setFullScreen = value => { setTimeout(() => { fullscreen = value; w.emit(value ? 'enter-full-screen' : 'leave-full-screen') }, 0) } })
  return { app, page, root, file, text, cleanup: async () => { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) } }
}
const saveText = async (f: Awaited<ReturnType<typeof fixture>>, value: string) => { await f.page.getByRole('button', { name: '编辑', exact: true }).click(); await f.page.getByRole('textbox').focus(); await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.insertText(value); await menu(f.app, '立即保存'); await expect.poll(() => readFile(f.file, 'utf8')).toBe(value) }
const screenshot = async (app: ElectronApplication, name: string) => writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))

test('editor heading follows inserted heading before caret after passive parse and retains undo', async () => {
  const f = await fixture('# First\n\n## Child'); const { page } = f
  try {
    await open(f.app, page, f.file); await page.getByRole('button', { name: '编辑', exact: true }).click(); const editor = page.getByRole('textbox')
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('# Inserted\n'); await page.keyboard.press('ControlOrMeta+End')
    await expect(page.locator('.document-outline .outline-title')).toHaveCount(3)
    await expect(page.locator('.document-outline [aria-current="location"]')).toHaveText('Child')
    await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page.locator('.cm-line')).toHaveText(['# First', '', '## Child'])
  } finally { await f.cleanup() }
})

for (const closure of ['tab', 'window'] as const) test(`historical display keeps dirty live save checkpoint and ${closure} close snapshots; delayed save receipt cannot replace history`, async () => {
  const f = await fixture('# C'); const { page, app } = f
  try {
    await open(app, page, f.file); await saveText(f, '# A')
    await app.evaluate(({ ipcMain }) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (...args: unknown[]) => Promise<unknown>>
      const save = handlers.get('document:save')!; const checkpoint = handlers.get('backup:checkpoint')!; const close = handlers.get('document:complete-close')!
      Reflect.set(globalThis, 'surfaceSnapshots', { saves: [], checkpoints: [], closes: [] })
      for (const [channel, action, field] of [['document:save', save, 'saves'], ['backup:checkpoint', checkpoint, 'checkpoints'], ['document:complete-close', close, 'closes']] as const) {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, async (...args) => {
          Reflect.get(globalThis, 'surfaceSnapshots')[field].push(structuredClone(args.slice(1)))
          const result = await action(...args)
          if (field === 'saves') return new Promise(resolve => Reflect.set(globalThis, 'releaseSurfaceSave', () => resolve(result)))
          return result
        })
      }
    })
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# B dirty')
    await menu(app, '立即保存'); await expect.poll(() => readFile(f.file, 'utf8')).toBe('# B dirty')
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.locator('.history-list').getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('C')
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'surfaceSnapshots').checkpoints.length)).toBeGreaterThan(0)
    await app.evaluate(() => Reflect.get(globalThis, 'releaseSurfaceSave')()); await expect(page.locator('.preview h1')).toHaveText('C')
    await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.press('ControlOrMeta+Shift+z'); await menu(app, '立即保存')
    await app.evaluate(() => Reflect.get(globalThis, 'releaseSurfaceSave')())
    if (closure === 'tab') { await menu(app, '关闭当前文档'); await expect(page.getByRole('tab')).toHaveCount(0) }
    else { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await expect.poll(() => app.windows().length).toBe(0) }
    const values = await app.evaluate(() => Reflect.get(globalThis, 'surfaceSnapshots'))
    expect(values.saves.every((args: { snapshot: { text: string } }[]) => args[0]!.snapshot.text === '# B dirty')).toBe(true)
    expect(values.checkpoints.every((args: { text: string }[]) => args[0]!.text === '# B dirty')).toBe(true)
    expect(values.closes[0][1].snapshot.text).toBe('# B dirty'); expect(await readFile(f.file, 'utf8')).toBe('# B dirty')
    await writeFile(test.info().outputPath(`live-snapshots-${closure}.json`), JSON.stringify(values, null, 2))
  } finally { await f.cleanup() }
})

test('controlled boundary: 100 history outline presentation cycles return owned resources to baseline', async () => {
  test.setTimeout(240000); const f = await fixture(); const { app, page } = f
  try {
    await installSurfaceProbe(page); await open(app, page, f.file); await saveText(f, '# Current\n\n' + f.text); await trackEditor(page)
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.waitForTimeout(3500)
    const baseline = await surfaceMetrics(page); const listenersBefore = await globalListenerCounts(page)
    const rss = () => app.evaluate(({ app }) => { const processes = app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, workingSetSizeKiB: p.memory.workingSetSize })); return { processes, summedWorkingSetKiB: processes.reduce((sum, p) => sum + p.workingSetSizeKiB, 0) } })
    const rssBefore = await rss()
    const nativeBefore = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return { enter: w.listenerCount('enter-full-screen'), leave: w.listenerCount('leave-full-screen') } })
    for (let i = 0; i < 100; i++) {
      await page.locator('.history-list').getByRole('button', { name: '预览', exact: true }).last().click(); await expect(page.locator('.preview h1')).toHaveText('Original')
      await page.getByRole('button', { name: '文档目录', exact: true }).click(); await page.getByRole('button', { name: '关闭目录', exact: true }).click()
      await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await expect(page.getByRole('textbox')).toBeVisible(); await trackEditor(page)
      await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible()
      await page.getByRole('button', { name: '演示目录', exact: true }).click(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(page.getByRole('textbox')).toBeVisible(); await trackEditor(page)
      if (i % 25 === 24) console.log(`Completed ${i + 1} controlled surface cycles`)
    }
    await page.waitForTimeout(30000); const end = await surfaceMetrics(page); const listenersAfter = await globalListenerCounts(page); const rssAfter = await rss()
    const nativeAfter = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return { enter: w.listenerCount('enter-full-screen'), leave: w.listenerCount('leave-full-screen') } })
    await writeFile(test.info().outputPath('surface-resource-cycles.json'), JSON.stringify({ boundary: 'controlled native fullscreen only', cycles: 100, baseline, end, listenersBefore, listenersAfter, nativeBefore, nativeAfter, rssBefore, rssAfter, rssGrowthKiB: rssAfter.summedWorkingSetKiB - rssBefore.summedWorkingSetKiB, idleBeforeMs: 3500, idleAfterMs: 30000, forcedGC: false }, null, 2))
    const nonzero = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).filter(([, count]) => count !== 0))
    expect(nonzero(end.listeners)).toEqual(nonzero(baseline.listeners)); expect(end.timers).toBe(baseline.timers); expect(end.editorAlive).toBe(1); expect(end.previewAlive).toBe(0); expect(end.editorDOM).toBe(1); expect(end.previewDOM).toBe(0); expect(nativeAfter).toEqual(nativeBefore); expect(listenersAfter).toEqual(listenersBefore)
    expect(end.previewMounted - baseline.previewMounted).toBe(200); expect(end.previewUnmounted - baseline.previewUnmounted).toBe(200); expect(end.editorDestroyed - baseline.editorDestroyed).toBe(200)
  } finally { await f.cleanup() }
})

test('800x600 at 200 percent in both actual themes keeps notice actions body history and presentation exits reachable', async () => {
  test.setTimeout(90000); const f = await fixture(); const { app, page } = f
  try {
    await open(app, page, f.file); await saveText(f, '# Current\n\n' + f.text)
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', () => ({ status: 'error', error: { code: 'DISK_FULL', message: '测试磁盘已满，当前修改保留；请重试或另存为。', retryable: true } })) })
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' dirty'); await menu(app, '立即保存')
    await expect(page.getByRole('alert')).toContainText('测试磁盘已满')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(800, 600); w.webContents.setZoomFactor(2) })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(400)
    const results = []
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: null })
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme }, theme)
      const background = theme === 'dark' ? 'rgb(29, 31, 35)' : 'rgb(255, 255, 255)'
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(background)
      const retry = page.getByRole('button', { name: '重试', exact: true }); await retry.focus(); await expect(retry).toBeFocused(); await page.keyboard.press('Space'); await expect(retry).toBeEnabled()
      await expect(retry).toBeInViewport({ ratio: 1 }); await expect(page.getByRole('button', { name: '另存为…', exact: true })).toBeInViewport({ ratio: 1 })
      await page.getByRole('button', { name: '历史版本', exact: true }).click(); const list = page.getByRole('complementary', { name: '历史版本', exact: true }); await expect(list).toBeVisible(); await list.getByRole('button', { name: '预览', exact: true }).last().click()
      await expect(list).toBeVisible(); await expect(page.locator('.preview h1')).toHaveText('Original'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(`layout-${theme}-diagnostic.json`), JSON.stringify(await page.evaluate(() => Object.fromEntries(['.tabs-header', '.document-notices', '.history-preview-bar', '.history-preview-actions', '.document-stage'].map(selector => { const n = document.querySelector(selector)!; return [selector, { rect: n.getBoundingClientRect().toJSON(), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight }] }))), null, 2)); await screenshot(app, `layout-${theme}-diagnostic.png`)
      const back = page.getByRole('button', { name: '返回当前文档', exact: true }); await expect(back).toBeInViewport({ ratio: 1 }); await back.focus(); await expect(back).toBeFocused()
      const stage = await page.locator('.document-stage').boundingBox(); expect(stage!.height).toBeGreaterThanOrEqual(100); expect(stage!.width).toBeGreaterThanOrEqual(280)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await screenshot(app, `surfaces-${theme}-history-200.png`)
      await page.getByRole('button', { name: '文档目录', exact: true }).click(); await expect(page.getByRole('complementary', { name: '文档目录面板' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '文档目录', exact: true })).toBeFocused()
      await back.click(); await page.getByRole('button', { name: '进入演示', exact: true }).click(); await expect(page.locator('.presentation-stage')).toBeVisible(); await expect(page.locator('.presentation-notice')).toBeVisible()
      const exit = page.getByRole('button', { name: '退出演示', exact: true }); await exit.focus(); await expect(exit).toBeFocused(); await expect(exit).toBeInViewport({ ratio: 1 })
      const presentationStage = await page.locator('.presentation-stage').boundingBox(); expect(presentationStage!.height).toBeGreaterThanOrEqual(100)
      await screenshot(app, `surfaces-${theme}-presentation-200.png`)
      results.push({ theme, background, stage, presentationStage, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) })
      await page.keyboard.press('Space'); await expect(page.getByRole('textbox')).toBeVisible()
    }
    await writeFile(test.info().outputPath('narrow-geometry.json'), JSON.stringify(results, null, 2))
  } finally { await f.cleanup() }
})

test('natural idle RSS observations at 1 5 20 tabs retain existing memory targets', async () => {
  test.setTimeout(90000)
  const text = '# Memory sample\n\n' + 'A quiet 100 KiB reading document paragraph.\n\n'.repeat(2500)
  const f = await fixture(text.slice(0, 102400)); const { page, app } = f
  const sample = async () => { await page.waitForTimeout(3000); return app.evaluate(({ app }) => { const processes = app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, workingSetSizeKiB: p.memory.workingSetSize })); return { processes, summedWorkingSetKiB: processes.reduce((sum, p) => sum + p.workingSetSizeKiB, 0) } }) }
  try {
    const results: Record<string, unknown> = { definition: 'app.getAppMetrics summed workingSetSize KiB; shared pages may be counted repeatedly; 100 KiB files; 3 sec natural idle; no forced GC', targetMiB: 350, growthTargetMiB: 50 }
    await open(app, page, f.file); results.tabs1 = await sample()
    for (let i = 2; i <= 20; i++) { const file = join(f.root, `memory-${i}.md`); await writeFile(file, f.text); await open(app, page, file); if (i === 5 || i === 20) results[`tabs${i}`] = await sample() }
    await writeFile(test.info().outputPath('rss-1-5-20.json'), JSON.stringify(results, null, 2)); console.log('RSS:', JSON.stringify(results))
    expect(await page.getByRole('tab').count()).toBe(20)
  } finally { await f.cleanup() }
})

for (const state of ['readonly', 'missing', 'permission'] as const) test(`${state} source blocks restore but exports the historical bytes through real UI`, async () => {
  const { chmod, link } = await import('node:fs/promises')
  const f = await fixture('# Historical C'); const { app, page } = f
  try {
    await open(app, page, f.file); await saveText(f, '# Current B')
    if (state === 'readonly') {
      await menu(app, '关闭当前文档'); await expect(page.getByRole('tab')).toHaveCount(0)
      await link(f.file, join(f.root, 'linked.md')); await open(app, page, f.file)
    } else {
      if (state === 'missing') await rm(f.file)
      else await chmod(f.file, 0)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('focus'))
      await expect(page.getByRole('region', { name: '文档通知与备份' })).toBeVisible()
    }
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.locator('.history-list').getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('Historical C'); await expect(page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true })).toBeDisabled()
    const output = join(f.root, 'historical-export.md'); await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, output)
    const exportButton = page.locator('.history-preview-bar').getByRole('button', { name: '另存为…', exact: true }); await expect(exportButton).toBeEnabled(); await exportButton.click()
    await expect.poll(() => readFile(output, 'utf8').catch(() => null)).toBe('# Historical C')
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click()
    if (state === 'permission') await chmod(f.file, 0o600)
    if (state !== 'missing') expect(await readFile(f.file, 'utf8')).toBe('# Current B')
  } finally { if (state === 'permission') await chmod(f.file, 0o600).catch(() => {}); await f.cleanup() }
})
