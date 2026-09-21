import { describe, expect, it } from 'vitest'
import { fitImageScale, imageViewerUrl, nextImageIndex, zoomImageScale, viewerNavigationDirection, imageViewerLoadStatus, clampImageScale, isImageZoomWheel, imageWheelDelta, wheelImageScale, nextImageRotation, rotatedImageSize, rotateImagePoint, unrotateImagePoint, type ImageRotation } from '../../src/renderer/src/preview/image-viewer'

const url = 'inknest-resource://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333'
describe('controlled image viewer', () => {
  it('accepts only complete controlled resource URLs without query, fragments or credentials', () => {
    expect(imageViewerUrl(url)).toBe(url)
    for (const input of ['https://example.com/a.png', 'file:///tmp/a.png', 'data:image/png;base64,a', 'inknest-resource://example/a', `${url}?remote=true`, `${url}#x`, url.replace('://', '://user@')]) expect(imageViewerUrl(input)).toBeNull()
  })
  it('keeps unresolved lazy images loading but rejects failed and uncontrolled images', () => {
    expect(imageViewerLoadStatus({ url: '', label: 'pending', loading: true })).toBe('loading')
    expect(imageViewerLoadStatus({ url, label: 'authorized' })).toBe('loading')
    expect(imageViewerLoadStatus({ url: '', label: 'failed', loading: false })).toBe('error')
    expect(imageViewerLoadStatus({ url: 'https://example.com/a.png', label: 'remote', loading: true })).toBe('error')
    expect(imageViewerLoadStatus(undefined)).toBe('error')
  })
  it('fits wide and tall images without enlarging small images', () => {
    expect(fitImageScale(2000, 1000, 800, 600)).toBe(0.4)
    expect(fitImageScale(1000, 2000, 800, 600)).toBe(0.3)
    expect(fitImageScale(100, 100, 800, 600)).toBe(1)
    expect(fitImageScale(0, 100, 800, 600)).toBe(1)
    expect(fitImageScale(100, 100, 0, 0)).toBe(1)
  })
  it('uses 25 percentage point zoom steps within bounds and preserves very small fit scales', () => {
    expect(zoomImageScale(3.9, 1)).toBe(4)
    expect(zoomImageScale(0.11, -1)).toBe(0.1)
    expect(zoomImageScale(0.02, -1)).toBe(0.02)
    expect(zoomImageScale(0.02, 1)).toBe(0.27)
    expect(zoomImageScale(1, 1)).toBe(1.25)
    expect(zoomImageScale(2, 1)).toBe(2.25)
    expect(zoomImageScale(1, -1)).toBe(0.75)
  })
  it('routes unmodified arrows only for multiple images outside focused controls', () => {
    expect(viewerNavigationDirection('ArrowLeft', 2, false, false)).toBe(-1)
    expect(viewerNavigationDirection('ArrowRight', 2, false, false)).toBe(1)
    expect(viewerNavigationDirection('ArrowRight', 1, false, false)).toBeNull()
    expect(viewerNavigationDirection('ArrowLeft', 2, false, true)).toBeNull()
    expect(viewerNavigationDirection('ArrowRight', 2, true, false)).toBeNull()
    expect(viewerNavigationDirection('ArrowDown', 2, false, false)).toBeNull()
  })
  it('accepts ctrl pinch on both platforms and Command wheel only on Mac', () => {
    for (const isMac of [true, false]) {
      expect(isImageZoomWheel({ ctrlKey: true, metaKey: false }, isMac)).toBe(true)
      expect(isImageZoomWheel({ ctrlKey: false, metaKey: false }, isMac)).toBe(false)
      expect(isImageZoomWheel({ ctrlKey: false, metaKey: true }, isMac)).toBe(isMac)
    }
  })
  it('normalizes wheel units, bounds outliers, and ignores invalid input', () => {
    expect(imageWheelDelta(1.5, 0, 600)).toBe(1.5)
    expect(imageWheelDelta(-2, 1, 600)).toBe(-32)
    expect(imageWheelDelta(0.25, 2, 600)).toBe(150)
    expect(imageWheelDelta(10000, 0, 600)).toBe(300)
    expect(imageWheelDelta(-10000, 0, 600)).toBe(-300)
    for (const delta of [NaN, Infinity, -Infinity]) expect(imageWheelDelta(delta, 0, 600)).toBe(0)
    expect(imageWheelDelta(4, 3, 600)).toBe(0)
    expect(imageWheelDelta(4, 2, 0)).toBe(0)
  })
  it('zooms continuously and reversibly, allowing very large images back to their fit scale', () => {
    const enlarged = wheelImageScale(1, -0.5, 0.4)
    expect(enlarged).toBeGreaterThan(1)
    expect(enlarged).toBeLessThan(1.01)
    expect(wheelImageScale(enlarged, 0.5, 0.4)).toBeCloseTo(1, 12)
    expect(wheelImageScale(3.99, -300, 0.4)).toBe(4)
    expect(wheelImageScale(0.11, 300, 0.4)).toBe(0.1)
    expect(wheelImageScale(0.021, 300, 0.02)).toBe(0.02)
    expect(zoomImageScale(0.27, -1, 0.02)).toBeCloseTo(0.02)
    expect(wheelImageScale(1, NaN, 0.4)).toBe(1)
    expect(wheelImageScale(1, 0, 0.4)).toBe(1)
    expect(clampImageScale(1, Infinity, 0.4)).toBe(1)
  })
  it('does not snap a below-minimum manual scale when resizing or rotating raises the floor', () => {
    expect(wheelImageScale(0.02, 10, 0.5)).toBe(0.02)
    expect(wheelImageScale(0.02, -1, 0.5)).toBeGreaterThan(0.02)
    expect(wheelImageScale(0.02, -1, 0.5)).toBeLessThan(0.1)
  })
  it('rotates clockwise, swaps the fit dimensions, and returns exactly after four turns', () => {
    const points = [{ x: 0.2, y: 0.3 }, { x: 0, y: 0 }, { x: 1, y: 1 }]
    let rotation: ImageRotation = 0
    for (const expected of [90, 180, 270, 0]) {
      rotation = nextImageRotation(rotation)
      expect(rotation).toBe(expected)
      const size = rotatedImageSize(1600, 800, rotation)
      expect(size).toEqual(rotation % 180 ? { width: 800, height: 1600 } : { width: 1600, height: 800 })
      expect(fitImageScale(size.width, size.height, 1000, 600)).toBe(rotation % 180 ? 0.375 : 0.625)
      for (const point of points) {
        const original = unrotateImagePoint(rotateImagePoint(point, rotation), rotation)
        expect(original.x).toBeCloseTo(point.x, 12)
        expect(original.y).toBeCloseTo(point.y, 12)
      }
    }
    expect(rotateImagePoint({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 })
    expect(rotateImagePoint({ x: 1, y: 0 }, 90)).toEqual({ x: 1, y: 1 })
  })
  it('wraps navigation without producing invalid indices for an empty or single list', () => {
    expect(nextImageIndex(0, -1, 3)).toBe(2)
    expect(nextImageIndex(2, 1, 3)).toBe(0)
    expect(nextImageIndex(0, 1, 1)).toBe(0)
    expect(nextImageIndex(0, -1, 0)).toBe(0)
  })
})
