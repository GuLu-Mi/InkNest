import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { ResourceReference, ResolvedResource, ResourceBlockedReason } from '../../shared/contracts'
import { DocumentRegistry } from '../documents/registry'
import type { DocumentSession } from '../documents/registry'
import { readBounded, sameVersion } from '../documents/reader'
import { openAuthorized, openAuthorizedFile, resolveImagePath, ResourceFailure } from './path-grants'
import { MAX_IMAGE_BYTES, validateImageMetadata } from './image-metadata'
import type { ImageMetadata } from './image-metadata'

const SESSION_BUDGET = 100 * 1024 * 1024
const UUID = '[a-f0-9-]{36}'
const RESOURCE_URL = new RegExp(`^inknest-resource://(${UUID})/(${UUID})/(${UUID})$`)
export function isResourceUrl(url: string): boolean { return RESOURCE_URL.test(url) }
function reserve(session: DocumentSession, bytes: number): void {
  if (session.resourceBytes + bytes > SESSION_BUDGET) throw new ResourceFailure('unavailable')
  session.resourceBytes += bytes
}
function blockedReason(error: unknown): ResourceBlockedReason {
  if (error instanceof ResourceFailure) return error.reason
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return 'access'
  return 'unavailable'
}
export class ResourceService {
  // Weak object capabilities disappear with registry resource revocation; no directory grant
  // or separate long-lived map of paths survives close/epoch/save-as transitions.
  private readonly selectedFiles = new WeakSet<object>()
  private readonly metadata = new WeakMap<object, { stats: Stats; value: ImageMetadata }>()
  constructor(private readonly registry: DocumentRegistry, private readonly ownerId: () => number) {}
  async resolve(session: DocumentSession, refs: ResourceReference[]): Promise<ResolvedResource[]> {
    const results: ResolvedResource[] = []
    for (const ref of refs) {
      try {
        if (!session.document.displayPath) throw new ResourceFailure(/^https?:\/\//iu.test(ref.rawTarget) ? 'remote' : 'unsaved')
        const path = await resolveImagePath(session.root, ref.rawTarget)
        results.push(await this.register(session, path, ref.key, false))
      } catch (error) { results.push({ key: ref.key, url: null, blockedReason: blockedReason(error) }) }
    }
    return results
  }
  // The link router calls this only after an explicit link gesture authorizes this single target.
  async resolveFile(session: DocumentSession, absolutePath: string, key = 'linked-image'): Promise<ResolvedResource> {
    try { return await this.register(session, absolutePath, key, true) }
    catch (error) { return { key, url: null, blockedReason: blockedReason(error) } }
  }
  private async register(session: DocumentSession, path: string, key: string, selected: boolean): Promise<ResolvedResource> {
    if (!this.registry.has(session) || session.resourceBytes >= SESSION_BUDGET) throw new ResourceFailure('unavailable')
    const root = session.root
    const sourcePath = session.path
    const { handle, stats } = await (selected ? openAuthorizedFile(path) : openAuthorized(root, path))
    try {
      if (stats.size > MAX_IMAGE_BYTES) throw new ResourceFailure('size')
      const existing = [...session.resources].find(([, entry]) => entry.path === path && entry.dev === stats.dev && entry.ino === stats.ino)
      if (!existing && session.resources.size >= 2000) throw new ResourceFailure('unavailable')
      const cached = existing && this.metadata.get(existing[1])
      let value: ImageMetadata
      if (cached && sameVersion(cached.stats, stats)) value = cached.value
      else {
        reserve(session, stats.size + 1)
        value = await validateImageMetadata(await readBounded(handle, stats.size, MAX_IMAGE_BYTES), path)
      }
      if (!sameVersion(stats, await handle.stat()) || !this.registry.has(session) || session.root !== root || session.path !== sourcePath) throw new ResourceFailure('unavailable')
      // No await between the final cap/dedup check and installation: metadata scans
      // for separate preview surfaces can complete concurrently.
      const current = [...session.resources].find(([, entry]) => entry.path === path && entry.dev === stats.dev && entry.ino === stats.ino)
      if (!current && session.resources.size >= 2000) throw new ResourceFailure('unavailable')
      const id = current?.[0] ?? randomUUID()
      const entry = current?.[1] ?? { path, dev: stats.dev, ino: stats.ino }
      session.resources.set(id, entry)
      if (selected) this.selectedFiles.add(entry)
      this.metadata.set(entry, { stats, value })
      return { key, url: `inknest-resource://${session.document.docId}/${session.document.epoch}/${id}`, blockedReason: null, metadata: value }
    } finally { await handle.close() }
  }
  async respond(request: Request): Promise<Response> {
    try {
      const parts = RESOURCE_URL.exec(request.url)
      const session = parts ? this.registry.get({ docId: parts[1]!, epoch: parts[2]! }, this.ownerId()) : undefined
      if (request.method !== 'GET' || !parts || !session || parts[1] !== session.document.docId) throw new Error('Invalid resource')
      const resource = session.resources.get(parts[3]!)
      if (!resource) throw new Error('Unknown resource')
      const root = session.root
      const { handle, stats } = await (this.selectedFiles.has(resource) ? openAuthorizedFile(resource.path, resource) : openAuthorized(root, resource.path, resource))
      try {
        if (stats.size > MAX_IMAGE_BYTES) throw new ResourceFailure('size')
        reserve(session, stats.size + 1)
        const bytes = await readBounded(handle, stats.size, MAX_IMAGE_BYTES)
        const metadata = await validateImageMetadata(bytes, resource.path)
        if (!this.registry.has(session) || session.root !== root || session.resources.get(parts[3]!) !== resource || !sameVersion(stats, await handle.stat())) throw new Error('Changed resource')
        return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': metadata.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
      } finally { await handle.close() }
    } catch { return new Response(null, { status: 404 }) }
  }
}
