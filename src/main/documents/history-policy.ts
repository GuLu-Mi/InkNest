export interface AutoGroup { startedAt: number; owner: string; path: string; sealed: boolean; snapshot: string }
export function canMergeAuto(group: Omit<AutoGroup, 'snapshot'> | null, owner: string, path: string, now: number): boolean {
  return group !== null && !group.sealed && group.owner === owner && group.path === path
    && now >= group.startedAt && now - group.startedAt < 60_000
}
