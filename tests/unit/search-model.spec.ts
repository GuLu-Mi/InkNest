import { Text } from '@codemirror/state'
import { expect, test } from 'vitest'
import { findMatches } from '../../src/renderer/src/search/search-model'
const scan = (text: string, query: string, sensitive = false) => findMatches(Text.of(text.split('\n')), query, sensitive, new AbortController().signal)
test('literal, non-overlapping searches preserve Unicode and source offsets', async () => {
  expect((await scan('aaaaa', 'aa')).length).toBe(2)
  expect((await scan('Aa aA', 'aa')).length).toBe(2)
  expect((await scan('Aa aA', 'aa', true)).length).toBe(0)
  const hits = await scan('甲😀e\u0301乙😀é', '😀é')
  expect(hits.length).toBe(2); expect(hits.at(0)).toEqual({ from: 1, to: 5 }); expect(hits.at(1)).toEqual({ from: 6, to: 9 })
  expect((await scan('<img onerror=x> .*', '.*')).length).toBe(1)
  expect((await scan('one\ntwo', 'one\ntwo')).length).toBe(0)
  expect((await scan('text', '')).length).toBe(0)
})
test('chunk boundaries neither duplicate nor lose matches', async () => {
  const text = 'x'.repeat(16383) + 'abcabc' + 'x'.repeat(16378) + 'abc'
  const found = await scan(text, 'abc')
  expect(found.length).toBe(3); expect(found.at(0).from).toBe(16383); expect(found.at(1).from).toBe(16386); expect(found.at(2).from).toBe(32767)
  expect(found.after(16384)).toBe(1); expect(found.after(text.length)).toBe(3)
})
test('ten MiB counts remain exact and cancellation interrupts chunked work', async () => {
  const text = Text.of(['a'.repeat(10 * 1024 * 1024)])
  const found = await findMatches(text, 'aa', true, new AbortController().signal)
  expect(found.length).toBe(5 * 1024 * 1024); expect(found.at(found.length - 1).to).toBe(text.length)
  const abort = new AbortController(); const running = findMatches(text, 'a', true, abort.signal); abort.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
}, 30000)
