export interface ViewerImage { url: string; label: string; loading?: boolean }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RESOURCE_URL = new RegExp(`^inknest-resource://${UUID}/${UUID}/${UUID}$`)

/** Defense in depth: authorization and image budgets remain owned by the main process. */
export function imageViewerUrl(url: string): string | null { return RESOURCE_URL.test(url) ? url : null }
export function fitImageScale(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  if (![width, height, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) return 1
  return Math.min(1, viewportWidth / width, viewportHeight / height)
}
export function zoomImageScale(scale: number, direction: -1 | 1): number {
  const minimum = direction < 0 ? Math.min(scale, 0.1) : 0.1
  return Math.max(minimum, Math.min(4, scale + direction * 0.25))
}
export function nextImageIndex(index: number, direction: -1 | 1, count: number): number {
  return count > 0 ? (index + direction + count) % count : 0
}

export function viewerNavigationDirection(key: string, count: number, modified: boolean, controlFocused: boolean): -1 | 1 | null {
  if (count < 2 || modified || controlFocused) return null
  return key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : null
}

export function imageViewerLoadStatus(image: ViewerImage | undefined): 'loading' | 'error' {
  return image && (imageViewerUrl(image.url) || (!image.url && image.loading)) ? 'loading' : 'error'
}
