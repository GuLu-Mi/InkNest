import { expect, test } from 'vitest'
import { canMergeAuto } from '../../src/main/documents/history-policy'

test('auto grouping keeps a fixed start and separates boundaries, owners and paths', () => {
  const group = { startedAt: 100_000, owner: 'doc/epoch', path: '/a.md', sealed: false }
  expect(canMergeAuto(group, 'doc/epoch', '/a.md', 159_999)).toBe(true)
  expect(canMergeAuto(group, 'doc/epoch', '/a.md', 160_000)).toBe(false)
  expect(canMergeAuto(group, 'doc/epoch', '/a.md', 99_999)).toBe(false)
  expect(canMergeAuto(group, 'other/epoch', '/a.md', 100_001)).toBe(false)
  expect(canMergeAuto(group, 'doc/epoch', '/b.md', 100_001)).toBe(false)
  expect(canMergeAuto({ ...group, sealed: true }, 'doc/epoch', '/a.md', 100_001)).toBe(false)
  expect(canMergeAuto(null, 'doc/epoch', '/a.md', 100_001)).toBe(false)
})
