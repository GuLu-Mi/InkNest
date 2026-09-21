import MarkdownIt from 'markdown-it'

export const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
})

/**
 * Converts Markdown to untrusted HTML. Callers must sanitize the result before
 * inserting it into the DOM; DOM filtering belongs to the later preview stage.
 */
export function renderMarkdown(text: string): string {
  return markdown.render(text)
}
