import { copy } from '../../shared/copy'
import { basename, dirname } from 'node:path'
import type { VerifiedRecovery } from './recovery-store'
import { randomUUID } from 'node:crypto'
import type { ContentSnapshot, DiskStatus, HistoryCommit, OpenDocument, Result, SessionRef } from '../../shared/contracts'
import { fail, readDocument, safeError } from './reader'
import type { Candidate } from './reader'

export interface DocumentSession extends Omit<Candidate, 'document' | 'rawBytes'> {
  historyAttention?: HistoryCommit | null
  recoveryPending?: boolean
  recoveryRevision?: number
  diskStatus?: DiskStatus
  latestSnapshot?: ContentSnapshot
  ownerId: number
  document: OpenDocument
  resources: Map<string, { path: string; dev: number; ino: number }>
  resourceBytes: number
}
export function hasFile(session: DocumentSession): boolean { return !!session.document.displayPath && !!session.path }
function retained(candidate: Candidate): Omit<Candidate, 'rawBytes'> { return { path: candidate.path, root: candidate.root, fingerprint: candidate.fingerprint, document: candidate.document } }
function identity(candidate: Candidate | DocumentSession): string {
  return `${candidate.fingerprint.dev}:${candidate.fingerprint.ino}`
}
export class DocumentRegistry {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly paths = new Map<string, DocumentSession>()
  private readonly identities = new Map<string, DocumentSession>()
  private active: SessionRef | null = null
  private activationVersion = 0
  get activationGeneration(): number { return this.activationVersion }
  private readonly writes = new Map<string, Promise<void>>()
  private writeVersion = 0
  private untitledNumber = 0
  private lastDirectory: string | null = null
  get suggestedDirectory(): string | null { return this.lastDirectory }
  private untitledName(): string { return `未命名-${++this.untitledNumber}` }
  create(ownerId: number): Result<OpenDocument> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return { status: 'error', error: { code: 'INVALID_REQUEST', message: copy.invalidWindow, retryable: false } }
    if (this.list(ownerId).length >= 20) return { status: 'error', error: { code: 'TAB_LIMIT', message: copy.tabLimit, retryable: true } }
    const document: OpenDocument = { docId: randomUUID(), epoch: randomUUID(), displayName: this.untitledName(), displayPath: null, text: '', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: null, readOnlyReason: null, recovered: false, readingPosition: null }
    const session: DocumentSession = { document, ownerId, path: '', root: '', fingerprint: { sha256: '', dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 }, diskStatus: 'current', resources: new Map(), resourceBytes: 0 }
    this.sessions.set(document.docId, session)
    this.activate(document, ownerId)
    return { status: 'ok', value: document }
  }

  get current(): DocumentSession | null {
    return this.active ? this.sessions.get(this.active.docId) ?? null : null
  }
  get(ref: SessionRef, ownerId: number): DocumentSession | undefined {
    const session = this.sessions.get(ref.docId)
    return session?.ownerId === ownerId && session.document.epoch === ref.epoch ? session : undefined
  }
  has(session: DocumentSession): boolean { return this.sessions.get(session.document.docId) === session }
  list(ownerId: number): readonly DocumentSession[] { return [...this.sessions.values()].filter((session) => session.ownerId === ownerId) }
  matches(ref: SessionRef, ownerId: number): boolean { return this.get(ref, ownerId) !== undefined }
  activate(ref: SessionRef, ownerId: number): boolean {
    if (!this.get(ref, ownerId)) return false
    this.activationVersion++
    this.active = { docId: ref.docId, epoch: ref.epoch }
    return true
  }
  release(ref: SessionRef, ownerId: number): boolean {
    const session = this.get(ref, ownerId)
    if (!session) return false
    this.activationVersion++
    session.resources.clear()
    this.sessions.delete(ref.docId)
    if (this.paths.get(session.path) === session) this.paths.delete(session.path)
    if (this.identities.get(identity(session)) === session) this.identities.delete(identity(session))
    if (this.active?.docId === ref.docId) {
      const next = this.list(ownerId).at(-1)
      this.active = next ? { docId: next.document.docId, epoch: next.document.epoch } : null
    }
    return true
  }
  close(): void {
    for (const session of this.sessions.values()) this.release(session.document, session.ownerId)
    this.active = null
    this.untitledNumber = 0; this.lastDirectory = null
  }
  findCandidate(candidate: Candidate, ownerId: number): DocumentSession | undefined {
    const byPath = this.paths.get(candidate.path)
    const byIdentity = this.identities.get(identity(candidate))
    if (byPath && byIdentity && byPath !== byIdentity) fail('TARGET_OPEN', copy.targetOpen)
    const existing = byPath ?? byIdentity
    if (existing && existing.ownerId !== ownerId) fail('TARGET_OPEN', copy.targetOtherWindow)
    return existing
  }
  updateFingerprint(session: DocumentSession, fingerprint: Candidate['fingerprint']): void {
    if (!this.has(session)) fail('STALE_SESSION', copy.staleSession)
    const key = `${fingerprint.dev}:${fingerprint.ino}`
    const existing = this.identities.get(key)
    if (existing && existing !== session) fail('TARGET_OPEN', copy.targetAlreadyOpen)
    if (this.identities.get(identity(session)) === session) this.identities.delete(identity(session))
    session.fingerprint = fingerprint
    this.identities.set(key, session)
  }
  // Keep path serialization in the registry so even separate coordinators cannot write one target concurrently.
  serializeWrite<T>(session: DocumentSession, operation: () => Promise<T>, targetPath = session.path): Promise<T> {
    this.writeVersion++
    const paths = [...new Set([session.path, targetPath].filter(Boolean))]
    const result = Promise.all(paths.map(path => this.writes.get(path))).then(operation)
    const settled = result.then(() => {}, () => {})
    for (const path of paths) this.writes.set(path, settled)
    void settled.then(() => { for (const path of paths) if (this.writes.get(path) === settled) this.writes.delete(path) })
    return result
  }
  // Admission waits outside any recovery lock: writers may await recovery maintenance.
  async waitForWrites(): Promise<number> {
    for (;;) {
      const version = this.writeVersion
      await Promise.all(this.writes.values())
      if (this.isWriteVersionCurrent(version)) return version
    }
  }
  isWriteVersionCurrent(version: number): boolean { return version === this.writeVersion && this.writes.size === 0 }
  findPath(path: string): DocumentSession | undefined { return this.paths.get(path) }
  migrate(session: DocumentSession, candidate: Candidate): void {
    const existing = this.findCandidate(candidate, session.ownerId)
    if (existing && existing !== session) fail('TARGET_OPEN', copy.targetAlreadyOpen)
    this.updateFingerprint(session, candidate.fingerprint)
    if (this.paths.get(session.path) === session) this.paths.delete(session.path)
    session.path = candidate.path; session.root = candidate.root
    this.lastDirectory = candidate.root
    this.paths.set(session.path, session)
    session.resources.clear()
  }
  reload(session: DocumentSession, candidate: Candidate): OpenDocument {
    const active = this.active?.docId === session.document.docId
    this.migrate(session, candidate)
    const document = { ...candidate.document, docId: session.document.docId, epoch: randomUUID() }
    const replacement: DocumentSession = { ...retained(candidate), document, ownerId: session.ownerId, resources: new Map(), resourceBytes: 0, diskStatus: 'current' }
    this.sessions.set(document.docId, replacement); this.paths.set(candidate.path, replacement); this.identities.set(identity(candidate), replacement)
    if (active) this.active = { docId: document.docId, epoch: document.epoch }
    return document
  }
  registerRecovery(recovery: VerifiedRecovery, ownerId: number, candidate: Candidate | null, diskStatus: DiskStatus, writeVersion: number): OpenDocument {
    if (!this.isWriteVersionCurrent(writeVersion)) fail('FILE_BUSY', copy.recoveryDuringSave)
    if (this.list(ownerId).length >= 20) fail('TAB_LIMIT', copy.recoveryTabLimit)
    const path = recovery.manifest.originalPath ?? ''
    const existing = candidate ? this.findCandidate(candidate, ownerId) : path ? this.findPath(path) : undefined
    if (existing) { this.activate(existing.document, ownerId); fail('TARGET_OPEN', copy.originalAlreadyOpen) }
    const document: OpenDocument = { docId: randomUUID(), epoch: randomUUID(), displayName: path ? basename(path) : this.untitledName(), displayPath: path || null, text: candidate?.document.text ?? '', revision: recovery.revision, format: recovery.manifest.format, diskToken: path ? recovery.manifest.baseDiskToken : null, readOnlyReason: null, recovered: true, readingPosition: null }
    const session: DocumentSession = { path, root: path ? dirname(path) : '', fingerprint: candidate?.fingerprint ?? { sha256: '', dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 }, document, ownerId, diskStatus, recoveryPending: true, recoveryRevision: recovery.revision, latestSnapshot: { docId: document.docId, epoch: document.epoch, revision: recovery.revision, text: recovery.text }, resources: new Map(), resourceBytes: 0 }
    if (!path) session.diskStatus = 'current'
    this.sessions.set(document.docId, session)
    if (path) this.paths.set(path, session)
    if (candidate) this.identities.set(identity(candidate), session)
    this.activate(document, ownerId)
    return { ...document, text: recovery.text }
  }
  async open(path: string, ownerId: number, admitted: () => boolean = () => true, options: { activate?: boolean; expected?: { path: string; dev: number; ino: number } } = {}): Promise<Result<OpenDocument>> {
    try {
      if (!Number.isSafeInteger(ownerId) || ownerId <= 0) fail('INVALID_REQUEST', copy.invalidWindow)
      for (;;) {
        // A replacement's new inode must be published before an alias can create another session.
        const version = await this.waitForWrites()
        if (!admitted()) return { status: 'cancelled' }
        const candidate = await readDocument(path, options.expected)
        if (!admitted()) return { status: 'cancelled' }
        if (!this.isWriteVersionCurrent(version)) continue
        const existing = this.findCandidate(candidate, ownerId)
        if (existing) {
          this.lastDirectory = candidate.root
          if (options.activate !== false) this.activate(existing.document, ownerId)
          return { status: 'ok', value: existing.document }
        }
        if (this.list(ownerId).length >= 20) fail('TAB_LIMIT', copy.tabLimit)
        const document = { ...candidate.document, docId: randomUUID(), epoch: randomUUID() }
        const session = { ...retained(candidate), document, ownerId, resources: new Map(), resourceBytes: 0 }
        this.sessions.set(document.docId, session)
        this.paths.set(candidate.path, session)
        this.identities.set(identity(candidate), session)
        this.lastDirectory = candidate.root
        if (options.activate !== false) this.activate(document, ownerId)
        return { status: 'ok', value: document }
      }
    } catch (error) { return { status: 'error', error: safeError(error) } }
  }
}
