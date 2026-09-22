import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test('checkpoint survives a killed isolated app, recovery stays unsaved and gated, history export leaves current tab', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-recovery-e2e-')); const path = join(root, 'doc.md'); const profile = join(root, 'profile'); await writeFile(path, '# old')
  await mkdir(profile); await writeFile(join(profile, 'history'), 'block auto history so the independent recovery is needed')
  let app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    let page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
    await openDocumentPicker(page); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await expect(page.locator('.document-status')).toContainText('草稿已备份', { timeout: 7000 }); expect(await readFile(path, 'utf8')).toBe('# old')
    const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exited
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true }); page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) })
    await expect(page.getByText('发现1份未保存稿', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '恢复未保存稿', exact: true }).click(); await expect(page.getByRole('dialog', { name: '本地备份' })).toBeVisible()
    await page.getByRole('button', { name: '查看草稿', exact: true }).click(); await expect(page.getByLabel('备份正文', { exact: true }).getByRole('heading', { name: 'old local', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click(); await expect(page.getByRole('heading', { name: 'old local', exact: true })).toBeVisible()
    await expect(page.locator('.document-status')).toContainText('等待确认'); await expect(page.locator('.document-status')).toContainText('待保存')
    await page.waitForTimeout(2200); expect(await readFile(path, 'utf8')).toBe('# old')
    await rm(join(profile, 'history'))
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(path, 'utf8')).toBe('# old local')
    await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click(); await expect(page.getByRole('heading', { name: 'old', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('backup-panel.png') })
    const exported = join(root, 'history.md'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exported)
    await page.getByRole('button', { name: '另存为…', exact: true }).click(); await expect.poll(() => readFile(exported, 'utf8').catch(() => null)).toBe('# old')
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click(); await expect(page.getByRole('heading', { name: 'old local', exact: true })).toBeVisible(); expect(await readFile(path, 'utf8')).toBe('# old local')
    await page.getByRole('button', { name: '关闭第 1 个文档', exact: true }).click()
    await expect(page.getByRole('heading', { name: '打开一份文档', exact: true })).toBeVisible()
    await expect(page.locator('.welcome-recovery')).toHaveCount(0)
    await expect(page.getByText('发现1份未保存稿', { exact: true })).toHaveCount(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
test('first checkpoint failure never displays backed up; retry and already-open restoration preserve editor, IPC rejects forged records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-recovery-failure-')); const profile = join(root, 'profile'); await mkdir(profile); await writeFile(join(profile, 'recovery'), 'blocked directory'); await writeFile(join(profile, 'history'), 'block formal auto write')
  const path = join(root, 'doc.md'); await writeFile(path, 'old')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1920, 1080) }); await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
    await openDocumentPicker(page); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' local')
    await expect(page.locator('.document-status')).toContainText('草稿备份失败', { timeout: 7000 }); await expect(page.locator('.document-status')).not.toContainText('已备份'); expect(await readFile(path, 'utf8')).toBe('old')
    await rm(join(profile, 'recovery')); await mkdir(join(profile, 'recovery'))
    await page.getByRole('alert').filter({ hasText: '未能备份最近的修改' }).getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('.document-status')).toContainText('草稿已备份')
    expect(await readFile(path, 'utf8')).toBe('old')
    await expect(page.getByRole('textbox')).toHaveText('old local')
    await page.getByRole('textbox').focus(); await page.keyboard.insertText(' retry'); await expect(page.locator('.document-status')).toContainText('草稿已备份', { timeout: 7000 })
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(item => item.label === '文件')!.submenu!.items.find(item => item.label === '本地备份…')!.click() }); await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '本地备份' }).getByRole('alert')).toContainText('已在标签中打开')
    await page.getByRole('button', { name: '关闭本地备份', exact: true }).click()
    await expect(page.getByRole('textbox')).toHaveText('old local retry'); await expect(page.getByRole('tablist', { name: '文档标签' }).getByRole('tab', { name: /doc.md.*出错/ })).toHaveCount(1)
    const rejected = await page.evaluate(async () => {
      const opened = await window.inknest.openFile(); if (opened.status !== 'ok') throw new Error('fixture open failed')
      const ref = { docId: opened.value.docId, epoch: opened.value.epoch }
      return Promise.all([
        window.inknest.inspectRecovery('../doc.md'), window.inknest.restoreRecovery(crypto.randomUUID()),
        window.inknest.checkpoint({ ...ref, revision: 100, text: 'forged', path: '/arbitrary.md' } as never),
        window.inknest.listHistory({ ...ref, path: '/arbitrary.md' } as never),
        window.inknest.inspectHistory(ref, '../doc.md')
      ])
    })
    expect(rejected.every(result => result.status === 'error')).toBe(true); expect(await readFile(path, 'utf8')).toBe('old')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
