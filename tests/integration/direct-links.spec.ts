import { expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { LinkRouter } from '../../src/main/documents/link-router'
import { ResourceService } from '../../src/main/security/resource-protocol'

test('explicit links open parent Markdown directly, reveal attachments and open directories without a picker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-direct-links-')))
  try {
    await mkdir(join(root, 'docs')); await mkdir(join(root, 'data'))
    await writeFile(join(root, 'docs/compatibility.md'), '[使用指南](../GETTING_STARTED.md)')
    await writeFile(join(root, 'GETTING_STARTED.md'), '# 使用指南')
    await writeFile(join(root, 'data/android-app-labels.json'), '{}')
    await writeFile(join(root, 'report.pdf'), 'fixture')
    const registry = new DocumentRegistry(); const opened = await registry.open(join(root, 'docs/compatibility.md'), 1)
    if (opened.status !== 'ok') throw new Error('fixture')
    const calls: string[] = []
    const resources = new ResourceService(registry, () => 1)
    const router = new LinkRouter(registry, resources, {
      blocked: () => false, external: async () => {},
      directory: async (path: string) => { calls.push(`directory:${path}`); return '' }, reveal: (path: string) => { calls.push(`reveal:${path}`) }
    })
    expect(await router.open(opened.value, '../GETTING_STARTED.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'document', document: { displayName: 'GETTING_STARTED.md' } } })
    expect(await router.open(opened.value, join(root, 'data/android-app-labels.json'), 1)).toMatchObject({ status: 'ok', value: { kind: 'dispatched' } })
    expect(await router.open(opened.value, '../data', 1)).toMatchObject({ status: 'ok' })
    expect(await router.open(opened.value, '../report.pdf', 1)).toMatchObject({ status: 'ok' })
    expect(calls).toEqual([`reveal:${root}/data/android-app-labels.json`, `directory:${root}/data`, `reveal:${root}/report.pdf`])
    expect(await router.open(opened.value, '../missing.md', 1)).toMatchObject({ status: 'error' })
    expect(registry.current?.document.docId).toBe(opened.value.docId)
    expect(await router.open(opened.value, pathToFileURL(join(root, 'GETTING_STARTED.md')).href, 1)).toMatchObject({ status: 'ok', value: { kind: 'document' } })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(root, 'one.png'), png); await writeFile(join(root, 'two.png'), png)
    const image = await router.open(opened.value, '../one.png', 1)
    expect(image).toMatchObject({ status: 'ok', value: { kind: 'image' } })
    if (image.status !== 'ok' || image.value.kind !== 'image') throw new Error('expected image')
    expect((await resources.respond(new Request(image.value.url))).status).toBe(200)
    const passive = await resources.resolve(registry.current!, [{ key: 'one', rawTarget: '../one.png' }, { key: 'two', rawTarget: '../two.png' }])
    expect(passive.every(item => !item.url)).toBe(true)
    expect(registry.current!.root).toBe(join(root, 'docs'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
