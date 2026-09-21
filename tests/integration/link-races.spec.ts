import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, writeFile, rm, realpath, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { LinkRouter } from '../../src/main/documents/link-router'
import type { ResourceService } from '../../src/main/security/resource-protocol'

const race = vi.hoisted(() => ({ path: '', checks: 0, interrupt: null as (() => void) | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    realpath: async (path: Parameters<typeof fs.realpath>[0]) => {
      const result = await fs.realpath(path)
      // Use the real filesystem result, then simulate a tab switch at the final
      // pending canonical-path syscall boundary, before control returns to router.
      if (path === race.path && ++race.checks === 2) race.interrupt?.()
      return result
    }
  }
})
afterEach(() => { race.path = ''; race.checks = 0; race.interrupt = null })

test.each(['report.pdf', 'attachment.txt', 'folder'])('does not dispatch %s if source changes during final identity verification', async name => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-link-final-race-')))
  try {
    const a = join(root, 'a.md'); const b = join(root, 'b.md')
    await writeFile(a, '# A'); await writeFile(b, '# B'); if (name === 'folder') await mkdir(join(root, name)); else await writeFile(join(root, name), 'fixture')
    const registry = new DocumentRegistry(); const source = await registry.open(a, 1); const other = await registry.open(b, 1)
    if (source.status !== 'ok' || other.status !== 'ok') throw new Error('fixture failed')
    registry.activate(source.value, 1)
    race.path = join(root, name); race.interrupt = () => { registry.activate(other.value, 1) }
    const dispatches: string[] = []
    const router = new LinkRouter(registry, {} as ResourceService, {
      blocked: () => false, 
      external: async url => { dispatches.push(url) }, directory: async path => { dispatches.push(path); return '' }, reveal: path => { dispatches.push(path) }
    })
    expect(await router.open(source.value, name, 1)).toEqual({ status: 'cancelled' })
    expect(dispatches).toEqual([])
    expect(registry.current?.document.docId).toBe(other.value.docId)
  } finally { await rm(root, { recursive: true, force: true }) }
})
