import fs from 'node:fs/promises'
import { SnapshotStore } from '../../src/main/documents/snapshot-store'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { RecoveryStore } from '../../src/main/documents/recovery-store'
import { HistoryStore } from '../../src/main/documents/history-store'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { atomicWrite } from '../../src/main/documents/atomic-writer'
import { readDocument } from '../../src/main/documents/reader'
vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, unlink: vi.fn(actual.unlink) } })
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-backups-'))) })
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(unlink).mockReset(); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const path = join(root, 'doc.md'); await writeFile(path, Buffer.from('efbbbf6f6c640d0a', 'hex'))
  const registry = new DocumentRegistry(); await registry.open(path, 1); const session = registry.current!
  const snapshot = (revision: number, text = `new${revision}`) => ({ docId: session.document.docId, epoch: session.document.epoch, revision, text })
  return { path, registry, session, snapshot }
}
test('rev11 content without published manifest leaves only committed rev10 after restart', async () => {
  const f = await fixture(); let failIndex = false
  const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { beforeManifest: () => { if (failIndex) throw new Error('injected index failure') } })
  await recovery.checkpoint(f.session, f.snapshot(10)); failIndex = true
  await expect(recovery.checkpoint(f.session, f.snapshot(11))).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } })
  const restarted = new RecoveryStore(join(root, 'recovery'), new DocumentRegistry())
  const [entry] = await restarted.list(); expect(await restarted.inspect(entry!.id)).toBe('new10')
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a')
})
test('hash, unknown schema, unknown fields and traversal ids cannot restore or overwrite original', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list()
  const dir = join(root, 'recovery', entry!.id); const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(join(dir, manifest.snapshots[0].snapshot), 'tampered')
  await expect(recovery.inspect(entry!.id)).rejects.toMatchObject({ appError: { code: 'CORRUPT_DATA' } })
  for (const change of [{ schemaVersion: 2 }, { unexpected: true }, { snapshots: [{ ...manifest.snapshots[0], snapshot: '../doc.md' }] }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...change }))
    await expect(recovery.inspect(entry!.id)).rejects.toMatchObject({ appError: { code: 'CORRUPT_DATA' } })
    await expect(recovery.checkpoint(f.session, f.snapshot(2))).rejects.toBeDefined()
  }
  await expect(recovery.inspect('../doc.md')).rejects.toBeDefined(); await expect(recovery.inspect(randomUUID())).rejects.toBeDefined()
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a')
})
test('save A retains later B recovery and migrates its path, durable discard never revives old snapshot', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); await recovery.checkpoint(f.session, f.snapshot(2))
  f.session.path = join(root, 'copy.md'); await recovery.afterSave(f.session, 1)
  const [entry] = await recovery.list(); expect(await recovery.inspect(entry!.id)).toBe('new2')
  const manifest = JSON.parse(await readFile(join(root, 'recovery', entry!.id, 'manifest.json'), 'utf8')); expect(manifest.originalPath).toBe(f.session.path)
  await recovery.discardSession(f.session)
  expect(await new RecoveryStore(join(root, 'recovery'), new DocumentRegistry()).list()).toEqual([])
})
test('capacity does not evict 20 active unique copies; clear leaves active records intact', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { maxBytes: 20 })
  for (let i = 0; i < 20; i++) {
    const path = join(root, `${i}.md`); await writeFile(path, 'old')
    if (i === 0) f.registry.release(f.session.document, 1)
    await f.registry.open(path, 1); const s = f.registry.current!
    await recovery.checkpoint(s, { ...s.document, revision: 1, text: 'x' })
  }
  const s = f.registry.current!
  await expect(recovery.checkpoint(s, { ...s.document, revision: 2, text: 'xx' })).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } })
  await recovery.clear(); expect(await recovery.list()).toHaveLength(20)
})
test('history failure prevents any formal writer call and keeps newest local text', async () => {
  const f = await fixture(); let calls = 0
  const history = new HistoryStore(join(root, 'history'), { beforeManifest: () => { throw new Error('ENOSPC injection') } })
  const saves = new SaveCoordinator(f.registry, async (...args) => { calls++; return atomicWrite(...args) }, { history })
  const result = await saves.save({ requestId: randomUUID(), snapshot: f.snapshot(1), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1)
  expect(result).toMatchObject({ status: 'error', error: { code: 'HISTORY_FAILED' } }); expect(calls).toBe(0)
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a'); expect(f.session.latestSnapshot?.text).toBe('new1')
})
test('history keeps exact old BOM/CRLF bytes, unthrottled protection, 100 count and global quota', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history'))
  const bytes = await readFile(f.path); const start = Date.now()
  await history.captureBeforeWrite(f.session, bytes, 'auto', start)
  expect((await history.list(f.session)).entries).toHaveLength(1)
  const [first] = (await history.list(f.session)).entries; expect(await history.read(f.session, first!.id)).toEqual(bytes)
  await history.captureBeforeWrite(f.session, Buffer.from('second'), 'auto', start + 59999)
  expect((await history.list(f.session)).entries).toHaveLength(2)
  for (let i = 0; i < 101; i++) await history.captureBeforeWrite(f.session, Buffer.from(`version${i}`), 'manual', start + 60000 + i)
  expect((await history.list(f.session)).entries).toHaveLength(100)
  const quota = new HistoryStore(join(root, 'small-history'), { maxBytes: 12 })
  await quota.captureBeforeWrite(f.session, Buffer.from('12345678'), 'manual', Date.now())
  await quota.captureBeforeWrite(f.session, Buffer.from('abcdefgh'), 'manual', Date.now() + 1)
  expect((await quota.list(f.session)).entries).toHaveLength(1)
  expect(await readdir(join(root, 'history'))).toHaveLength(1)
}, 20000)
test('history capture is checked again before replacement and existing SaveAs captures destination bytes', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history'), { beforeManifest: async () => { await writeFile(f.path, 'external') } })
  const saves = new SaveCoordinator(f.registry, atomicWrite, { history })
  expect(await saves.save({ requestId: randomUUID(), snapshot: f.snapshot(1), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('external')
  const target = join(root, 'target.md'); await writeFile(target, 'target old')
  const destinationHistory = new HistoryStore(join(root, 'destination-history'))
  const copySaves = new SaveCoordinator(f.registry, atomicWrite, { history: destinationHistory })
  expect((await copySaves.saveAs({ requestId: randomUUID(), snapshot: f.snapshot(2), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1, async () => target, async () => true)).status).toBe('ok')
  const [, entry] = (await destinationHistory.list(f.session)).entries; expect(await destinationHistory.read(f.session, entry!.id)).toEqual(Buffer.from('target old'))
  expect((await readDocument(target)).document.text).toBe('new2')
})

test('restore activates an already open source without changing text; release then restores new gated epoch', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(5)); const [entry] = await recovery.list()
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  const history = new HistoryStore(join(root, 'history')); const saves = new SaveCoordinator(f.registry)
  const coordinator = new BackupCoordinator(f.registry, saves, recovery, history, { choosePath: async () => null, confirm: async () => true })
  const originalEpoch = f.session.document.epoch
  expect(await coordinator.restore(entry!.id, 1)).toMatchObject({ status: 'error', error: { code: 'TARGET_OPEN' } })
  expect(f.registry.list(1)).toHaveLength(1); expect(f.session.document.text).toBe('old\n'); expect(await recovery.inspect(entry!.id)).toBe('new5')
  f.registry.release(f.session.document, 1)
  const restored = await coordinator.restore(entry!.id, 1)
  expect(restored).toMatchObject({ status: 'ok', value: { text: 'new5', recovered: true } })
  if (restored.status === 'ok') expect(restored.value.epoch).not.toBe(originalEpoch)
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a')
  expect(f.registry.current!.recoveryPending).toBe(true)
})
test('restoring a missing original creates an editable recovery association but never recreates disk', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(2)); const [entry] = await recovery.list(); f.registry.release(f.session.document, 1); await rm(f.path)
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  const result = await new BackupCoordinator(f.registry, new SaveCoordinator(f.registry), recovery, new HistoryStore(join(root, 'history')), { choosePath: async () => null, confirm: async () => true }).restore(entry!.id, 1)
  expect(result).toMatchObject({ status: 'ok', value: { text: 'new2', recovered: true, readOnlyReason: null } })
  expect(f.registry.current!.diskStatus).toBe('missing'); await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
test('history export preserves exact bytes, current text/path, and refuses source or another open target', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history')); await history.captureBeforeWrite(f.session, await readFile(f.path), 'manual', Date.now())
  const [entry] = (await history.list(f.session)).entries; let target = f.path
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  const coordinator = new BackupCoordinator(f.registry, new SaveCoordinator(f.registry), new RecoveryStore(join(root, 'recovery'), f.registry), history, { choosePath: async () => target, confirm: async () => true })
  expect(await coordinator.exportHistory(f.session.document, entry!.id, 1)).toMatchObject({ status: 'error', error: { code: 'TARGET_OPEN' } })
  target = join(root, 'export.md'); expect(await coordinator.exportHistory(f.session.document, entry!.id, 1)).toMatchObject({ status: 'ok' })
  expect(await readFile(target, 'hex')).toBe('efbbbf6f6c640d0a'); expect(f.session.path).toBe(f.path); expect(f.session.document.text).toBe('old\n')
})
test('failed discard marker retains a restorable copy; adopted recovery is retired only by its own save', async () => {
  const f = await fixture(); let failing = false
  const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { beforeManifest: () => { if (failing) throw new Error('discard write failure') } })
  await recovery.checkpoint(f.session, f.snapshot(2)); const [entry] = await recovery.list(); failing = true
  await expect(recovery.discardSession(f.session)).rejects.toThrow(); expect(await recovery.inspect(entry!.id)).toBe('new2')
  failing = false; f.registry.release(f.session.document, 1)
  await f.registry.open(f.path, 1); const unrelated = f.registry.current!
  const saves = new SaveCoordinator(f.registry, atomicWrite, { recovery })
  await saves.save({ requestId: randomUUID(), snapshot: { ...unrelated.document, text: 'other', revision: 1 }, expectedDiskToken: unrelated.document.diskToken, trigger: 'manual' }, 1)
  expect(await recovery.inspect(entry!.id)).toBe('new2'); f.registry.release(unrelated.document, 1)
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  await new BackupCoordinator(f.registry, saves, recovery, new HistoryStore(join(root, 'history')), { choosePath: async () => null, confirm: async () => true }).restore(entry!.id, 1)
  const restored = f.registry.current!; expect(await recovery.inspect(entry!.id)).toBe('new2')
  await recovery.discardSession(restored); expect(await new RecoveryStore(join(root, 'recovery'), new DocumentRegistry()).list()).toEqual([])
})
test('manifest symlinks cannot redirect a checkpoint into an outside file', async () => {
  const { symlink } = await import('node:fs/promises'); const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list(); const path = join(root, 'recovery', entry!.id, 'manifest.json')
  const outside = join(root, 'outside.json'); await writeFile(outside, await readFile(path)); await rm(path); await symlink(outside, path)
  const before = await readFile(outside)
  await expect(recovery.checkpoint(f.session, f.snapshot(2))).rejects.toBeDefined(); expect(await readFile(outside)).toEqual(before)
})
test('first history manifest failure can retry, explicit manual skip is one operation, maintenance failure preserves successful receipt', async () => {
  const f = await fixture(); let failure = true
  const history = new HistoryStore(join(root, 'history'), { beforeManifest: () => { if (failure) throw new Error('first manifest fail') } })
  await expect(history.captureBeforeWrite(f.session, await readFile(f.path), 'manual', Date.now())).rejects.toBeDefined()
  failure = false; await history.captureBeforeWrite(f.session, await readFile(f.path), 'manual', Date.now()); expect((await history.list(f.session)).entries).toHaveLength(1)
  let confirms = 0; let maintenance = 0
  const saves = new SaveCoordinator(f.registry, atomicWrite, { history: { protectBeforeWrite: async () => { throw new Error('history fail') }, recordSaved: async () => { throw new Error('history fail') } }, confirmWithoutHistory: async () => ++confirms === 1, recovery: { afterSave: async () => { throw new Error('cleanup fail') } }, maintenanceFailed: () => maintenance++ })
  const request = (revision: number) => ({ requestId: randomUUID(), snapshot: f.snapshot(revision), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' as const })
  expect((await saves.save(request(1), 1)).status).toBe('ok'); expect(maintenance).toBe(1)
  expect((await saves.save(request(2), 1)).status).toBe('error'); expect(confirms).toBe(2); expect(await readFile(f.path, 'utf8')).toBe('\ufeffnew1')
})
test('discard refuses a forged marker symlink and cannot overwrite another local file', async () => {
  const { symlink } = await import('node:fs/promises'); const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list()
  const outside = join(root, 'outside.json'); await writeFile(outside, 'user data')
  await symlink(outside, join(root, 'recovery', entry!.id, 'discarded.json'))
  await expect(recovery.discardSession(f.session)).rejects.toBeDefined(); expect(await readFile(outside, 'utf8')).toBe('user data')
})
test('30-day cleanup expires only inactive recovery and history while preserving active recovery', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list(); const manifestPath = join(root, 'recovery', entry!.id, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.snapshots[0].createdAt = new Date(Date.now() - 31 * 86400000).toISOString(); await writeFile(manifestPath, JSON.stringify(manifest))
  expect(await recovery.list()).toHaveLength(1); f.registry.release(f.session.document, 1); expect(await recovery.list()).toEqual([])
  const history = new HistoryStore(join(root, 'history')); await history.captureBeforeWrite(f.session, Buffer.from('expired'), 'manual', Date.now() - 31 * 86400000)
  expect((await history.list(f.session)).entries).toEqual([])
})
test('use-disk epoch replacement waits for durable discard, failure preserves original session and checkpoint', async () => {
  const { FileLifecycle } = await import('../../src/main/documents/file-lifecycle')
  const f = await fixture(); let failure = false; const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { beforeManifest: () => { if (failure) throw new Error('discard failed') } })
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list(); await writeFile(f.path, 'external')
  const lifecycle = new FileLifecycle(f.registry, new SaveCoordinator(f.registry), { choosePath: async () => null, confirm: async () => true }, recovery)
  failure = true; expect((await lifecycle.resolveConflict(f.session.document, 'use-disk', f.snapshot(1), 1)).status).toBe('error')
  expect(f.registry.current).toBe(f.session); expect(await recovery.inspect(entry!.id)).toBe('new1')
  failure = false; expect(await lifecycle.resolveConflict(f.session.document, 'use-disk', f.snapshot(1), 1)).toMatchObject({ status: 'ok', value: { kind: 'opened', document: { text: 'external' } } })
  expect(await recovery.list()).toEqual([]); expect(f.registry.current!.document.epoch).not.toBe(f.session.document.epoch)
})
test('checkpoint B during formal write A survives post-save maintenance; stale released epoch cannot revive discarded data', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1))
  let entered!: () => void; let resume!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }); const gate = new Promise<void>(resolve => { resume = resolve })
  const saves = new SaveCoordinator(f.registry, async (...args) => { entered(); await gate; return atomicWrite(...args) }, { recovery })
  const saveA = saves.save({ requestId: randomUUID(), snapshot: f.snapshot(1), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1)
  await started; await recovery.checkpoint(f.session, f.snapshot(2)); resume(); expect((await saveA).status).toBe('ok')
  const [entry] = await recovery.list(); expect(await recovery.inspect(entry!.id)).toBe('new2'); expect(await readFile(f.path, 'utf8')).toBe('\ufeffnew1')
  await recovery.discardSession(f.session); f.registry.release(f.session.document, 1)
  await expect(recovery.checkpoint(f.session, f.snapshot(3))).rejects.toMatchObject({ appError: { code: 'STALE_SESSION' } }); expect(await recovery.list()).toEqual([])
})
test('capacity eviction announces affected inactive count, cancellation retains records, success reports actual cleanup', async () => {
  const f = await fixture(); let allow = false; const announced: number[] = []; const cleaned: number[] = []
  const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { maxBytes: 3, confirmEviction: async count => { announced.push(count); return allow }, didEvict: count => { cleaned.push(count) } })
  await recovery.checkpoint(f.session, f.snapshot(1, 'aa')); f.registry.release(f.session.document, 1)
  await f.registry.open(f.path, 1); const next = f.registry.current!; const snapshot = { docId: next.document.docId, epoch: next.document.epoch, revision: 1, text: 'bb' }
  await expect(recovery.checkpoint(next, snapshot)).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } }); expect(announced).toEqual([1]); expect(cleaned).toEqual([])
  allow = true; await recovery.checkpoint(next, snapshot); expect(announced).toEqual([1, 1]); expect(cleaned).toEqual([1]); expect(await recovery.list()).toHaveLength(1)
})
test('unindexed retained bytes count toward capacity and are never deleted by cleanup', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry, { maxBytes: 8 })
  await recovery.checkpoint(f.session, f.snapshot(1, 'aa')); const [entry] = await recovery.list()
  const orphan = join(root, 'recovery', entry!.id, `${randomUUID()}.txt`); await writeFile(orphan, '123456')
  await expect(recovery.checkpoint(f.session, f.snapshot(2, 'bb'))).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } })
  expect(await recovery.inspect(entry!.id)).toBe('aa'); expect(await readFile(orphan, 'utf8')).toBe('123456')
})
test('valid hash cannot legitimize malformed UTF-8 recovery bytes', async () => {
  const { createHash } = await import('node:crypto'); const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list(); const dir = join(root, 'recovery', entry!.id); const path = join(dir, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')); const bytes = Buffer.from([0xff]); manifest.snapshots[0].contentHash = createHash('sha256').update(bytes).digest('hex'); manifest.snapshots[0].byteLength = 1
  await writeFile(join(dir, manifest.snapshots[0].snapshot), bytes); await writeFile(path, JSON.stringify(manifest))
  await expect(recovery.inspect(entry!.id)).rejects.toMatchObject({ appError: { code: 'CORRUPT_DATA' } })
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a')
})

test.each(['missing', 'corrupt', 'expired'] as const)('history reuse verifies matching %s data before any formal overwrite', async kind => {
  const f = await fixture(); const historyRoot = join(root, 'history'); const history = new HistoryStore(historyRoot); const oldBytes = await readFile(f.path)
  await history.captureBeforeWrite(f.session, oldBytes, 'manual', Date.now())
  const [directory] = await readdir(historyRoot); const manifestPath = join(historyRoot, directory!, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); const record = manifest.snapshots[0]
  const contentPath = join(historyRoot, directory!, record.snapshot)
  if (kind === 'missing') await rm(contentPath)
  else if (kind === 'corrupt') await writeFile(contentPath, 'damaged')
  else { record.createdAt = new Date(Date.now() - 31 * 86400000).toISOString(); await writeFile(manifestPath, JSON.stringify(manifest)) }
  let writes = 0
  const saves = new SaveCoordinator(f.registry, async (...args) => { writes++; return atomicWrite(...args) }, { history })
  const result = await saves.save({ requestId: randomUUID(), snapshot: f.snapshot(1, 'replacement'), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1)
  if (kind !== 'expired') {
    expect(result).toMatchObject({ status: 'error', error: { code: 'HISTORY_FAILED' } }); expect(writes).toBe(0)
    expect(await readFile(f.path)).toEqual(oldBytes); expect(f.session.latestSnapshot?.text).toBe('replacement')
  } else {
    expect(result.status).toBe('ok'); expect(writes).toBe(1)
    const retained = (await history.list(f.session)).entries; expect(retained).toHaveLength(2)
    expect(retained[1]!.id).not.toBe(record.snapshot.slice(0, -4)); expect(await history.read(f.session, retained[1]!.id)).toEqual(oldBytes)
  }
})

test.each(['writer-first', 'restore-first'] as const)('restore admission coordinates %s final-check reservation without holding the recovery queue', async order => {
  const f = await fixture(); const target = join(root, 'target.md'); await writeFile(target, 'target old')
  const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await f.registry.open(target, 1); const formerTarget = f.registry.current!
  await recovery.checkpoint(formerTarget, { ...formerTarget.document, revision: 3, text: 'target recovered' })
  const [entry] = await recovery.list(); f.registry.release(formerTarget.document, 1)
  await recovery.checkpoint(f.session, f.snapshot(1, 'source saved'))
  let writerReached!: () => void; let releaseWriter!: () => void; let restoreReached!: () => void; let releaseRestore!: () => void
  const atFinalCheck = new Promise<void>(resolve => { writerReached = resolve }); const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const atAdmission = new Promise<void>(resolve => { restoreReached = resolve }); const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve })
  if (order === 'restore-first') {
    const verified = recovery.withVerified.bind(recovery); let attempt = 0
    recovery.withVerified = (id, operation) => verified(id, async value => { if (++attempt === 1) { restoreReached(); await restoreGate }; return operation(value) })
  }
  let checks = 0
  const saves = new SaveCoordinator(f.registry, (path, bytes, check) => atomicWrite(path, bytes, async () => { await check(); if (++checks === 2) { writerReached(); await writerGate } }), { recovery })
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  const coordinator = new BackupCoordinator(f.registry, saves, recovery, new HistoryStore(join(root, 'history')), { choosePath: async () => null, confirm: async () => true })
  let restoreSettled = false
  const restore = () => coordinator.restore(entry!.id, 1).then(result => { restoreSettled = true; return result })
  const earlyRestore = order === 'restore-first' ? restore() : null
  if (earlyRestore) await atAdmission
  const saving = saves.saveAs({ requestId: randomUUID(), snapshot: f.snapshot(1, 'source saved'), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, 1, async () => target, async () => true)
  await atFinalCheck
  const restoring = earlyRestore ?? restore(); releaseRestore()
  let results
  try {
    // This queued read drains an entered restore callback, but must remain available
    // when restore waits for a writer. No wall-clock sleep establishes the ordering.
    expect(await recovery.inspect(entry!.id)).toBe('target recovered')
    expect(restoreSettled).toBe(false); expect(f.registry.findPath(target)).toBeUndefined(); expect(f.registry.list(1)).toHaveLength(1)
  } finally { releaseWriter(); results = await Promise.all([saving, restoring]) }
  expect(checks).toBe(2); expect(results[0].status).toBe('ok')
  expect(results[1]).toMatchObject({ status: 'error', error: { code: 'TARGET_OPEN' } })
  expect(f.registry.current).toBe(f.session); expect(f.session.path).toBe(target); expect(await readFile(target, 'utf8')).toBe('\ufeffsource saved')
  expect(await recovery.inspect(entry!.id)).toBe('target recovered')
  f.registry.release(f.session.document, 1)
  const restored = await coordinator.restore(entry!.id, 1)
  expect(restored).toMatchObject({ status: 'ok', value: { text: 'target recovered', recovered: true } })
  if (restored.status === 'ok') expect(restored.value.epoch).not.toBe(formerTarget.document.epoch)
  expect(await readFile(target, 'utf8')).toBe('\ufeffsource saved')
})

// F1: unlink failures must remain retryable even after another record disappeared.
test.each(['list', 'clear'] as const)('discarded snapshots retry partial unlink failure after restart through %s', async entrypoint => {
  const f = await fixture(); const location = join(root, 'recovery'); const recovery = new RecoveryStore(location, f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); await recovery.checkpoint(f.session, f.snapshot(2))
  const [entry] = await recovery.list(); const dir = join(location, entry!.id)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const original = fs.unlink; const failing = join(dir, manifest.snapshots[1].snapshot)
  const spy = vi.mocked(unlink).mockImplementation(async path => { if (path === failing) throw Object.assign(new Error('temporary unlink denial'), { code: 'EACCES' }); return original(path) })
  await recovery.discardSession(f.session)
  expect(await new SnapshotStore(location).contentBytes()).toBe(4)
  spy.mockReset()
  const restarted = new RecoveryStore(location, new DocumentRegistry()); await restarted[entrypoint](); await restarted[entrypoint]()
  expect(await new SnapshotStore(location).contentBytes()).toBe(0)
  expect(await restarted.list()).toEqual([]); await expect(restarted.inspect(entry!.id)).rejects.toMatchObject({ appError: { code: 'INVALID_REQUEST' } })
  expect(JSON.parse(await readFile(join(dir, 'discarded.json'), 'utf8')).sessionId).toBe(entry!.id)
})
test('failed eviction deletion never promises physical quota space for a new checkpoint', async () => {
  const f = await fixture(); const location = join(root, 'recovery'); const recovery = new RecoveryStore(location, f.registry, { maxBytes: 5, confirmEviction: async () => true })
  await recovery.checkpoint(f.session, f.snapshot(1)); f.registry.release(f.session.document, 1)
  await f.registry.open(f.path, 1); const next = f.registry.current!
  const spy = vi.mocked(unlink).mockRejectedValue(Object.assign(new Error('temporary unlink denial'), { code: 'EACCES' }))
  await expect(recovery.checkpoint(next, { ...next.document, revision: 1, text: 'next' })).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } })
  expect(await new SnapshotStore(location).contentBytes()).toBe(4); spy.mockReset()
  await recovery.checkpoint(next, { ...next.document, revision: 1, text: 'next' })
  expect(await new SnapshotStore(location).contentBytes()).toBe(4)
})
test.each(['tampered', 'symlink', 'hardlink', 'future-manifest', 'bad-marker'] as const)('discard maintenance preserves %s and unknown content', async kind => {
  const f = await fixture(); const location = join(root, 'recovery'); const recovery = new RecoveryStore(location, f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [entry] = await recovery.list(); const dir = join(location, entry!.id)
  const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); const content = join(dir, manifest.snapshots[0].snapshot)
  const spy = vi.mocked(unlink).mockRejectedValue(new Error('hold content')); await recovery.discardSession(f.session); spy.mockReset()
  await writeFile(join(dir, 'unknown.txt'), 'unknown')
  if (kind === 'tampered') await writeFile(content, 'tampered')
  if (kind === 'symlink' || kind === 'hardlink') { const outside = join(root, 'outside'); await writeFile(outside, 'new1'); await rm(content); if (kind === 'symlink') await fs.symlink(outside, content); else await fs.link(outside, content) }
  if (kind === 'future-manifest') await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }))
  if (kind === 'bad-marker') await writeFile(join(dir, 'discarded.json'), JSON.stringify({ schemaVersion: 1, sessionId: randomUUID(), discardedAt: new Date().toISOString() }))
  const restarted = new RecoveryStore(location, new DocumentRegistry()); await restarted.list(); await restarted.clear().catch(() => {})
  expect(await readFile(content, 'utf8')).toBe(kind === 'tampered' ? 'tampered' : 'new1'); expect(await readFile(join(dir, 'unknown.txt'), 'utf8')).toBe('unknown')
  await expect(restarted.inspect(entry!.id)).rejects.toBeDefined()
})
test('owner maintenance bounds released associations while retaining a saved active session', async () => {
  const f = await fixture(); const recovery = new RecoveryStore(join(root, 'recovery'), f.registry)
  await recovery.checkpoint(f.session, f.snapshot(1)); const [active] = await recovery.list(); await recovery.afterSave(f.session, 1)
  for (let i = 0; i < 30; i++) {
    const path = join(root, 'transient.md'); await writeFile(path, 'baseline'); await f.registry.open(path, 1); const session = f.registry.current!
    await recovery.checkpoint(session, { ...session.document, revision: 1, text: 'draft' }); await recovery.afterSave(session, 1); f.registry.release(session.document, 1)
  }
  await recovery.list()
  expect((Reflect.get(recovery, 'owners') as Map<string, unknown>).size).toBe(1)
  expect(recovery.activeSession(active!.id)).toBe(f.session)
  await recovery.checkpoint(f.session, f.snapshot(2)); expect(await recovery.inspect(active!.id)).toBe('new2')
})
test('same-path overwrite history records the verified external token and bytes', async () => {
  const f = await fixture(); const historyRoot = join(root, 'history'); const history = new HistoryStore(historyRoot); const saves = new SaveCoordinator(f.registry, atomicWrite, { history })
  await writeFile(f.path, 'external'); const external = await readDocument(f.path)
  expect((await saves.overwrite(f.session, { requestId: randomUUID(), snapshot: f.snapshot(1), expectedDiskToken: f.session.document.diskToken, trigger: 'manual' }, external.document.diskToken!)).status).toBe('ok')
  const [id] = await readdir(historyRoot); const manifest = JSON.parse(await readFile(join(historyRoot, id!, 'manifest.json'), 'utf8'))
  expect(manifest.snapshots[1].capturedToken).toBe(external.document.diskToken)
  expect(await readFile(join(historyRoot, id!, manifest.snapshots[1].snapshot), 'utf8')).toBe('external')
})

test('recovery rollover does not allocate beyond physical quota by subtracting a still-committed snapshot', async () => {
  const f = await fixture(); const location = join(root, 'recovery'); const recovery = new RecoveryStore(location, f.registry, { maxBytes: 8 })
  await recovery.checkpoint(f.session, f.snapshot(1)); await recovery.checkpoint(f.session, f.snapshot(2))
  await expect(recovery.checkpoint(f.session, f.snapshot(3))).rejects.toMatchObject({ appError: { code: 'RECOVERY_FAILED' } })
  const [entry] = await recovery.list(); expect(await recovery.inspect(entry!.id)).toBe('new2'); expect(await new SnapshotStore(location).contentBytes()).toBe(8)
})
test('same-session auto saves retain the baseline and latest saved bytes', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history')); const saves = new SaveCoordinator(f.registry, atomicWrite, { history })
  for (let revision = 1; revision <= 3; revision++) expect((await saves.save({ requestId: randomUUID(), snapshot: f.snapshot(revision), expectedDiskToken: f.session.document.diskToken, trigger: 'auto' }, 1)).status).toBe('ok')
  const entries = (await history.list(f.session)).entries; expect(entries).toHaveLength(2); expect(await history.read(f.session, entries[0]!.id)).toEqual(Buffer.from('\ufeffnew3')); expect(await history.read(f.session, entries[1]!.id)).toEqual(Buffer.from('efbbbf6f6c640d0a', 'hex'))
})

test('history inspection returns verified raw-byte metadata and codec text for two distinct versions', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history')); const now = Date.now()
  const bytes = [Buffer.from('efbbbf6f6c640d0a', 'hex'), Buffer.from('new\n')]
  await history.captureBeforeWrite(f.session, bytes[0]!, 'manual', now - 1000)
  await history.captureBeforeWrite(f.session, bytes[1]!, 'manual', now)
  expect(history.inspect).toBeTypeOf('function')
  const entries = (await history.list(f.session)).entries
  const { createHash } = await import('node:crypto')
  for (const [index, text, format] of [[0, 'new\n', { encoding: 'utf-8', bom: false, eol: 'lf' }], [1, 'old\n', { encoding: 'utf-8', bom: true, eol: 'crlf' }]] as const) {
    const raw = bytes[1 - index]!
    expect(await history.inspect(f.session, entries[index]!.id)).toEqual({ source: 'baseline', sealed: true, id: entries[index]!.id, savedAt: new Date(now - index * 1000).toISOString(), byteLength: raw.length, contentHash: createHash('sha256').update(raw).digest('hex'), text, format, restorable: true })
    expect(await history.read(f.session, entries[index]!.id)).toEqual(raw)
  }
  const otherPath = join(root, 'other.md'); await writeFile(otherPath, 'other'); await f.registry.open(otherPath, 1)
  await expect(history.inspect(f.registry.current!, entries[0]!.id)).rejects.toMatchObject({ appError: { code: 'INVALID_REQUEST' } })
  expect(await readFile(f.path)).toEqual(bytes[0]); expect(f.session.document.revision).toBe(0)
})

test.each([['invalid UTF-8', Buffer.from([0xff]), '\ufffd'], ['mixed newlines', Buffer.from('a\r\nb\n'), 'a\r\nb\n']] as const)('%s history remains inspectable and byte-exportable but not restorable', async (_kind, bytes, text) => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history'))
  await history.captureBeforeWrite(f.session, bytes, 'manual', Date.now()); const [entry] = (await history.list(f.session)).entries
  expect(history.inspect).toBeTypeOf('function')
  expect(await history.inspect(f.session, entry!.id)).toMatchObject({ text, format: null, restorable: false })
  expect(await history.read(f.session, entry!.id)).toEqual(bytes)
})

test('oversized history can be read but cannot advertise restoration eligibility', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history')); const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 97)
  await history.captureBeforeWrite(f.session, bytes, 'manual', Date.now()); const [entry] = (await history.list(f.session)).entries
  expect(history.inspect).toBeTypeOf('function'); expect(await history.inspect(f.session, entry!.id)).toMatchObject({ byteLength: bytes.length, restorable: false })
})

test.each(['cleared', 'corrupt', 'missing'] as const)('inspection rejects %s records without changing the source session or file', async kind => {
  const f = await fixture(); const location = join(root, 'history'); const history = new HistoryStore(location)
  await history.captureBeforeWrite(f.session, await readFile(f.path), 'manual', Date.now()); const [entry] = (await history.list(f.session)).entries
  const [directory] = await readdir(location); const content = join(location, directory!, `${entry!.id}.bin`)
  if (kind === 'cleared') await history.clear(); else if (kind === 'missing') await rm(content); else await writeFile(content, 'corrupt')
  expect(history.inspect).toBeTypeOf('function')
  await expect(history.inspect(f.session, entry!.id)).rejects.toMatchObject({ appError: { code: kind === 'cleared' ? 'INVALID_REQUEST' : 'CORRUPT_DATA' } })
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a'); expect(f.session.document.revision).toBe(0)
})

test('inspection queued before a same-ref migration rejects its old path result', async () => {
  const f = await fixture(); let hold = false; let reached!: () => void; let release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve }); const gate = new Promise<void>(resolve => { release = resolve })
  const history = new HistoryStore(join(root, 'history'), { beforeManifest: async () => { if (hold) { reached(); await gate } } })
  await history.captureBeforeWrite(f.session, Buffer.from('first'), 'manual', Date.now()); const [entry] = (await history.list(f.session)).entries
  hold = true; const capturing = history.captureBeforeWrite(f.session, Buffer.from('second'), 'manual', Date.now()); await entered
  const inspecting = history.inspect(f.session, entry!.id); f.session.path = join(root, 'migrated.md'); release(); await capturing
  await expect(inspecting).rejects.toMatchObject({ appError: { code: 'STALE_SESSION' } })
  expect(await readFile(f.path, 'hex')).toBe('efbbbf6f6c640d0a'); expect(f.session.document.revision).toBe(0)
})

test('historical export proposes captured timestamp and cross-directory cancellation leaves no file', async () => {
  const f = await fixture(); const history = new HistoryStore(join(root, 'history'))
  const captured = new Date(); captured.setHours(9, 38, 12, 0)
  await history.captureBeforeWrite(f.session, await readFile(f.path), 'manual', captured.getTime())
  const [entry] = (await history.list(f.session)).entries; await fs.mkdir(join(root, 'elsewhere'))
  const target = join(root, 'elsewhere', 'copy.md'); let suggested = ''; let allow = false
  const { BackupCoordinator } = await import('../../src/main/documents/backup-coordinator')
  const coordinator = new BackupCoordinator(f.registry, new SaveCoordinator(f.registry), new RecoveryStore(join(root, 'recovery'), f.registry), history, {
    choosePath: async name => { suggested = name; return target }, confirm: async kind => kind === 'directory' ? allow : true
  })
  expect(await coordinator.exportHistory(f.session.document, entry!.id, 1)).toEqual({ status: 'cancelled' })
  expect(suggested).toMatch(/^doc-历史-\d{8}-093812\.md$/u)
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  allow = true
  expect(await coordinator.exportHistory(f.session.document, entry!.id, 1)).toMatchObject({ status: 'ok' })
  expect(await readFile(target, 'hex')).toBe('efbbbf6f6c640d0a')
  expect(f.session.path).toBe(f.path)
})
