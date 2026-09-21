import { expect, test } from 'vitest'
import { panelFits, panelLayout } from '../../src/renderer/src/documents/panel-layout'

test('sidebars fit only when the centered 1080px document has room for panel and gap', () => {
  expect(panelFits(1687, 280)).toBe(false)
  expect(panelFits(1688, 280)).toBe(true)
  expect(panelFits(1727, 300)).toBe(false)
  expect(panelFits(1728, 300)).toBe(true)
  for (const width of [400, 800, 1200]) {
    expect(panelFits(width, 280)).toBe(false)
    expect(panelFits(width, 300)).toBe(false)
  }
})

test('scroll viewport only reserves space for visible panels, independently of content balance', () => {
  for (const width of [1920, 1200, 800, 400]) {
    for (const outline of [false, true]) for (const history of [false, true]) {
      const layout = panelLayout(width, outline, history)
      expect(layout.left).toBe(outline ? Math.min(280, width * 0.3) : 0)
      expect(layout.right).toBe(history ? Math.min(300, width * 0.3) : 0)
    }
  }
})

test('wide content keeps its window center while narrower windows use all remaining space', () => {
  expect(panelLayout(1920, true, true)).toEqual({ outlineWidth: 280, historyWidth: 300, left: 280, right: 300, contentLeft: 20, contentRight: 0 })
  expect(panelLayout(1920, true, false)).toMatchObject({ left: 280, right: 0, contentLeft: 0, contentRight: 280 })
  expect(panelLayout(1920, false, true)).toMatchObject({ left: 0, right: 300, contentLeft: 300, contentRight: 0 })
  expect(panelLayout(1200, true, false)).toMatchObject({ left: 280, right: 0, contentLeft: 0, contentRight: 0 })
  expect(panelLayout(400, false, true)).toMatchObject({ left: 0, right: 120, contentLeft: 0, contentRight: 0 })
})
