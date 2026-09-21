import { copy } from '../shared/copy'
import type { AppEvent, PresentationRequest, Result, SessionRef } from '../shared/contracts'
interface NativeWindow {
  isFullScreen(): boolean
  isDestroyed(): boolean
  setFullScreen(value: boolean): void
  on(event: 'enter-full-screen' | 'leave-full-screen' | 'closed', listener: () => void): unknown
  removeListener(event: 'enter-full-screen' | 'leave-full-screen' | 'closed', listener: () => void): unknown
}
const same = (a: SessionRef, b: SessionRef) => a.docId === b.docId && a.epoch === b.epoch
/** Window-owned native transition state; accepted requests are not native receipts. */
export class PresentationController {
  private current: PresentationRequest | null = null
  private priorFullscreen = false
  private confirmed = false
  private transitioning = false
  private cancelledEnter = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly seen = new Map<string, PresentationRequest>()
  get active(): boolean { return !!this.current?.enabled || this.transitioning || this.cancelledEnter }
  constructor(private readonly window: NativeWindow, private readonly live: (ref: SessionRef) => boolean, private readonly blocked: () => boolean, private readonly send: (event: AppEvent) => void) {
    window.on('enter-full-screen', this.entered); window.on('leave-full-screen', this.left); window.on('closed', this.dispose)
  }
  set(request: PresentationRequest): Result<void> {
    if (this.disposed || this.window.isDestroyed()) return { status: 'cancelled' }
    const seen = this.seen.get(request.requestId)
    if (seen) return same(seen.ref, request.ref) && seen.enabled === request.enabled ? { status: 'cancelled' } : this.error('INVALID_REQUEST', copy.invalidRequest)
    if (request.enabled) {
      if (!this.live(request.ref)) return this.error('STALE_SESSION', copy.staleSession)
      if (this.blocked() || this.current?.enabled && !same(this.current.ref, request.ref)) return this.error('FILE_BUSY', copy.processingWait)
    } else if (!this.current || !same(this.current.ref, request.ref)) {
      return this.error('STALE_SESSION', copy.staleSession)
    }
    this.seen.set(request.requestId, { ...request, ref: { ...request.ref } })
    if (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!)
    const continuing = this.current?.enabled || this.transitioning || this.cancelledEnter
    if (request.enabled && !continuing) this.priorFullscreen = this.window.isFullScreen()
    if (!request.enabled && this.current?.enabled && !this.confirmed) this.cancelledEnter = true
    this.current = { ...request, ref: { ...request.ref } }
    clearTimeout(this.timer)
    try {
      if (request.enabled) {
        if (this.window.isFullScreen() && !this.transitioning) { this.confirmed = true; this.emit() }
        else { this.confirmed = false; this.transitioning = true; this.window.setFullScreen(true); this.watchdog() }
      } else {
        this.confirmed = false
        this.restore()
      }
      return { status: 'ok', value: undefined }
    } catch {
      this.current.enabled = false; this.confirmed = false; this.transitioning = false; this.cancelledEnter = true
      this.emit(); return this.error('IO_ERROR', copy.presentationFailed)
    }
  }
  checkSource(): void {
    if (this.disposed || this.window.isDestroyed() || !this.current?.enabled || this.live(this.current.ref)) return
    this.cancelledEnter = !this.confirmed
    this.current.enabled = false; this.confirmed = false; clearTimeout(this.timer)
    this.emit(); this.restore()
  }
  private error(code: 'INVALID_REQUEST' | 'STALE_SESSION' | 'FILE_BUSY' | 'IO_ERROR', message: string): Result<void> { return { status: 'error', error: { code, message, retryable: code !== 'INVALID_REQUEST' } } }
  private emit(): void {
    if (!this.current || this.disposed || this.window.isDestroyed()) return
    this.send({ type: 'presentation-state', ...this.current, enabled: this.current.enabled && this.confirmed, fullscreen: this.window.isFullScreen() })
  }
  private restore(): void {
    if (!this.current) return
    if (this.window.isFullScreen() !== this.priorFullscreen) {
      try { this.transitioning = true; this.window.setFullScreen(this.priorFullscreen); this.watchdog() }
      catch { this.transitioning = false; this.emit() }
    } else { this.transitioning = false; this.emit() }
  }
  private entered = (): void => {
    if (this.disposed || !this.current || !this.current.enabled && !this.transitioning && !this.cancelledEnter) return
    clearTimeout(this.timer); this.transitioning = false
    if (this.current.enabled && this.live(this.current.ref) && !this.blocked()) { this.confirmed = true; this.cancelledEnter = false; this.emit() }
    else {
      this.current.enabled = false; this.confirmed = false
      // A late enter belongs to the cancelled transition, never to a new presentation.
      this.cancelledEnter = false; this.emit(); this.restore()
    }
  }
  private left = (): void => {
    if (this.disposed || !this.current) return
    clearTimeout(this.timer); this.transitioning = false
    if (this.current.enabled && !this.confirmed && this.live(this.current.ref)) {
      try { this.transitioning = true; this.window.setFullScreen(true); this.watchdog() } catch { this.current.enabled = false; this.emit() }
      return
    }
    // A native system exit overrides the old fullscreen baseline.
    this.current.enabled = false; this.confirmed = false; this.priorFullscreen = false; this.cancelledEnter = false; this.emit()
  }
  private watchdog(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.disposed || this.window.isDestroyed() || !this.current) return
      this.transitioning = false
      if (this.current.enabled && this.live(this.current.ref) && !this.blocked() && this.window.isFullScreen()) { this.confirmed = true; this.emit(); return }
      if (this.current.enabled) { this.current.enabled = false; this.cancelledEnter = true }
      this.confirmed = false; this.emit()
      // Bounded retry; later native events still reconcile the latest disabled goal.
      if (this.window.isFullScreen() !== this.priorFullscreen) { try { this.window.setFullScreen(this.priorFullscreen) } catch { /* Ordinary UI is already restored. */ } }
    }, 10000)
  }
  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true; clearTimeout(this.timer); this.current = null; this.seen.clear()
    this.window.removeListener('enter-full-screen', this.entered); this.window.removeListener('leave-full-screen', this.left); this.window.removeListener('closed', this.dispose)
  }
}
