import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function launch(profile: string, file: string) {
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  return electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`, file], chromiumSandbox: true })
}

async function capture(page: Page, app: ElectronApplication, name: string): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))))
  await writeFile(test.info().outputPath(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG()])))
}

test('code wraps, folds after layout changes and reveals full search hits without changing copied or saved text', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-code-layout-')), file = join(root, 'code.md')
  const longCode = '// ' + 'long-code-'.repeat(3201) + 'END_CODE_NEEDLE\n'
  const source = '# 代码阅读\n\n```ts\nconst small = 1\n```\n\n```ts\nconst message = "' + 'wide_'.repeat(180) + '"\n```\n\n<details>\n<summary>超长代码示例</summary>\n\n```javascript\n' + longCode + '```\n\n</details>\n'
  await writeFile(file, source)
  const app = await launch(join(root, 'profile'), file)
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 900))
    const blocks = page.locator('.code-block'), short = blocks.nth(0), responsive = blocks.nth(1), long = blocks.nth(2)
    await expect(blocks).toHaveCount(3)
    await expect(short.locator('.hljs-keyword')).toHaveText('const')
    await expect(short.locator('.code-footer')).toBeHidden()
    await expect(responsive.locator('.code-footer')).toBeHidden()
    await page.getByText('超长代码示例', { exact: true }).press('Enter')
    const toggle = long.locator('[data-code-action="fold"]')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeVisible()
    expect(await long.locator('pre').evaluate(node => ({ wraps: node.scrollWidth <= node.clientWidth, height: node.getBoundingClientRect().height }))).toMatchObject({ wraps: true })
    expect(await long.locator('pre').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(1000)
    expect(await long.locator('.code-content').evaluate(node => node.clientHeight)).toBe(320)
    await expect(long.locator('.hljs')).toHaveCount(0)
    await long.getByRole('button', { name: '复制', exact: true }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(longCode)
    await toggle.press('Enter'); await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Expanded blocks retain a reachable bottom-right control even far from their end.
    await expect(toggle).toBeInViewport()
    const controlPosition = await toggle.evaluate(node => {
      const stage = node.closest('.document-stage')!
      const button = node.getBoundingClientRect(), block = node.closest('.code-block')!.getBoundingClientRect(), viewport = stage.getBoundingClientRect()
      return { bottom: Math.abs(button.bottom - Math.min(block.bottom, viewport.bottom)), right: block.right - button.right }
    })
    await capture(page, app, 'code-expanded.png')
    expect(controlPosition.bottom).toBeLessThan(20); expect(controlPosition.right).toBeLessThan(20)
    await toggle.press('Space'); await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeInViewport()
    await capture(page, app, 'code-collapsed.png')
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('find')!.click())
    const query = page.locator('.search-bar input:not(.replacement-input)')
    await query.fill('END_CODE_NEEDLE')
    await expect(page.locator('.search-count')).toHaveText('1 / 1')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await long.locator('code').evaluate(node => {
      const text = node.firstChild!, range = document.createRange()
      range.setStart(text, text.textContent!.indexOf('END_CODE_NEEDLE')); range.setEnd(text, text.textContent!.length)
      const hit = range.getBoundingClientRect(), host = node.closest('.document-stage')!.getBoundingClientRect()
      return hit.top >= host.top && hit.bottom <= host.bottom
    })).toBe(true)
    await query.press('Escape')
    const dark = await page.evaluate(() => document.documentElement.dataset.theme === 'dark')
    await page.getByRole('radio', { name: dark ? '浅色主题' : '深色主题', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'light' : 'dark')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.press('Enter')
    await page.getByText('超长代码示例', { exact: true }).press('Enter')
    await page.getByText('超长代码示例', { exact: true }).press('Enter')
    await expect(toggle).toBeVisible(); await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 700); window.webContents.setZoomFactor(2) })
    await expect(responsive.locator('[data-code-action="fold"]')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await responsive.locator('pre').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await responsive.scrollIntoViewIfNeeded()
    await capture(page, app, 'code-narrow-200.png')
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.webContents.setZoomFactor(1); window.setSize(1200, 900) })
    await expect(responsive.locator('.code-footer')).toBeHidden()
    await expect(short.locator('.code-footer')).toBeHidden()
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('mind map labels stay inside their shapes in both themes and alerts and links remain accessible', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-rich-layout-')), file = join(root, 'layout.md')
  const alerts = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map(type => `> [!${type}]\n> 正文内容与行内代码 \`sample\`。`).join('\n\n')
  const source = '# 提示与图表\n\n' + alerts + '\n\n裸邮箱：reader@example.com。\n\n[短引用]\n\n[短引用]: link-target.md\n\n<a id="sample-anchor"></a>\n\n```mermaid\n' + '%% 图表源码说明\n'.repeat(6) + 'mindmap\n  root((Markdown))\n    内容\n      正文\n      列表\n    文件\n      保存\n      历史\n    展示\n      图表\n      公式\n```\n'
  await writeFile(file, source)
  const app = await launch(join(root, 'profile'), file)
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 1000))
    await expect(page.locator('.diagram-view svg')).toHaveCount(1)
    await expect(page.locator('.preview a').filter({ hasText: 'reader@example.com' })).toHaveCount(1)
    await expect(page.getByRole('link', { name: '短引用', exact: true })).toHaveCount(1)
    await expect(page.locator('.preview')).not.toContainText('[短引用]:')
    await expect(page.locator('.preview')).not.toContainText('<a id=')
    await expect(page.locator('.alert-title svg[aria-hidden="true"]')).toHaveCount(5)
    await expect(page.locator('.alert-title')).toHaveText(['说明', '提示', '重要', '警告', '注意'])
    for (const theme of ['浅色', '深色']) {
      const previousId = await page.locator('.diagram-view svg').getAttribute('id')
      const wasDark = await page.evaluate(() => document.documentElement.dataset.theme === 'dark')
      await page.getByRole('radio', { name: `${theme}主题`, exact: true }).click()
      if (wasDark !== (theme === '深色')) await expect(page.locator('.diagram-view svg')).not.toHaveAttribute('id', previousId!)
      const metrics = await page.locator('.diagram-view svg').evaluate(svg => [...svg.querySelectorAll<SVGGElement>('.mindmap-node')].map(node => {
        const shape = node.querySelector(':scope > circle,:scope > path')!.getBoundingClientRect()
        const label = node.querySelector('.label')!.getBoundingClientRect()
        return { title: node.textContent, inside: label.left >= shape.left && label.right <= shape.right && label.top >= shape.top && label.bottom <= shape.bottom, dx: Math.abs((label.left + label.right - shape.left - shape.right) / 2), dy: Math.abs((label.top + label.bottom - shape.top - shape.bottom) / 2) }
      }))
      expect(metrics).toHaveLength(10)
      for (const item of metrics) { expect(item.inside, item.title ?? '').toBe(true); expect(item.dx).toBeLessThan(1); expect(item.dy).toBeLessThan(1) }
      await page.locator('.diagram-view').screenshot({ path: test.info().outputPath(`mindmap-${theme}.png`) })
      await page.locator('.markdown-alert').first().scrollIntoViewIfNeeded()
      await capture(page, app, `alerts-${theme}.png`)
    }
    await page.getByRole('button', { name: '查看源码', exact: true }).press('Enter')
    const fold = page.locator('[data-code-action="fold"]')
    await expect(fold).toBeVisible(); await fold.press('Enter')
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    const previousId = await page.locator('.diagram-view svg').getAttribute('id')
    await page.getByRole('radio', { name: '浅色主题', exact: true }).click()
    await expect(page.locator('.diagram-view svg')).not.toHaveAttribute('id', previousId!)
    await expect(page.locator('.code-content pre')).toBeVisible()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.preview svg script,.preview svg foreignObject,.preview svg image')).toHaveCount(0)
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
