import { Text } from '@codemirror/state'
import { SearchCursor } from '@codemirror/search'

export interface Match { from: number; to: number }
/** Compact coordinates, not millions of DOM ranges or reactive objects. */
export class Matches {
  private chunks: Uint32Array[] = []
  length = 0
  add(from: number, to: number): void {
    const slot = this.length++ * 2, chunk = Math.floor(slot / 8192)
    this.chunks[chunk] ??= new Uint32Array(8192)
    this.chunks[chunk]![slot % 8192] = from; this.chunks[chunk]![slot % 8192 + 1] = to
  }
  at(index: number): Match {
    const slot = index * 2, data = this.chunks[Math.floor(slot / 8192)]!
    return { from: data[slot % 8192]!, to: data[slot % 8192 + 1]! }
  }
  after(offset: number): number {
    let low = 0, high = this.length
    while (low < high) { const mid = (low + high) >>> 1; if (this.at(mid).from < offset) low = mid + 1; else high = mid }
    return low
  }
}
export const pause = async (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  signal.throwIfAborted()
}
export async function findMatches(text: Text, query: string, caseSensitive: boolean, signal: AbortSignal): Promise<Matches> {
  const matches = new Matches()
  if (!query || /[\r\n]/u.test(query)) return matches
  const overlap = query.normalize('NFKD').length * 2 + 4
  let next = 0, tick = performance.now()
  for (let start = 0; start < text.length; start += 16384) {
    signal.throwIfAborted()
    const end = Math.min(start + 16384, text.length)
    if (next >= end) continue
    const cursor = new SearchCursor(text, query, Math.max(start, next), Math.min(text.length, end + overlap), caseSensitive ? undefined : value => value.toLowerCase())
    while (!cursor.next().done) {
      const { from, to } = cursor.value
      if (from >= end) break
      matches.add(from, to); next = to
      if (matches.length % 256 === 0 && performance.now() - tick >= 8) { await pause(signal); tick = performance.now() }
    }
    if (performance.now() - tick >= 8) { await pause(signal); tick = performance.now() }
  }
  return matches
}
export type ReplaceResult = { status: 'ok'; count: number; nextFrom: number } | { status: 'cancelled' } | { status: 'error'; message: string }
export interface SearchSurface {
  replace?(matches: Matches, index: number | null, replacement: string, signal: AbortSignal): Promise<ReplaceResult>
  scan(query: string, caseSensitive: boolean, signal: AbortSignal): Promise<Matches>
  paint(matches: Matches, index: number): void
  reveal(match: Match): void
  position(): number
  selection(): string
  focus(): void
  clear(): void
  dispose(): void
}
