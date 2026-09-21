import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { HistoryStore, type HistoryWriteContext } from '../../src/main/documents/history-store'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { atomicWrite } from '../../src/main/documents/atomic-writer'
import { SnapshotStore, digest } from '../../src/main/documents/snapshot-store'
vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, unlink: vi.fn(actual.unlink) } })
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-history-recording-'))) })
afterEach(async () => { vi.mocked(unlink).mockReset(); await rm(root, { recursive: true, force: true }) })
async function fixture(options: ConstructorParameters<typeof HistoryStore>[1] = {}) {
  const path = join(root, 'doc.md'); await writeFile(path, 'A')
  const registry = new DocumentRegistry(); await registry.open(path, 1); const session = registry.current!
  const history = new HistoryStore(join(root, 'history'), options)
  const saves = new SaveCoordinator(registry, atomicWrite, { history })
  const context = (now: number, source: HistoryWriteContext['source'] = 'auto'): HistoryWriteContext => ({ session, targetPath: path, requestId: randomUUID(), revision: 1, source, now })
  const texts = async () => Promise.all((await history.list(session)).entries.map(async e => (await history.read(session, e.id)).toString()))
  const save = (revision: number, text: string, trigger: 'auto' | 'manual' | 'close' = 'auto') => saves.save({ requestId: randomUUID(), snapshot: { docId: session.document.docId, epoch: session.document.epoch, revision, text }, expectedDiskToken: session.document.diskToken, trigger }, 1)
  return { path, registry, session, history, saves, context, texts, save }
}
test('saved versions replace only the current auto group, preserve baseline and freeze on manual save', async () => {
  const f = await fixture(); const now = Date.now()
  const c = f.context(now); const protection = await f.history.protectBeforeWrite(c, Buffer.from('A'), f.session.document.diskToken!, false)
  try { expect((await f.history.recordSaved(c, Buffer.from('B'), 'b'.repeat(64))).state).toBe('recorded') } finally { protection.release() }
  expect(await f.texts()).toEqual(['B', 'A'])
  await f.history.recordSaved(f.context(now + 59_999), Buffer.from('C'), 'c'.repeat(64))
  expect(await f.texts()).toEqual(['C', 'A'])
  await f.history.recordSaved(f.context(now + 60_000), Buffer.from('D'), 'd'.repeat(64))
  expect(await f.texts()).toEqual(['D', 'C', 'A'])
  const manual = f.context(now + 60_001, 'manual')
  expect((await f.history.recordSaved(manual, Buffer.from('D'), 'd'.repeat(64))).state).toBe('recorded')
  const listing = await f.history.list(f.session)
  expect(listing.entries[0]).toMatchObject({ source: 'manual', sealed: true })
  expect((await f.history.recordSaved(f.context(now + 60_002, 'manual'), Buffer.from('D'), 'd'.repeat(64))).state).toBe('unchanged')
  expect(await f.history.list(f.session)).toEqual(listing)
  await f.history.recordSaved(f.context(now + 60_003), Buffer.from('E'), 'e'.repeat(64))
  expect(await f.texts()).toEqual(['E', 'D', 'C', 'A'])
})
test('confirmed writes record the new version; clean manual save seals without rewriting Markdown', async () => {
  const f = await fixture(); expect((await f.save(1, 'B')).status).toBe('ok')
  expect(await f.texts()).toEqual(['B', 'A'])
  const token = f.session.document.diskToken
  expect((await f.save(1, 'B', 'manual')).status).toBe('ok')
  expect(f.session.document.diskToken).toBe(token)
  expect((await f.history.list(f.session)).entries[0]?.source).toBe('manual')
  expect(await readFile(f.path, 'utf8')).toBe('B')
})
test('post-save history failure keeps the confirmed disk baseline and pauses auto until explicit repair', async () => {
  let manifests = 0; let broken = true
  const f = await fixture({ beforeManifest: () => { if (++manifests >= 2 && broken) throw new Error('history unavailable') } })
  const result = await f.save(1, 'B')
  expect(result).toMatchObject({ status: 'ok', value: { savedRevision: 1, history: { state: 'failed' } } })
  expect(await readFile(f.path, 'utf8')).toBe('B'); expect(f.session.document.text).toBe('B')
  expect(await f.texts()).toEqual(['A'])
  expect((await f.save(2, 'C')).status).not.toBe('ok'); expect(await readFile(f.path, 'utf8')).toBe('B')
  broken = false
  expect(await f.save(2, 'C', 'manual')).toMatchObject({ status: 'ok', value: { history: { state: 'recorded' } } })
  expect(await readFile(f.path, 'utf8')).toBe('C'); expect(f.session.historyAttention).toBeNull()
})

test('returning to older content preserves the return event instead of global hash deduplication', async () => {
  const f = await fixture(); await f.save(1, 'B'); await f.save(2, 'A')
  expect(await f.texts()).toEqual(['A', 'B', 'A'])
})
test('a pending history failure makes clean close require a separate explicit acknowledgement', async () => {
  const { CloseCoordinator } = await import('../../src/main/documents/close-coordinator')
  let manifests = 0
  const f = await fixture({ beforeManifest: () => { if (++manifests >= 2) throw Error('history down') } })
  await f.save(1, 'B'); let allow = false; let prompts = 0
  const close = new CloseCoordinator(f.registry, () => {}, async () => 'cancel', f.saves, undefined, async () => false, async () => { prompts++; return allow })
  const state = { ref: { docId: f.session.document.docId, epoch: f.session.document.epoch }, snapshot: { docId: f.session.document.docId, epoch: f.session.document.epoch, revision: 1, text: 'B' } }
  const first = close.prepare(); await close.complete(close.requestId!, state)
  expect(await first).toBe(false); expect(prompts).toBe(1); close.finish()
  allow = true
  const second = close.prepare(undefined, false); await close.complete(close.requestId!, state)
  expect(await second).toBe(true); expect(prompts).toBe(2); close.finish()
  expect(await readFile(f.path, 'utf8')).toBe('B')
})


test('v1 is read without rewriting and migrates atomically with original bytes and timestamps', async () => {
  let broken = false
  const f = await fixture({ beforeManifest: () => { if (broken) throw Error('migration failed') } })
  const store = new SnapshotStore(join(root, 'history')); const id = randomUUID(); await store.create(id)
  const timestamp = Date.now() - 1000; const record = { ...await store.content(id, Buffer.from('old'), 'bin', timestamp), capturedToken: 'a'.repeat(64) }
  const old = JSON.stringify({ schemaVersion: 1, canonicalPath: f.path, snapshots: [record] }); const manifest = join(root, 'history', id, 'manifest.json'); await writeFile(manifest, old)
  expect((await f.history.list(f.session)).entries[0]).toMatchObject({ source: 'legacy', sealed: true, savedAt: new Date(timestamp).toISOString() })
  expect(await readFile(manifest, 'utf8')).toBe(old)
  broken = true
  expect((await f.history.recordSaved(f.context(Date.now()), Buffer.from('B'), 'b'.repeat(64))).state).toBe('failed')
  expect(await readFile(manifest, 'utf8')).toBe(old); expect(await f.texts()).toEqual(['old'])
  broken = false
  expect((await f.history.recordSaved(f.context(Date.now()), Buffer.from('B'), 'b'.repeat(64))).state).toBe('recorded')
  expect(JSON.parse(await readFile(manifest, 'utf8')).schemaVersion).toBe(2)
  expect(await f.texts()).toEqual(['B', 'old'])
})
test('failed auto replacement leaves the previous complete index and immutable preview bytes', async () => {
  let broken = false
  const f = await fixture({ beforeManifest: () => { if (broken) throw Error('index unavailable') } }); await f.save(1, 'B')
  const before = await f.history.list(f.session); const oldId = before.entries[0]!.id
  broken = true
  expect(await f.save(2, 'C')).toMatchObject({ status: 'ok', value: { history: { state: 'failed' } } })
  expect(await f.history.list(f.session)).toEqual(before)
  expect((await f.history.inspect(f.session, oldId)).text).toBe('B')
  expect(await readFile(f.path, 'utf8')).toBe('C')
})
test('pinned target survives automatic replacement and clear is blocked only until lease release', async () => {
  const f = await fixture(); await f.save(1, 'B')
  const oldId = (await f.history.list(f.session)).entries[0]!.id
  const pin = await f.history.pin(f.session, oldId)
  try {
    await f.save(2, 'C'); expect(await f.texts()).toEqual(['C', 'B', 'A'])
    await expect(f.history.clear()).rejects.toMatchObject({ appError: { code: 'FILE_BUSY' } })
    expect((await f.history.inspect(f.session, oldId)).text).toBe('B')
  } finally { pin.release() }
  await f.history.clear(); expect(await f.texts()).toEqual([])
})
test('failed retirement deletion consumes real quota and can be reclaimed after restart', async () => {
  const warnings: boolean[] = []; const f = await fixture({ maxBytes: 3, maintenanceChanged: (_path, failed) => warnings.push(failed) })
  await f.save(1, 'B'); await f.save(2, 'C')
  vi.mocked(unlink).mockRejectedValue(Object.assign(Error('busy'), { code: 'EACCES' }))
  expect((await f.save(3, 'D'))).toMatchObject({ status: 'ok', value: { history: { state: 'failed' } } })
  expect(await readFile(f.path, 'utf8')).toBe('D'); expect(warnings).toContain(true)
  expect(await new SnapshotStore(join(root, 'history')).contentBytes()).toBe(3)
  vi.mocked(unlink).mockReset()
  const restarted = new HistoryStore(join(root, 'history'), { maxBytes: 3 })
  await restarted.list(f.session)
  expect(await new SnapshotStore(join(root, 'history')).contentBytes()).toBe(1)
  expect((await restarted.recordSaved(f.context(Date.now(), 'manual'), Buffer.from('D'), digest(Buffer.from('D')))).state).toBe('recorded')
  expect((await restarted.list(f.session)).entries).toHaveLength(2)
})
test('reopening a file cannot merge the previous session automatic version', async () => {
  const f = await fixture(); await f.save(1, 'B'); f.registry.release(f.session.document, 1)
  await f.registry.open(f.path, 1); const session = f.registry.current!
  const result = await f.saves.save({ requestId: randomUUID(), snapshot: { docId: session.document.docId, epoch: session.document.epoch, revision: 1, text: 'C' }, expectedDiskToken: session.document.diskToken, trigger: 'auto' }, 1)
  expect(result.status).toBe('ok')
  expect(await f.texts()).toEqual(['C', 'B', 'A'])
})
test('a save of an unchanged newly opened document does not invent a history version', async () => {
  const f = await fixture(); const token = f.session.document.diskToken
  expect((await f.save(0, 'A', 'manual')).status).toBe('ok')
  expect(await f.texts()).toEqual([]); expect(f.session.document.diskToken).toBe(token)
  expect(await readdir(join(root, 'history'))).toEqual([])
})
test.each(['schema', 'unknown-field', 'duplicate', 'content'])('v2 %s corruption remains visible and blocks overwrite', async kind => {
  const f = await fixture(); await f.save(1, 'B')
  const [id] = await readdir(join(root, 'history')); const file = join(root, 'history', id!, 'manifest.json'); const manifest = JSON.parse(await readFile(file, 'utf8'))
  if (kind === 'schema') manifest.schemaVersion = 3
  if (kind === 'unknown-field') manifest.arbitrary = true
  if (kind === 'duplicate') manifest.snapshots.push(manifest.snapshots[0])
  if (kind === 'content') await writeFile(join(root, 'history', id!, manifest.snapshots[0].snapshot), 'tampered')
  await writeFile(file, JSON.stringify(manifest)); const original = await readFile(file, 'utf8')
  expect((await f.save(2, 'C')).status).toBe('error')
  expect(await readFile(f.path, 'utf8')).toBe('B'); expect(await readFile(file, 'utf8')).toBe(original)
})

test('automatic replacement at the 100-node limit preserves all other 99 nodes', async () => {
  const f = await fixture(); const store = new SnapshotStore(join(root, 'history')); const id = randomUUID(); await store.create(id)
  const now = Date.now(); const snapshots = []
  for (let i = 0; i < 99; i++) snapshots.unshift({ ...await store.content(id, Buffer.from(`old${i}`), 'bin', now - 1000 + i), capturedToken: 'a'.repeat(64), source: 'manual', groupStartedAt: null, sealed: true })
  await store.publish(id, { schemaVersion: 2, canonicalPath: f.path, generation: 99, snapshots, retired: [] })
  await f.history.recordSaved(f.context(now), Buffer.from('B'), 'b'.repeat(64))
  expect((await f.history.list(f.session)).entries).toHaveLength(100)
  await f.history.recordSaved(f.context(now + 1), Buffer.from('C'), 'c'.repeat(64))
  expect((await f.history.list(f.session)).entries).toHaveLength(100)
  expect((await f.texts()).at(-1)).toBe('old0')
}, 20_000)
test('quota eviction respects per-file commit order even when wall clock moves backward', async () => {
  const f = await fixture({ maxBytes: 3 }); const now = Date.now()
  for (const [index, text] of ['A', 'B', 'C'].entries()) await f.history.recordSaved(f.context(now - index * 1000, 'manual'), Buffer.from(text), digest(Buffer.from(text)))
  expect((await f.history.recordSaved(f.context(now, 'manual'), Buffer.from('D'), digest(Buffer.from('D')))).state).toBe('recorded')
  expect(await f.texts()).toEqual(['D', 'C', 'B'])
})
