import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../../src/renderer/src/preview/markdown'

const basicMarkdown = readFileSync(resolve(import.meta.dirname, '../fixtures/basic-zh.md'), 'utf8')

describe('basic Markdown rendering', () => {
  it('renders the agreed basic structures and Chinese text', () => {
    const html = renderMarkdown(basicMarkdown)

    expect(html).toContain('<h1>InkNest 中文样本</h1>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<table>')
    expect(html).toContain('<s>已删除</s>')
    expect(html).toContain('<code class="language-ts">')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('displays raw HTML as escaped text', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })

  it('does not create a link for a javascript protocol', () => {
    const html = renderMarkdown('[运行](javascript:alert(1))')

    expect(html).toContain('[运行](javascript:alert(1))')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
  })

  it('returns untrusted HTML without mutating the Markdown source', () => {
    const source = '# 标题\n\n正文'

    expect(renderMarkdown(source)).toBe('<h1>标题</h1>\n<p>正文</p>\n')
    expect(source).toBe('# 标题\n\n正文')
  })
})
