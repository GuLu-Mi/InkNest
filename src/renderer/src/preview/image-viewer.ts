export interface ViewerImage { url: string; label: string; loading?: boolean }
export type ImageRotation = 0 | 90 | 180 | 270
export interface ImagePoint { x: number; y: number }
export const IMAGE_VIEWER_PADDING = 24
export const MAX_IMAGE_SCALE = 4
const WHEEL_ZOOM_SPEED = 0.002

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RESOURCE_URL = new RegExp(`^inknest-resource://${UUID}/${UUID}/${UUID}$`)

/** Defense in depth: authorization and image budgets remain owned by the main process. */
export function imageViewerUrl(url: string): string | null { return RESOURCE_URL.test(url) ? url : null }
export function fitImageScale(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  if (![width, height, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) return 1
  return Math.min(1, viewportWidth / width, viewportHeight / height)
}
export function clampImageScale(scale: number, proposed: number, fitScale = 0.1): number {
  if (!Number.isFinite(proposed) || proposed <= 0) return scale
  // A resize/rotation may leave the current manual scale below the new floor.
  // Keep it stable and allow gradual zoom-in instead of snapping to that floor.
  const minimum = Math.min(scale, 0.1, fitScale)
  return Math.max(minimum, Math.min(MAX_IMAGE_SCALE, proposed))
}
export function zoomImageScale(scale: number, direction: -1 | 1, fitScale = 0.1): number {
  return clampImageScale(scale, Math.max(Number.MIN_VALUE, scale + direction * 0.25), fitScale)
}
export function isImageZoomWheel(event: { ctrlKey: boolean; metaKey: boolean }, isMac: boolean): boolean {
  // Chromium also sends trackpad pinch as ctrl+wheel on macOS.
  return event.ctrlKey || (isMac && event.metaKey)
}
export function imageWheelDelta(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (!Number.isFinite(deltaY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0
  const unit = deltaMode === 0 ? 1 : deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 0
  return Math.max(-300, Math.min(300, deltaY * unit))
}
export function wheelImageScale(scale: number, delta: number, fitScale: number): number {
  return clampImageScale(scale, scale * Math.exp(-delta * WHEEL_ZOOM_SPEED), fitScale)
}
export function nextImageRotation(rotation: ImageRotation): ImageRotation {
  return ((rotation + 90) % 360) as ImageRotation
}
export function rotatedImageSize(width: number, height: number, rotation: ImageRotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height }
}
/** Normalized coordinates measured from the top-left of the oriented image. */
export function rotateImagePoint(point: ImagePoint, rotation: ImageRotation): ImagePoint {
  switch (rotation) {
    case 90: return { x: 1 - point.y, y: point.x }
    case 180: return { x: 1 - point.x, y: 1 - point.y }
    case 270: return { x: point.y, y: 1 - point.x }
    default: return point
  }
}
export function unrotateImagePoint(point: ImagePoint, rotation: ImageRotation): ImagePoint {
  return rotateImagePoint(point, ((360 - rotation) % 360) as ImageRotation)
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
