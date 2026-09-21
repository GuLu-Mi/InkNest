import { expect, it } from 'vitest'
import { classifyLink } from '../../src/main/documents/link-target'
it('classifies targets without silently converting remote .md or encoded separators', () => {
  expect(classifyLink('https://example.test/a.md?q=1#part')).toEqual({ kind: 'external', url: 'https://example.test/a.md?q=1#part' })
  expect(classifyLink('chapter%20one.md#%E7%AB%A0%E8%8A%82')).toEqual({ kind: 'local', path: 'chapter one.md', fragment: '章节' })
  expect(classifyLink('#hello')).toEqual({ kind: 'anchor', fragment: 'hello' })
  expect(classifyLink('mailto:user@example.test')).toEqual({ kind: 'external', url: 'mailto:user@example.test' })
  expect(classifyLink('a%2520b.md')).toEqual({ kind: 'local', path: 'a%20b.md', fragment: '' })
})
it.each(['javascript:alert(1)', 'data:text/html,bad', 'shell:foo', '//server/path', '\\\\server\\file', 'a.md?query=1', 'a%00b.md', 'https://user:pw@example.test/', 'file://server/a.md'])('rejects unsupported or ambiguous targets %s', raw => { expect(() => classifyLink(raw)).toThrow() })

it.each(['/\\server/share', '\\/server/share', '%2f%5cserver/share', '%5c%2fserver/share'])('rejects mixed Windows network prefixes before filesystem access: %s', raw => { expect(() => classifyLink(raw)).toThrow() })
