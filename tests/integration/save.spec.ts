import { randomUUID } from 'node:crypto'
import { mkdtemp, link, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { atomicWrite } from '../../src/main/documents/atomic-writer'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import type { SaveRequest } from '../../src/shared/contracts'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inknest-save-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function setup(bytes: string | Buffer = 'v0') {
  const path = join(root, 'doc.md'); await writeFile(path, bytes)
  const registry = new DocumentRegistry(); await registry.open(path, 1)
  const session = new DocumentSession(structuredClone(registry.current!.document))
  const request = (text: string, revision = 1): SaveRequest => ({ requestId: randomUUID(), snapshot: { docId: registry.current!.document.docId, epoch: registry.current!.document.epoch, revision, text }, expectedDiskToken: session.document.diskToken, trigger: 'manual' })
  return { path, registry, session, request }
}
function gate() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve }); return { wait, release } }

test('TC-016 saves immutable v1 then queued v2 along its own token chain without cleaning v2 early', async () => {
  const f = await setup(); const started = gate(); const resume = gate(); let writes = 0
  const saves = new SaveCoordinator(f.registry, async (path, bytes, check) => { if (++writes === 1) { started.release(); await resume.wait }; return atomicWrite(path, bytes, check) })
  f.session.dispatch({ changes: { from: 0, to: 2, insert: 'v1' } })
  const a = f.request('v1'); a.snapshot = f.session.captureSave(a.requestId)
  const first = saves.save(a, 1); await started.wait
  f.session.dispatch({ changes: { from: 0, to: 2, insert: 'v2' } })
  const b = f.request('v2', 2); b.snapshot = f.session.captureSave(b.requestId)
  const second = saves.save(b, 1)
  resume.release(); const savedA = await first
  expect(savedA).toMatchObject({ status: 'ok', value: { savedRevision: 1 } })
  if (savedA.status === 'ok') f.session.acceptSave(savedA.value, a.snapshot.text)
  expect(f.session.dirty).toBe(true)
  const savedB = await second
  if (savedB.status === 'ok') f.session.acceptSave(savedB.value, b.snapshot.text)
  expect(savedB.status).toBe('ok'); expect(f.session.dirty).toBe(false)
  expect(await readFile(f.path, 'utf8')).toBe('v2')
  expect(f.registry.current!.latestSnapshot?.text).toBe('v2')
})

test('TC-019 checks external changes at actual write entry and never overwrites external bytes', async () => {
  const f = await setup(); const started = gate(); const resume = gate()
  const saves = new SaveCoordinator(f.registry, async (path, bytes, check) => { started.release(); await resume.wait; return atomicWrite(path, bytes, check) })
  const result = saves.save(f.request('v1'), 1); await started.wait
  await writeFile(f.path, 'external'); resume.release()
  expect(await result).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('external'); expect(f.registry.current!.latestSnapshot?.text).toBe('v1')
})

test('TC-013/014 unchanged saves do not replace or touch bytes and edited BOM CRLF/no-final bytes are preserved', async () => {
  const f = await setup(Buffer.from('efbbbf610d0a62', 'hex')); const saves = new SaveCoordinator(f.registry)
  const before = await stat(f.path)
  expect((await saves.save(f.request('a\nb', 0), 1)).status).toBe('ok')
  expect((await stat(f.path)).ino).toBe(before.ino); expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs)
  expect((await saves.save(f.request('a\n中文', 1), 1)).status).toBe('ok')
  expect((await readFile(f.path)).toString('hex')).toBe('efbbbf610d0ae4b8ade69687')
})

test('request duplicates reuse one result; changed payload, stale revisions, identity and arbitrary token reject', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const a = f.request('v1')
  const first = await saves.save(a, 1); const identity = (await stat(f.path)).ino
  expect(await saves.save(structuredClone(a), 1)).toEqual(first)
  expect((await stat(f.path)).ino).toBe(identity)
  for (const request of [{ ...a, snapshot: { ...a.snapshot, text: 'bad' } }, f.request('bad', 0), f.request('bad', 1), { ...f.request('bad', 2), expectedDiskToken: 'a'.repeat(64) }, { ...f.request('bad', 2), snapshot: { ...a.snapshot, epoch: randomUUID() } }]) expect((await saves.save(request, 1)).status).toBe('error')
  expect((await saves.save(f.request('bad', 3), 2)).status).toBe('error')
  expect(await readFile(f.path, 'utf8')).toBe('v1')
})

test.each(['a\rb', '\ud800', '中'.repeat(700000)])('rejects non-roundtrippable or oversized snapshots without writing', async (text) => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry)
  expect((await saves.save(f.request(text), 1)).status).toBe('error')
  expect(await readFile(f.path, 'utf8')).toBe('v0')
})

test('leading U+FEFF source gets a successful byte-bound receipt without losing source baseline', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry)
  expect((await saves.save(f.request('\ufeffvalue'), 1)).status).toBe('ok')
  expect((await readFile(f.path)).toString('hex')).toBe('efbbbf76616c7565')
  expect(f.registry.current!.document.text).toBe('\ufeffvalue')
  expect((await saves.save({ ...f.request('\ufeffnext', 2), expectedDiskToken: f.registry.current!.document.diskToken }, 1)).status).toBe('ok')
  expect((await readFile(f.path)).toString('hex')).toBe('efbbbf6e657874')
})


test('background saves preserve the active document and refresh the written file identity', async () => {
  const f = await setup(); const a = f.registry.current!; const request = f.request('saved A')
  const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1)
  const b = f.registry.current!
  const saves = new SaveCoordinator(f.registry)
  expect((await saves.save(request, 1)).status).toBe('ok')
  expect(f.registry.current).toBe(b); expect(b.document.text).toBe('B')
  expect(await readFile(f.path, 'utf8')).toBe('saved A')
  expect(await readFile(bPath, 'utf8')).toBe('B')
  await link(f.path, join(root, 'alias.md'))
  expect(await f.registry.open(join(root, 'alias.md'), 1)).toEqual({ status: 'ok', value: a.document })
  expect(f.registry.list(1)).toHaveLength(2)
})

test('unrelated files save independently while opening waits for atomic identity publication', async () => {
  const f = await setup(); const a = f.registry.current!; const request = f.request('saved A')
  const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1)
  const b = f.registry.current!; const started = gate(); const resume = gate()
  const saves = new SaveCoordinator(f.registry, async (path, bytes, check) => {
    const identity = await atomicWrite(path, bytes, check)
    if (path === f.path) { started.release(); await resume.wait }
    return identity
  })
  const first = saves.save(request, 1); await Promise.race([started.wait, first.then((result) => { expect(result.status).toBe('ok') })])
  expect((await saves.save({ requestId: randomUUID(), snapshot: { docId: b.document.docId, epoch: b.document.epoch, text: 'saved B', revision: 1 }, expectedDiskToken: b.document.diskToken, trigger: 'manual' }, 1)).status).toBe('ok')
  await link(f.path, join(root, 'alias.md'))
  const reopened = f.registry.open(join(root, 'alias.md'), 1)
  // Remove the test-created hard link so the pending save can finish its write verification.
  await rm(join(root, 'alias.md'))
  const reopenedPath = f.registry.open(f.path, 1)
  resume.release()
  expect((await first).status).toBe('ok')
  expect((await reopened).status).toBe('error')
  expect(await reopenedPath).toEqual({ status: 'ok', value: a.document })
  expect(f.registry.list(1)).toHaveLength(2)
})

test('auto gate refuses untouched recovered text but accepts a real later edit before its checkpoint', async () => {
  const f = await setup(); const main = f.registry.current!; main.recoveryPending = true; main.recoveryRevision = 10
  main.latestSnapshot = { docId: main.document.docId, epoch: main.document.epoch, text: 'recovered', revision: 10 }
  const saves = new SaveCoordinator(f.registry)
  expect((await saves.save({ ...f.request('recovered', 10), trigger: 'auto' }, 1)).status).toBe('cancelled')
  expect(await readFile(f.path, 'utf8')).toBe('v0'); expect(main.recoveryPending).toBe(true)
  expect((await saves.save({ ...f.request('edited recovery', 11), trigger: 'auto' }, 1)).status).toBe('ok')
  expect(await readFile(f.path, 'utf8')).toBe('edited recovery'); expect(main.recoveryPending).toBe(false)
})
test('auto waiting slot coalesces latest, duplicates remain pinned, manual barrier rejects C until B finishes', async () => {
  const f = await setup(); const started = gate(); const release = gate(); const writes: string[] = []
  const saves = new SaveCoordinator(f.registry, async (path, bytes, check) => { writes.push(Buffer.from(bytes).toString()); if (writes.length === 1) { started.release(); await release.wait }; return atomicWrite(path, bytes, check) })
  const a = { ...f.request('A', 1), trigger: 'auto' as const }; const first = saves.save(a, 1); await started.wait
  const old = saves.save({ ...f.request('old pending', 2), trigger: 'auto' }, 1)
  let latest = saves.save({ ...f.request('latest pending', 3), trigger: 'auto' }, 1)
  expect(await old).toEqual({ status: 'cancelled' })
  for (let revision = 4; revision <= 303; revision++) {
    const previous = latest; latest = saves.save({ ...f.request('latest pending', revision), trigger: 'auto' }, 1)
    expect(await previous).toEqual({ status: 'cancelled' })
  }
  expect(saves.save(a, 1)).toBe(first)
  const pinned = Reflect.get(saves, 'queues').get(f.registry.current!)
  expect(pinned.requests.size).toBe(258); expect(pinned.tokens.size).toBe(1)
  const manual = saves.save(f.request('B', 304), 1)
  const c = { ...f.request('C', 305), trigger: 'auto' as const }
  expect(await saves.save(c, 1)).toEqual({ status: 'cancelled' })
  release.release(); expect((await first).status).toBe('ok'); expect(pinned.requests.has(a.requestId)).toBe(true); expect((await latest).status).toBe('ok'); const savedB = await manual; expect(savedB.status).toBe('ok')
  c.expectedDiskToken = f.registry.current!.document.diskToken
  expect((await saves.save(c, 1)).status).toBe('ok'); expect(writes).toEqual(['A', 'latest pending', 'B', 'C']); expect(await readFile(f.path, 'utf8')).toBe('C')
})
test('1000 real saves bound completed replay to 256 and tokens to current, pending baselines and 256 successful proofs', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const main = f.registry.current!
  const first = f.request('v1', 1); const retained: SaveRequest[] = []
  for (let revision = 1; revision <= 1000; revision++) {
    const request = revision === 1 ? first : { ...f.request(`v${revision}`, revision), expectedDiskToken: main.document.diskToken }
    retained.push(request); expect((await saves.save(request, 1)).status).toBe('ok')
    const queue = Reflect.get(saves, 'queues').get(main)
    expect(queue.requests.size).toBeLessThanOrEqual(256); expect(queue.tokens.size).toBeLessThanOrEqual(257)
    if (revision % 100 === 0) expect(await readFile(f.path, 'utf8')).toBe(`v${revision}`)
  }
  expect((await saves.save(first, 1))).toMatchObject({ status: 'error', error: { code: 'STALE_REVISION' } })
  expect(await saves.save({ ...f.request('expired proof', 1001), expectedDiskToken: first.expectedDiskToken }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  const before = await stat(f.path); expect((await saves.save(retained[999]!, 1)).status).toBe('ok'); expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs)
}, 30000)

test('real paused auto A cannot clear newer B snapshot or rename the other active workspace tab', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const f = await setup(); const a = f.registry.current!; const workspace = new WorkspaceModel(); workspace.install(structuredClone(a.document))
  const otherPath = join(root, 'other.md'); await writeFile(otherPath, 'other'); await f.registry.open(otherPath, 1); const other = f.registry.current!
  workspace.register(structuredClone(other.document)); const current = workspace.getSession(a.document)!; const started = gate(); const release = gate()
  const saves = new SaveCoordinator(f.registry, async (path, bytes, check) => { started.release(); await release.wait; return atomicWrite(path, bytes, check) })
  current.dispatch({ changes: { from: 0, to: 2, insert: 'A' } }); const id = randomUUID(); const snapshot = current.captureSave(id)
  const saving = saves.save({ requestId: id, snapshot, expectedDiskToken: current.document.diskToken, trigger: 'auto' }, 1); await started.wait
  current.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); workspace.activate(other.document); workspace.getSession(other.document)!.dispatch({ changes: { from: 0, insert: 'dirty ' } })
  release.release(); const result = await saving; expect(result.status).toBe('ok'); if (result.status === 'ok') workspace.acceptSave(result.value, snapshot.text)
  expect(current.snapshot().text).toBe('B'); expect(current.dirty).toBe(true); expect(workspace.active?.docId).toBe(other.document.docId)
  expect(workspace.get(other.document)!.displayName).toBe('other.md'); expect(workspace.getSession(other.document)!.dirty).toBe(true); expect(await readFile(f.path, 'utf8')).toBe('A')
  workspace.dispose()
})

test('explicit conflict overwrite retires old tokens even without a following ordinary save', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const main = f.registry.current!
  expect((await saves.overwrite(main, f.request('explicit replacement', 1), main.document.diskToken!)).status).toBe('ok')
  const queue = Reflect.get(saves, 'queues').get(main); expect([...queue.tokens]).toEqual([main.document.diskToken])
})

test('bounded successful self-chain proof accepts delayed renderer token, but real external bytes still reject', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const oldToken = f.registry.current!.document.diskToken
  expect((await saves.save(f.request('A', 1), 1)).status).toBe('ok')
  expect((await saves.save({ ...f.request('B', 2), expectedDiskToken: oldToken }, 1)).status).toBe('ok')
  expect(await readFile(f.path, 'utf8')).toBe('B')
  await writeFile(f.path, 'external')
  expect(await saves.save({ ...f.request('C', 3), expectedDiskToken: oldToken }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('external')
})
test.each(['save-as', 'overwrite'] as const)('%s invalidates successful proof from the previous target/baseline chain', async action => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const main = f.registry.current!; const oldToken = main.document.diskToken
  expect((await saves.save(f.request('A', 1), 1)).status).toBe('ok')
  const request = { ...f.request('B', 2), expectedDiskToken: main.document.diskToken }
  const result = action === 'save-as' ? await saves.saveAs(request, 1, async () => join(root, 'copy.md'), async () => true) : await saves.overwrite(main, request, main.document.diskToken!)
  expect(result.status).toBe('ok')
  expect(await saves.save({ ...f.request('C', 3), expectedDiskToken: oldToken }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(main.path, 'utf8')).toBe('B')
})

test('failed requests cannot renew a retired successful self-chain proof', async () => {
  const f = await setup(); let writes = 0
  const saves = new SaveCoordinator(f.registry, (path, bytes, check) => { if (writes++) throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' }); return atomicWrite(path, bytes, check) })
  const oldToken = f.registry.current!.document.diskToken; expect((await saves.save(f.request('A', 1), 1)).status).toBe('ok')
  for (let i = 0; i < 256; i++) expect(await saves.save({ ...f.request('B', 2), expectedDiskToken: oldToken }, 1)).toMatchObject({ status: 'error', error: { code: 'DISK_FULL' } })
  expect(await saves.save({ ...f.request('B', 2), expectedDiskToken: oldToken }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('A')
})

test('auto during a migrated but unfinished SaveAs barrier is cancelled before retired-token classification', async () => {
  const f = await setup(); const started = gate(); const release = gate(); const main = f.registry.current!
  const saves = new SaveCoordinator(f.registry, atomicWrite, { recovery: { afterSave: async () => { started.release(); await release.wait } } })
  const originalToken = main.document.diskToken; const saveAs = saves.saveAs(f.request('B', 1), 1, async () => join(root, 'copy.md'), async () => true); await started.wait
  const c = { ...f.request('C', 2), expectedDiskToken: originalToken, trigger: 'auto' as const }
  expect(await saves.save(c, 1)).toEqual({ status: 'cancelled' }); expect(main.latestSnapshot?.revision).toBe(1)
  release.release(); expect((await saveAs).status).toBe('ok'); c.expectedDiskToken = main.document.diskToken
  expect((await saves.save(c, 1)).status).toBe('ok'); expect(await readFile(main.path, 'utf8')).toBe('C')
})
