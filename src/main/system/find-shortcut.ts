export type FindCommand = 'find' | 'find-next' | 'find-previous'
type SearchKey = Pick<Electron.Input, 'key' | 'meta' | 'control' | 'shift' | 'alt'>
/** One platform mapping for native key-down/up consumption; UI behavior is shared. */
export function findShortcut(input: SearchKey, platform: string): FindCommand | null {
  if (input.alt) return null
  const modified = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  const key = input.key.toLowerCase()
  if (modified && !input.shift && key === 'f') return 'find'
  const navigate = platform === 'darwin' ? modified && key === 'g' : !input.control && !input.meta && key === 'f3'
  return navigate ? input.shift ? 'find-previous' : 'find-next' : null
}
