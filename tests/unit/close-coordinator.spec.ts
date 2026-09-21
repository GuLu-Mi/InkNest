import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CloseCoordinator } from '../../src/main/documents/close-coordinator'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { DocumentRegistry } from '../../src/main/documents/registry'
import type { AppEvent, CurrentState } from '../../src/shared/contracts'

const roots: string[] = []
async function fixture(readonly = false, failDialog = false) {
  const registry = new DocumentRegistry()
  const root = await mkdtemp(join(tmpdir(), 'inknest-close-unit-')); roots.push(root)
  const path = join(root, 'test.md'); await writeFile(path, readonly ? Buffer.from([0xff]) : 'disk')
  await registry.open(path, 1)
  const document = registry.current!.document
  const ref = { docId: document.docId, epoch: document.epoch }
  const events: Array<Extract<AppEvent, { type: 'prepare-close' | 'close-finished' }>> = []
  let decision = false
  const prompted: string[] = []
  const close = new CloseCoordinator(registry, (event) => { if (event.type === 'prepare-close' || event.type === 'close-finished') events.push(event) }, async (name) => { prompted.push(name); if (failDialog) throw new Error('native dialog failed'); return decision ? 'save' : 'cancel' }, new SaveCoordinator(registry))
  const state = (text: string, revision = 1): CurrentState => ({ ref, snapshot: { ...ref, text, revision } })
  return { registry, close, events, prompted, state, ref, setDecision: (value: boolean) => { decision = value } }
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('saves the latest text in main without a routine prompt and rechecks each close attempt', async () => {
  const f = await fixture()
  const first = f.close.prepare()
  await f.close.complete(f.events[0]!.requestId, f.state('typed immediately before close'))
  expect(await first).toBe(true)
  expect(f.prompted).toEqual([])
  f.close.finish()
  const second = f.close.prepare()
  f.setDecision(true)
  await f.close.complete(f.events.at(-1)!.requestId, f.state('newer text', 2))
  expect(await second).toBe(true)
  f.close.finish()
})
it('does not prompt for clean content or main-registered readonly identity-only state', async () => {
  for (const readonly of [false, true]) {
    const f = await fixture(readonly)
    const pending = f.close.prepare()
    await f.close.complete(f.events[0]!.requestId, readonly ? { ref: f.ref, snapshot: null } : f.state('disk'))
    expect(await pending).toBe(true)
    expect(f.prompted).toEqual([])
    f.close.finish()
  }
})
it('rejects null editable snapshots, stale identities/revisions and changed same revisions', async () => {
  const f = await fixture()
  const invalid = [
    { ref: f.ref, snapshot: null },
    { ref: { ...f.ref, epoch: randomUUID() }, snapshot: null },
    f.state('different', 0)
  ]
  for (const state of invalid) {
    const pending = f.close.prepare()
    expect((await f.close.complete(f.events.at(-1)!.requestId, state)).status).toBe('error')
    expect(await pending).toBe(false)
    f.close.finish()
  }
  const pending = f.close.prepare()
  await f.close.complete(f.events.at(-1)!.requestId, f.state('dirty', 3))
  await pending; f.close.finish()
  const stale = f.close.prepare()
  expect((await f.close.complete(f.events.at(-1)!.requestId, f.state('disk', 2))).status).toBe('error')
  expect(await stale).toBe(false)
  f.close.finish()
})
it('times out safely and rejects unsolicited/duplicate responses and concurrent attempts', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  expect((await f.close.complete(randomUUID(), f.state('disk'))).status).toBe('error')
  const pending = f.close.prepare()
  expect(await f.close.prepare()).toBe(false)
  const id = f.events[0]!.requestId
  await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toBe(false)
  expect(f.events.at(-1)!.type).toBe('close-finished')
  expect((await f.close.complete(id, f.state('disk'))).status).toBe('error')
})

it('keeps the document when the native confirmation fails and rejects repeated replies', async () => {
  const f = await fixture(false, true)
  f.registry.current!.diskStatus = 'changed'
  const pending = f.close.prepare()
  const id = f.events[0]!.requestId
  expect((await f.close.complete(id, f.state('dirty'))).status).toBe('error')
  expect(await pending).toBe(false)
  expect((await f.close.complete(id, f.state('disk', 2))).status).toBe('error')
  f.close.finish()
})

it('prepares exactly the requested background ref and saves dirty text without a routine prompt', async () => {
  const registry = new DocumentRegistry()
  const root = await mkdtemp(join(tmpdir(), 'inknest-close-ref-')); roots.push(root)
  await writeFile(join(root, 'a.md'), 'A'); await writeFile(join(root, 'b.md'), 'B')
  await registry.open(join(root, 'a.md'), 1); const a = registry.current!
  await registry.open(join(root, 'b.md'), 1); const b = registry.current!
  const events: AppEvent[] = []; const prompt = vi.fn(async () => 'cancel' as const)
  const close = new CloseCoordinator(registry, event => events.push(event), prompt, new SaveCoordinator(registry))
  const pending = close.prepare(a.document)
  const first = events.find(event => event.type === 'prepare-close')!
  if (first.type !== 'prepare-close') throw new Error('missing request')
  expect(first.ref).toEqual({ docId: a.document.docId, epoch: a.document.epoch })
  expect((await close.complete(first.requestId, { ref: first.ref, snapshot: { ...first.ref, text: 'A complete latest', revision: 1 } })).status).toBe('ok')
  expect(await pending).toBe(true)
  expect(prompt).not.toHaveBeenCalled()
  expect(events.filter(event => event.type === 'prepare-close')).toHaveLength(1)
  expect(registry.current).toBe(b); expect(b.document.text).toBe('B')
  close.finish()
})

it('a clean snapshot cannot silently close an unobserved changed disk version', async () => {
  const registry = new DocumentRegistry(); const root = await mkdtemp(join(tmpdir(), 'inknest-close-clean-')); roots.push(root)
  const path = join(root, 'a.md'); await writeFile(path, 'A'); await registry.open(path, 1); const ref = registry.current!.document
  const events: AppEvent[] = []; const close = new CloseCoordinator(registry, event => events.push(event), async () => 'cancel', new SaveCoordinator(registry))
  await writeFile(path, 'external complete text')
  const pending = close.prepare(ref, false); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing challenge')
  expect(await close.complete(event.requestId, { ref, snapshot: { ...ref, text: 'A', revision: 0 } })).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await pending).toBe(false); close.finish()
})

it('ending a close challenge releases its retained confirmation text', async () => {
  const f = await fixture(); const preparing = f.close.prepare(f.ref)
  await f.close.complete(f.events[0]!.requestId, f.state('complete text')); expect(await preparing).toBe(true)
  expect(f.close.confirmedSnapshot?.text).toBe('complete text'); f.close.finish()
  expect(f.close.confirmedSnapshot).toBeNull()
})
