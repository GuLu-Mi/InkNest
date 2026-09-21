import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { ResourceService } from '../../src/main/security/resource-protocol'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=', 'base64')
let root: string
let registry: DocumentRegistry
let resources: ResourceService
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inknest-resource-')); await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', '中文.md'), '# Hi')
  await writeFile(join(root, 'docs', '图片.png'), png); await writeFile(join(root, 'secret.png'), png)
  registry = new DocumentRegistry(); await registry.open(join(root, 'docs', '中文.md'), 1)
  resources = new ResourceService(registry, () => 1)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function resolve(rawTarget: string) {
  return (await resources.resolve(registry.current!, [{ key: 'img', rawTarget }]))[0]!
}
test('reads authorized PNG through an opaque resource URL and revokes old IDs', async () => {
  const result = await resolve('%E5%9B%BE%E7%89%87.png')
  expect(result.url).toMatch(/^inknest-resource:\/\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/)
  const response = await resources.respond(new Request(result.url!))
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  registry.close()
  expect((await resources.respond(new Request(result.url!))).status).toBe(404)
})
test('rejects traversal, schemes, malformed encodings, symlink escapes and fake IDs', async () => {
  await symlink(join(root, 'secret.png'), join(root, 'docs', 'escape.png'))
  for (const target of ['../secret.png', '%2e%2e/secret.png', '%252e%252e/secret.png', 'escape.png', '/etc/test.png', 'https://example.invalid/track.png', 'file:///etc/test.png', 'data:image/png;base64,abc', '//server/a.png', 'x%00.png', '%ZZ', 'missing.png']) {
    expect((await resolve(target)).url, target).toBeNull()
  }
  expect((await resources.respond(new Request('inknest-resource://fake/fake'))).status).toBe(404)
})
test('rejects disguised images, oversized pixels and files; revalidates identity before reading', async () => {
  await writeFile(join(root, 'docs', 'fake.png'), '<svg/>')
  expect((await resolve('fake.png')).url).toBeNull()
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(1000, 20)
  await writeFile(join(root, 'docs', 'pixels.png'), huge)
  expect((await resolve('pixels.png')).url).toBeNull()
  await writeFile(join(root, 'docs', 'large.png'), Buffer.alloc(20 * 1024 * 1024 + 1))
  expect((await resolve('large.png')).url).toBeNull()
  const authorized = await resolve('图片.png')
  await rm(join(root, 'docs', '图片.png')); await symlink(join(root, 'secret.png'), join(root, 'docs', '图片.png'))
  expect((await resources.respond(new Request(authorized.url!))).status).toBe(404)
})
test('enforces the cumulative 100 MiB session read budget', async () => {
  const large = Buffer.alloc(20 * 1024 * 1024); png.copy(large)
  await writeFile(join(root, 'docs', 'budget.png'), large)
  const result = await resolve('budget.png')
  let allowed = 0
  for (let index = 0; index < 6; index++) {
    const response = await resources.respond(new Request(result.url!))
    if (response.status === 200) { await response.arrayBuffer(); allowed++ }
  }
  // Initial bounded metadata scan plus three 20 MiB responses fit; a fourth cannot.
  expect(allowed).toBe(3)
  expect(registry.current!.resourceBytes).toBeLessThanOrEqual(100 * 1024 * 1024)
})

test('handles encoded Chinese, spaces, hashes and percent signs as filenames', async () => {
  await writeFile(join(root, 'docs', '中文 空格#%.png'), png)
  const result = await resolve('%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%23%25.png')
  expect(result.url).not.toBeNull()
  expect((await resources.respond(new Request(result.url!))).status).toBe(200)
})

test('reuses a live resource URL and rejects stale epoch or another owner', async () => {
  const first = await resolve('图片.png'); const second = await resolve('图片.png')
  expect(first.url).toBe(second.url)
  const ref = registry.current!.document
  expect(registry.matches(ref, 2)).toBe(false)
  expect(registry.matches({ ...ref, epoch: '00000000-0000-0000-0000-000000000000' }, 1)).toBe(false)
})

test('reuses authorized identity at the 2000-resource cap while rejecting new and replaced identities', async () => {
  const first = await resolve('图片.png')
  const session = registry.current!
  for (let index = 1; index < 2000; index++) {
    session.resources.set(`occupied-${index}`, { path: join(root, `unused-${index}.png`), dev: 0, ino: index })
  }
  expect(session.resources.size).toBe(2000)
  expect((await resolve('图片.png')).url).toBe(first.url)
  expect(session.resourceBytes).toBe(png.length + 1)
  await writeFile(join(root, 'docs', 'new.png'), png)
  expect((await resolve('new.png')).url).toBeNull()
  await rename(join(root, 'docs', '图片.png'), join(root, 'docs', 'old.png'))
  await writeFile(join(root, 'docs', '图片.png'), png)
  expect((await resolve('图片.png')).url).toBeNull()
  expect((await resources.respond(new Request(first.url!))).status).toBe(404)
  expect(session.resources.size).toBe(2000)
  session.resources.delete('occupied-1')
  const replaced = await resolve('图片.png')
  expect(replaced.url).not.toBeNull()
  expect(replaced.url).not.toBe(first.url)
  expect(session.resources.size).toBe(2000)
  session.resourceBytes = 100 * 1024 * 1024
  expect((await resolve('图片.png')).url).toBeNull()
})


test('serves background resources by complete ref and revokes only the released document', async () => {
  const a = registry.current!
  const first = await resolve('图片.png')
  await writeFile(join(root, 'docs', 'b.md'), 'b')
  await registry.open(join(root, 'docs', 'b.md'), 1)
  const b = registry.current!
  const second = await resolve('图片.png')
  expect((await resources.respond(new Request(first.url!))).status).toBe(200)
  expect((await resources.resolve(a, [{ key: 'background', rawTarget: '图片.png' }]))[0]?.url).toBe(first.url)
  const aId = new URL(first.url!).pathname.split('/').at(-1)!
  expect((await resources.respond(new Request(`inknest-resource://${b.document.docId}/${b.document.epoch}/${aId}`))).status).toBe(404)
  expect((await resources.respond(new Request(first.url!.replace(a.document.epoch, b.document.epoch)))).status).toBe(404)
  expect(registry.release(a.document, 1)).toBe(true)
  expect(a.resources.size).toBe(0)
  expect((await resources.respond(new Request(first.url!))).status).toBe(404)
  expect((await resources.respond(new Request(second.url!))).status).toBe(200)
  expect((await resources.resolve(a, [{ key: 'old', rawTarget: '图片.png' }]))[0]?.url).toBeNull()
})

test('classifies blocked resources by verified cause without exposing paths or technical limits', async () => {
  await writeFile(join(root, 'docs', 'fake.png'), '<svg/>')
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(1000, 20)
  await writeFile(join(root, 'docs', 'pixels.png'), huge)
  await symlink(join(root, 'secret.png'), join(root, 'docs', 'escape.png'))
  for (const [target, reason] of [
    ['missing.png', 'missing'], ['../secret.png', 'path'], ['escape.png', 'path'], ['%ZZ', 'access'],
    ['https://example.invalid/image.png', 'remote'], ['//example.invalid/image.png', 'remote'],
    ['file:///private/image.png', 'path'], ['image.svg', 'format'], ['fake.png', 'format'], ['pixels.png', 'size']
  ]) expect(await resolve(target!)).toEqual({ key: 'img', url: null, blockedReason: reason })
  registry.current!.resourceBytes = 100 * 1024 * 1024
  expect((await resolve('图片.png')).blockedReason).toBe('unavailable')
  const expired = registry.current!; registry.close()
  expect((await resources.resolve(expired, [{ key: 'expired', rawTarget: '图片.png' }]))[0]?.blockedReason).toBe('unavailable')
})


test('diagnoses malformed image titles before path policy, without granting or reading external files', async () => {
  const session = registry.current!
  for (const target of ['/Users/example/IMG.PNG%20%22示例%22', 'image.png%20%22title%22']) {
    expect((await resolve(target)).blockedReason).toBe('syntax')
  }
  expect((await resolve(join(root, 'secret.png'))).blockedReason).toBe('path')
  expect(session.resources.size).toBe(0); expect(session.resourceBytes).toBe(0)
  await writeFile(join(root, 'docs', 'UPPER.PNG'), png)
  expect((await resolve('UPPER.PNG')).url).not.toBeNull()
})
