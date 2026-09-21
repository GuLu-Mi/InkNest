import type { HeadingEntry } from '../preview/document-model'
export class OutlineState {
  headings: HeadingEntry[] = []
  collapsed = new Set<string>()
  top = 0
  update(headings: HeadingEntry[]): void {
    const before = new Map([...identities(this.headings)].map(([id, identity]) => [identity, id])); const after = identities(headings)
    const next = new Set<string>()
    for (const heading of headings) {
      const target = after.get(heading.id)!
      const source = before.get(target)
      if (source && this.collapsed.has(source)) next.add(heading.id)
    }
    this.collapsed = next; this.headings = headings
  }
  toggle(id: string): void { if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id) }
  get visible(): HeadingEntry[] {
    const hidden = new Set<string>()
    return this.headings.filter(heading => {
      const hide = !!heading.parentId && (hidden.has(heading.parentId) || this.collapsed.has(heading.parentId))
      if (hide) hidden.add(heading.id)
      return !hide
    })
  }
  visibleActive(id: string): string {
    const visible = new Set(this.visible.map(heading => heading.id))
    let heading = this.headings.find(heading => heading.id === id)
    while (heading && !visible.has(heading.id)) heading = this.headings.find(item => item.id === heading!.parentId)
    return heading?.id ?? ''
  }
}

// A changed duplicate count invalidates the whole ambiguous path. Occurrence
// ordinals distinguish stable duplicates without matching an unrelated parent.
export function matchHeading(before: HeadingEntry[], after: HeadingEntry[], id: string): HeadingEntry | null {
  const identity = identities(before).get(id)
  const match = [...identities(after)].find(([, value]) => value === identity)?.[0]
  return after.find(heading => heading.id === match) ?? null
}
function identities(headings: HeadingEntry[]): Map<string, string> {
  const paths = new Map<string, string>(); const groups = new Map<string, HeadingEntry[]>()
  for (const heading of headings) {
    const path = JSON.stringify([heading.parentId ? paths.get(heading.parentId) : '', heading.level, heading.title])
    paths.set(heading.id, path)
    const group = groups.get(path) ?? []; group.push(heading); groups.set(path, group)
  }
  const result = new Map<string, string>(); const occurrences = new Map<string, number>()
  for (const heading of headings) {
    const path = paths.get(heading.id)!; const group = groups.get(path)!
    const occurrence = occurrences.get(path) ?? 0; occurrences.set(path, occurrence + 1)
    result.set(heading.id, JSON.stringify([heading.parentId ? result.get(heading.parentId) : '', path, group.length, occurrence]))
  }
  return result
}
