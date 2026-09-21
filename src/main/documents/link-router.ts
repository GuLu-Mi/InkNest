import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { LinkOutcome, Result, SessionRef } from '../../shared/contracts'
import type { DocumentRegistry, DocumentSession } from './registry'
import type { ResourceService } from '../security/resource-protocol'
import { classifyLink } from './link-target'
import { fail, safeError } from './reader'
export interface LinkActions {
  external(url: string): Promise<void>
  directory(path: string): Promise<string>
  reveal(path: string): void
  blocked(): boolean
}
export class LinkRouter {
  constructor(private registry: DocumentRegistry, private resources: ResourceService, private actions: LinkActions) {}
  async open(ref: SessionRef, raw: string, ownerId: number): Promise<Result<LinkOutcome>> {
    const session = this.registry.get(ref, ownerId)
    if (!session) return { status: 'error', error: { code: 'STALE_SESSION', message: '来源文档已关闭或更新', retryable: false } }
    const sourcePath = session.path; const activation = this.registry.activationGeneration
    const current = () => this.registry.has(session) && session.path === sourcePath && this.registry.current === session && this.registry.activationGeneration === activation && !this.actions.blocked()
    try {
      if (!current()) return { status: 'cancelled' }
      const target = classifyLink(raw)
      if (target.kind === 'anchor') return { status: 'ok', value: target }
      if (target.kind === 'external') { await this.actions.external(target.url); return { status: 'ok', value: { kind: 'dispatched' } } }
      const candidate = isAbsolute(target.path) ? target.path : session.root ? resolve(session.root, target.path) : ''
      if (!candidate) fail('ACCESS_DENIED', '请先保存文档，再打开相对链接')
      // An explicit gesture grants this target only; passive resource roots do not change.
      const path = await realpath(candidate)
      if (!current()) return { status: 'cancelled' }
      const info = await stat(path)
      if (!current()) return { status: 'cancelled' }
      if (!info.isDirectory() && !info.isFile()) fail('UNSUPPORTED_TYPE', '此链接不是普通文件')
      const extension = extname(path).toLowerCase()
      if (info.isFile() && (extension === '.md' || extension === '.markdown')) {
        const result = await this.registry.open(path, ownerId, current, { activate: false, expected: { path, dev: info.dev, ino: info.ino } })
        return result.status === 'ok' ? { status: 'ok', value: { kind: 'document', document: result.value, fragment: target.fragment } } : result
      }
      if (info.isFile() && ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
        const resource = await this.image(session, path)
        if (!current()) return { status: 'cancelled' }
        if (!resource.url) fail(resource.blockedReason === 'size' ? 'TOO_LARGE' : 'UNSUPPORTED_TYPE', resource.blockedReason === 'size' ? '图片超过大小或像素限制' : '图片无法读取或格式不受支持')
        return { status: 'ok', value: { kind: 'image', url: resource.url, label: basename(path) } }
      }
      const latest = await stat(path)
      if (!current()) return { status: 'cancelled' }
      if (await realpath(path) !== path || latest.dev !== info.dev || latest.ino !== info.ino) fail('ACCESS_DENIED', '链接目标已变化，请重新打开')
      if (!current()) return { status: 'cancelled' }
      if (info.isDirectory()) { const error = await this.actions.directory(path); if (error) fail('IO_ERROR', '系统文件管理器无法打开此文件夹') }
      else this.actions.reveal(path)
      return { status: 'ok', value: { kind: 'dispatched' } }
    } catch (error) { return { status: 'error', error: safeError(error) } }
  }
  private image(session: DocumentSession, path: string) { return this.resources.resolveFile(session, path) }
}
