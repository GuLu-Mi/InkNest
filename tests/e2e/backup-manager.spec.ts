import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native backups command opens a bounded modal with keyboard dismissal and focus restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-backup-dialog-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.welcome-recovery')).toHaveCount(0)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().focus()
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(i => i.label === '文件')!.submenu!.items.find(i => i.label === '本地备份…')!.click() })
    const dialog = page.getByRole('dialog', { name: '本地备份', exact: true })
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText('没有待恢复草稿')
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden()
    await expect(page.locator('.welcome-recovery')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeFocused()
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('recovery preview renders safe Markdown with no borrowed image authority and cleanup cancellation keeps live drafts', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'inknest-backup-safe-')); const profile = join(root, 'profile'); await mkdir(profile); await writeFile(join(profile, 'history'), 'block autosave')
  const path = join(root, 'source.md'); await writeFile(path, '# Current')
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) }, path)
    await openDocumentPicker(page); await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# Draft\n\n![local](image.png)\n\n<script>window.backupUnsafe = true</script>\n\n```mermaid\nflowchart LR\nA[草稿]-->B[备份]\n```\n\n$E=mc^2$')
    await expect(page.locator('.document-status')).toContainText('草稿已备份', { timeout: 7000 })
    // Observe the real privileged resolver: recovery preview must not borrow the active document capability.
    await app.evaluate(({ ipcMain }) => { const original = (Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (...args: unknown[]) => unknown>).get('document:resources')!; Reflect.set(globalThis, 'recoveryResourceReads', 0); ipcMain.removeHandler('document:resources'); ipcMain.handle('document:resources', (...args) => { Reflect.set(globalThis, 'recoveryResourceReads', Number(Reflect.get(globalThis, 'recoveryResourceReads')) + 1); return original(...args) }) })
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(i => i.label === '文件')!.submenu!.items.find(i => i.label === '本地备份…')!.click() })
    const dialog = page.getByRole('dialog', { name: '本地备份' }); await dialog.getByRole('button', { name: '查看草稿', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Draft' })).toBeVisible(); await expect(dialog.locator('.backup-preview')).toContainText('图片暂时无法显示'); await expect(dialog.locator('img')).toHaveCount(0)
    await expect(dialog.locator('.diagram-view svg')).toHaveCount(1)
    await expect(dialog.locator('.math-rendered math')).toHaveCount(1)
    await dialog.getByRole('button', { name: '查看源码', exact: true }).click()
    await expect(dialog.locator('pre')).toContainText('flowchart LR')
    expect(await page.evaluate(() => Reflect.get(window, 'backupUnsafe'))).toBeUndefined()
    expect(await app.evaluate(() => Reflect.get(globalThis, 'recoveryResourceReads'))).toBe(0)
    await dialog.getByRole('button', { name: '清理旧草稿', exact: true }).click(); await expect(dialog.getByRole('button', { name: '查看草稿', exact: true })).toHaveCount(1)
    await dialog.getByRole('button', { name: '丢弃草稿', exact: true }).click(); await expect(dialog.getByRole('button', { name: '查看草稿', exact: true })).toHaveCount(1)
    expect(await readFile(path, 'utf8')).toBe('# Current')
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
