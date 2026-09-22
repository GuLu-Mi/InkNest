import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

function launch(profile: string) {
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  return electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + profile], chromiumSandbox: true })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inknest-new-e2e-'))
  const profile = join(root, 'profile'), app = await launch(profile), page = await app.firstWindow()
  const child = app.process()
  await app.evaluate(({ dialog }) => {
    Reflect.set(globalThis, 'newDialogs', [])
    dialog.showMessageBox = async (_window, options) => {
      Reflect.get(globalThis, 'newDialogs').push(options)
      return { response: options.cancelId ?? 0, checkboxChecked: false }
    }
    dialog.showSaveDialog = async () => ({ canceled: true })
  })
  return { root, profile, app, page, child, cleanup: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) } }
}
async function saveTarget(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, filePath) => {
    Reflect.set(globalThis, 'saveOptions', [])
    dialog.showSaveDialog = async (_window, options) => { Reflect.get(globalThis, 'saveOptions').push(options); return { canceled: false, filePath } }
  }, path)
}
async function newShortcut(app: ElectronApplication, repeat = false) {
  await app.evaluate(({ app, BrowserWindow }, repeat) => {
    app.focus({ steal: true })
    const window = BrowserWindow.getAllWindows()[0]!; window.focus()
    const modifiers: ('meta' | 'control' | 'isautorepeat')[] = [process.platform === 'darwin' ? 'meta' : 'control']
    if (repeat) modifiers.push('isautorepeat')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers })
  }, repeat)
}
async function type(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Markdown 源码' }).focus()
  await page.keyboard.press('ControlOrMeta+a'); if (text) await page.keyboard.insertText(text); else await page.keyboard.press('Backspace')
}
async function capture(app: ElectronApplication, page: Page, name: string) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
}

test('home choices, menu and native shortcut create one empty editing tab per action; numbering and tab limit', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click()
    await expect(f.page.getByRole('textbox')).toBeFocused()
    await expect(f.page.locator('.document-status')).toHaveText('尚未保存到文件')
    await expect(f.page.locator('.tab-dot')).toHaveCount(0)
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await f.page.locator('.welcome-create').click()
    await newShortcut(f.app)
    await expect(f.page.getByRole('tab')).toHaveCount(3)
    await newShortcut(f.app, true)
    await expect(f.page.getByRole('tab')).toHaveCount(3)
    await f.app.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('new-document')!; item.click() })
    await expect(f.page.getByRole('tab')).toHaveCount(4)
    await f.page.getByRole('button', { name: '关闭第 2 个文档', exact: true }).click()
    await expect(f.page.getByRole('tab')).toHaveCount(3)
    await newShortcut(f.app)
    await expect(f.page.getByRole('tab', { name: '未命名-5', exact: true })).toHaveAttribute('aria-selected', 'true')
    await f.page.evaluate(async () => { for (let i = 0; i < 16; i++) await window.inknest.createDocument() })
    await expect(f.page.getByRole('tab')).toHaveCount(20)
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await f.page.locator('.welcome-create').click()
    await expect(f.page.getByRole('alert')).toContainText('20')
    await expect(f.page.getByRole('tab')).toHaveCount(20)
    expect(await f.page.evaluate(() => window.inknest.listRecovery())).toEqual({ status: 'ok', value: [] })
    expect((await readdir(f.root)).filter(name => name.endsWith('.md'))).toEqual([])
  } finally { await f.cleanup() }
})

test('first save preserves raw text, undo, selection and preview resources; empty files can also be created', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click()
    const source = '# 新建\n\n![图片](two-by-three.png)\n\n最后一行'
    await type(f.page, source)
    await f.page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(f.page.getByText(/保存文档后可加载相对路径图片/)).toBeVisible()
    await f.page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(f.page.getByText('保存为文件后开始记录历史版本。')).toBeVisible()
    await f.page.getByRole('button', { name: '关闭历史', exact: true }).click()
    await writeFile(join(f.root, 'two-by-three.png'), await readFile('tests/fixtures/images/two-by-three.png'))
    await saveTarget(f.app, join(f.root, '首存'))
    await f.page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(f.page.locator('.document-status')).toContainText('已保存')
    expect(await readFile(join(f.root, '首存.md'), 'utf8')).toBe(source)
    await expect(f.page.locator('.preview img')).toHaveCount(1)
    await expect(f.page.getByRole('tab', { name: '首存.md', exact: true })).toBeVisible()
    const options = await f.app.evaluate(() => Reflect.get(globalThis, 'saveOptions'))
    expect(options).toMatchObject([{ title: '保存 Markdown 文档', defaultPath: expect.stringMatching(/未命名-1\.md$/) }])
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'newDialogs'))).toEqual([])
    await f.page.getByRole('button', { name: '编辑', exact: true }).click()
    await f.page.keyboard.press('ControlOrMeta+z')
    await expect(f.page.getByRole('textbox')).toHaveText('')
    await f.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(f.page.getByRole('textbox')).toContainText('最后一行')
    await newShortcut(f.app)
    await saveTarget(f.app, join(f.root, 'empty.MARKDOWN'))
    await f.page.keyboard.press('ControlOrMeta+s')
    await expect(f.page.getByRole('tab', { name: 'empty.MARKDOWN', exact: true })).toBeVisible()
    expect((await readFile(join(f.root, 'empty.MARKDOWN'))).length).toBe(0)
  } finally { await f.cleanup() }
})

test('cancel, failed write and lost receipt retain content; retry checks the exact successful request', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click(); await type(f.page, '保留全部内容')
    await f.page.keyboard.press('ControlOrMeta+s')
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(f.page.getByRole('tab', { name: /未命名-1/ })).toBeVisible()
    await saveTarget(f.app, join(f.root, 'missing-directory', 'doc.md'))
    await f.page.keyboard.press('ControlOrMeta+s')
    await expect(f.page.getByRole('alert')).toContainText('保留')
    await expect(f.page.getByRole('textbox')).toHaveText('保留全部内容')
    const target = join(f.root, 'retry.md'); await saveTarget(f.app, target)
    await f.app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:save-as')
      let lose = true; Reflect.set(globalThis, 'newSaveRequests', [])
      ipcMain.removeHandler('document:save-as')
      ipcMain.handle('document:save-as', async (event, request) => {
        Reflect.get(globalThis, 'newSaveRequests').push(request)
        const result = await original(event, request)
        if (lose) { lose = false; throw new Error('injected lost reply') }
        return result
      })
    })
    await f.page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(f.page.getByText(/保存结果尚未确认/)).toBeVisible()
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await expect(f.page.getByRole('button', { name: '返回首页', exact: true })).toBeDisabled()
    expect(await readFile(target, 'utf8')).toBe('保留全部内容')
    await f.page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(f.page.getByRole('tab', { name: 'retry.md', exact: true })).toBeVisible()
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    const requests = await f.app.evaluate(() => Reflect.get(globalThis, 'newSaveRequests'))
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'saveOptions').length)).toBe(1)
  } finally { await f.cleanup() }
})

test('window exit preserves all drafts; single close defaults cancel, saves then closes or durably discards', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click(); await type(f.page, '草稿 A')
    await newShortcut(f.app); await type(f.page, '草稿 B')
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect(f.page.locator('.welcome-create')).toBeVisible()
    await f.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close() })
    await expect(f.page.locator('.document-status')).toContainText('请先保存或关闭此文档，再退出')
    await expect(f.page.getByRole('tab')).toHaveCount(2)
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'newDialogs').length)).toBe(1)
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'newDialogs')[0])).toMatchObject({ defaultId: 2, cancelId: 2, buttons: ['保存…', '不保存…', '取消'] })
    await saveTarget(f.app, join(f.root, 'closed.md'))
    await f.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.getByRole('tab')).toHaveCount(1)
    expect(await readFile(join(f.root, 'closed.md'), 'utf8')).toBe('草稿 A')
    await expect.poll(() => f.page.evaluate(async () => (await window.inknest.listRecovery()).status === 'ok')).toBe(true)
    await f.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await f.page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(f.page.locator('.welcome-create')).toBeVisible()
    expect(await f.page.evaluate(() => window.inknest.listRecovery())).toEqual({ status: 'ok', value: [] })
  } finally { await f.cleanup() }
})

test('home retains draft undo and named autosave, opens only on choice and preserves the current save action', async () => {
  const f = await fixture()
  try {
    await f.app.evaluate(({ dialog }) => {
      Reflect.set(globalThis, 'homeOpenCount', 0)
      dialog.showOpenDialog = async () => { Reflect.set(globalThis, 'homeOpenCount', Reflect.get(globalThis, 'homeOpenCount') + 1); return { canceled: true, filePaths: [] } }
    })
    await f.page.locator('.welcome-create').click(); await type(f.page, '# 保留草稿')
    await f.page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(f.page.getByRole('textbox')).toBeFocused()
    await expect(f.page.locator('.document-toolbar .document-status, .initial-save, .open-document')).toHaveCount(0)
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect(f.page.locator('.welcome-open')).toBeFocused()
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect(f.page.getByRole('tab')).toHaveCount(1)
    await expect(f.page.getByRole('tab', { selected: true })).toHaveCount(0)
    await expect(f.page.getByRole('tab')).toHaveAttribute('tabindex', '0')
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'homeOpenCount'))).toBe(0)
    await expect.poll(() => f.page.evaluate(async () => { const r = await window.inknest.listRecovery(); return r.status === 'ok' ? r.value.length : -1 })).toBe(1)
    await f.page.locator('.welcome-open').click()
    await expect(f.page.locator('.welcome-create')).toBeVisible()
    expect(await f.app.evaluate(() => Reflect.get(globalThis, 'homeOpenCount'))).toBe(1)
    await f.page.getByRole('tab').click()
    await expect(f.page.getByRole('textbox')).toHaveText('# 保留草稿')
    await f.page.getByRole('textbox').focus(); await f.page.keyboard.press('ControlOrMeta+z')
    await expect(f.page.getByRole('textbox')).toHaveText('')
    await f.page.keyboard.press('ControlOrMeta+Shift+z')
    const path = join(f.root, 'saved.md'); await saveTarget(f.app, path)
    await f.page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(f.page.locator('.document-status-bar')).toContainText('已保存')
    await type(f.page, '# 在首页继续自动保存')
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect.poll(() => readFile(path, 'utf8')).toBe('# 在首页继续自动保存')
    const opened = join(f.root, 'opened.md'); await writeFile(opened, '# 从首页打开')
    await f.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, opened)
    await f.page.locator('.welcome-open').click()
    await expect(f.page.locator('.preview h1')).toHaveText('从首页打开')
    await expect(f.page.getByRole('tab')).toHaveCount(2)
  } finally { await f.cleanup() }
})

test('overflowing tabs hide both scrollbars and remain reachable by wheel and keyboard in both themes', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click()
    await f.page.evaluate(async () => { for (let i = 0; i < 11; i++) await window.inknest.createDocument() })
    await expect(f.page.getByRole('tab')).toHaveCount(12)
    for (const theme of ['light', 'dark'] as const) {
      await f.page.getByRole('radio', { name: theme === 'light' ? '浅色主题' : '深色主题' }).click()
      await expect(f.page.locator('html')).not.toHaveClass(/theme-transition/)
      const strip = f.page.locator('.document-tabs')
      expect(await strip.evaluate(el => ({ hidden: getComputedStyle(el).scrollbarWidth, webkit: getComputedStyle(el, '::-webkit-scrollbar').display, overflowing: el.scrollWidth > el.clientWidth, vertical: el.scrollHeight > el.clientHeight }))).toEqual({ hidden: 'none', webkit: 'none', overflowing: true, vertical: false })
      await strip.hover(); await f.page.mouse.wheel(0, -5000)
      await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBe(0)
      await f.page.getByRole('tab').first().click()
      await expect(f.page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
      await f.page.getByRole('tab').first().focus(); await f.page.keyboard.press('End')
      await expect(f.page.getByRole('tab').last()).toBeFocused()
      await expect(f.page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
      await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
      await f.page.keyboard.press('Home')
      await expect(f.page.getByRole('tab').first()).toBeFocused()
      await expect(f.page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
      await f.page.keyboard.press('ArrowRight')
      await expect(f.page.getByRole('tab').nth(1)).toBeFocused()
      await expect(f.page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
      await capture(f.app, f.page, 'tabs-save-' + theme + '.png')
      await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
      await expect(f.page.locator('.welcome-create')).toBeVisible()
      await capture(f.app, f.page, 'home-' + theme + '.png')
      await f.page.getByRole('tab').last().click()
    }
  } finally { await f.cleanup() }
})

test('crash restores separate unnamed drafts into editing and latest empty recovery does not resurrect old content', async () => {
  const f = await fixture()
  let restarted: ElectronApplication | undefined
  try {
    await f.page.locator('.welcome-create').click(); await type(f.page, '恢复 A')
    await newShortcut(f.app); await type(f.page, '恢复 B')
    await expect.poll(() => f.page.evaluate(async () => { const result = await window.inknest.listRecovery(); return result.status === 'ok' ? result.value.length : -1 })).toBe(2)
    await type(f.page, '')
    await expect.poll(() => f.page.evaluate(async () => { const result = await window.inknest.listRecovery(); return result.status === 'ok' ? result.value.length : -1 })).toBe(1)
    await type(f.page, '恢复 B 最新')
    await expect.poll(() => f.page.evaluate(async () => { const result = await window.inknest.listRecovery(); return result.status === 'ok' ? result.value.length : -1 })).toBe(2)
    const exited = new Promise<void>(resolve => f.child.once('exit', () => resolve()))
    f.child.kill('SIGKILL'); await exited
    restarted = await launch(f.profile); const page = await restarted.firstWindow()
    await page.getByRole('button', { name: '恢复未保存稿', exact: true }).click()
    await page.getByRole('button', { name: '恢复草稿', exact: true }).nth(0).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    const first = await page.getByRole('textbox').innerText()
    await restarted.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(item => item.label === '文件')!.submenu!.items.find(item => item.label === '本地备份…')!.click() })
    await page.getByRole('button', { name: '恢复草稿', exact: true }).nth(1).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    expect([first, await page.getByRole('textbox').innerText()].sort()).toEqual(['恢复 A', '恢复 B 最新'])
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(page.locator('.document-status')).toContainText('尚未保存到文件')
  } finally { restarted?.process().kill('SIGKILL'); await f.cleanup() }
})

test('strict create IPC, two themes and 200 percent narrow layout keep controls reachable', async () => {
  const f = await fixture()
  try {
    const denied = await f.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      const handler = Reflect.get(ipcMain, '_invokeHandlers').get('document:create')
      return Promise.all([
        handler({ sender: contents, senderFrame: contents.mainFrame }, { path: '/tmp/forged.md' }),
        handler({ sender: contents, senderFrame: { url: 'inknest://app/' } })
      ])
    })
    expect(denied).toMatchObject([{ status: 'error', error: { code: 'INVALID_REQUEST' } }, { status: 'error', error: { code: 'INVALID_REQUEST' } }])
    await f.page.locator('.welcome-create').click()
    await f.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 600); window.webContents.setZoomFactor(2) })
    await expect.poll(() => f.page.evaluate(() => innerWidth)).toBe(400)
    for (const theme of ['light', 'dark'] as const) {
      await f.page.getByRole('radio', { name: theme === 'light' ? '浅色主题' : '深色主题' }).click()
      await expect(f.page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(f.page.locator('html')).not.toHaveClass(/theme-transition/)
      for (const selector of ['.open-tab', '.quick-save', '.document-status-bar', '.presentation-trigger']) {
        const rect = await f.page.locator(selector).boundingBox(); const size = await f.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        expect(rect).not.toBeNull(); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(size.width + 1)
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(size.height)
      }
      await capture(f.app, f.page, 'new-document-' + theme + '-200.png')
    }
  } finally { await f.cleanup() }
})

test('home waits for unfinished composition and returns focus without dropping text, mode or scroll', async () => {
  const f = await fixture()
  try {
    await f.page.locator('.welcome-create').click()
    const source = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')
    await type(f.page, source)
    const editor = f.page.getByRole('textbox', { name: 'Markdown 源码' })
    await f.page.locator('.cm-scroller').evaluate(el => { el.scrollTop = 400 })
    await expect.poll(() => f.page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBe(400)
    await editor.dispatchEvent('compositionstart', { data: '拼' })
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect(f.page.getByRole('alert')).toContainText('输入尚未完成', { timeout: 7000 })
    await expect(editor).toBeFocused()
    await expect(f.page.locator('.welcome-stage')).toHaveCount(0)
    await expect(f.page.getByRole('tab')).toHaveCount(1)
    await editor.dispatchEvent('compositionend', { data: '拼' })
    await f.page.getByRole('button', { name: '返回首页', exact: true }).click()
    await expect(f.page.locator('.welcome-open')).toBeFocused()
    await f.page.getByRole('tab').click()
    await expect(editor).toBeVisible()
    await expect(f.page.getByRole('alert')).toHaveCount(0)
    await expect.poll(() => f.page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBe(400)
    const target = join(f.root, 'composition.md'); await saveTarget(f.app, target)
    await f.page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => readFile(target, 'utf8').catch(() => null)).toBe(source)
  } finally { await f.cleanup() }
})
