export type Mode = 'read' | 'edit'
export type SaveReason = 'manual' | 'auto' | 'mode-change' | 'close'
export interface ScrollBookmark { top: number; ratio: number; revision: number }
export interface TabViewState { mode: Mode; reading: ScrollBookmark; editorTop: number }
export interface TextFormat { encoding: 'utf-8'; bom: boolean; eol: 'lf' | 'crlf' }
export interface SessionRef { docId: string; epoch: string }
export type ReadOnlyReason = 'encoding' | 'mixed-eol' | 'size' | 'link' | 'filesystem' | 'permission'
export interface OpenDocument extends SessionRef {
  displayName: string
  displayPath: string | null
  text: string
  revision: number
  format: TextFormat | null
  diskToken: string | null
  readOnlyReason: ReadOnlyReason | null
  recovered: boolean
  readingPosition: { headingId: string | null; offset: number; ratio: number } | null
}
export type ErrorCode = 'NOT_FOUND' | 'ACCESS_DENIED' | 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'INVALID_REQUEST' | 'STALE_SESSION' | 'IO_ERROR' | 'FILE_BUSY' | 'STALE_REVISION' | 'EXTERNAL_CHANGE' | 'DISK_FULL' | 'READ_ONLY' | 'TAB_LIMIT' | 'TARGET_OPEN' | 'RECOVERY_FAILED' | 'HISTORY_FAILED' | 'CORRUPT_DATA'
export interface AppError { code: ErrorCode; message: string; retryable: boolean }
export type Result<T> = { status: 'ok'; value: T } | { status: 'cancelled' } | { status: 'error'; error: AppError }
export interface ResourceReference { key: string; rawTarget: string }
export type ResourceBlockedReason = 'missing' | 'access' | 'path' | 'syntax' | 'format' | 'size' | 'remote' | 'unavailable'
export interface ImageMetadata { mime: string; width: number; height: number; orientation: number; frames: number }
export type LinkOutcome = { kind: 'anchor'; fragment: string } | { kind: 'document'; document: OpenDocument; fragment: string } | { kind: 'image'; url: string; label: string } | { kind: 'dispatched' }
export interface LinkRequest { requestId: string; ref: SessionRef; rawTarget: string }
export interface ResolvedResource { metadata?: ImageMetadata; key: string; url: string | null; blockedReason: ResourceBlockedReason | null }
export interface PresentationRequest { requestId: string; ref: SessionRef; enabled: boolean }
export type ThemeChoice = 'system' | 'light' | 'dark'
export interface ThemePreferences { theme: ThemeChoice; warning: string }

export interface InkNestAPI {
  openDocumentLink(request: LinkRequest): Promise<Result<LinkOutcome>>
  getTheme(): Promise<Result<ThemePreferences>>
  setTheme(theme: 'light' | 'dark'): Promise<Result<ThemePreferences>>
  setPresentation(request: PresentationRequest): Promise<Result<void>>
  checkpoint(snapshot: ContentSnapshot): Promise<Result<{ revision: number; savedAt: string }>>
  listRecovery(): Promise<Result<RecoveryEntry[]>>
  inspectRecovery(id: string): Promise<Result<string>>
  restoreRecovery(id: string): Promise<Result<OpenDocument>>
  discardRecovery(id: string): Promise<Result<void>>
  listHistory(ref: SessionRef): Promise<Result<HistoryListing>>
  inspectHistory(ref: SessionRef, id: string): Promise<Result<HistorySnapshot>>
  restoreHistory(request: HistoryRestoreRequest): Promise<HistoryRestoreResult>
  exportHistory(ref: SessionRef, id: string): Promise<Result<void>>
  clearRecords(kind: 'recovery' | 'history'): Promise<Result<void>>
  saveAs(request: SaveRequest): Promise<Result<SaveReceipt>>
  reconcileExternal(state: CurrentState): Promise<Result<ReconcileOutcome>>
  resolveConflict(ref: SessionRef, action: ConflictAction, snapshot: ContentSnapshot): Promise<Result<ConflictOutcome>>
  save(request: SaveRequest): Promise<Result<SaveReceipt>>
  openFile(): Promise<Result<OpenDocument>>
  rendererReady(): Promise<Result<void>>
  closeDocument(ref: SessionRef): Promise<Result<void>>
  activateDocument(ref: SessionRef): Promise<Result<void>>
  completeClose(requestId: string, state: CurrentState): Promise<Result<void>>
  onEvent(listener: (event: AppEvent) => void): () => void
  resolveResources(ref: SessionRef, refs: ResourceReference[]): Promise<Result<ResolvedResource[]>>
}
declare global { interface Window { inknest: InkNestAPI } }

export interface ContentSnapshot extends SessionRef { revision: number; text: string }
export interface SaveRequest { requestId: string; snapshot: ContentSnapshot; expectedDiskToken: string | null; trigger: 'manual' | 'auto' | 'close' }
export interface SaveReceipt {
  history: HistoryCommit
  requestId: string
  ref: SessionRef
  savedRevision: number
  diskToken: string
  savedAt: string
  displayName: string
  displayPath: string
}
export interface CurrentState { ref: SessionRef; snapshot: ContentSnapshot | null }
export type AppEvent =
  | { type: 'system-document-opened'; document: OpenDocument }
  | { type: 'link-opened'; requestId: string; document: OpenDocument }
  | { type: 'history-maintenance'; ref: SessionRef; displayPath: string; failed: boolean }
  | { type: 'history-changed'; ref: SessionRef; displayPath: string; generation: number }
  | ({ type: 'presentation-state'; fullscreen: boolean } & PresentationRequest)
  | { type: 'recovery-status'; ref: SessionRef; revision: number; state: 'pending' | 'backed-up' | 'error' }
  | { type: 'workspace-freeze' | 'workspace-thaw'; requestId: string }
  | { type: 'close-blocked'; requestId: string; ref: SessionRef; action: 'locate' | 'save-as' }
  | { type: 'close-error'; requestId: string; ref: SessionRef; error: AppError }
  | { type: 'document-closed'; ref: SessionRef }
  | { type: 'save-receipt'; receipt: SaveReceipt }
  | { type: 'menu-command'; command: 'open' | 'save' | 'save-as' | 'backups' | 'close' | 'presentation' | 'find' | 'find-next' | 'find-previous' }
  | { type: 'external-change'; ref: SessionRef; diskStatus: DiskStatus }
  | { type: 'document-opened'; document: OpenDocument }
  | { type: 'document-activated'; ref: SessionRef }
  | { type: 'prepare-close'; requestId: string; ref: SessionRef }
  | { type: 'close-finished'; requestId: string; message: string | null }

export type DiskStatus = 'current' | 'changed' | 'missing' | 'unavailable'
export type ConflictAction = 'inspect' | 'save-copy' | 'use-disk' | 'overwrite'
export type ConflictOutcome = { kind: 'inspection'; text: string; diskToken: string } | { kind: 'opened'; document: OpenDocument } | { kind: 'saved'; receipt: SaveReceipt }
export type ReconcileOutcome = { kind: 'unchanged' } | { kind: 'reloaded'; document: OpenDocument } | { kind: 'conflict'; diskStatus: DiskStatus }

export interface RecoveryEntry { id: string; displayName: string; savedAt: string; available: boolean }
export type HistorySource = 'baseline' | 'auto' | 'manual' | 'close' | 'save-as' | 'restore' | 'legacy'
export interface HistoryCommit { state: 'recorded' | 'unchanged' | 'failed' | 'skipped'; generation: number; error: AppError | null }
export interface HistoryEntry { id: string; savedAt: string; byteLength: number; source: HistorySource; sealed: boolean }
export interface HistoryListing { generation: number; entries: HistoryEntry[] }

/** Verified historical bytes decoded for display only; never a normal save source. */
export interface HistorySnapshot extends HistoryEntry {
  contentHash: string
  text: string
  format: TextFormat | null
  /** Source eligibility only; restore must also validate the current session/format. */
  restorable: boolean
}

export interface HistoryRestoreRequest {
  requestId: string
  snapshot: ContentSnapshot
  expectedDiskToken: string | null
  historyId: string
  expectedContentHash: string
}
export interface HistoryRestoreReceipt {
  kind: 'restored'
  requestId: string
  ref: SessionRef
  previousRevision: number
  historyId: string
  contentHash: string
  preservedCurrent: SaveReceipt | null
  restored: SaveReceipt
}
export type HistoryRestoreResult =
  | { status: 'ok'; value: HistoryRestoreReceipt | { kind: 'unchanged'; requestId: string; ref: SessionRef; historyId: string; contentHash: string; revision: number } }
  | { status: 'cancelled' }
  | { status: 'error'; error: AppError; preservedCurrent: SaveReceipt | null; diskUncertain: boolean }
