export function isLocalImageLink(raw: string): boolean {
  if (/^(?:https?:|mailto:|\/\/)/iu.test(raw)) return false
  try { return /\.(png|jpe?g|webp|gif)$/iu.test(decodeURIComponent(raw.split('#')[0] ?? '')) } catch { return false }
}
export function linkGesture(event: MouseEvent | KeyboardEvent, mac: boolean): boolean {
  if (event.altKey || event.shiftKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return false
  return event instanceof KeyboardEvent ? event.key === 'Enter' : event.button === 0
}
