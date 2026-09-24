import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/preview/markdown'
import { parseDocument } from '../../src/renderer/src/preview/document-model'
import { diagramProblem, safeDiagramDeclaration } from '../../src/renderer/src/preview/rich-policy'

test('extended syntax is parsed without rewriting source or losing source lines', () => {
  const source = readFileSync(new URL('../fixtures/markdown-compatibility.md', import.meta.url), 'utf8')
  const parsed = parseDocument(source)
  expect(parsed.headings[0]).toMatchObject({ title: 'Markdown 兼容样本 ✨', sourceLine: 5 })
  expect(parsed.html).toContain('document-metadata')
  expect(parsed.html).toContain('text-align:center')
  expect(parsed.html).toContain('disabled=""')
  expect(parsed.html).toContain('checked=""')
  expect(parsed.html).toContain('markdown-alert-warning')
  expect(parsed.html).toContain('class="math-source')
  expect(parsed.html).toContain('class="language-mermaid"')
  expect(parsed.html).toContain('class="footnotes')
  expect(parsed.html).toContain('<dl>')
  expect(parsed.html).toContain('<mark>标记</mark>')
  expect(parsed.html).toContain('<sub>2</sub>')
  expect(parsed.html).toContain('<sup>2</sup>')
  expect(parsed.html).toContain('<kbd>Command</kbd>')
  expect(parsed.html).toContain('<details>')
  expect(parsed.html).toContain('href="https://example.com/inknest"')
  expect(parsed.html).toContain('href="mailto:reader@example.com"')
  expect(parsed.html).not.toContain('<script>')
  expect(source).toContain('```mermaid')
})

test('currency, escapes, inline code and fences remain literal', () => {
  const result = renderMarkdown('货币 $5 和 $10。\\$x\\$。`$x$`\n\n```text\n$x$\n<details>\n```')
  expect(result).not.toContain('math-source')
  expect(result).toContain('<code>$x$</code>')
  expect(result).toContain('&lt;details&gt;')
})

test('reference definitions stay invisible and full, collapsed and shortcut links resolve equally', () => {
  const parsed = parseDocument('[完整][目标] [目标][] [目标]\n\n[目标]: link-target.md "引用目标"\n\n<a id="sample-anchor"></a>\n\n锚点正文')
  expect(parsed.html.match(/href="link-target.md"/gu)).toHaveLength(3)
  expect(parsed.html).not.toContain('[目标]:')
  expect(parsed.html).not.toContain('&lt;a')
  expect(parsed.anchors).toHaveLength(1)
  expect(renderMarkdown('[未定义]')).toContain('[未定义]')
})

test('bare email handles CJK punctuation without consuming it or linking literal code', () => {
  for (const [before, after] of [['裸邮箱：', '。'], ['（', '）'], ['【', '】'], ['“', '”'], ['联系：', '；'], ['', '']]) {
    const html = renderMarkdown(`${before}reader+tag@example.com${after}`)
    expect(html).toContain(`${before}<a href="mailto:reader+tag@example.com">reader+tag@example.com</a>${after}`)
  }
  const literal = renderMarkdown('`邮箱：reader@example.com`\n\n```text\n（reader@example.com）\n```\n\n[reader@example.com](https://example.com)\n\nfoo@@example.com reader@invalid')
  expect(literal).not.toContain('mailto:')
  expect(literal.match(/<a /gu)).toHaveLength(1)
})

test('raw HTML outside the small formatting vocabulary stays escaped', () => {
  const result = renderMarkdown('<kbd onclick="x()">x</kbd> <iframe src="x"></iframe> <img src="x">\n\n<details ontoggle="x()">\n\n<div class="math-source">x</div>')
  expect(result).not.toContain('<iframe')
  expect(result).not.toContain('<img')
  expect(result).not.toContain('<kbd onclick')
  expect(result).not.toContain('<details ontoggle')
  expect(result).not.toContain('<div class="math-source">')
})

test('Mermaid configuration and resource CSS cannot escape application policy', () => {
  expect(diagramProblem('flowchart LR\nA-->B')).toBeNull()
  expect(diagramProblem('%%{init: {securityLevel:"loose"}}%%\nflowchart LR\nA-->B')).not.toBeNull()
  expect(diagramProblem('---\nconfig: {}\n---\nflowchart LR\nA-->B')).not.toBeNull()
  expect(diagramProblem('a'.repeat(20001))).not.toBeNull()
  expect(safeDiagramDeclaration('fill', '#ccc')).toBe(true)
  expect(safeDiagramDeclaration('marker-end', 'url(#arrow)')).toBe(true)
  for (const value of ['url(https://example.com/a)', 'url(inknest-resource://a)', 'var(--unsafe)', 'url(\\68ttps://example.com)']) expect(safeDiagramDeclaration('fill', value)).toBe(false)
  expect(safeDiagramDeclaration('position', 'fixed')).toBe(false)
})
