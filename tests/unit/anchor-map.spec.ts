import { expect, it } from 'vitest'
import { anchorId, resolveAnchor } from '../../src/renderer/src/preview/anchor-map'
import { parseDocument } from '../../src/renderer/src/preview/document-model'
it('maps Unicode and duplicate headings without changing outline IDs', () => {
  const headings = ['测试 标题！', '测试 标题！', 'Hello, World'].map((title, i) => ({ id: `inknest-heading-${i}`, title, sourceLine: i, level: 1, parentId: null }))
  expect(anchorId(headings, '测试-标题')).toBe('inknest-heading-0')
  expect(anchorId(headings, '测试-标题-1')).toBe('inknest-heading-1')
  expect(anchorId(headings, 'hello-world')).toBe('inknest-heading-2')
  expect(anchorId(headings, 'missing')).toBeNull()
})

it('maps explicit anchor names before generated heading slugs and keeps the first duplicate', () => {
  const parsed = parseDocument('# acceptance\n\n<a id="acceptance"></a>\n验收正文\n\n<a name="acceptance"></a>\n重复正文')
  expect(anchorId(parsed.headings, 'acceptance', parsed.anchors)).toBe('inknest-anchor-0')
  expect(anchorId(parsed.headings, 'inknest-heading-0', parsed.anchors)).toBe('inknest-heading-0')
  expect(anchorId(parsed.headings, 'missing', parsed.anchors)).toBeNull()
})

it('preserves case-sensitive explicit names and Unicode while retaining case-insensitive heading slugs', () => {
  const parsed = parseDocument('<a id="CaseSensitive"></a>\n正文\n<a name="中文锚点"></a>\n正文\n# Hello World')
  expect(anchorId(parsed.headings, 'CaseSensitive', parsed.anchors)).toBe('inknest-anchor-0')
  expect(anchorId(parsed.headings, 'casesensitive', parsed.anchors)).toBeNull()
  expect(anchorId(parsed.headings, '中文锚点', parsed.anchors)).toBe('inknest-anchor-1')
  expect(anchorId(parsed.headings, 'HELLO-WORLD', parsed.anchors)).toBe('inknest-heading-0')
})

it('returns the explicit marker line for editing and heading lines for ordinary slug targets', () => {
  const parsed = parseDocument('# 标题\n\n<a id="acceptance"></a>\n## 后续真机验收\n\n<a name="paragraph"></a>\n验收正文')
  expect(resolveAnchor(parsed, 'acceptance')).toEqual({ id: 'inknest-anchor-0', sourceLine: 2 })
  expect(resolveAnchor(parsed, 'paragraph')).toEqual({ id: 'inknest-anchor-1', sourceLine: 5 })
  expect(resolveAnchor(parsed, '后续真机验收')).toEqual({ id: 'inknest-heading-1', sourceLine: 3 })
  expect(resolveAnchor(parsed, 'missing')).toBeNull()
})
