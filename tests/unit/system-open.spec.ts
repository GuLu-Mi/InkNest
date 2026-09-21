import { afterEach, expect, test, vi } from 'vitest'
import { commandLineFiles, SystemOpenQueue } from '../../src/main/system/open-events'

afterEach(() => vi.useRealTimers())

test('argv keeps literal Unicode, spaces, # and %, skips runtime flags, URLs and app entry', () => {
  expect(commandLineFiles(['/Electron', '/app.md', '--inspect=123', '中文 #100%.MD', 'other.markdown', 'a.txt', 'https://host/a.md', 'bad\0.md', '--user-data-dir=x.md', '中文 #100%.MD'], '/work', true))
    .toEqual(['/work/中文 #100%.MD', '/work/other.markdown'])
  expect(commandLineFiles(['/InkNest', '/work/first.md'], '/', false)).toEqual(['/work/first.md'])
})

test('cold events wait for readiness and multi-file bursts are deduplicated before dispatch', async () => {
  vi.useFakeTimers()
  const dispatch = vi.fn(async () => {})
  const queue = new SystemOpenQueue(dispatch, vi.fn())
  queue.enqueue(['/a.md']); queue.enqueue(['/b.md', '/a.md'])
  await vi.advanceTimersByTimeAsync(500)
  expect(dispatch).not.toHaveBeenCalled()
  queue.start(); await vi.advanceTimersByTimeAsync(75)
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(['/a.md', '/b.md'])
})

test('in-flight dispatch is serialized, and failure does not swallow later requests', async () => {
  vi.useFakeTimers()
  let reject!: (reason: Error) => void
  const dispatch = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail })).mockResolvedValue(undefined)
  const failed = vi.fn()
  const queue = new SystemOpenQueue(dispatch, failed)
  queue.start(); queue.enqueue(['/a.md']); await vi.advanceTimersByTimeAsync(75)
  queue.enqueue(['/b.md']); await vi.advanceTimersByTimeAsync(500)
  expect(dispatch).toHaveBeenCalledTimes(1)
  reject(new Error('unavailable')); await vi.advanceTimersByTimeAsync(75)
  expect(failed).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenLastCalledWith(['/b.md'])
  queue.enqueue([]); await vi.advanceTimersByTimeAsync(75)
  expect(dispatch).toHaveBeenLastCalledWith([])
})
