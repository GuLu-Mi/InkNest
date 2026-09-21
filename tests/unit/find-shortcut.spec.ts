import { expect, test } from 'vitest'
import { findShortcut } from '../../src/main/system/find-shortcut'
const key = (value: string, modifiers: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({ key: value, meta: false, control: false, alt: false, shift: false, ...modifiers })
test('Mac and Windows map their platform keys to identical find/navigation commands', () => {
  expect(findShortcut(key('F', { meta: true }), 'darwin')).toBe('find')
  expect(findShortcut(key('f', { control: true }), 'win32')).toBe('find')
  expect(findShortcut(key('g', { meta: true }), 'darwin')).toBe('find-next')
  expect(findShortcut(key('F3'), 'win32')).toBe('find-next')
  expect(findShortcut(key('g', { meta: true, shift: true }), 'darwin')).toBe('find-previous')
  expect(findShortcut(key('F3', { shift: true }), 'win32')).toBe('find-previous')
})
test('unmodified typing, alternate modifiers and unrelated combinations remain untouched', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const input of [key('f'), key('f', { meta: true, control: true }), key('f', { meta: true, alt: true }), key('f', { control: true, shift: true })]) expect(findShortcut(input, platform)).toBeNull()
  }
  expect(findShortcut(key('f', { control: true }), 'darwin')).toBeNull()
  expect(findShortcut(key('f', { meta: true }), 'win32')).toBeNull()
})
