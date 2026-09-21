import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('only modified text links open; images use plain click; Markdown reuses tabs and navigates anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-link-ui-')); const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, '# A\n\n[Other](b.md#target)\n\n[Web](https://example.test/test.md)\n\n[Mail](mailto:user@example.test)\n\n[Image](one.png)\n\n[Image Two](two.png)\n\n[Broken image](missing.png)\n\n[Missing](missing.md)\n\n[Jump](#ending)\n\n' + 'paragraph\n\n'.repeat(80) + '## Ending\n\nDone')
  await writeFile(b, '# B\n\n[Back](a.md)\n\n' + 'paragraph\n\n'.repeat(80) + '## Target\n\nDestination')
  await copyFile(resolve('tests/fixtures/images/valid.png'), join(root, 'one.png')).catch(async () => { await writeFile(join(root, 'one.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64')) })
  await copyFile(join(root, 'one.png'), join(root, 'two.png'))
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog, shell }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); Reflect.set(globalThis, 'linkCalls', []); shell.openExternal = async url => { Reflect.get(globalThis, 'linkCalls').push(url) } }, a)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    const modifier = process.platform === 'darwin' ? 'Meta' as const : 'Control' as const
    await page.getByRole('link', { name: 'Other', exact: true }).click(); await expect(page.getByRole('tab')).toHaveCount(1)
    await page.getByRole('link', { name: 'Web', exact: true }).click(); expect(await app.evaluate(() => Reflect.get(globalThis, 'linkCalls'))).toEqual([])
    const webBounds = await page.getByRole('link', { name: 'Web', exact: true }).boundingBox(); if (!webBounds) throw new Error('Missing link')
    await page.keyboard.down(modifier); await page.mouse.move(webBounds.x + 1, webBounds.y + webBounds.height / 2); await page.mouse.down()
    await page.mouse.move(webBounds.x + webBounds.width - 1, webBounds.y + webBounds.height / 2, { steps: 10 }); await page.mouse.up(); await page.keyboard.up(modifier)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'linkCalls'))).toEqual([])
    await page.getByRole('link', { name: 'Web', exact: true }).focus(); await page.keyboard.press('Enter')
    expect(await app.evaluate(() => Reflect.get(globalThis, 'linkCalls'))).toEqual([])
    await page.keyboard.press(`${modifier}+Enter`)
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'linkCalls'))).toEqual(['https://example.test/test.md'])
    await page.getByRole('link', { name: 'Mail', exact: true }).click({ modifiers: [modifier] }); await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'linkCalls').length)).toBe(2)
    await page.getByRole('link', { name: 'Image', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '图片查看器' }); await expect(viewer).toBeVisible()
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click()
    await expect.poll(() => viewer.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await expect(viewer.locator('img')).toHaveAttribute('alt', 'Image Two')
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click(); await expect(viewer.getByRole('alert')).toBeVisible()
    await expect(viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true })).toBeDisabled()
    await expect(viewer.getByRole('button', { name: '放大图片', exact: true })).toBeDisabled()
    await viewer.locator('.image-viewer-viewport').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 })
    await expect(viewer.getByRole('alert')).toBeVisible()
    await viewer.getByRole('button', { name: '上一张图片', exact: true }).click(); await expect(viewer.locator('img')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('link', { name: 'Other', exact: true }).click({ modifiers: [modifier] })
    await expect(page.getByRole('tab', { name: 'b.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: 'Target', exact: true })).toBeInViewport()
    await page.getByRole('tab', { name: 'a.md', exact: true }).click(); await page.getByRole('link', { name: 'Other', exact: true }).click({ modifiers: [modifier] }); await expect(page.getByRole('tab')).toHaveCount(2)
    await page.getByRole('tab', { name: 'a.md', exact: true }).click(); await page.getByRole('link', { name: 'Missing', exact: true }).click({ modifiers: [modifier] }); await expect(page.locator('.toast-notice')).toBeVisible()
    await page.getByRole('link', { name: 'Jump', exact: true }).click({ modifiers: [modifier] }); await expect(page.getByRole('heading', { name: 'Ending', exact: true })).toBeInViewport()
    await writeFile(test.info().outputPath('links.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
  } finally { const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }) }
})
