import { openDocumentPicker } from './open-document'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function launch(profile: string, file?: string) {
  const executablePath = process.env.INKNEST_PACKAGED_EXECUTABLE
  return electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`, ...(file ? [file] : [])], chromiumSandbox: true })
}

test('renders the complete compatibility fixture under production CSP and preserves the source', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-markdown-'))
  const path = join(root, 'compatibility.md')
  await copyFile('tests/fixtures/markdown-compatibility.md', path)
  const original = await readFile(path)
  const app = await launch(join(root, 'profile'))
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1280, 1200) })
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  try {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
    await openDocumentPicker(page)
    await expect(page.getByRole('heading', { name: 'Markdown 兼容样本 ✨', exact: true })).toBeVisible()
    await expect(page.locator('.diagram-failed pre').filter({ hasText: 'this is not a diagram' })).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.diagram-view svg')).toHaveCount(13, { timeout: 45_000 })
    await expect(page.locator('.diagram-failed')).toHaveCount(1)
    await expect(page.locator('.math-rendered math')).toHaveCount(4)
    await expect(page.locator('.math-error')).toHaveCount(1)
    await expect(page.locator('.task-list-item input')).toHaveCount(2)
    await expect(page.locator('.task-list-item input').first()).toBeDisabled()
    expect(await page.locator('.preview th').nth(1).evaluate(node => getComputedStyle(node).textAlign)).toBe('center')
    expect(await page.locator('.preview td').nth(2).evaluate(node => getComputedStyle(node).textAlign)).toBe('right')
    await expect(page.locator('.language-typescript .hljs-keyword').first()).toHaveText('const')
    await expect(page.locator('.markdown-alert-warning')).toContainText('这是一条警告')
    await expect(page.locator('details.document-metadata')).not.toHaveAttribute('open')
    await page.getByText('展开补充说明', { exact: true }).click()
    await expect(page.getByText('折叠正文中的关键词：折叠测试。')).toBeVisible()
    await page.locator('.footnote-ref a').first().click()
    await expect(page.locator('#inknest-footnote-fn1')).toBeFocused()
    await page.locator('.footnote-backref').first().click()
    await expect(page.locator('#inknest-footnote-fnref1')).toBeFocused()
    const code = page.locator('.code-block').filter({ has: page.locator('.language-typescript') })
    const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]!.focus() })
      await code.getByRole('button', { name: '复制', exact: true }).click()
      await expect(page.getByText('代码已复制', { exact: true })).toBeVisible()
      await expect.poll(() => app.evaluate(async ({ clipboard }) => await clipboard.readText() === "const greeting: string = '你好，InkNest'\nconsole.log(greeting)\n")).toBe(true)
    } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard) }
    await expect(page.getByText('代码已复制', { exact: true })).toHaveCount(0)
    const firstDiagram = page.locator('.code-block').filter({ has: page.locator('.diagram-view') }).first()
    await firstDiagram.scrollIntoViewIfNeeded()
    await firstDiagram.screenshot({ path: test.info().outputPath('flowchart-light.png') })
    const styles = await firstDiagram.locator('svg').evaluate(svg => ({ width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, text: svg.textContent, styles: [...svg.querySelectorAll('style')].map(style => ({ nonce: style.nonce, size: style.textContent?.length })) }))
    expect(styles.width).toBeGreaterThan(100); expect(styles.height).toBeGreaterThan(100)
    expect(styles.text).toContain('未命名空白')
    expect(styles.styles.some(style => style.nonce && style.size)).toBe(true)
    await firstDiagram.getByRole('button', { name: '查看源码', exact: true }).click()
    await expect(firstDiagram.locator('pre')).toBeVisible()
    await expect(firstDiagram.locator('pre')).toContainText('flowchart TD')
    await firstDiagram.getByRole('button', { name: '查看图表', exact: true }).click()
    const lastDiagramId = await page.locator('.diagram-view svg').last().getAttribute('id')
    await page.getByRole('radio', { name: '深色主题' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.diagram-view svg')).toHaveCount(13, { timeout: 45_000 })
    await expect(page.locator('.diagram-view svg').last()).not.toHaveAttribute('id', lastDiagramId!, { timeout: 45_000 })
    await expect(page.locator('text.journey-section').filter({ hasText: '开始' })).toHaveCSS('fill', 'rgb(229, 231, 235)')
    await expect(page.locator('details').filter({ has: page.getByText('展开补充说明', { exact: true }) })).toHaveAttribute('open')
    await firstDiagram.scrollIntoViewIfNeeded()
    await firstDiagram.screenshot({ path: test.info().outputPath('flowchart-theme.png') })
    for (const [index, name] of ['flowchart', 'sequence', 'class', 'state', 'er', 'pie', 'gantt', 'mindmap', 'timeline', 'git', 'quadrant', 'xy', 'journey'].entries()) {
      await page.locator('.diagram-view').nth(index).screenshot({ path: test.info().outputPath(`diagram-${name}-dark.png`) })
    }
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(800, 600); window.webContents.setZoomFactor(2) })
    await firstDiagram.getByRole('button', { name: '原始大小', exact: true }).press('Enter')
    await expect(firstDiagram.locator('.diagram-view')).toHaveClass(/diagram-original/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await firstDiagram.locator('.diagram-view').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('diagram-narrow-200.png') })
    expect(await readFile(path)).toEqual(original)
    expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined()
    await writeFile(test.info().outputPath('renderer-console-errors.txt'), errors.join('\n'))
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('isolates malformed, configured and unsafe rich blocks while keeping the document readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-markdown-security-'))
  const path = join(root, 'unsafe.md')
  const source = '# 安全兼容\n\n```mermaid\n%%{init: {securityLevel: "loose"}}%%\nflowchart LR\nA-->B\n```\n\n```mermaid\nflowchart LR\nA[安全节点]-->B[终点]\nclick A "https://example.com/should-not-open"\n```\n\n$\\href{https://example.com}{链接}$\n\n<script>window.pwned=true</script>\n\n<details ontoggle="window.pwned=true">\n\n```math\n\\frac{1}{2}\n```\n\n最后的正文\n'
  await writeFile(path, source)
  const app = await launch(join(root, 'profile'))
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
    await openDocumentPicker(page)
    await expect(page.locator('.diagram-failed')).toContainText('自定义配置暂不支持')
    await expect(page.locator('.diagram-view svg')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.math-rendered math')).toHaveCount(1)
    await expect(page.locator('.math-error')).toHaveCount(1)
    await expect(page.locator('.preview svg a,.preview svg foreignObject,.preview iframe,.preview script,.preview [onclick],.preview [ontoggle]')).toHaveCount(0)
    await expect(page.getByText('最后的正文', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('rich content search, history and controlled presentation preserve the exact Markdown and undo', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-rich-surfaces-')), file = join(root, 'surfaces.md')
  const source = '# 共享显示\n\n<details>\n<summary>展开内容</summary>\n\n折叠关键词\n\n## 折叠标题\n\n</details>\n\n```mermaid\nflowchart LR\nA[检索节点]-->B[终点]\n```\n\n$$\\frac{1}{2}$$\n'
  await writeFile(file, source)
  const app = await launch(join(root, 'profile'), file)
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true }); const window = BrowserWindow.getAllWindows()[0]!; window.focus()
      let fullscreen = false
      window.isFullScreen = () => fullscreen
      window.setFullScreen = value => { setTimeout(() => { fullscreen = value; window.emit(value ? 'enter-full-screen' : 'leave-full-screen') }, 20) }
    })
    await expect(page.locator('.diagram-view svg')).toHaveCount(1)
    await expect(page.locator('.math-rendered math')).toHaveCount(1)
    const find = () => app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('find')!.click() })
    await find()
    const query = page.locator('.search-bar input:not(.replacement-input)'), count = page.locator('.search-count')
    await query.fill('检索节点'); await expect(count).toHaveText('1 / 1')
    await query.fill('检索节点终点'); await expect(count).toHaveText('无结果')
    await query.fill('flowchart'); await expect(count).toHaveText('无结果')
    await page.getByRole('button', { name: '查看源码', exact: true }).press('Enter'); await expect(count).toHaveText('1 / 1')
    await page.getByRole('button', { name: '查看图表', exact: true }).press('Enter'); await expect(count).toHaveText('无结果')
    await query.fill('折叠关键词'); await expect(count).toHaveText('无结果')
    await page.getByText('展开内容', { exact: true }).press('Enter'); await expect(count).toHaveText('1 / 1')
    await query.press('Escape')
    await page.locator('.math-display').screenshot({ path: test.info().outputPath('formula-fraction.png') })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源码', exact: true })
    await editor.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(source + '\n新版本正文')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toBe(source + '\n新版本正文')
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.diagram-view svg')).toHaveCount(1); await expect(page.locator('.math-rendered math')).toHaveCount(1)
    await expect(page.locator('.preview')).not.toContainText('新版本正文')
    expect(await readFile(file, 'utf8')).toBe(source + '\n新版本正文')
    await page.getByRole('button', { name: '返回当前文档', exact: true }).click()
    await page.getByRole('button', { name: '进入演示', exact: true }).click()
    await expect(page.locator('.presentation-stage .diagram-view svg')).toHaveCount(1)
    await expect(page.locator('.presentation-stage .math-rendered math')).toHaveCount(1)
    await page.keyboard.press('Escape'); await expect(editor).toBeVisible()
    await editor.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(editor).not.toContainText('新版本正文')
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toBe(source)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})

test('rapid source changes discard pending diagrams and limited blocks retain readable source', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'inknest-rich-cancel-')), first = join(root, 'many.md'), second = join(root, 'next.md')
  const diagram = '```mermaid\nflowchart LR\nA[旧图表]-->B[结束]\n```\n\n'
  await writeFile(first, '# 多图文档\n\n' + diagram.repeat(21) + '```mermaid\n' + 'x'.repeat(20001) + '\n```\n')
  await writeFile(second, '# 新文档\n\n不含图表')
  const app = await launch(join(root, 'profile'), first)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.preview h1')).toHaveText('多图文档')
    await app.evaluate(({ app }, file) => { app.emit('open-file', { preventDefault() {} }, file) }, second)
    await expect(page.locator('.preview h1')).toHaveText('新文档')
    await expect(page.locator('.diagram-measure')).toHaveCount(0)
    await expect(page.locator('.preview svg')).toHaveCount(0)
    await page.getByRole('tab', { name: 'many.md', exact: true }).click()
    await expect(page.locator('.diagram-view svg')).toHaveCount(20, { timeout: 30_000 })
    await expect(page.locator('.diagram-failed')).toHaveCount(2)
    await expect(page.locator('.diagram-failed').first()).toContainText('数量超过显示限制')
    await expect(page.locator('.diagram-failed pre').first()).toContainText('旧图表')
    await expect(page.locator('.diagram-measure')).toHaveCount(0)
    await page.getByRole('radio', { name: '深色主题' }).click()
    await page.getByRole('radio', { name: '浅色主题' }).click()
    await page.getByRole('tab', { name: 'next.md', exact: true }).click()
    await expect(page.locator('.preview h1')).toHaveText('新文档')
    await expect(page.locator('.diagram-measure')).toHaveCount(0)
    await expect(page.locator('.preview svg')).toHaveCount(0)
  } finally { app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
