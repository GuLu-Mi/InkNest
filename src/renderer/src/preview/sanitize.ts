import DOMPurify from 'dompurify'

export function sanitizePreview(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'em', 'strong', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span', 'a'],
    ALLOWED_ATTR: ['src', 'alt', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^inknest-resource:\/\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/u
  })
}
