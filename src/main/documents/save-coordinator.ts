import { copy } from '../../shared/copy'
import { basename, dirname, extname, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { AppError, ContentSnapshot, HistoryCommit, HistoryRestoreRequest, HistoryRestoreResult, Result, SaveReceipt, SaveRequest, TextFormat } from '../../shared/contracts'
import { EDITABLE_DOCUMENT_MAX_BYTES } from '../../shared/limits'
import { restoreHistoryTransaction } from './history-restore'
import { validHistoryRestoreArgs, validSaveArgs } from '../ipc/validation'
import { atomicWrite, type AtomicWriter } from './atomic-writer'
import { encodeUtf8 } from './codec'
import type { HistoryStore, HistoryProtection, HistoryWriteContext } from './history-store'
import type { RecoveryStore } from './recovery-store'
import { fail, FileFailure, readDocument } from './reader'
import type { DocumentRegistry, DocumentSession } from './registry'

interface RequestEntry {
  kind: 'save' | 'restore'
  payloadHash: string
  result: Promise<Result<SaveReceipt> | HistoryRestoreResult>
  expectedToken: string | null
  completed: boolean
  proof: boolean
  chain: number
}
interface AutoSlot { execute: () => Promise<Result<SaveReceipt>>; cancel: () => void }
interface Queue {
  restoring: boolean
  chain: number
  generation: number
  tail: Promise<void>
  tokens: Set<string>
  requests: Map<string, RequestEntry>
  autoWaiting: AutoSlot | null
  barriers: number
}
function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function restorePayloadHash(request: HistoryRestoreRequest): string {
  return hash(JSON.stringify(['restore', request.snapshot.docId, request.snapshot.epoch, request.snapshot.revision, request.snapshot.text, request.expectedDiskToken, request.historyId, request.expectedContentHash]))
}
export function validSnapshotText(snapshot: ContentSnapshot, format: TextFormat): boolean {
  return !snapshot.text.includes('\r') && Buffer.from(snapshot.text, 'utf8').toString('utf8') === snapshot.text && encodeUtf8(snapshot.text, format).byteLength <= EDITABLE_DOCUMENT_MAX_BYTES
}
export function saveError(error: unknown): AppError {
  if (error instanceof FileFailure) return error.appError
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return { code: 'NOT_FOUND', message: copy.saveMissing, retryable: true }
  if (code === 'ENOSPC' || code === 'EDQUOT') return { code: 'DISK_FULL', message: copy.saveDiskFull, retryable: true }
  if (code === 'EACCES' || code === 'EPERM') return { code: 'ACCESS_DENIED', message: copy.saveDenied, retryable: true }
  if (code === 'EBUSY' || code === 'ETXTBSY') return { code: 'FILE_BUSY', message: copy.saveBusy, retryable: true }
  return { code: 'IO_ERROR', message: copy.saveUnconfirmed, retryable: true }
}
export interface BackupHooks { history?: Pick<HistoryStore, 'protectBeforeWrite' | 'recordSaved'>; recovery?: Pick<RecoveryStore, 'afterSave'>; confirmWithoutHistory?: (name: string) => Promise<boolean>; maintenanceFailed?: (session: DocumentSession) => void }
export class SaveCoordinator {
  private readonly queues = new WeakMap<DocumentSession, Queue>()
  constructor(private readonly registry: DocumentRegistry, private readonly write: AtomicWriter = atomicWrite, private readonly backups: BackupHooks = {}) {}
  private queue(session: DocumentSession): Queue {
    let queue = this.queues.get(session)
    if (!queue) { queue = { restoring: false, chain: 0, generation: 0, tail: Promise.resolve(), tokens: new Set([session.document.diskToken!]), requests: new Map(), autoWaiting: null, barriers: 0 }; this.queues.set(session, queue) }
    return queue
  }
  async settle(session: DocumentSession): Promise<void> { await this.queue(session).tail }
  // Lifecycle barriers share the session queue. Version changes cancel waiting saves,
  // while an already executing atomic replacement is always allowed to settle.
  barrier<T>(session: DocumentSession, operation: () => Promise<T>, cancelPending = false): Promise<T> {
    this.assertAvailable(session)
    return this.enqueueBarrier(session, operation, cancelPending)
  }
  isRestoring(session: DocumentSession): boolean { return this.queue(session).restoring }
  assertAvailable(session: DocumentSession): void { if (this.isRestoring(session)) fail('FILE_BUSY', copy.processingWait) }
  private enqueueBarrier<T>(session: DocumentSession, operation: () => Promise<T>, cancelPending = false): Promise<T> {
    const queue = this.queue(session)
    queue.barriers++
    if (cancelPending) queue.generation++
    const result = queue.tail.then(() => {
      if (!this.registry.has(session)) fail('STALE_SESSION', copy.staleSession)
      return operation()
    })
    const settled = result.finally(() => { queue.barriers-- })
    queue.tail = settled.then(() => {}, () => {})
    return settled
  }
  save(input: SaveRequest, ownerId: number): Promise<Result<SaveReceipt>> {
    return this.submit(input, ownerId)
  }
  saveAs(input: SaveRequest, ownerId: number, choose: () => Promise<string | null>, confirm: (kind: 'replace' | 'directory', name: string) => Promise<boolean>): Promise<Result<SaveReceipt>> {
    return this.submit(input, ownerId, { choose, confirm })
  }
  private submit(input: SaveRequest, ownerId: number, destination?: { choose: () => Promise<string | null>; confirm: (kind: 'replace' | 'directory', name: string) => Promise<boolean> }): Promise<Result<SaveReceipt>> {
    try {
      if (!validSaveArgs([input])) fail('INVALID_REQUEST', copy.invalidSave)
      const session = this.registry.get(input.snapshot, ownerId)
      if (!session) fail('STALE_SESSION', copy.staleSession)
      const document = session.document
      const readonlyCopy = !!destination && (document.readOnlyReason === 'link' || document.readOnlyReason === 'permission')
      if (document.readOnlyReason && !readonlyCopy || !document.format) fail('READ_ONLY', copy.readOnlyDocument)
      if (readonlyCopy && (input.snapshot.text !== document.text || input.snapshot.revision !== document.revision)) fail('INVALID_REQUEST', copy.readOnlyCopy)
      const queue = this.queue(session)
      const request = { ...input, snapshot: { ...input.snapshot } }
      const payloadHash = hash(JSON.stringify(['save', request.snapshot.docId, request.snapshot.epoch, request.snapshot.revision, request.snapshot.text, request.expectedDiskToken, request.trigger, !!destination]))
      const duplicate = queue.requests.get(request.requestId)
      if (duplicate) {
        if (duplicate.kind !== 'save' || duplicate.payloadHash !== payloadHash) fail('INVALID_REQUEST', copy.duplicateSave)
        return duplicate.result as Promise<Result<SaveReceipt>>
      }
      this.assertAvailable(session)
      if (!destination && !document.displayPath) fail('INVALID_REQUEST', copy.initialSaveRequired)
      if (!validSnapshotText(request.snapshot, document.format)) fail('INVALID_REQUEST', copy.invalidSaveText)
      const previous = session.latestSnapshot ?? document
      if (request.snapshot.revision < previous.revision || request.snapshot.revision === previous.revision && request.snapshot.text !== previous.text) fail('STALE_REVISION', copy.staleSave)
      if (request.trigger === 'auto' && session.historyAttention) fail('HISTORY_FAILED', copy.historySavedFailed)
      if (request.trigger === 'auto' && (destination || queue.barriers || session.recoveryPending && request.snapshot.revision <= (session.recoveryRevision ?? document.revision))) return Promise.resolve({ status: 'cancelled' })
      if (!destination && (!request.expectedDiskToken || !queue.tokens.has(request.expectedDiskToken))) fail('EXTERNAL_CHANGE', copy.saveBaselineChanged)
      session.latestSnapshot = { ...request.snapshot }
      const generation = queue.generation
      const execute = async (): Promise<Result<SaveReceipt>> => {
        try {
          if (generation !== queue.generation || !this.registry.has(session)) fail('STALE_SESSION', copy.saveCancelledChanged)
          return await (destination ? this.performSaveAs(session, queue, request, destination) : this.registry.serializeWrite(session, () => this.perform(session, queue, request)))
        } catch (error) {
          const mapped = saveError(error)
          if (!destination) this.markFailure(session, mapped)
          return { status: 'error', error: mapped }
        }
      }
      let complete!: (result: Result<SaveReceipt>) => void
      const result = new Promise<Result<SaveReceipt>>(resolve => { complete = resolve })
      const entry: RequestEntry = { kind: 'save', payloadHash, result, expectedToken: request.expectedDiskToken, completed: false, proof: false, chain: queue.chain }
      queue.requests.set(request.requestId, entry)
      const finish = (value: Result<SaveReceipt>) => {
        entry.completed = true; entry.proof = value.status === 'ok' && entry.chain === queue.chain
        // Completion order, not submission order: a long-running request finishes newest.
        queue.requests.delete(request.requestId); queue.requests.set(request.requestId, entry)
        this.prune(session, queue); complete(value)
      }
      if (request.trigger === 'auto') {
        const slot: AutoSlot = { execute: async () => { const value = await execute(); finish(value); return value }, cancel: () => finish({ status: 'cancelled' }) }
        if (queue.autoWaiting) { queue.autoWaiting.cancel(); queue.autoWaiting = slot }
        else {
          queue.autoWaiting = slot
          const queued = queue.tail.then(async () => {
            const next = queue.autoWaiting!; queue.autoWaiting = null
            await next.execute()
          })
          queue.tail = queued.then(() => {}, () => {})
        }
      } else {
        void this.barrier(session, execute).then(finish, error => finish({ status: 'error', error: saveError(error) }))
      }
      return result
    } catch (error) { return Promise.resolve({ status: 'error', error: saveError(error) }) }
  }
  // Read-only exact replay is safe even while close blocks new operations. A close
  // admission cancellation must never masquerade as the original restore outcome.
  replayHistoryRestore(input: HistoryRestoreRequest, ownerId: number): Promise<HistoryRestoreResult> | null {
    try {
      if (!validHistoryRestoreArgs([input])) fail('INVALID_REQUEST', copy.invalidRequest)
      const session = this.registry.get(input.snapshot, ownerId)
      if (!session) fail('STALE_SESSION', copy.staleSession)
      const duplicate = this.queue(session).requests.get(input.requestId)
      if (!duplicate) return null
      if (duplicate.kind !== 'restore' || duplicate.payloadHash !== restorePayloadHash(input)) fail('INVALID_REQUEST', copy.duplicateSave)
      return duplicate.result as Promise<HistoryRestoreResult>
    } catch (error) { return Promise.resolve({ status: 'error', error: saveError(error), preservedCurrent: null, diskUncertain: false }) }
  }
  restoreHistory(input: HistoryRestoreRequest, ownerId: number, history: HistoryStore, confirm: () => Promise<boolean>): Promise<HistoryRestoreResult> {
    const replay = this.replayHistoryRestore(input, ownerId)
    if (replay) return replay
    try {
      if (!validHistoryRestoreArgs([input]) || input.snapshot.revision >= Number.MAX_SAFE_INTEGER) fail('INVALID_REQUEST', copy.invalidRequest)
      const session = this.registry.get(input.snapshot, ownerId)
      if (!session) fail('STALE_SESSION', copy.staleSession)
      const queue = this.queue(session)
      const request = { ...input, snapshot: { ...input.snapshot } }
      const payloadHash = restorePayloadHash(request)
      this.assertAvailable(session)
      if (!session.document.format || session.document.readOnlyReason) fail('READ_ONLY', copy.readOnlyDocument)
      if (!validSnapshotText(request.snapshot, session.document.format)) fail('INVALID_REQUEST', copy.invalidSaveText)
      const previous = session.latestSnapshot ?? session.document
      if (request.snapshot.revision < previous.revision || request.snapshot.revision === previous.revision && request.snapshot.text !== previous.text) fail('STALE_REVISION', copy.staleSave)
      if (!request.expectedDiskToken || !queue.tokens.has(request.expectedDiskToken)) fail('EXTERNAL_CHANGE', copy.saveBaselineChanged)
      const originalPath = session.path
      const release = history.acquireRestore()
      queue.restoring = true
      session.latestSnapshot = { ...request.snapshot }
      const operation = () => {
        if (session.path !== originalPath || !queue.tokens.has(request.expectedDiskToken!)) fail('EXTERNAL_CHANGE', copy.saveBaselineChanged)
        return this.registry.serializeWrite(session, () => restoreHistoryTransaction(this.registry, session, request, history, confirm,
        async (step, beforeWrite) => {
          const result = await this.perform(session, queue, step, undefined, { mandatoryHistory: true, beforeWrite, source: step.snapshot.revision === request.snapshot.revision ? 'manual' : 'restore' })
          if (result.status !== 'ok') throw new Error('Internal save did not complete')
          return result.value
        }, () => { queue.chain++; this.prune(session, queue) }))
      }
      const result = this.enqueueBarrier(session, operation).catch((error): HistoryRestoreResult => ({ status: 'error', error: saveError(error), preservedCurrent: null, diskUncertain: false })).finally(() => {
        queue.restoring = false; release()
        entry.completed = true
        queue.requests.delete(request.requestId); queue.requests.set(request.requestId, entry)
        this.prune(session, queue)
      })
      const entry: RequestEntry = { kind: 'restore', payloadHash, result, expectedToken: null, completed: false, proof: false, chain: queue.chain }
      queue.requests.set(request.requestId, entry)
      return result
    } catch (error) { return Promise.resolve({ status: 'error', error: saveError(error), preservedCurrent: null, diskUncertain: false }) }
  }
  private prune(session: DocumentSession, queue: Queue): void {
    // Pending entries and recent successful self-chain proofs retain bounded baseline tokens, never source text.
    let completed = 0
    for (const entry of queue.requests.values()) if (entry.completed) completed++
    for (const [id, entry] of queue.requests) {
      if (completed <= 256) break
      if (entry.completed) { queue.requests.delete(id); completed-- }
    }
    queue.tokens.clear()
    if (session.document.diskToken) queue.tokens.add(session.document.diskToken)
    for (const entry of queue.requests.values()) if (entry.chain === queue.chain && (!entry.completed || entry.proof) && entry.expectedToken) queue.tokens.add(entry.expectedToken)
  }
  private markFailure(session: DocumentSession, error: AppError): void {
    if (error.code === 'EXTERNAL_CHANGE') session.diskStatus = 'changed'
    else if (error.code === 'NOT_FOUND') session.diskStatus = 'missing'
    else if (error.code === 'ACCESS_DENIED') session.diskStatus = 'unavailable'
  }
  private historyContext(session: DocumentSession, request: SaveRequest, targetPath = session.path, source: HistoryWriteContext['source'] = request.trigger): HistoryWriteContext {
    return { session, requestId: request.requestId, revision: request.snapshot.revision, targetPath, source, now: Date.now() }
  }
  private async captureHistory(context: HistoryWriteContext, request: SaveRequest, token: string | null, mandatory = false): Promise<{ protection: HistoryProtection | null; skipped: boolean }> {
    if (!this.backups.history) { if (mandatory) fail('HISTORY_FAILED', copy.historyWriteFailed); return { protection: null, skipped: false } }
    const candidate = await readDocument(context.targetPath)
    if (candidate.path !== context.targetPath || candidate.document.diskToken !== token) fail('EXTERNAL_CHANGE', copy.historySourceChanged)
    try { return { protection: await this.backups.history.protectBeforeWrite(context, candidate.rawBytes, candidate.document.diskToken!, mandatory), skipped: false } }
    catch (error) {
      if (mandatory || request.trigger !== 'manual' || !await this.backups.confirmWithoutHistory?.(basename(context.targetPath))) throw error
      return { protection: null, skipped: true }
    }
  }
  private async recordHistory(context: HistoryWriteContext, bytes: Uint8Array, token: string, skipped: boolean, onlyExisting = false): Promise<HistoryCommit> {
    let result: HistoryCommit = { state: 'unchanged', generation: 0, error: null }
    if (skipped) result = { state: 'skipped', generation: 0, error: { code: 'HISTORY_FAILED', message: copy.historySkipped, retryable: true } }
    else if (this.backups.history) {
      try { result = await this.backups.history.recordSaved({ ...context, now: Date.now() }, Buffer.from(bytes), token, onlyExisting) }
      catch { result = { state: 'failed', generation: 0, error: { code: 'HISTORY_FAILED', message: copy.historySavedFailed, retryable: true } } }
    }
    context.session.historyAttention = result.state === 'failed' || result.state === 'skipped' ? result : null
    return result
  }
  private async maintainRecovery(session: DocumentSession, request: SaveRequest): Promise<void> {
    session.document.recovered = false; session.recoveryPending = false
    try { await this.backups.recovery?.afterSave(session, request.snapshot.revision) } catch { this.backups.maintenanceFailed?.(session) }
  }
  private receipt(session: DocumentSession, request: SaveRequest, history: HistoryCommit = { state: 'unchanged', generation: 0, error: null }): Result<SaveReceipt> {
    const document = session.document
    return { status: 'ok', value: { history, requestId: request.requestId, ref: { docId: document.docId, epoch: document.epoch }, savedRevision: request.snapshot.revision, diskToken: document.diskToken!, savedAt: new Date().toISOString(), displayName: document.displayName, displayPath: document.displayPath! } }
  }
  private async performSaveAs(session: DocumentSession, queue: Queue, request: SaveRequest, destination: { choose: () => Promise<string | null>; confirm: (kind: 'replace' | 'directory', name: string) => Promise<boolean> }): Promise<Result<SaveReceipt>> {
    let selected = await destination.choose()
    if (!selected) return { status: 'cancelled' }
    if (!extname(selected)) selected += '.md'
    if (!['.md', '.markdown'].includes(extname(selected).toLowerCase())) fail('UNSUPPORTED_TYPE', copy.markdownName)
    const parent = await realpath(dirname(selected))
    const parentIdentity = await lstat(parent)
    const target = join(parent, basename(selected))
    return this.registry.serializeWrite(session, async () => {
      if (!this.registry.has(session)) fail('STALE_SESSION', copy.staleSession)
      const exists = async () => { try { await lstat(target); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
      const loaded = await exists() ? await readDocument(target) : null
      const opened = loaded ? this.registry.findCandidate(loaded, session.ownerId) : this.registry.findPath(target)
      if (opened && opened !== session) fail('TARGET_OPEN', copy.targetOpen)
      if (opened === session || target === session.path) {
        if (session.document.readOnlyReason) fail('READ_ONLY', copy.readOnlyOriginal)
        if (loaded) {
          try { return await this.perform(session, queue, request) }
          catch (error) { this.markFailure(session, saveError(error)); throw error }
        }
        session.diskStatus = 'missing'
      }
      if (loaded?.document.readOnlyReason || loaded && loaded.path !== target) fail('READ_ONLY', copy.unsafeWritableTarget)
      if (loaded && !await destination.confirm('replace', basename(target))) return { status: 'cancelled' }
      if (session.document.displayPath && dirname(target) !== session.root && !await destination.confirm('directory', basename(target))) return { status: 'cancelled' }
      const check = async () => {
        if (!this.registry.has(session)) fail('STALE_SESSION', copy.staleSession)
        if (await realpath(dirname(target)) !== dirname(target)) fail('EXTERNAL_CHANGE', copy.chooseChangedDirectory)
        const currentParent = await lstat(parent)
        if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) fail('EXTERNAL_CHANGE', copy.chooseChangedDirectory)
        const current = await exists() ? await readDocument(target) : null
        const openedNow = current ? this.registry.findCandidate(current, session.ownerId) : this.registry.findPath(target)
        if (openedNow && openedNow !== session) fail('TARGET_OPEN', copy.targetAlreadyOpen)
        if (loaded ? !current || current.path !== target || current.document.diskToken !== loaded.document.diskToken || current.document.readOnlyReason : current !== null) fail('EXTERNAL_CHANGE', copy.targetChanged)
      }
      const bytes = encodeUtf8(request.snapshot.text, session.document.format!)
      await check()
      const context = this.historyContext(session, request, target, 'save-as')
      const protection = loaded ? await this.captureHistory(context, request, loaded.document.diskToken) : { protection: null, skipped: false }
      try {
      const written = await this.write(target, bytes, check)
      const saved = await readDocument(target)
      if (saved.path !== target || saved.document.readOnlyReason || saved.fingerprint.sha256 !== hash(bytes) || saved.fingerprint.dev !== written.dev || saved.fingerprint.ino !== written.ino) fail('EXTERNAL_CHANGE', copy.changedAfterSave)
      this.registry.migrate(session, saved)
      queue.chain++
      Object.assign(session.document, { displayName: basename(target), displayPath: target, diskToken: saved.document.diskToken, text: request.snapshot.text, revision: request.snapshot.revision, readOnlyReason: null })
      this.prune(session, queue); session.diskStatus = 'current'
      const history = await this.recordHistory(context, bytes, session.document.diskToken!, protection.skipped)
      await this.maintainRecovery(session, request)
      return this.receipt(session, request, history)
      } finally { protection.protection?.release() }
    }, target)
  }
  async overwrite(session: DocumentSession, request: SaveRequest, token: string): Promise<Result<SaveReceipt>> {
    return this.registry.serializeWrite(session, async () => {
      try { return await this.perform(session, this.queue(session), request, token) }
      catch (error) { const mapped = saveError(error); this.markFailure(session, mapped); return { status: 'error', error: mapped } }
    })
  }
  private async perform(session: DocumentSession, queue: Queue, request: SaveRequest, overwriteToken?: string, policy?: { mandatoryHistory: boolean; beforeWrite: () => void; source: HistoryWriteContext['source'] }): Promise<Result<SaveReceipt>> {
    const document = session.document
    const bytes = encodeUtf8(request.snapshot.text, document.format!)
    const check = async (): Promise<void> => {
      if (!this.registry.has(session)) fail('STALE_SESSION', copy.staleSession)
      const current = await readDocument(session.path)
      if (current.document.readOnlyReason === 'permission') fail('ACCESS_DENIED', copy.saveDenied)
      if (current.path !== session.path || current.document.diskToken !== (overwriteToken ?? document.diskToken) || current.document.readOnlyReason) fail('EXTERNAL_CHANGE', copy.sourceChangedOrReadOnly)
    }
    if (!overwriteToken && session.diskStatus && session.diskStatus !== 'current') fail('EXTERNAL_CHANGE', copy.resolveConflictFirst)
    if (request.trigger === 'auto' && session.historyAttention) fail('HISTORY_FAILED', copy.historySavedFailed)
    await check()
    const context = this.historyContext(session, request, session.path, policy?.source ?? request.trigger)
    const changed = !!overwriteToken || request.snapshot.text !== document.text
    let protection: HistoryProtection | null = null; let skipped = false
    let history: HistoryCommit = { state: 'unchanged', generation: 0, error: null }
    try {
    if (overwriteToken || request.snapshot.text !== document.text) {
      const captured = await this.captureHistory(context, request, overwriteToken ?? document.diskToken, policy?.mandatoryHistory)
      protection = captured.protection; skipped = captured.skipped
      policy?.beforeWrite()
      const written = await this.write(session.path, bytes, check)
      const saved = await readDocument(session.path)
      if (saved.path !== session.path || saved.document.readOnlyReason || saved.fingerprint.sha256 !== hash(bytes) || saved.fingerprint.dev !== written.dev || saved.fingerprint.ino !== written.ino) fail('EXTERNAL_CHANGE', copy.changedAfterSave)
      // Raw bytes are authoritative. A source-leading FEFF may decode as a BOM on a fresh open;
      // keep this session's source/format, but use the token derived from actual stored bytes.
      this.registry.updateFingerprint(session, saved.fingerprint)
      document.diskToken = saved.document.diskToken
      queue.tokens.add(document.diskToken!)
    }
    if (overwriteToken) queue.chain++
    session.diskStatus = 'current'
    document.text = request.snapshot.text
    document.revision = request.snapshot.revision
    if (changed || request.trigger === 'manual' || request.trigger === 'close' && !session.historyAttention) history = await this.recordHistory(context, bytes, document.diskToken!, skipped, !changed && !session.historyAttention)
    else if (session.historyAttention) history = session.historyAttention
    await this.maintainRecovery(session, request)
    this.prune(session, queue)
    return this.receipt(session, request, history)
    } finally { protection?.release() }
  }
}
