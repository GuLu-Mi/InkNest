import { expect, test } from 'vitest'
import { hasWindowDialog, runWindowDialog } from '../../src/main/window-dialogs'
test('window dialog admission survives overlapping prompts and all failure paths', async () => {
  const window = {}; const other = {}; let release!: () => void
  const first = runWindowDialog(window, () => new Promise<void>(resolve => { release = resolve }))
  expect(hasWindowDialog(window)).toBe(true); expect(hasWindowDialog(other)).toBe(false)
  await expect(runWindowDialog(window, () => { throw new Error('sync') })).rejects.toThrow('sync')
  await expect(runWindowDialog(window, async () => { throw new Error('async') })).rejects.toThrow('async')
  expect(hasWindowDialog(window)).toBe(true); release(); await first; expect(hasWindowDialog(window)).toBe(false)
})
