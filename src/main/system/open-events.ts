import { extname, isAbsolute, resolve } from 'node:path'

/** Electron development argv includes the app path; packaged argv does not. */
export function commandLineFiles(argv: readonly string[], cwd: string, defaultApp: boolean): string[] {
  return [...new Set(argv.slice(defaultApp ? 2 : 1).filter(value =>
    value.length > 0 && !value.startsWith('-') && !value.includes('\0') &&
    !/^[a-z][a-z\d+.-]*:\/\//i.test(value) && /^(\.md|\.markdown)$/i.test(extname(value))
  ).map(value => isAbsolute(value) ? value : resolve(cwd, value)))]
}

/** Collect a macOS multi-file burst before choosing; never dispatch before renderer readiness. */
export class SystemOpenQueue {
  private ready = false
  private pending: string[] = []
  private requested = false
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly dispatch: (paths: string[]) => Promise<void>, private readonly failed: () => void) {}
  enqueue(paths: readonly string[]): void {
    this.pending.push(...paths)
    this.requested = true
    this.schedule()
  }
  start(): void { this.ready = true; this.schedule() }
  private schedule(): void {
    if (!this.ready || this.running || this.timer || !this.requested) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, 75)
  }
  private async drain(): Promise<void> {
    const paths = [...new Set(this.pending)]
    this.pending = []; this.requested = false; this.running = true
    try { await this.dispatch(paths) } catch { this.failed() }
    finally { this.running = false; this.schedule() }
  }
}
