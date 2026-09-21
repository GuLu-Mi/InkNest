import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

test('plain click opens the image modal, navigation resets zoom, Escape restores focus and wheel stays isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-image-viewer-'))
  const document = join(root, 'images.md')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(root, 'one.png'), png)
  await writeFile(join(root, 'two.png'), png)
  await writeFile(document, '# Images\n\n![第一张](one.png)\n\n![第二张](two.png)\n\n' + 'Long text\n\n'.repeat(100))
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow({ timeout: 10000 })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, document)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    const origin = page.locator('.preview img').first()
    await expect.poll(() => origin.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await origin.click()
    const viewer = page.getByRole('dialog', { name: '图片查看器' })
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('img')).toHaveAttribute('draggable', 'false')
    await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('125%')
    await viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true }).click()
    await expect(viewer.locator('img')).toHaveCSS('transform', /matrix\(0, 1, -1, 0,/)
    const oldImage = await viewer.locator('img').elementHandle()
    await viewer.evaluate(element => {
      element.querySelector('.image-viewer-viewport')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }))
      element.querySelector<HTMLButtonElement>('[aria-label="下一张图片"]')!.click()
    })
    await expect(viewer.getByAltText('第二张')).toBeVisible()
    await oldImage!.evaluate(element => { element.dispatchEvent(new Event('load')); element.dispatchEvent(new Event('error')) })
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    await expect(viewer.locator('img')).toHaveCSS('transform', /matrix\(1, 0, 0, 1,/)
    await viewer.locator('.image-viewer-viewport').focus()
    await page.keyboard.press('ArrowLeft')
    await expect(viewer.getByAltText('第一张')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(viewer.getByAltText('第二张')).toBeVisible()
    await viewer.getByRole('button', { name: '放大图片', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(viewer.getByAltText('第二张')).toBeVisible()
    const before = await page.locator('.document-stage').evaluate(element => element.scrollTop)
    await viewer.locator('.image-viewer-viewport').hover()
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(100)
    expect(await page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(before)
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(origin).toBeFocused()
    expect(await page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(before)
    await origin.click()
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    await viewer.evaluate(element => {
      element.querySelector('.image-viewer-viewport')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }))
      element.querySelector<HTMLButtonElement>('[aria-label="关闭图片查看器"]')!.click()
    })
    await expect(viewer).toHaveCount(0)
    await origin.click()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    await viewer.click({ position: { x: 8, y: 100 } })
    await expect(viewer).toHaveCount(0)
  } finally { const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }) }
})

test('single large image fits, zooms with native scrolling, stays still on drag, and resets fit after resizing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-image-viewer-large-'))
  const document = join(root, 'large.md')
  await writeFile(join(root, 'large.png'), await readFile(join(process.cwd(), 'tests/fixtures/images/viewer-large.png')))
  await writeFile(document, '# Large image\n\n![大图](large.png)')
  const app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
  try {
    const page = await app.firstWindow({ timeout: 10000 })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, document)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    await test.step('open decoded large fixture in viewer', async () => {
      const previewImage = page.locator('.preview img')
      await expect.poll(() => previewImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1600)
      await previewImage.click()
    })
    const viewer = page.getByRole('dialog', { name: '图片查看器' })
    await expect(viewer).toBeVisible()
    await expect(viewer.getByRole('button', { name: '下一张图片', exact: true })).toHaveCount(0)
    await expect(viewer.locator('.image-viewer-frame')).not.toHaveClass(/image-viewer-image-loading/u)
    await viewer.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await writeFile(test.info().outputPath('image-viewer.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
    await viewer.getByAltText('大图').dblclick()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    await expect(viewer.getByRole('button', { name: '原始大小', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await viewer.getByAltText('大图').dblclick()
    await expect(viewer.getByRole('button', { name: '适应窗口', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await viewer.getByRole('button', { name: '原始大小', exact: true }).click()
    const viewport = viewer.locator('.image-viewer-viewport')
    await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const beforeWheel = await viewport.evaluate(element => element.scrollTop)
    await viewport.hover()
    await page.mouse.wheel(0, 250)
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel)
    const beforeDrag = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))
    const box = await viewport.boundingBox()
    if (!box) throw new Error('Missing viewport')
    await page.mouse.move(box.x + 250, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 350, box.y + 270, { steps: 5 })
    await page.mouse.up()
    await expect(viewer).toBeVisible()
    expect(await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).toEqual(beforeDrag)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 700))
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
    await expect.poll(() => viewport.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
  } finally { const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }) }
})

interface ViewerTestContext { app: ElectronApplication; page: Page; viewer: Locator; viewport: Locator; root: string }
async function withViewer(run: (context: ViewerTestContext) => Promise<void>, fixture = 'viewer-large.png'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'inknest-image-interaction-'))
  const document = join(root, 'images.md')
  const bytes = fixture === 'tall.png'
    ? await sharp({ create: { width: 200, height: 12000, channels: 4, background: '#3a7ebc' } }).png().toBuffer()
    : await readFile(join(process.cwd(), 'tests/fixtures/images', fixture))
  const markdown = `# Viewer\n\n![测试图片](${fixture})\n\n${'Text\n\n'.repeat(100)}`
  await writeFile(join(root, fixture), bytes)
  await writeFile(document, markdown)
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ ...(process.env.INKNEST_PACKAGED_EXECUTABLE ? { executablePath: process.env.INKNEST_PACKAGED_EXECUTABLE } : {}), args: [...(process.env.INKNEST_PACKAGED_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], chromiumSandbox: true })
    const page = await app.firstWindow()
    await page.bringToFront()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, document)
    await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
    const origin = page.locator('.preview img').first()
    await expect.poll(() => origin.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await origin.click()
    const viewer = page.getByRole('dialog', { name: '图片查看器' })
    await expect(viewer.getByRole('button', { name: '原始大小', exact: true })).toBeEnabled()
    await viewer.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
    await run({ app, page, viewer, viewport: viewer.locator('.image-viewer-viewport'), root })
    expect(await readFile(join(root, fixture))).toEqual(bytes)
    expect(await readFile(document, 'utf8')).toBe(markdown)
  } finally {
    if (app) { const exited = new Promise<void>(resolve => app!.process().once('exit', () => resolve())); app.process().kill('SIGKILL'); await exited }
    await rm(root, { recursive: true, force: true })
  }
}

test('pinch-equivalent wheel anchors the rotated image and native modifier wheel leaves page zoom unchanged', async () => {
  await withViewer(async ({ app, page, viewer, viewport }) => {
    await viewer.getByRole('button', { name: '原始大小', exact: true }).click()
    await viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true }).click()
    const baseline = await page.locator('.document-stage').evaluate(element => element.scrollTop)
    const anchor = await viewport.evaluate(element => {
      const view = element.getBoundingClientRect()
      const frame = element.querySelector('.image-viewer-frame')!.getBoundingClientRect()
      const clientX = view.left + element.clientWidth * 0.55
      const clientY = view.top + element.clientHeight * 0.45
      const point = { x: (clientX - frame.left) / frame.width, y: (clientY - frame.top) / frame.height }
      const image = element.querySelector('img')!
      // Multiple events in one frame exercise accumulation, not one step per event.
      for (let i = 0; i < 8; i++) image.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10, clientX, clientY }))
      return { clientX, clientY, point, width: frame.width }
    })
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('117%')
    await expect.poll(() => viewport.evaluate((element, anchor) => {
      const frame = element.querySelector('.image-viewer-frame')!.getBoundingClientRect()
      return Math.hypot(frame.left + frame.width * anchor.point.x - anchor.clientX, frame.top + frame.height * anchor.point.y - anchor.clientY)
    }, anchor)).toBeLessThan(2)
    const width = await viewer.locator('.image-viewer-frame').evaluate(element => element.getBoundingClientRect().width)
    expect(width / anchor.width).toBeCloseTo(Math.exp(0.16), 3)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await viewport.hover()
    await page.keyboard.down(modifier)
    try { await page.mouse.wheel(0, -100) } finally { await page.keyboard.up(modifier) }
    await expect.poll(() => viewer.locator('.image-viewer-frame').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(width)
    const currentScale = await viewer.locator('.image-viewer-scale').textContent()
    const scroll = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))
    await page.mouse.wheel(60, 60)
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(scroll.y)
    await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(scroll.x)
    await expect(viewer.locator('.image-viewer-scale')).toHaveText(currentScale!)
    const toolbarCancelled = await viewer.locator('.image-viewer-toolbar').evaluate(element => !element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })))
    expect(toolbarCancelled).toBe(true)
    await expect(viewer.locator('.image-viewer-scale')).toHaveText(currentScale!)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1)
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1)
    expect(await page.locator('.document-stage').evaluate(element => element.scrollTop)).toBe(baseline)
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(page.locator('.preview img').first()).toBeFocused()
  })
})

test('rotation fits every orientation, preserves manual scale, and keeps controls reachable at 200%', async () => {
  await withViewer(async ({ app, page, viewer, viewport }) => {
    const rotate = viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true })
    const image = viewer.locator('img')
    const originalElement = await image.elementHandle()
    const source = await image.getAttribute('src')
    const initial = await viewer.locator('.image-viewer-frame').boundingBox()
    for (let turn = 1; turn <= 4; turn++) {
      await rotate.focus()
      await page.keyboard.press(turn % 2 ? 'Space' : 'Enter')
      await expect(rotate).toBeFocused()
      await expect(image).toHaveAttribute('style', new RegExp(`rotate\\(${(turn * 90) % 360}deg\\)`))
      await expect(viewer.getByRole('button', { name: '适应窗口', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const geometry = await viewport.evaluate(element => {
        const frame = element.querySelector('.image-viewer-frame')!.getBoundingClientRect()
        return { width: frame.width, height: frame.height, fits: frame.width <= element.clientWidth && frame.height <= element.clientHeight, scrollX: element.scrollWidth - element.clientWidth, scrollY: element.scrollHeight - element.clientHeight }
      })
      expect(geometry.fits).toBe(true)
      expect(geometry.scrollX).toBeLessThanOrEqual(1)
      expect(geometry.scrollY).toBeLessThanOrEqual(1)
      expect(geometry.width / geometry.height).toBeCloseTo(turn % 2 ? initial!.height / initial!.width : initial!.width / initial!.height, 2)
    }
    await viewer.getByRole('button', { name: '原始大小', exact: true }).click()
    await rotate.click()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    await expect(image).toHaveCSS('transform', /matrix\(0, 1, -1, 0,/)
    await image.dblclick()
    await expect(viewer.getByRole('button', { name: '适应窗口', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(image).toHaveCSS('transform', /matrix\(0, 1, -1, 0,/)
    expect(await originalElement!.evaluate(element => element.isConnected)).toBe(true)
    await expect(image).toHaveAttribute('src', source!)
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 600); window.webContents.setZoomFactor(2) })
    for (const control of [rotate, viewer.getByRole('button', { name: '关闭图片查看器' }), viewer.getByRole('button', { name: '原始大小', exact: true })]) {
      await expect(control).toBeInViewport({ ratio: 1 })
      await control.focus()
      await expect(control).toBeFocused()
    }
    await writeFile(test.info().outputPath('rotated-small-window-200.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
  })
})

test('very tall images zoom continuously back below 10% and rotation keeps every edge reachable', async () => {
  await withViewer(async ({ app, viewer, viewport, page }) => {
    const fitText = await viewer.locator('.image-viewer-scale').textContent()
    expect(Number.parseInt(fitText!)).toBeLessThan(10)
    await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
    await viewport.evaluate(element => {
      for (let i = 0; i < 12; i++) element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 300 }))
    })
    await expect(viewer.locator('.image-viewer-scale')).toHaveText(fitText!)
    await expect(viewer.getByRole('button', { name: '缩小图片', exact: true })).toBeDisabled()
    await viewer.getByRole('button', { name: '原始大小', exact: true }).click()
    await viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true }).click()
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('100%')
    // Scroll using input events, then compare the rotated image's actual edges.
    await viewport.hover()
    await page.mouse.wheel(-20000, 0)
    await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0)
    const leftGap = await viewport.evaluate(element => element.querySelector('.image-viewer-frame')!.getBoundingClientRect().left - element.getBoundingClientRect().left)
    expect(leftGap).toBeGreaterThanOrEqual(0)
    await page.mouse.wheel(20000, 0)
    await expect.poll(() => viewport.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1)
    const rightGap = await viewport.evaluate(element => element.getBoundingClientRect().right - element.querySelector('.image-viewer-frame')!.getBoundingClientRect().right)
    expect(rightGap).toBeGreaterThanOrEqual(0)
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect.poll(() => viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await writeFile(test.info().outputPath('rotated-tall-fit.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
  }, 'tall.png')
})

test('EXIF JPEG and animated WebP keep the decoded image and resource through rotation and zoom', async () => {
  for (const fixture of ['rotated.jpg', 'animated.webp']) await withViewer(async ({ viewer }) => {
    const image = viewer.locator('img')
    const original = await image.elementHandle()
    const size = await image.evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }))
    expect(size).toEqual(fixture === 'rotated.jpg' ? { width: 3, height: 2 } : { width: 1, height: 1 })
    for (let turn = 0; turn < 4; turn++) {
      await viewer.getByRole('button', { name: '顺时针旋转 90°', exact: true }).click()
      await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
      const rect = await viewer.locator('.image-viewer-frame').boundingBox()
      expect(rect!.width / rect!.height).toBeCloseTo(turn % 2 ? size.width / size.height : size.height / size.width, 1)
    }
    expect(await original!.evaluate(element => element.isConnected)).toBe(true)
    await expect(viewer.locator('.image-viewer-scale')).toHaveText('200%')
  }, fixture)
})
