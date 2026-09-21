/** Per-window admission only; never exposes dialog or window capabilities to renderer. */
const depths = new WeakMap<object, number>()
export function hasWindowDialog(window: object): boolean { return (depths.get(window) ?? 0) > 0 }
export async function runWindowDialog<T>(window: object, operation: () => Promise<T>): Promise<T> {
  depths.set(window, (depths.get(window) ?? 0) + 1)
  try { return await operation() }
  finally { const depth = (depths.get(window) ?? 1) - 1; if (depth) depths.set(window, depth); else depths.delete(window) }
}
