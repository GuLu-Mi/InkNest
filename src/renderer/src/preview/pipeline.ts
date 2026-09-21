import { isLocalImageLink } from './link-actions'
import { copy, resourceCopy } from '../../../shared/copy'
import type { InkNestAPI, SessionRef, ResourceReference, ResolvedResource } from '../../../shared/contracts'
import { parseDocument, type ParsedDocument, type PreviewImage } from './document-model'
import { sanitizePreview } from './sanitize'

export async function buildPreview(source: string | ParsedDocument, ref: SessionRef | null, api: InkNestAPI): Promise<ParsedDocument> {
  const parsed = typeof source === 'string' ? parseDocument(source) : source
  // Template contents are inert: original image URLs never enter the active DOM.
  const template = document.createElement('template')
  template.innerHTML = parsed.html
  const images = [...template.content.querySelectorAll('img')]
  const gallery: PreviewImage[] = [...template.content.querySelectorAll('a,img')].flatMap(node => {
    const target = node.getAttribute(node.tagName === 'IMG' ? 'src' : 'href') ?? ''
    return isLocalImageLink(target) ? [{ target, label: node.getAttribute('alt') || node.textContent || '图片', url: '', failed: false }] : []
  }).filter((item, index, all) => all.findIndex(other => other.target === item.target) === index)
  const refs: ResourceReference[] = images.map((img, index) => ({ key: String(index), rawTarget: img.getAttribute('src') ?? '' }))
  for (const img of images) img.removeAttribute('src')
  for (let offset = 0; offset < refs.length; offset += 200) {
    const batch = refs.slice(offset, offset + 200)
    const result = ref ? await api.resolveResources({ docId: ref.docId, epoch: ref.epoch }, batch) : { status: 'cancelled' as const }
    const mapped = result.status === 'ok' ? new Map(result.value.map((item) => [item.key, item])) : new Map<string, ResolvedResource>()
    for (const resource of batch) {
      const img = images[Number(resource.key)]!
      const resolved = mapped.get(resource.key)
      const item = gallery.find(item => item.target === resource.rawTarget)
      if (item) { item.url = resolved?.url ?? ''; item.failed = !resolved?.url }
      if (resolved?.url && /^inknest-resource:\/\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/u.test(resolved.url)) img.setAttribute('src', resolved.url)
      else {
        const placeholder = document.createElement('span')
        placeholder.textContent = `[${img.alt || copy.image}] ${resourceCopy[resolved?.blockedReason ?? 'unavailable']}`
        placeholder.dataset.searchIgnore = ''
        if (resolved?.blockedReason === 'path' && isLocalImageLink(resource.rawTarget) && !img.closest('a')) {
          const action = document.createElement('a')
          action.setAttribute('href', resource.rawTarget); action.textContent = '打开图片'
          placeholder.append(' ', action)
        }
        img.replaceWith(placeholder)
      }
    }
  }
  const links = [...template.content.querySelectorAll('a')].map(anchor => anchor.getAttribute('href') ?? '')
  for (const anchor of template.content.querySelectorAll('a')) {
    anchor.removeAttribute('href')
    anchor.removeAttribute('title')
  }
  const ignored = new Set([...template.content.querySelectorAll('span')].flatMap((span, index) => span.hasAttribute('data-search-ignore') ? [index] : []))
  // Record only parser-generated marker positions. Sanitization removes the
  // temporary attributes; restore app-owned IDs by position, never source IDs.
  const anchorTargets = new Map([...template.content.querySelectorAll('span')].flatMap((span, index) => {
    const marker = span.getAttribute('data-inknest-anchor')
    const entry = marker !== null && /^\d+$/u.test(marker) ? parsed.anchors?.[Number(marker)] : undefined
    return entry && /^inknest-anchor-\d+$/u.test(entry.id) && !span.textContent ? [[index, entry.id] as const] : []
  }))
  // Sanitize the document before adding app-owned scroll containers and focus targets.
  template.innerHTML = sanitizePreview(template.innerHTML)
  for (const [index, span] of [...template.content.querySelectorAll('span')].entries()) {
    if (ignored.has(index)) span.dataset.searchIgnore = ''
    const id = anchorTargets.get(index)
    if (id) { span.id = id; span.tabIndex = -1 }
  }
  for (const [index, anchor] of [...template.content.querySelectorAll('a')].entries()) {
    anchor.dataset.linkIndex = String(index); anchor.tabIndex = 0; anchor.setAttribute('role', 'link')
    anchor.title = isLocalImageLink(links[index] ?? '') ? '单击查看图片' : /Mac/.test(navigator.platform) ? 'Command＋单击打开链接' : 'Ctrl＋单击打开链接'
  }
  for (const image of template.content.querySelectorAll('img')) { image.tabIndex = 0; image.setAttribute('role', 'button'); image.title = '单击查看图片'; image.draggable = false }
  for (const [index, heading] of [...template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')].entries()) {
    const entry = parsed.headings[index]
    if (entry && heading.tagName.toLowerCase() === `h${entry.level}`) { heading.id = entry.id; (heading as HTMLElement).tabIndex = -1 }
  }
  for (const table of template.content.querySelectorAll('table')) {
    const wrapper = document.createElement('div')
    wrapper.className = 'table-scroll'; wrapper.tabIndex = 0
    wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', copy.table)
    table.replaceWith(wrapper); wrapper.append(table)
  }
  for (const code of template.content.querySelectorAll('td code')) if ((code.textContent?.length ?? 0) > 64) code.className = 'long-token'
  for (const code of template.content.querySelectorAll('pre')) code.tabIndex = 0
  return { html: template.innerHTML, headings: parsed.headings, anchors: parsed.anchors ?? [], links, images: gallery }
}
