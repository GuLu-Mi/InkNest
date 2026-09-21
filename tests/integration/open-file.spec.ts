import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, link, utimes, chmod, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { readDocument } from '../../src/main/documents/reader'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inknest-open-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('failed additive candidates preserve the registered document', async () => {
  const registry = new DocumentRegistry()
  const first = join(root, '中文.MD')
  await writeFile(first, '# 中文\n')
  const opened = await registry.open(first, 7)
  expect(opened.status).toBe('ok')
  const prior = registry.current
  expect(prior?.document).toMatchObject({ displayName: '中文.MD', text: '# 中文\n', revision: 0, readOnlyReason: null })
  expect(prior?.document.docId).toMatch(/^[a-f0-9-]{36}$/)
  expect(prior?.document.epoch).not.toBe(prior?.document.docId)
  for (const [name, data, code] of [['wrong.txt', 'x', 'UNSUPPORTED_TYPE'], ['huge.md', Buffer.alloc(10 * 1024 * 1024 + 1), 'TOO_LARGE']] as const) {
    await writeFile(join(root, name), data)
    expect(await registry.open(join(root, name), 7)).toMatchObject({ status: 'error', error: { code } })
    expect(registry.current).toBe(prior)
  }
  expect(await registry.open(join(root, 'missing.md'), 7)).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } })
  expect(registry.current).toBe(prior)
})

test('disk tokens are stable across registries and detect same-size byte changes', async () => {
  const path = join(root, 'doc.md'); await writeFile(path, 'aa')
  const a = new DocumentRegistry(); const b = new DocumentRegistry()
  await a.open(path, 1); await b.open(path, 1)
  expect(a.current?.document.diskToken).toBe(b.current?.document.diskToken)
  expect(a.current?.document.epoch).not.toBe(b.current?.document.epoch)
  await writeFile(path, 'bb'); b.close(); await b.open(path, 1)
  expect(a.current?.document.diskToken).not.toBe(b.current?.document.diskToken)
})

test('large, unsupported format and linked documents are explicitly readonly', async () => {
  const registry = new DocumentRegistry()
  for (const [name, bytes, reason] of [['large.md', Buffer.alloc(2 * 1024 * 1024 + 1, 97), 'size'], ['bad.md', Buffer.from([0xff]), 'encoding'], ['mixed.md', 'a\r\nb\n', 'mixed-eol']] as const) {
    await writeFile(join(root, name), bytes); await registry.open(join(root, name), 1)
    expect(registry.current?.document.readOnlyReason).toBe(reason)
  }
  await writeFile(join(root, 'base.md'), 'base')
  await symlink(join(root, 'base.md'), join(root, 'sym.md'))
  await registry.open(join(root, 'sym.md'), 1)
  expect(registry.current?.document.readOnlyReason).toBe('link')
  await link(join(root, 'base.md'), join(root, 'hard.md'))
  await registry.open(join(root, 'hard.md'), 1)
  expect(registry.current?.document.readOnlyReason).toBe('link')
})


test('disk tokens ignore metadata-only changes but detect byte or identity changes', async () => {
  const path = join(root, 'stable.md')
  await writeFile(path, 'same bytes', { mode: 0o600 })
  const initial = await readDocument(path)
  const timestamp = new Date('2001-01-01T00:00:00Z')
  await utimes(path, timestamp, timestamp)
  await chmod(path, 0o644)
  const touched = await readDocument(path)
  expect(touched.fingerprint.mtimeMs).not.toBe(initial.fingerprint.mtimeMs)
  expect(touched.document.diskToken).toBe(initial.document.diskToken)

  await writeFile(path, 'edit bytes')
  await utimes(path, timestamp, timestamp)
  const edited = await readDocument(path)
  expect(edited.fingerprint.size).toBe(touched.fingerprint.size)
  expect(edited.document.diskToken).not.toBe(touched.document.diskToken)

  const replacement = join(root, 'replacement.md')
  await writeFile(replacement, 'edit bytes')
  await utimes(replacement, timestamp, timestamp)
  await rename(replacement, path)
  const replaced = await readDocument(path)
  expect(replaced.fingerprint.ino).not.toBe(edited.fingerprint.ino)
  expect(replaced.document.diskToken).not.toBe(edited.document.diskToken)
})


test('keeps independent sessions and rejects wrong owners, stale epochs and stale objects', async () => {
  const registry = new DocumentRegistry()
  await mkdir(join(root, 'other'))
  const paths = [join(root, 'same.md'), join(root, 'other', 'same.md')]
  await Promise.all(paths.map((path, index) => writeFile(path, `file ${index}`)))
  const first = await registry.open(paths[0]!, 7)
  const firstSession = registry.current!
  const second = await registry.open(paths[1]!, 7)
  expect(first.status).toBe('ok'); expect(second.status).toBe('ok')
  expect(registry.list(7)).toHaveLength(2)
  expect(registry.list(8)).toHaveLength(0)
  expect(registry.get(firstSession.document, 7)).toBe(firstSession)
  expect(registry.get(firstSession.document, 8)).toBeUndefined()
  const stale = { ...firstSession.document, epoch: '00000000-0000-0000-0000-000000000000' }
  expect(registry.get(stale, 7)).toBeUndefined()
  expect(registry.activate(stale, 7)).toBe(false)
  expect(registry.release(stale, 7)).toBe(false)
  expect(registry.has({ ...firstSession })).toBe(false)
  expect(registry.has(firstSession)).toBe(true)
  expect(await registry.open(paths[0]!, 7)).toEqual(first)
  expect(registry.current).toBe(firstSession)
  expect(await registry.open(paths[0]!, 8)).toMatchObject({ status: 'error', error: { code: 'TARGET_OPEN' } })
  expect(registry.release(firstSession.document, 8)).toBe(false)
  expect(registry.release(firstSession.document, 7)).toBe(true)
  expect(registry.has(firstSession)).toBe(false)
  expect(registry.current?.document).toEqual(second.status === 'ok' ? second.value : null)
})

test('deduplicates concurrent opens, hardlinks, symlinks and renamed file identities', async () => {
  const registry = new DocumentRegistry()
  const path = join(root, 'base.md'); await writeFile(path, 'original')
  const results = await Promise.all(Array.from({ length: 5 }, () => registry.open(path, 1)))
  for (const result of results) expect(result).toEqual(results[0])
  expect(registry.list(1)).toHaveLength(1)
  const original = registry.current!
  original.latestSnapshot = { ...original.document, text: 'unsaved', revision: 1 }
  await link(path, join(root, 'hard.md'))
  await symlink(path, join(root, 'sym.md'))
  expect(await registry.open(join(root, 'hard.md'), 1)).toEqual(results[0])
  expect(await registry.open(join(root, 'sym.md'), 1)).toEqual(results[0])
  await rename(path, join(root, 'renamed.md'))
  expect(await registry.open(join(root, 'renamed.md'), 1)).toEqual(results[0])
  expect(original.latestSnapshot.text).toBe('unsaved')
  expect(registry.list(1)).toHaveLength(1)
})

test('rejects the twenty-first concurrent new file without evicting any session', async () => {
  const registry = new DocumentRegistry()
  const paths = Array.from({ length: 21 }, (_, i) => join(root, `${i}.md`))
  await Promise.all(paths.map((path) => writeFile(path, 'document')))
  const firstTwenty = await Promise.all(paths.slice(0, 20).map((path) => registry.open(path, 1)))
  expect(firstTwenty.every((result) => result.status === 'ok')).toBe(true)
  const before = registry.list(1); const active = registry.current
  expect(await registry.open(paths[20]!, 1)).toMatchObject({ status: 'error', error: { code: 'TAB_LIMIT' } })
  expect(registry.list(1)).toEqual(before); expect(registry.current).toBe(active)
  expect(await registry.open(paths[0]!, 1)).toEqual(firstTwenty[0])
  expect(registry.list(1)).toHaveLength(20)
  registry.close(); expect(registry.list(1)).toHaveLength(0)
})

test('additive opening retains the previous session when the next file fails, then succeeds', async () => {
  const registry = new DocumentRegistry()
  const a = join(root, 'a.md'); const b = join(root, 'b.md')
  await writeFile(a, 'a'); await registry.open(a, 1)
  const before = registry.current!
  expect(await registry.open(b, 1)).toMatchObject({ status: 'error' })
  expect(registry.current).toBe(before); expect(registry.has(before)).toBe(true)
  await writeFile(b, 'b')
  expect((await registry.open(b, 1)).status).toBe('ok')
  expect(registry.list(1)).toHaveLength(2); expect(registry.has(before)).toBe(true)
})
