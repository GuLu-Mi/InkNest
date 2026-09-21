import { describe, expect, it } from 'vitest'
import { fitImageScale, imageViewerUrl, nextImageIndex, zoomImageScale, viewerNavigationDirection, imageViewerLoadStatus } from '../../src/renderer/src/preview/image-viewer'

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
  it('wraps navigation without producing invalid indices for an empty or single list', () => {
    expect(nextImageIndex(0, -1, 3)).toBe(2)
    expect(nextImageIndex(2, 1, 3)).toBe(0)
    expect(nextImageIndex(0, 1, 1)).toBe(0)
    expect(nextImageIndex(0, -1, 0)).toBe(0)
  })
})
