const paths: Record<string, string> = {
  note: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v.2',
  tip: 'M9 18h6 M10 21h4 M9 15c0-2-3-3-3-6a6 6 0 0 1 12 0c0 3-3 4-3 6v1H9z',
  important: 'M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7l-5 3v-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M12 7v5 M12 15v.2',
  warning: 'M10.3 4a2 2 0 0 1 3.4 0l7.6 13.5a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3z M12 9v5 M12 17v.2',
  caution: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z M12 7v6 M12 16v.2'
}

/** Fixed application icons, added only after document HTML has been sanitized. */
export function decorateAlerts(root: DocumentFragment): void {
  for (const title of root.querySelectorAll('.markdown-alert > .alert-title')) {
    const type = Object.keys(paths).find(type => title.parentElement?.classList.contains(`markdown-alert-${type}`))
    if (!type) continue
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.classList.add('alert-icon'); icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false')
    const path = document.createElementNS(icon.namespaceURI, 'path')
    path.setAttribute('d', paths[type]!); icon.append(path); title.prepend(icon)
  }
}
