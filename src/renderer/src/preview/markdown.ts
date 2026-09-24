import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import taskLists from 'markdown-it-task-lists'
import texmath from 'markdown-it-texmath'
import { full as emoji } from 'markdown-it-emoji'
import deflist from 'markdown-it-deflist'
import mark from 'markdown-it-mark'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import { documentExtensions } from './extensions'

export const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false
})

// Treat common CJK punctuation as an email boundary, while keeping the library's
// address validation and Markdown token handling (links/code/escapes) intact.
const linkPatterns = markdown.linkify.re
const emailName = new RegExp(`(?:^|[：，；、。！？（）【】《》「」『』“”‘’]|${linkPatterns.get_text_separators().source}|"|\\(|${linkPatterns.src_ZCc})(${linkPatterns.get_mail_name().source})$`)
linkPatterns.get_mail_name_validator = () => emailName

markdown.use(footnote).use(taskLists, { enabled: false, label: false }).use(emoji, { shortcuts: {} })
  .use(deflist).use(mark).use(sub).use(sup).use(documentExtensions)

// Tokenize math here, but render it only in the browser's isolated enhancement
// stage. The parser and outline never execute TeX or carry trusted HTML.
markdown.use(texmath, { delimiters: ['dollars', 'brackets'], engine: { renderToString: () => '' } })
// Do not let an unmatched currency dollar consume another code span or price.
markdown.inline.ruler.disable('math_inline')
markdown.inline.ruler.before('escape', 'inknest_inline_math', (state, silent) => {
  const bracket = state.src.startsWith('\\(', state.pos)
  const begin = state.pos + (bracket ? 2 : 1)
  if (!bracket && (state.src[state.pos] !== '$' || /[\s$]/u.test(state.src[begin] ?? ' '))) return false
  let end = begin
  while (end < state.posMax && end - begin <= 8000) {
    if (bracket && state.src.startsWith('\\)', end)) break
    if (!bracket && state.src[end] === '$') break
    if (state.src[end] === '\n' || state.src[end] === '`') return false
    if (state.src[end] === '\\') end++
    end++
  }
  if (end >= state.posMax || end - begin > 8000 || end === begin) return false
  if (!bracket && (/\s/u.test(state.src[end - 1]!) || /\d/u.test(state.src[end + 1] ?? ''))) return false
  if (!silent) { const token = state.push('math_inline', 'math', 0); token.content = state.src.slice(begin, end) }
  state.pos = end + (bracket ? 2 : 1)
  return true
})
for (const name of ['math_inline', 'math_inline_double', 'math_block', 'math_block_eqno']) {
  markdown.renderer.rules[name] = (tokens, index) => {
    const token = tokens[index]!
    const display = name !== 'math_inline'
    const tag = name.startsWith('math_block') ? 'div' : 'span'
    return `<${tag} class="math-source${display ? ' math-display' : ''}">${markdown.utils.escapeHtml(token.content)}</${tag}>`
  }
}
const originalFence = markdown.renderer.rules.fence!
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => tokens[index]!.info.trim().toLowerCase() === 'math'
  ? `<div class="math-source math-display">${markdown.utils.escapeHtml(tokens[index]!.content)}</div>\n`
  : originalFence(tokens, index, options, env, renderer)

/**
 * Converts Markdown to untrusted HTML. Callers must sanitize the result before
 * inserting it into the DOM; DOM filtering belongs to the later preview stage.
 */
export function renderMarkdown(text: string): string {
  return markdown.render(text)
}
