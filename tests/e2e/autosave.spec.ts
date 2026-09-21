import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
async function select(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
}
async function edit(page: Page, text: string) { await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text) }
test('unchanged opening never touches bytes; independent background auto receipt preserves latest edit and active tab', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-autosave-')); const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A'); await writeFile(b, '# B'); const initial = await stat(a); const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex'); const originalHash = hash(await readFile(a))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, a); await page.waitForTimeout(2200)
    expect((await stat(a)).mtimeMs).toBe(initial.mtimeMs); expect(hash(await readFile(a))).toBe(originalHash)
    await app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:save'); let held = false
      ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', async (...args) => {
        const hold = !held; held = true; const result = await original(...args)
        if (!hold) return result
        Reflect.set(globalThis, 'savedAutoA', result)
        return new Promise(resolve => Reflect.set(globalThis, 'releaseAutoA', () => resolve(result)))
      })
    })
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await edit(page, ' first')
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'savedAutoA'))).toMatchObject({ status: 'ok', value: { savedRevision: 1 } })
    await edit(page, ' latest'); await select(app, page, b); await page.getByRole('button', { name: '编辑', exact: true }).click(); await edit(page, ' local')
    await app.evaluate(() => Reflect.get(globalThis, 'releaseAutoA')())
    await expect(page).toHaveTitle(/InkNest$/u); await expect(page.getByRole('tab', { selected: true })).toHaveText('b.md')
    await expect.poll(() => readFile(a, 'utf8')).toBe('# A first latest'); await expect.poll(() => readFile(b, 'utf8')).toBe('# B local')
    await page.getByRole('tab', { name: 'a.md', exact: true }).click(); await expect(page.getByRole('textbox')).toHaveText('# A first latest')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page.getByRole('textbox')).not.toHaveText('# A first latest')
    await page.getByRole('button', { name: '预览', exact: true }).click(); await expect(page.locator('.document-status')).toContainText('已保存')
    const forbidden = await page.evaluate(async () => {
      const result = await window.inknest.openFile(); if (result.status !== 'ok') throw new Error('fixture')
      const d = result.value; return window.inknest.save({ requestId: crypto.randomUUID(), snapshot: { docId: d.docId, epoch: d.epoch, revision: d.revision, text: d.text }, expectedDiskToken: d.diskToken, trigger: 'close' })
    }); expect(forbidden).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('history failure pauses automatic retries, recovery remains independent, explicit manual action resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-autosave-failure-')); const profile = join(root, 'profile'); await mkdir(profile); await writeFile(join(profile, 'history'), 'blocked')
  const path = join(root, 'doc.md'); await writeFile(path, 'old')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path); await page.getByRole('button', { name: '编辑', exact: true }).click(); await edit(page, ' failed')
    await expect(page.locator('.document-status')).toContainText('修改尚未保存'); await expect(page.locator('.document-status')).toContainText('草稿已备份'); expect(await readFile(path, 'utf8')).toBe('old')
    await rm(join(profile, 'history')); await edit(page, ' pending'); await page.waitForTimeout(2200); expect(await readFile(path, 'utf8')).toBe('old')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(path, 'utf8')).toBe('old failed pending')
    await edit(page, ' resumed'); await expect.poll(() => readFile(path, 'utf8')).toBe('old failed pending resumed')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('recovered preview stays gated; genuine editor change autosaves before the two-second checkpoint', async () => {
  const { DocumentRegistry } = await import('../../src/main/documents/registry'); const { RecoveryStore } = await import('../../src/main/documents/recovery-store')
  const root = await mkdtemp(join(tmpdir(), 'inknest-autosave-restored-')); const profile = join(root, 'profile'); const path = join(root, 'restore.md'); await writeFile(path, 'disk')
  const registry = new DocumentRegistry(); await registry.open(path, 1); const session = registry.current!
  const store = new RecoveryStore(join(profile, 'recovery'), registry); await store.checkpoint(session, { docId: session.document.docId, epoch: session.document.epoch, revision: 7, text: 'restored' })
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: '查看', exact: true }).click(); await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
    await expect(page.locator('.document-status')).toContainText('等待确认'); await page.waitForTimeout(2200); expect(await readFile(path, 'utf8')).toBe('disk')
    await app.evaluate(({ ipcMain }) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('backup:checkpoint'); if (typeof original !== 'function') throw new Error('checkpoint handler is not registered'); Reflect.set(globalThis, 'checkpointCount', 0)
      ipcMain.removeHandler('backup:checkpoint'); ipcMain.handle('backup:checkpoint', (...args) => { Reflect.set(globalThis, 'checkpointCount', Reflect.get(globalThis, 'checkpointCount') + 1); return original(...args) })
    })
    // Positive control through the real preload API and registered main handler.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
    expect(await page.evaluate(async () => {
      const opened = await window.inknest.openFile(); if (opened.status !== 'ok') throw new Error('control open failed')
      const { docId, epoch } = opened.value
      return window.inknest.checkpoint({ docId, epoch, revision: 7, text: 'restored' })
    })).toMatchObject({ status: 'ok', value: { revision: 7 } })
    expect(await app.evaluate(() => Reflect.get(globalThis, 'checkpointCount'))).toBe(1)
    await app.evaluate(() => Reflect.set(globalThis, 'checkpointCount', 0))
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await edit(page, ' edited')
    await expect.poll(() => readFile(path, 'utf8'), { intervals: [50], timeout: 1800 }).toBe('restored edited')
    expect(await app.evaluate(() => Reflect.get(globalThis, 'checkpointCount'))).toBe(0)
    await expect(page.locator('.document-status')).toContainText('已保存'); await expect(page.locator('.document-status')).not.toContainText('等待确认')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

for (const action of ['save-as', 'overwrite'] as const) for (const oldReply of ['success', 'rejected'] as const) test(`held auto ${oldReply} after newer ${action} leaves subsequent edits automatically saveable`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-auto-obsolete-')); const path = join(root, 'original.md'); const copy = join(root, 'copy.md'); await writeFile(path, '# original')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, path); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await app.evaluate(({ ipcMain }, oldReply) => {
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('document:save'); let held = false
      ipcMain.removeHandler('document:save'); ipcMain.handle('document:save', async (...args) => {
        const hold = !held; held = true; const result = await original(...args)
        if (!hold) return result
        Reflect.set(globalThis, 'heldAutoResult', result)
        return new Promise((resolve, reject) => Reflect.set(globalThis, 'releaseObsoleteAuto', () => oldReply === 'success' ? resolve(result) : reject(new Error('injected obsolete IPC rejection'))))
      })
    }, oldReply)
    await edit(page, ' auto'); await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'heldAutoResult'))).toMatchObject({ status: 'ok' }); expect(await readFile(path, 'utf8')).toBe('# original auto')
    await edit(page, ' newer')
    await app.evaluate(({ dialog }, copy) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }, copy)
    if (action === 'save-as') await page.keyboard.press('ControlOrMeta+Shift+s')
    else { await writeFile(path, '# external'); await page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click() }
    const target = action === 'save-as' ? copy : path
    await expect.poll(() => readFile(target, 'utf8').catch(() => null)).toBe('# original auto newer'); await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    await app.evaluate(() => Reflect.get(globalThis, 'releaseObsoleteAuto')()); await expect(page.locator('.document-status')).toContainText('已保存')
    await edit(page, ' latest'); await expect.poll(() => readFile(target, 'utf8')).toBe('# original auto newer latest')
    await expect(page.getByRole('textbox')).toHaveText('# original auto newer latest'); await expect(page.locator('.document-status')).toContainText('已保存'); await expect(page.getByRole('alert')).toHaveCount(0)
    if (action === 'save-as') expect(await readFile(path, 'utf8')).toBe('# original auto')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('background dirty auto survives an active composition close timeout before document freezing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-auto-freeze-timeout-')); const a = join(root, 'a.md'); const b = join(root, 'b.md'); await writeFile(a, '# A'); await writeFile(b, '# B')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await select(app, page, a); await page.getByRole('button', { name: '编辑', exact: true }).click(); await select(app, page, b); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await edit(page, ' pending'); await page.getByRole('tab', { name: 'a.md', exact: true }).click()
    // Synthetic composition covers scheduling/close timing; native OS IME remains separate acceptance.
    await page.getByRole('textbox').dispatchEvent('compositionstart', { data: '候选' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect(page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeDisabled()
    await page.waitForTimeout(2200); expect(await readFile(b, 'utf8')).toBe('# B')
    // Main close and renderer composition both have 5s deadlines; either truthful
    // retained-content message may arrive last. State assertions below stay exact.
    await expect(page.getByRole('alert')).toHaveText(/^(?:输入尚未完成，请完成输入后重试。|暂时无法完成关闭，文档已保留。请稍后重试。)$/u, { timeout: 6000 }); expect(app.windows()).toHaveLength(1)
    await expect(page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeEnabled(); await expect.poll(() => readFile(b, 'utf8')).toBe('# B pending')
    expect(await readFile(a, 'utf8')).toBe('# A'); await expect(page.getByRole('textbox')).toHaveText('# A')
    await page.getByRole('textbox').dispatchEvent('compositionend', { data: '候选' }); await page.getByRole('tab', { name: 'b.md', exact: true }).click(); await expect(page.getByRole('textbox')).toHaveText('# B pending')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
