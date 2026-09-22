import { openDocumentPicker } from './open-document'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('capsule changes global theme without replacing the editor, persists, and respects reduced motion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-theme-ui-')); const profile = join(root, 'profile'); const file = join(root, 'sample.md')
  await writeFile(file, '# Theme sample\n\nReading and editing.\n\n| A | B |\n| --- | --- |\n| one | two |')
  const executablePath = process.env.INKNEST_TEST_EXECUTABLE
  const launch = () => electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`], chromiumSandbox: true })
  let app: ElectronApplication = await launch()
  try {
    let page = await app.firstWindow()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await openDocumentPicker(page)
    const dark = page.getByRole('radio', { name: '深色主题' }); const light = page.getByRole('radio', { name: '浅色主题' })
    await light.click(); await expect(light).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('\nNew words')
    await dark.click(); await expect(dark).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => page.locator('.shell').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(29, 31, 35)')
    await expect(page.locator('.theme-thumb')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 30, 0)')
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(page.getByRole('textbox')).not.toContainText('New words')
    await dark.focus(); await page.keyboard.press('ArrowLeft'); await expect(light).toBeFocused(); await expect(light).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowRight'); await expect(dark).toBeFocused(); await expect(dark).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => JSON.parse(await readFile(join(profile, 'theme.json'), 'utf8')).theme).toBe('dark')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 260)))
    await writeFile(test.info().outputPath('dark-capsule.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    await page.emulateMedia({ reducedMotion: 'reduce' }); await light.click()
    await expect(page.locator('.theme-thumb')).toHaveCSS('transition-duration', '0s')
    await dark.click(); await expect.poll(async () => JSON.parse(await readFile(join(profile, 'theme.json'), 'utf8')).theme).toBe('dark')
    await app.close(); app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('radio', { name: '深色主题' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('radio', { name: '浅色主题' }).click(); await expect.poll(() => page.locator('.shell').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)')
    await writeFile(test.info().outputPath('light-capsule.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('theme frames keep inherited text and editor surfaces synchronized without a late color reversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-theme-frames-'))
  const file = join(root, 'sample.md')
  await writeFile(file, '# Theme frames\n\nNormal **bold *nested*** text.\n\n> Secondary **nested** text.')
  const executablePath = process.env.INKNEST_TEST_EXECUTABLE
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await openDocumentPicker(page)
    await expect(page.locator('.preview strong em')).toBeVisible()
    await page.getByRole('radio', { name: '浅色主题' }).click()
    await expect(page.locator('html')).not.toHaveClass(/theme-transition/)

    for (const mode of ['reading', 'editing'] as const) {
      if (mode === 'editing') await page.getByRole('button', { name: '编辑', exact: true }).click()
      for (const choice of ['dark', 'light'] as const) {
        const frames = await page.evaluate(async ({ mode, choice }) => {
          const color = (selector: string, property: 'color' | 'backgroundColor') => getComputedStyle(document.querySelector(selector)!)[property]
          const samples: Array<{ primary: string; text: string[]; surface: string; backgrounds: string[] }> = []
          const start = performance.now()
          const button = document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${choice === 'dark' ? '深色主题' : '浅色主题'}"]`)!
          button.click()
          do {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
            samples.push({
              primary: color('html', 'color'),
              text: (mode === 'reading' ? ['.preview', '.preview > p', '.preview strong', '.preview strong em'] : ['.cm-editor', '.cm-content']).map(selector => color(selector, 'color')),
              surface: color('html', 'backgroundColor'),
              backgrounds: (mode === 'reading' ? ['.shell'] : ['.shell', '.editor-pane', '.cm-editor']).map(selector => color(selector, 'backgroundColor'))
            })
          } while (performance.now() - start < 360)
          return samples
        }, { mode, choice })
        expect(frames.length).toBeGreaterThan(2)
        for (const frame of frames) {
          expect(frame.text.every(value => value === frame.primary), JSON.stringify(frame)).toBe(true)
          expect(frame.backgrounds.every(value => value === frame.surface), JSON.stringify(frame)).toBe(true)
        }
        expect(frames.at(-1)?.primary).toBe(choice === 'dark' ? 'rgb(227, 229, 233)' : 'rgb(38, 41, 48)')
        expect(frames.at(-1)?.surface).toBe(choice === 'dark' ? 'rgb(29, 31, 35)' : 'rgb(255, 255, 255)')
        // A second transition on an inheriting child used to turn the text back
        // toward its old color after the root's 200 ms transition had finished.
        const reds = frames.map(frame => Number(frame.primary.match(/\d+/)![0]))
        expect(reds.every((value, index) => index === 0 || (choice === 'dark' ? value >= reds[index - 1]! : value <= reds[index - 1]!))).toBe(true)
      }
    }
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
