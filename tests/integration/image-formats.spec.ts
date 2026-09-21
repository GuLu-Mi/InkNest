import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { ResourceService } from '../../src/main/security/resource-protocol'

// Fixed 1x1 GIF; the second fixture repeats its image block to represent two frames.
const gif = Buffer.from('47494638396101000100800000000000ffffff21f90400000000002c00000000010001000002024401003b', 'hex')
let root: string
let registry: DocumentRegistry
let service: ResourceService
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-formats-')))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'a.md'), '# Images')
  registry = new DocumentRegistry(); await registry.open(join(root, 'docs', 'a.md'), 1)
  service = new ResourceService(registry, () => 1)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function resolve(name: string, bytes: Buffer) {
  await writeFile(join(root, 'docs', name), bytes)
  return (await service.resolve(registry.current!, [{ key: name, rawTarget: name }]))[0]!
}
test('serves GIF bytes with verified type and frame dimensions', async () => {
  const image = await resolve('still.gif', gif)
  expect(image.url).not.toBeNull()
  expect(image.metadata).toEqual({ mime: 'image/gif', width: 1, height: 1, orientation: 1, frames: 1 })
  const response = await service.respond(new Request(image.url!))
  expect(response.headers.get('content-type')).toBe('image/gif')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(gif)
})
test('rejects GIF bytes disguised as PNG and truncated GIF metadata', async () => {
  expect((await resolve('wrong.png', gif)).blockedReason).toBe('format')
  expect((await resolve('broken.gif', gif.subarray(0, 12))).blockedReason).toBe('format')
})
test('counts all animated GIF frames against 40 MP even when a single frame is small', async () => {
  const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(19, -1), Buffer.from([0x3b])])
  expect((await resolve('animated.gif', animated)).metadata?.frames).toBe(2)
  animated.writeUInt16LE(5000, 6); animated.writeUInt16LE(5000, 8)
  expect((await resolve('bomb.gif', animated)).blockedReason).toBe('size')
})
test('explicit selection grants one exact image and revokes its replaced identity', async () => {
  const path = join(root, 'selected.gif'); await writeFile(path, gif)
  const session = registry.current!
  const selected = await service.resolveFile(session, path)
  expect(selected.url).not.toBeNull()
  expect((await service.respond(new Request(selected.url!))).status).toBe(200)
  expect((await service.resolve(session, [{ key: 'escape', rawTarget: '../selected.gif' }]))[0]?.blockedReason).toBe('path')
  await rename(path, join(root, 'old.gif')); await writeFile(path, gif)
  expect((await service.respond(new Request(selected.url!))).status).toBe(404)
})
test('does not turn a selected image into directory authorization or accept symlink substitution', async () => {
  const path = join(root, 'selected.gif'); await writeFile(path, gif)
  const selected = await service.resolveFile(registry.current!, path)
  await rename(path, join(root, 'old.gif')); await symlink(join(root, 'old.gif'), path)
  expect((await service.respond(new Request(selected.url!))).status).toBe(404)
  registry.close()
  expect((await service.respond(new Request(selected.url!))).status).toBe(404)
})

test.each([
  ['two-by-three.png', 'image/png', 2, 3, 1, 1],
  ['two-by-three.jpg', 'image/jpeg', 2, 3, 1, 1],
  ['two-by-three.webp', 'image/webp', 2, 3, 1, 1],
  ['rotated.jpg', 'image/jpeg', 3, 2, 6, 1],
  ['animated.webp', 'image/webp', 1, 1, 1, 2]
])('serves verified %s metadata and original bytes', async (name, mime, width, height, orientation, frames) => {
  const bytes = await readFile(join(process.cwd(), 'tests/fixtures/images', String(name)))
  const result = await resolve(String(name), bytes)
  expect(result.metadata).toEqual({ mime, width, height, orientation, frames })
  const response = await service.respond(new Request(result.url!))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(mime)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect((await resolve(`truncated-${name}`, bytes.subarray(0, 12))).blockedReason).toBe('format')
})
test('shares the same resource and metadata read budget between inline resolution and linked viewer', async () => {
  const result = await resolve('shared.gif', gif)
  const session = registry.current!
  const readBytes = session.resourceBytes
  const linked = await service.resolveFile(session, join(root, 'docs', 'shared.gif'))
  expect(linked.url).toBe(result.url)
  expect(session.resourceBytes).toBe(readBytes)
  session.resourceBytes = 100 * 1024 * 1024
  expect((await service.resolveFile(session, join(root, 'docs', 'shared.gif'))).blockedReason).toBe('unavailable')
  expect((await service.respond(new Request(result.url!))).status).toBe(404)
})
test('revokes explicitly selected files on registry resource revocation', async () => {
  const selected = join(root, 'outside.gif'); await writeFile(selected, gif)
  const session = registry.current!
  const result = await service.resolveFile(session, selected)
  session.resources.clear()
  expect((await service.respond(new Request(result.url!))).status).toBe(404)
})

test.each(['two-by-three.png', 'two-by-three.jpg', 'two-by-three.webp'])('rejects truncated %s containers even when dimensions are readable', async (name) => {
  const bytes = await readFile(join(process.cwd(), 'tests/fixtures/images', name))
  expect((await resolve(name, bytes.subarray(0, -12))).blockedReason).toBe('format')
})
test('rejects APNG when its animation frame budget cannot be verified by the metadata provider', async () => {
  const png = await readFile(join(process.cwd(), 'tests/fixtures/images/two-by-three.png'))
  // Valid acTL chunk declaring two frames; remaining static payload cannot prove them safe.
  const control = Buffer.from('000000086163544c0000000200000000f38d9370', 'hex')
  const result = await resolve('animation.png', Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]))
  expect(result.blockedReason).toBe('format')
})

test('keeps the 2000-resource cap when concurrent image scans finish together', async () => {
  const session = registry.current!
  for (let index = 0; index < 1999; index++) session.resources.set(`occupied-${index}`, { path: join(root, `unused-${index}.gif`), dev: 0, ino: index })
  await writeFile(join(root, 'docs', 'a.gif'), gif); await writeFile(join(root, 'docs', 'b.gif'), gif)
  const results = await Promise.all(['a.gif', 'b.gif'].map((name) => service.resolve(session, [{ key: name, rawTarget: name }])))
  expect(results.flat().filter((result) => result.url)).toHaveLength(1)
  expect(session.resources.size).toBe(2000)
})
