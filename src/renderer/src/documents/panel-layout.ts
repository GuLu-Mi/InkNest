export const OUTLINE_WIDTH = 280
export const HISTORY_WIDTH = 300
export const canShowBothPanels = (viewportWidth: number): boolean => viewportWidth >= 960

// Keep these dimensions aligned with document-content and sidebar styles.
export function panelFits(viewportWidth: number, panelWidth: number): boolean {
  const documentWidth = Math.min(1080, Math.max(0, viewportWidth - 48))
  return (viewportWidth - documentWidth) / 2 >= panelWidth + 24
}

export function panelLayout(viewportWidth: number, outlineOpen: boolean, historyOpen: boolean) {
  const outlineWidth = Math.min(OUTLINE_WIDTH, viewportWidth * 0.3)
  const historyWidth = Math.min(HISTORY_WIDTH, viewportWidth * 0.3)
  const left = outlineOpen ? outlineWidth : 0
  const right = historyOpen ? historyWidth : 0
  const balanced = panelFits(viewportWidth, Math.max(left, right))
  // Only occupied panels constrain the scroll viewport. Extra balancing space
  // belongs inside it, so a left panel cannot move the right scrollbar.
  const balance = balanced ? Math.max(left, right) : 0
  return { outlineWidth, historyWidth, left, right, contentLeft: Math.max(0, balance - left), contentRight: Math.max(0, balance - right) }
}
