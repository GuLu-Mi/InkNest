export const MAX_DIAGRAM_CHARS = 20_000
export const MAX_DIAGRAM_LINES = 500
export const MAX_DIAGRAMS = 20
export const MAX_MATH_CHARS = 8_000
export const MAX_FORMULAS = 200
export const MAX_HIGHLIGHT_CHARS = 32_000

export function diagramProblem(source: string): string | null {
  if (source.length > MAX_DIAGRAM_CHARS || source.split('\n').length > MAX_DIAGRAM_LINES) return '图表过大，已保留源码'
  // Document-provided configuration cannot replace application security,
  // stylesheet, layout or resource policy. Ordinary %% comments are supported.
  if (/%%\s*\{|^\s*---(?:\r?\n|$)/u.test(source)) return '图表内自定义配置暂不支持，已保留源码'
  return null
}

const safeProperties = new Set(['color', 'background-color', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'text-decoration', 'line-height', 'white-space', 'visibility', 'display', 'rx', 'ry', 'paint-order', 'marker-start', 'marker-mid', 'marker-end'])
export function safeDiagramDeclaration(property: string, value: string): boolean {
  if (!safeProperties.has(property) || /[\\<>@]|(?:expression|image-set|var)\s*\(/iu.test(value)) return false
  if (/url\s*\(/iu.test(value)) return /^url\(["']?#[a-zA-Z0-9_.:-]+["']?\)$/u.test(value)
  return !/(?:https?|file|data|inknest(?:-resource)?):/iu.test(value)
}
