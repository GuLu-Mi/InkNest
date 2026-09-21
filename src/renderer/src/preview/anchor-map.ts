import type { ExplicitAnchorEntry, HeadingEntry, ParsedDocument } from './document-model'
export function anchorId(headings: HeadingEntry[], fragment: string, anchors: ExplicitAnchorEntry[] = []): string | null {
  if (!fragment) return headings[0]?.id ?? null
  const explicit = anchors.find(anchor => anchor.name === fragment)
  if (explicit) return explicit.id
  const direct = headings.find(heading => heading.id === fragment)
  if (direct) return direct.id
  const counts = new Map<string, number>()
  for (const heading of headings) {
    const base = heading.title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').trim().replace(/\s/gu, '-')
    const count = counts.get(base) ?? 0; counts.set(base, count + 1)
    if ((count ? `${base}-${count}` : base) === fragment.normalize('NFC').toLowerCase()) return heading.id
  }
  return headings.find(heading => heading.title === fragment)?.id ?? null
}

/** Resolves both the safe DOM target and the original editor source location. */
export function resolveAnchor(parsed: ParsedDocument, fragment: string): { id: string; sourceLine: number } | null {
  const id = anchorId(parsed.headings, fragment, parsed.anchors)
  const entry = parsed.anchors?.find(anchor => anchor.id === id) ?? parsed.headings.find(heading => heading.id === id)
  return entry ? { id: entry.id, sourceLine: entry.sourceLine } : null
}
