import { expect, test } from 'vitest'
import { parseDocument } from '../../src/renderer/src/preview/document-model'
import { OutlineState } from '../../src/renderer/src/documents/outline-state'

test('headings share rendered token order, source lines and nearest shallower parents', () => {
  const source = '# 中文\n\n### 子节\n\n# 中文\n\n```md\n# 非标题\n```\n'
  const { headings, html } = parseDocument(source)
  expect(headings.map(h => h.title)).toEqual(['中文', '子节', '中文'])
  expect(headings.map(h => h.sourceLine)).toEqual([0, 2, 4])
  expect(headings.map(h => h.id)).toEqual(['inknest-heading-0', 'inknest-heading-1', 'inknest-heading-2'])
  expect(headings.map(h => h.parentId)).toEqual([null, 'inknest-heading-0', null])
  expect(html).toContain('<h3>子节</h3>')
  expect(html).toContain('<code class="language-md"># 非标题')
})

test('Setext and inline markup produce readable titles without link or HTML injection', () => {
  const model = parseDocument('标题 `code` [链接](https://example.com) &amp; ![图片](x.png)\n===\n\n## <b id="bad">字</b>\n')
  expect(model.headings.map(h => [h.title, h.level, h.sourceLine])).toEqual([['标题 code 链接 & 图片', 1, 0], ['<b id="bad">字</b>', 2, 3]])
  expect(model.html).not.toContain('<b ')
})

test('outline collapse survives unambiguous insertion and resets changed duplicate groups', () => {
  const state = new OutlineState()
  state.update(parseDocument('# A\n## child\n# B\n## child').headings)
  state.toggle('inknest-heading-2'); state.top = 80
  state.update(parseDocument('# Added\n# A\n## child\n# B\n## child').headings)
  expect([...state.collapsed]).toEqual(['inknest-heading-3'])
  expect(state.visible.map(h => h.title)).toEqual(['Added', 'A', 'child', 'B'])
  expect(state.visibleActive('inknest-heading-4')).toBe('inknest-heading-3')
  expect(state.top).toBe(80)
  state.update(parseDocument('# B\n## child\n# B\n## child').headings)
  expect([...state.collapsed]).toEqual([])
})

test('standalone explicit anchors retain their own source line before headings and paragraphs', () => {
  const model = parseDocument('# 文档\n\n<a id="acceptance"></a>\n## 后续真机验收\n\n<a name=\'paragraph\'></a>\n普通段落\n')
  expect(model.anchors).toEqual([
    { id: 'inknest-anchor-0', name: 'acceptance', sourceLine: 2 },
    { id: 'inknest-anchor-1', name: 'paragraph', sourceLine: 5 }
  ])
  expect(model.headings.map(heading => [heading.title, heading.sourceLine])).toEqual([['文档', 0], ['后续真机验收', 3]])
  expect(model.html).not.toContain('&lt;a ')
  expect(model.html).toContain('<p>普通段落</p>')
  expect(model.html).not.toContain('id="acceptance"')
})

test('anchor markers separate consecutive anchors and interrupt ordinary paragraphs', () => {
  const model = parseDocument('前文\n<a id="one"></a>\n<a name="two"></a>\n后文')
  expect(model.anchors?.map(anchor => [anchor.name, anchor.sourceLine])).toEqual([['one', 1], ['two', 2]])
  expect(model.html).toContain('<p>前文</p>')
  expect(model.html).toContain('<p>后文</p>')
})

test('fenced, indented and inline code never define explicit anchors', () => {
  const model = parseDocument('```html\n<a id="fenced"></a>\n```\n\n    <a id="indented"></a>\n\n`<a id="inline"></a>`\n')
  expect(model.anchors).toEqual([])
  expect(model.html).toContain('&lt;a id=&quot;fenced&quot;&gt;&lt;/a&gt;')
  expect(model.html).toContain('&lt;a id=&quot;indented&quot;&gt;&lt;/a&gt;')
})

test('only a standalone empty anchor with one quoted id or name attribute is recognized', () => {
  const source = [
    '<a id="event" onclick="alert(1)"></a>', '<a id="style" style="color:red"></a>',
    '<a id="both" name="other"></a>', '<a id="content">内容</a>', '<a href="https://example.com"></a>',
    '前文<a id="inline"></a>', '<a id="suffix"></a>后文', '<a id=""></a>', '<a id=unquoted></a>',
    '<a id="line\nbreak"></a>', '<a id="space value"></a>', '<script>alert(1)</script>'
  ].join('\n\n')
  const model = parseDocument(source)
  expect(model.anchors).toEqual([])
  expect(model.html).not.toContain('<a ')
  expect(model.html).not.toContain('<script>')
})
