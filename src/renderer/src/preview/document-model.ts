import { markdown } from './markdown'
export interface HeadingEntry { id: string; title: string; level: number; sourceLine: number; parentId: string | null }
export interface ExplicitAnchorEntry { id: string; name: string; sourceLine: number }
export interface PreviewImage { target: string; label: string; url: string; failed: boolean }
export interface ParsedDocument { html: string; headings: HeadingEntry[]; anchors?: ExplicitAnchorEntry[]; links?: string[]; images?: PreviewImage[] }

// A deliberately narrow Markdown extension, not raw HTML support. The block
// parser owns code/indentation boundaries, so literal anchors in code stay text.
markdown.block.ruler.before('paragraph', 'inknest_anchor', (state, startLine, _endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  const line = state.src.slice(state.bMarks[startLine]! + state.tShift[startLine]!, state.eMarks[startLine])
  const match = /^<a[ \t]+(?:id|name)[ \t]*=[ \t]*(["'])([^\s<>"'&\p{Cc}]+)\1[ \t]*><\/a>[ \t]*$/u.exec(line)
  if (!match) return false
  if (silent) return true
  const token = state.push('inknest_anchor', 'span', 0)
  token.block = true; token.map = [startLine, startLine + 1]; token.content = match[2]!
  state.line = startLine + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote'] })
markdown.renderer.rules.inknest_anchor = (tokens, index) => {
  const marker = tokens[index]!.attrGet('data-inknest-anchor')
  return marker === null ? '' : `<span data-inknest-anchor="${marker}"></span>\n`
}

/** Untrusted HTML and heading metadata derived from exactly one token parse. */
export function parseDocument(text: string): ParsedDocument {
  const environment = {}
  const tokens = markdown.parse(text, environment)
  const headings: HeadingEntry[] = []; const parents: HeadingEntry[] = []
  const anchors: ExplicitAnchorEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'inknest_anchor') {
      token.attrSet('data-inknest-anchor', String(anchors.length))
      anchors.push({ id: `inknest-anchor-${anchors.length}`, name: token.content, sourceLine: token.map?.[0] ?? 0 })
    }
    if (token.type !== 'heading_open') continue
    const level = Number(token.tag.slice(1))
    while (parents.length && parents.at(-1)!.level >= level) parents.pop()
    const title = (tokens[i + 1]?.children ?? []).map(child => child.type === 'softbreak' || child.type === 'hardbreak' ? ' ' : child.type === 'text' || child.type === 'inknest_literal_html' || child.type === 'code_inline' || child.type === 'image' || child.type === 'emoji' || child.type.startsWith('math_inline') ? child.content : '').join('')
    const heading = { id: `inknest-heading-${headings.length}`, title, level, sourceLine: token.map?.[0] ?? 0, parentId: parents.at(-1)?.id ?? null }
    headings.push(heading); parents.push(heading)
  }
  return { html: markdown.renderer.render(tokens, markdown.options, environment), headings, anchors }
}
