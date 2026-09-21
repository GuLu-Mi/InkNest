import DOMPurify from 'dompurify'

export function sanitizePreview(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'em', 'strong', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span', 'a', 'div', 'section', 'sup', 'sub', 'mark', 'kbd', 'dl', 'dt', 'dd', 'details', 'summary', 'input'],
    ALLOWED_ATTR: ['src', 'alt', 'title', 'start', 'class', 'type', 'checked', 'disabled', 'open'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['type', 'start'],
    ALLOWED_URI_REGEXP: /^inknest-resource:\/\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/u
  })
  const template = document.createElement('template')
  template.innerHTML = sanitized
  const known = /^(?:language-[a-zA-Z0-9_+-]{1,40}|contains-task-list|task-list-item|task-list-item-checkbox|footnote(?:s|s-sep|s-list|-item|-ref|-backref)|markdown-alert(?:-(?:note|tip|important|warning|caution))?|alert-title|document-metadata|math-source|math-display)$/u
  for (const element of template.content.querySelectorAll('[class]')) {
    for (const name of [...element.classList]) if (!known.test(name)) element.classList.remove(name)
    if (!element.classList.length) element.removeAttribute('class')
  }
  for (const input of template.content.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove()
    else input.disabled = true
  }
  return template.innerHTML
}
