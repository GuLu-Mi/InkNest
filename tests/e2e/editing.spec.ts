import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function select(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
}
async function decision(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, answer) => { dialog.showMessageBox = async (_window, options) => {
    Reflect.set(globalThis, 'lastCloseOptions', options)
    return { response: answer, checkboxChecked: false }
  } }, response)
}

test('edits Chinese multiline text, preserves history across modes and styles CodeMirror under production CSP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-edit-'))
  const path = join(root, '中文.md'); await writeFile(path, '# 原文\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源码' })
    await editor.click(); await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.insertText('中文输入\n第二行\n')
    await expect(page.getByRole('status')).toContainText('待保存')
    await expect(page).toHaveTitle(/\*/u)
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.preview')).toContainText('中文输入')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await editor.click(); await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveText('# 原文')
    await expect(page.getByRole('status')).toContainText('已保存')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(editor).toContainText('第二行')
    const styling = await page.evaluate(() => ({
      display: getComputedStyle(document.querySelector('.cm-editor')!).display,
      whitespace: getComputedStyle(document.querySelector('.cm-content')!).whiteSpace,
      nonce: document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce,
      csp: document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content
    }))
    expect(styling.display).toBe('flex')
    expect(styling.whitespace).toBe('break-spaces')
    expect(styling.nonce).toMatch(/^[A-Za-z0-9+/]{32}$/u)
    expect(styling.csp).toContain(`'nonce-${styling.nonce}'`)
    const header = await app.evaluate(async ({ net }) => (await net.fetch('inknest://app/')).headers.get('Content-Security-Policy'))
    expect(header).toContain(`'nonce-${styling.nonce}'`)
    expect(header).toContain("frame-ancestors 'none'")
    expect(errors).toEqual([])
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight')
    const selected = await page.evaluate(() => window.getSelection()?.toString())
    expect(selected).toBe('中文')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await editor.focus()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
    await page.screenshot({ path: test.info().outputPath('editing.png') })
    await decision(app, 1)
    expect(await readFile(path, 'utf8')).toBe('中文输入\n第二行\n# 原文\n')
  } finally { await decision(app, 1); app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('protects retained tab edits on failed native close, freezes its snapshot, and disables reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-close-'))
  const first = join(root, 'first.md'); const second = join(root, 'second.md')
  await writeFile(first, '# 第一份\n'); await writeFile(second, '# 第二份\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, first)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').click(); await page.keyboard.insertText('即时输入')
    await decision(app, 0)
    await select(app, page, second)
    await expect(page.getByRole('tab', { selected: true })).toContainText('second.md')
    await page.getByRole('tab', { name: /first.md/ }).click()
    await expect(page.getByRole('textbox')).toContainText('即时输入')
    await page.keyboard.press('ControlOrMeta+r')
    await page.keyboard.press('F5')
    // Electron cancels beforeunload itself; suppress Playwright's redundant dialog dismissal.
    page.on('dialog', () => {})
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload())
    await page.waitForTimeout(100)
    await expect(page.getByRole('textbox')).toContainText('即时输入')
    const menuRoles = await app.evaluate(({ Menu }) => {
      const roles: string[] = []
      const walk = (menu: Electron.Menu | null) => { for (const item of menu?.items ?? []) { if (item.role) roles.push(item.role); walk(item.submenu ?? null) } }
      walk(Menu.getApplicationMenu()); return roles
    })
    expect(menuRoles).not.toContain('reload'); expect(menuRoles).not.toContain('forceReload')
    const completeText = await page.locator('.cm-content').evaluate(element => Reflect.get(element, 'cmTile').root.view.state.doc.toString() as string)
    await chmod(first, 0o444)
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close')
      ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', (event, id, state) => new Promise(resolve => {
        Reflect.set(globalThis, 'finishCloseState', async () => { const result = await original(event, id, state); Reflect.set(globalThis, 'closeFailure', result); Reflect.set(globalThis, 'closeState', state); resolve(result) })
      }))
      Reflect.set(globalThis, 'originalCompleteClose', original)
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'finishCloseState'))).toBe('function')
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await app.evaluate(() => Reflect.get(globalThis, 'finishCloseState')())
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'closeFailure'))).toMatchObject({ status: 'error' })
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    expect(await page.locator('.cm-content').evaluate(element => Reflect.get(element, 'cmTile').root.view.state.doc.toString())).toBe(completeText)
    expect(await readFile(first, 'utf8')).toBe('# 第一份\n')
    await chmod(first, 0o644)
    const state = await app.evaluate(() => Reflect.get(globalThis, 'closeState') as import('../../src/shared/contracts').CurrentState)
    expect(await page.evaluate(state => window.inknest.reconcileExternal(state), state)).toMatchObject({ status: 'ok' })
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('document:complete-close'); ipcMain.handle('document:complete-close', Reflect.get(globalThis, 'originalCompleteClose')) })
    await select(app, page, second)
    await expect(page.getByRole('tab', { selected: true })).toContainText('second.md')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => app.windows().length).toBe(0)
    expect(await readFile(first, 'utf8')).toBe(completeText); expect(await readFile(second, 'utf8')).toBe('# 第二份\n')
  } finally { await decision(app, 1); app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('native quit preserves failed latest text, then saves directly after the source is repaired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-quit-'))
  const path = join(root, 'quit.md'); await writeFile(path, '# 退出\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  let exited = false
  try {
    const page = await app.firstWindow()
    await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').click(); await page.keyboard.insertText('退出前最新输入')
    const completeText = await page.locator('.cm-content').evaluate(element => Reflect.get(element, 'cmTile').root.view.state.doc.toString() as string)
    await chmod(path, 0o444)
    await app.evaluate(({ ipcMain, app }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:complete-close')
      ipcMain.removeHandler('document:complete-close'); ipcMain.handle('document:complete-close', async (event, id, state) => { const result = await original(event, id, state); Reflect.set(globalThis, 'quitResult', result); Reflect.set(globalThis, 'quitState', state); return result })
      app.quit()
    })
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'quitResult'))).toMatchObject({ status: 'error' })
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    expect(await page.locator('.cm-content').evaluate(element => Reflect.get(element, 'cmTile').root.view.state.doc.toString())).toBe(completeText)
    expect(await readFile(path, 'utf8')).toBe('# 退出\n')
    await chmod(path, 0o644)
    const state = await app.evaluate(() => Reflect.get(globalThis, 'quitState') as import('../../src/shared/contracts').CurrentState)
    expect(await page.evaluate(state => window.inknest.reconcileExternal(state), state)).toMatchObject({ status: 'ok' })
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
    await closed; exited = true
    expect(await readFile(path, 'utf8')).toBe(completeText)
  } finally { if (!exited) app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('same-file open keeps history and a failed additive open retains edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-replace-failure-'))
  const path = join(root, 'old.md'); const next = join(root, 'next.md')
  await writeFile(path, '# 保留\n'); await writeFile(next, '# 删除候选\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, path)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('保留修改')
    await expect(page.getByRole('textbox')).toContainText('保留修改')
    await select(app, page, path)
    await expect(page.getByRole('textbox')).toContainText('保留修改')
    await rm(next)
    await select(app, page, next)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('tab', { selected: true })).toContainText('old.md')
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(page.getByRole('textbox')).toContainText('保留修改')
    await page.getByRole('textbox').click(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByRole('status')).toContainText('已保存')
  } finally { await decision(app, 1); app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('lost renderer close response times out without closing and unsolicited close replies are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-close-timeout-'))
  const path = join(root, 'timeout.md'); await writeFile(path, '# 超时\n')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await select(app, page, path)
    const result = await page.evaluate(() => window.inknest.completeClose('12345678-1234-1234-1234-123456789abc', { ref: { docId: '12345678-1234-1234-1234-123456789abc', epoch: '12345678-1234-1234-1234-123456789abc' }, snapshot: null }))
    expect(result.status).toBe('error')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').click(); await page.keyboard.insertText('未响应也保留')
    await decision(app, 0)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('document:complete-close')
      ipcMain.handle('document:complete-close', () => new Promise(() => {}))
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'false')
    await expect(page.locator('.document-status')).toContainText('草稿已备份')
    const { RecoveryStore } = await import('../../src/main/documents/recovery-store')
    const { DocumentRegistry } = await import('../../src/main/documents/registry')
    const recovery = new RecoveryStore(join(root, 'profile', 'recovery'), new DocumentRegistry())
    const entries = await recovery.list(); expect(entries).toHaveLength(1)
    expect(await recovery.inspect(entries[0]!.id)).toContain('未响应也保留')
    expect(await readFile(path, 'utf8')).toBe('# 超时\n')
    await expect(page.getByRole('alert')).toContainText('暂时无法完成关闭', { timeout: 7000 })
    await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await expect(page.getByRole('textbox')).toContainText('未响应也保留')
    expect(app.windows()).toHaveLength(1)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('ignores an old preview result after a newer revision has rendered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-preview-revisions-'))
  const path = join(root, 'revisions.md'); await writeFile(path, '# 标题\n\n![受限图片](missing.png)')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await select(app, page, path)
    await expect(page.locator('.preview')).toContainText('标题')
    await app.evaluate(({ ipcMain }) => {
      const pending: Array<() => void> = []
      Reflect.set(globalThis, 'pendingPreviews', pending)
      ipcMain.removeHandler('document:resources')
      ipcMain.handle('document:resources', () => new Promise((resolve) => { pending.push(() => resolve({ status: 'ok', value: [] })) }))
    })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('# 旧修订\n')
    await expect(page.getByRole('navigation', { name: '文档目录', exact: true }).getByRole('button', { name: '旧修订', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'pendingPreviews').length)).toBe(1)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus()
    await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('# 最新修订\n')
    await expect(page.getByRole('navigation', { name: '文档目录', exact: true }).getByRole('button', { name: '最新修订', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'pendingPreviews').length)).toBe(2)
    await app.evaluate(() => Reflect.get(globalThis, 'pendingPreviews')[1]())
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible()
    await expect(page.locator('.preview')).toContainText('最新修订')
    await app.evaluate(() => Reflect.get(globalThis, 'pendingPreviews')[0]())
    await page.waitForTimeout(200)
    await expect(page.locator('.preview')).toContainText('最新修订')
  } finally { await decision(app, 1); app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
