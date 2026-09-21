import type { MarkdownIt } from 'markdown-it'

const alertNames: Record<string, string> = { NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }

/** Narrow static markup only; attributes and arbitrary HTML remain literal text. */
export function documentExtensions(md: MarkdownIt): void {
  md.inline.ruler.before('html_inline', 'inknest_formatting', (state, silent) => {
    const match = /^(?:<br\s*\/?>|<\/?(?:kbd|sub|sup|mark)>)/i.exec(state.src.slice(state.pos))
    if (!match) return false
    if (!silent) { const token = state.push('inknest_formatting', '', 0); token.content = match[0].toLowerCase() }
    state.pos += match[0].length
    return true
  })
  md.renderer.rules.inknest_formatting = (tokens, index) => tokens[index]!.content
  md.inline.ruler.before('html_inline', 'inknest_literal_html', (state, silent) => {
    const match = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?=[\s/>])[^<>]*>/u.exec(state.src.slice(state.pos))
    if (!match) return false
    if (!silent) { const token = state.push('inknest_literal_html', '', 0); token.content = match[0] }
    state.pos += match[0].length
    return true
  })
  md.renderer.rules.inknest_literal_html = (tokens, index) => md.utils.escapeHtml(tokens[index]!.content)

  md.block.ruler.before('fence', 'inknest_frontmatter', (state, start, end, silent) => {
    if (start !== 0 || state.blkIndent !== 0 || state.src.slice(state.bMarks[0], state.eMarks[0]) !== '---') return false
    let stop = start + 1
    while (stop < end && stop <= 256 && !/^(---|\.\.\.)\s*$/.test(state.src.slice(state.bMarks[stop], state.eMarks[stop]))) stop++
    if (stop >= end || stop > 256) return false
    if (silent) return true
    const token = state.push('inknest_frontmatter', '', 0)
    token.block = true; token.map = [start, stop + 1]
    token.content = state.src.slice(state.bMarks[1], state.bMarks[stop])
    state.line = stop + 1
    return true
  })
  md.renderer.rules.inknest_frontmatter = (tokens, index) => `<details class="document-metadata"><summary>文档元数据</summary><pre><code class="language-yaml">${md.utils.escapeHtml(tokens[index]!.content)}</code></pre></details>\n`

  md.block.ruler.before('paragraph', 'inknest_details', (state, start, _end, silent) => {
    if (state.sCount[start]! - state.blkIndent >= 4) return false
    const line = state.src.slice(state.bMarks[start]! + state.tShift[start]!, state.eMarks[start]).trim()
    const match = /^(<details>|<details open>|<\/details>|<summary>(.*?)<\/summary>)$/i.exec(line)
    if (!match) return false
    if (silent) return true
    const token = state.push('inknest_details', '', 0)
    token.block = true; token.map = [start, start + 1]
    token.content = line; state.line = start + 1
    return true
  }, { alt: ['paragraph', 'blockquote'] })
  md.renderer.rules.inknest_details = (tokens, index) => {
    const text = tokens[index]!.content
    if (/^<summary>/i.test(text)) return `<summary>${md.renderInline(text.slice(9, -10))}</summary>\n`
    return text.toLowerCase() + '\n'
  }

  md.core.ruler.after('inline', 'inknest_alerts', state => {
    for (let index = 0; index < state.tokens.length - 2; index++) {
      const block = state.tokens[index]!, paragraph = state.tokens[index + 1]!, inline = state.tokens[index + 2]!
      if (block.type !== 'blockquote_open' || paragraph.type !== 'paragraph_open' || inline.type !== 'inline') continue
      const children = inline.children
      const match = children?.[0]?.type === 'text' && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(children[0].content)
      if (!match || children?.[1] && children[1].type !== 'softbreak') continue
      block.attrSet('class', `markdown-alert markdown-alert-${match[1]!.toLowerCase()}`)
      children!.splice(0, children?.[1]?.type === 'softbreak' ? 2 : 1)
      const title = new state.Token('inknest_alert_title', '', 0)
      title.content = alertNames[match[1]!]!
      state.tokens.splice(index + 1, 0, title)
      index++
    }
  })
  md.renderer.rules.inknest_alert_title = (tokens, index) => `<p class="alert-title">${tokens[index]!.content}</p>\n`
}
