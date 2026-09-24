let nextCodeId = 0

export function setCodeExpanded(wrapper: HTMLElement, expanded: boolean): void {
  wrapper.classList.toggle('code-expanded', expanded)
  wrapper.classList.toggle('code-collapsed', !expanded)
  const toggle = wrapper.querySelector<HTMLButtonElement>('[data-code-action="fold"]')
  if (toggle) { toggle.textContent = expanded ? '收起代码' : '展开代码'; toggle.setAttribute('aria-expanded', String(expanded)) }
}

/** Observe natural code height, not the clipped viewport, including closed details and reflow. */
export function observeCodeFolding(signal: AbortSignal): (wrapper: HTMLElement, pre: HTMLPreElement) => void {
  const observer = new ResizeObserver(entries => {
    if (signal.aborted) return
    for (const { target } of entries) {
      const pre = target as HTMLPreElement
      const wrapper = pre.closest<HTMLElement>('.code-block')
      if (!wrapper) continue
      const footer = wrapper.querySelector<HTMLElement>('.code-footer')!
      const limit = Number.parseFloat(getComputedStyle(wrapper).getPropertyValue('--code-preview-height'))
      const tall = pre.getBoundingClientRect().height > limit + 1
      footer.hidden = !tall
      wrapper.classList.toggle('code-collapsed', tall && !wrapper.classList.contains('code-expanded'))
    }
  })
  signal.addEventListener('abort', () => observer.disconnect(), { once: true })
  return (wrapper, pre) => {
    if (signal.aborted) return
    if (!wrapper.querySelector('.code-content')) {
      const content = document.createElement('div'); content.className = 'code-content'; content.id = `inknest-code-${++nextCodeId}`
      pre.replaceWith(content); content.append(pre)
      const footer = document.createElement('div'); footer.className = 'code-footer'; footer.dataset.searchIgnore = ''; footer.hidden = true
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.codeAction = 'fold'
      toggle.textContent = '展开代码'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', content.id)
      footer.append(toggle); wrapper.append(footer)
    }
    observer.observe(pre)
  }
}

/** Code remains searchable in full; navigating to clipped text reveals it first. */
export function revealCodeRange(range: Range): void {
  const wrapper = range.startContainer.parentElement?.closest<HTMLElement>('.code-collapsed')
  const viewport = wrapper?.querySelector('.code-content')
  if (wrapper && viewport && range.getBoundingClientRect().bottom > viewport.getBoundingClientRect().bottom) setCodeExpanded(wrapper, true)
}
