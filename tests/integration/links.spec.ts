import { expect, test } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { LinkRouter } from '../../src/main/documents/link-router'
import { readDocument } from '../../src/main/documents/reader'
import type { ResourceService } from '../../src/main/security/resource-protocol'

test('link routing preserves sessions, guards late reads and isolates local grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-links-'))
  try {
    const dir = join(root, 'docs'); await mkdir(dir)
    const a = join(dir, 'a.md'); const b = join(dir, 'b.md'); const outside = join(root, 'out.md')
    await writeFile(a, '# A'); await writeFile(b, '# B'); await writeFile(outside, '# Outside'); await symlink(outside, join(dir, 'alias.md'))
    const registry = new DocumentRegistry(); const opened = await registry.open(a, 1); if (opened.status !== 'ok') throw new Error()
    const calls: string[] = []
    const router = new LinkRouter(registry, {} as ResourceService, { blocked: () => false, external: async url => { calls.push(url) }, directory: async path => { calls.push(path); return '' }, reveal: path => { calls.push(path) } })
    expect(await router.open(opened.value, '#part', 1)).toMatchObject({ status: 'ok', value: { kind: 'anchor', fragment: 'part' } })
    const second = await router.open(opened.value, 'b.md#target', 1); expect(second).toMatchObject({ status: 'ok', value: { kind: 'document', fragment: 'target' } })
    registry.activate(opened.value, 1)
    const again = await router.open(opened.value, 'b.md', 1); expect(again).toMatchObject(second.status === 'ok' && second.value.kind === 'document' ? { value: { document: { docId: second.value.document.docId } } } : {})
    expect(registry.list(1)).toHaveLength(2); registry.activate(opened.value, 1)
    expect(await router.open(opened.value, 'https://example.test/a.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'dispatched' } }); expect(calls).toContain('https://example.test/a.md')
    expect(await router.open(opened.value, 'alias.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'document' } })
    expect(await router.open(opened.value, '../out.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'document' } }); expect(registry.list(1)).toHaveLength(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('link opens do not activate main, stale A-B-A requests cancel, and replaced targets cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-link-race-'))
  try {
    const a = join(root, 'a.md'); const b = join(root, 'b.md'); const outside = join(root, 'else.md')
    await writeFile(a, '# A'); await writeFile(b, '# B'); await writeFile(outside, '# private')
    const registry = new DocumentRegistry(); const first = await registry.open(a, 1); if (first.status !== 'ok') throw new Error()
    const other = await registry.open(b, 1); if (other.status !== 'ok') throw new Error(); registry.activate(first.value, 1)
    const actions = { blocked: () => false, external: async () => {}, directory: async () => '', reveal: () => {} }
    const router = new LinkRouter(registry, {} as ResourceService, actions)
    const originalOpen = registry.open.bind(registry)
    registry.open = async (...args) => { registry.activate(other.value, 1); registry.activate(first.value, 1); return originalOpen(...args) }
    expect(await router.open(first.value, b, 1)).toEqual({ status: 'cancelled' })
    registry.open = originalOpen
    const result = await router.open(first.value, 'b.md', 1); expect(result.status).toBe('ok'); expect(registry.current?.document.docId).toBe(first.value.docId)
    registry.open = async (...args) => { await rm(b); await symlink(outside, b); return originalOpen(...args) }
    expect(await router.open(first.value, 'b.md', 1)).toMatchObject({ status: 'error', error: { code: 'ACCESS_DENIED' } })
    expect(registry.list(1)).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('link routing keeps the 20-tab cap while reusing an existing dirty session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-link-limit-'))
  try {
    const registry = new DocumentRegistry()
    for (let index = 0; index < 21; index++) {
      const path = join(root, `${index}.md`); await writeFile(path, `# ${index}`)
      if (index < 20) expect((await registry.open(path, 1)).status).toBe('ok')
    }
    const source = registry.current!
    const existing = registry.list(1)[0]!
    existing.latestSnapshot = { docId: existing.document.docId, epoch: existing.document.epoch, revision: 7, text: 'unsaved work' }
    const router = new LinkRouter(registry, {} as ResourceService, { blocked: () => false, external: async () => {}, directory: async () => '', reveal: () => {} })
    expect(await router.open(source.document, '20.md', 1)).toMatchObject({ status: 'error', error: { code: 'TAB_LIMIT' } })
    expect(registry.list(1)).toHaveLength(20)
    expect(registry.current).toBe(source)
    expect(await router.open(source.document, '0.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'document', document: { docId: existing.document.docId, epoch: existing.document.epoch } } })
    expect(existing.latestSnapshot.text).toBe('unsaved work')
    expect(existing.latestSnapshot.revision).toBe(7)
    expect(registry.current).toBe(source)
    expect(registry.list(1)).toHaveLength(20)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.each(['close', 'reload', 'migrate', 'blocked'] as const)('cancels pending link reads after source %s', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-link-source-'))
  try {
    const a = join(root, 'a.md'); const b = join(root, 'b.md'); const migrated = join(root, 'migrated.md')
    await writeFile(a, '# A'); await writeFile(b, '# B'); await writeFile(migrated, '# A elsewhere')
    const registry = new DocumentRegistry(); const result = await registry.open(a, 1)
    if (result.status !== 'ok') throw new Error('fixture failed')
    const source = registry.current!; let blocked = false; let finish!: () => void; let shown!: () => void
    const ready = new Promise<void>(resolve => { shown = resolve })
    const originalOpen = registry.open.bind(registry)
    registry.open = async (...args) => { shown(); await new Promise<void>(resolve => { finish = resolve }); return originalOpen(...args) }
    const router = new LinkRouter(registry, {} as ResourceService, {
      blocked: () => blocked,
      external: async () => {}, directory: async () => '', reveal: () => {}
    })
    const pending = router.open(result.value, b, 1)
    await ready
    if (change === 'close') registry.release(source.document, 1)
    else if (change === 'reload') registry.reload(source, await readDocument(a))
    else if (change === 'migrate') registry.migrate(source, await readDocument(migrated))
    else blocked = true
    finish()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(registry.list(1)).toHaveLength(change === 'close' ? 0 : 1)
    expect(registry.list(1).some(session => session.document.displayName === 'b.md')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reports a missing out-of-root target without launching anything and refuses an unknown protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inknest-link-grant-'))
  try {
    const path = join(root, 'a.md'); await writeFile(path, '# A')
    const registry = new DocumentRegistry(); const source = await registry.open(path, 1)
    if (source.status !== 'ok') throw new Error('fixture failed')
    const launches: string[] = []
    const router = new LinkRouter(registry, {} as ResourceService, {
      blocked: () => false, external: async url => { launches.push(url) }, directory: async path => { launches.push(path); return '' }, reveal: path => { launches.push(path) }
    })
    expect(await router.open(source.value, '../not-present/secret.md', 1)).toMatchObject({ status: 'error' })
    expect(await router.open(source.value, 'javascript:alert(1)', 1)).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_TYPE' } })
    expect(launches).toEqual([])
    expect(registry.list(1)).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
