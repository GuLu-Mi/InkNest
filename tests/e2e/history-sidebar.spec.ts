import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('historical display isolates editing and routes native and keyboard Save As to exact historical bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-ui-'))
  const file = join(root, 'document.md'); const original = Buffer.from('\ufeff# Version A\r\n\r\nold\r\n')
  await writeFile(file, original)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# Version B\n\nnew')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toContain('Version B')
    await expect(page.getByRole('button', { name: '历史版本', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    const history = page.getByRole('complementary', { name: '历史版本', exact: true })
    await expect(history).toBeVisible()
    await history.getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.getByRole('heading', { name: 'Version A', exact: true })).toBeVisible()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.insertText('DO NOT SAVE'); await page.keyboard.press('ControlOrMeta+s')
    expect(await readFile(file, 'utf8')).toBe('\ufeff# Version B\r\n\r\nnew')
    const target = join(root, 'export.md')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, target)
    await page.keyboard.press('ControlOrMeta+Shift+s')
    await expect.poll(() => readFile(target).catch(() => null)).toEqual(original)
    const target2 = join(root, 'native-export.md')
    await app.evaluate(({ dialog, Menu }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); Menu.getApplicationMenu()!.items.find(i => i.label === '文件')!.submenu!.items.find(i => i.label === '另存为…')!.click() }, target2)
    await expect.poll(() => readFile(target2).catch(() => null)).toEqual(original)
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', file)
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click()
    await expect(page.locator('.cm-line')).toHaveText(['# Version B', '', 'new'])
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('textbox')).toContainText('Version A')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

for (const retryFrom of ['same', 'other'] as const) test(`lost committed restore reconciles the ${retryFrom} active tab and preserves undo`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-pending-')); const file = join(root, 'source.md'); const other = join(root, 'other.md')
  await writeFile(file, '# Version C'); await writeFile(other, '# Other')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) }); const pageErrors: string[] = []; const consoleErrors: string[] = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => pageErrors.push(error.message))
    for (const path of [other, file]) {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
      await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path)
    }
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# Version B'); await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Version B')
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('complementary', { name: '历史版本' }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.getByRole('heading', { name: 'Version C' })).toBeVisible()
    await app.evaluate(({ ipcMain, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (...args: unknown[]) => Promise<{status: string}>>
      const original = handlers.get('backup:restore-history')!; let lose = true
      ipcMain.removeHandler('backup:restore-history')
      ipcMain.handle('backup:restore-history', async (...args) => { Reflect.set(globalThis, 'restoreRequest', args[1]); const result = await original(...args); if (lose && result.status === 'ok') { lose = false; throw new Error('deliberately lost committed receipt') }; return result })
    })
    await page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对还原结果', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Version C' })).toHaveCount(0)
    await expect(page.locator('.preview')).toHaveCount(0)
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Version C')
    const oldRequest = await app.evaluate(() => Reflect.get(globalThis, 'restoreRequest') as import('../../src/shared/contracts').HistoryRestoreRequest)
    expect(await page.evaluate(request => window.inknest.save({ requestId: crypto.randomUUID(), snapshot: request.snapshot, expectedDiskToken: request.expectedDiskToken, trigger: 'auto' }), oldRequest)).toMatchObject({ status: 'error' })
    expect(await readFile(file, 'utf8')).toBe('# Version C')
    await page.getByRole('textbox').focus(); await page.keyboard.insertText('BLOCKED')
    await expect(page.getByRole('textbox')).toHaveText('# Version B')
    await expect(page.getByRole('complementary', { name: '历史版本' }).getByRole('button', { name: '预览', exact: true }).last()).toBeDisabled()
    if (retryFrom === 'other') {
      await page.getByRole('tab', { name: 'other.md', exact: true }).click()
      await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' saved'); await page.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => readFile(other, 'utf8')).toBe('# Other saved')
    }
    if (retryFrom === 'same') await page.evaluate(() => {
      const view = Reflect.get(document.querySelector('.cm-content')!, 'cmTile').root.view
      Reflect.set(window, 'restoreConsistency', { view })
    })
    await page.getByRole('button', { name: '核对还原结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对还原结果', exact: true })).toHaveCount(0)
    if (retryFrom === 'same') {
      const states = await page.evaluate(() => {
        const { view } = Reflect.get(window, 'restoreConsistency')
        return { editor: view.state.doc.toString() }
      })
      await writeFile(test.info().outputPath('restore-consistency.json'), JSON.stringify({ ...states, disk: await readFile(file, 'utf8'), pageErrors, consoleErrors }, null, 2))
      expect(states).toEqual({ editor: '# Version C' })
    }
    if (retryFrom === 'other') await page.getByRole('tab', { name: 'source.md', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Version C' })).toBeVisible()
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('textbox')).toHaveText('# Version B')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toBe('# Version B')
    expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([])
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('history layout remains reachable, returns reading position, reports unavailable records and releases views across 100 switches', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-layout-')); const file = join(root, 'layout.md'); const other = join(root, 'second.md')
  const long = '# Historical document\n\n' + Array.from({ length: 70 }, (_, i) => `## Section ${i}\n\nReadable paragraph ${i}.\n\n`).join('')
  await writeFile(file, long); await writeFile(other, '# Second')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })

  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    for (const path of [other, file]) {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
      await page.getByRole('button', { name: '打开文档', exact: true }).first().click(); await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path)
    }
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('Current ')
    await page.getByRole('button', { name: '预览', exact: true }).last().click(); await expect.poll(() => readFile(file, 'utf8')).toContain('Current ')
    await expect(page.locator('.preview')).toContainText('Current ')
    await expect(page.locator('.reading-pane')).toHaveAttribute('aria-busy', 'false')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.locator('.document-stage').evaluate(element => { element.scrollTop = 500 }); await expect.poll(() => page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(500)
    for (const [width, height, zoom] of [[1200, 800, 1], [1920, 1080, 1], [800, 600, 1], [800, 600, 2]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom) }, { width, height, zoom })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom)
      await page.getByRole('button', { name: '历史版本', exact: true }).click()
      const list = page.getByRole('complementary', { name: '历史版本', exact: true })
      await expect(list).toBeVisible(); await list.getByRole('button', { name: '预览', exact: true }).last().scrollIntoViewIfNeeded(); await expect(list.getByRole('button', { name: '预览', exact: true }).last()).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      // Reflow preserves the visible text, so each viewport can have a different
      // scrollTop. History must restore the bookmark from this exact layout.
      const currentTop = await page.locator('.document-stage').evaluate(element => element.scrollTop)
      await writeFile(test.info().outputPath(`history-list-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
      await list.getByRole('button', { name: '预览', exact: true }).last().click(); await expect(page.getByRole('heading', { name: 'Historical document', exact: true })).toBeVisible()
      await expect(list).toBeVisible()
      await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toBeInViewport({ ratio: 1 })
      const bounds = await page.locator('.document-stage').boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(100)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('.document-stage').evaluate(element => { element.scrollTop = 150 }); await expect.poll(() => page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(150)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(`history-preview-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
      await page.getByRole('button', { name: '返回当前文档', exact: true }).click()
      await expect.poll(() => page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(currentTop)
      await page.getByRole('button', { name: '关闭历史', exact: true }).click()
      await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(i => i.label === '文件')!.submenu!.items.find(i => i.label === '本地备份…')!.click() })
      await expect(page.getByRole('dialog', { name: '本地备份' })).toBeVisible()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await writeFile(test.info().outputPath(`backup-manager-${width}-${zoom}.png`), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
      await page.keyboard.press('Escape')
    }
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(1920, 1080); window.webContents.setZoomFactor(1) })
    for (let i = 0; i < 100; i++) {
      await page.getByRole('tab', { name: i % 2 === 0 ? 'second.md' : 'layout.md', exact: true }).click()
      await expect(page.locator('.reading-pane')).toHaveCount(1); await expect(page.locator('.cm-editor')).toHaveCount(0)
    }
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    // Corrupt an actual snapshot on disk; the visible list retains its ID, but reading must fail safely.
    const { readdir } = await import('node:fs/promises')
    for (const dir of await readdir(join(root, 'profile/history'))) for (const name of await readdir(join(root, 'profile/history', dir))) if (name.endsWith('.bin')) await writeFile(join(root, 'profile/history', dir, name), 'corrupted')
    await page.getByRole('complementary', { name: '历史版本' }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.history-message[role=alert]')).toBeVisible(); await expect(page.locator('.preview')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 600); window.webContents.setZoomFactor(2) })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await writeFile(test.info().outputPath('history-record-unavailable.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await expect(page.locator('.preview')).toContainText('Current ')
    expect(await readFile(file, 'utf8')).toBe('Current ' + long)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('restore cancellation and actual backup-directory failure retain the preview and B; successful retry protects B and shows A', async () => {
  const { rename } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-failure-')); const file = join(root, 'source.md'); const profile = join(root, 'profile')
  await writeFile(file, '# A')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click(); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# B'); await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readFile(file, 'utf8')).toBe('# B')
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.getByRole('complementary', { name: '历史版本' }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    await page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true }).click(); await expect(page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true })).toBeEnabled()
    expect(await readFile(file, 'utf8')).toBe('# B'); await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    await rename(join(profile, 'history'), join(profile, 'held-history')); await writeFile(join(profile, 'history'), 'blocked history storage')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true }).click()
    await expect(page.locator('.document-notices').getByRole('alert')).toContainText('当前修改已保留'); expect(await readFile(file, 'utf8')).toBe('# B')
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    await rm(join(profile, 'history')); await rename(join(profile, 'held-history'), join(profile, 'history'))
    await page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible(); expect(await readFile(file, 'utf8')).toBe('# A')
    const bodies = await page.evaluate(async () => {
      const opened = await window.inknest.openFile(); if (opened.status !== 'ok') throw Error('fixture')
      const ref = { docId: opened.value.docId, epoch: opened.value.epoch }; const list = await window.inknest.listHistory(ref); if (list.status !== 'ok') throw Error('fixture')
      return Promise.all(list.value.entries.map(async item => { const result = await window.inknest.inspectHistory(ref, item.id); return result.status === 'ok' ? result.value.text : null }))
    })
    expect(bodies).toContain('# B'); expect(bodies).toContain('# A')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('history list restores its own scroll after switching tabs and reloading metadata', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-scroll-')); const file = join(root, 'many.md'); const other = join(root, 'other.md')
  await writeFile(file, '# version 0'); await writeFile(other, '# Other')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    for (const path of [other, file]) { await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path); await page.getByRole('button', { name: '打开文档', exact: true }).first().click(); await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path) }
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    for (let i = 1; i <= 12; i++) { await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# version ' + i); await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toBe('# version ' + i) }
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(page.locator('.history-list li')).toHaveCount(13)
    await page.locator('.history-list').evaluate(element => { element.scrollTop = 350 })
    await expect.poll(() => page.locator('.history-list').evaluate(element => element.scrollTop)).toBe(350)
    await page.getByRole('tab', { name: 'other.md', exact: true }).click(); await expect(page.locator('.history-list')).toHaveCount(0)
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await expect(page.locator('.history-list')).toContainText('暂无历史版本')
    await page.getByRole('tab', { name: 'many.md', exact: true }).click(); await expect(page.locator('.history-list li')).toHaveCount(13)
    await expect.poll(() => page.locator('.history-list').evaluate(element => element.scrollTop)).toBe(350)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('saved history shows the latest auto content and manual save seals it without a Markdown rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-saved-history-')); const file = join(root, 'doc.md'); await writeFile(file, '# A')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const edit = async (text: string) => { await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(text) }
    await edit('# B'); await expect.poll(() => readFile(file, 'utf8')).toBe('# B')
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    const history = page.getByRole('complementary', { name: '历史版本', exact: true }); const rows = history.locator('li')
    await expect(rows).toHaveCount(2); await expect(rows.first()).toContainText('自动保存')
    await edit('# C'); await expect.poll(() => readFile(file, 'utf8')).toBe('# C')
    await expect(rows).toHaveCount(2); await expect(rows.first()).toContainText('自动保存')
    const { stat } = await import('node:fs/promises'); const before = await stat(file)
    await page.keyboard.press('ControlOrMeta+s'); await expect(rows.first()).toContainText('手动保存')
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs); await expect(rows).toHaveCount(2)
    await edit('# D'); await expect.poll(() => readFile(file, 'utf8')).toBe('# D'); await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('手动保存')
    await rows.first().getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.getByRole('heading', { name: 'D', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('saved-history-desktop.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600))
    await page.screenshot({ path: test.info().outputPath('saved-history-narrow.png') })
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
