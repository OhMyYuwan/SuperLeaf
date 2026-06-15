import type { ProjectSummary } from '../services/projectsApi'

export type ProjectListSortKey = 'updated' | 'name' | 'created'
export type ProjectListSortDirection = 'asc' | 'desc'

export interface ProjectListSort {
  key: ProjectListSortKey
  direction: ProjectListSortDirection
}

export function normalizeProjectTags(tags: readonly string[] | null | undefined): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const raw of tags ?? []) {
    const tag = String(raw).trim().slice(0, 32)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(tag)
    if (normalized.length >= 12) break
  }
  return normalized
}

export function filterProjectsByTag(
  projects: readonly ProjectSummary[],
  activeTag: string | null,
): ProjectSummary[] {
  const needle = activeTag?.trim().toLocaleLowerCase()
  if (!needle) return [...projects]
  return projects.filter((project) =>
    normalizeProjectTags(project.tags).some((tag) => tag.toLocaleLowerCase() === needle),
  )
}

export function sortProjects(
  projects: readonly ProjectSummary[],
  sort: ProjectListSort = { key: 'updated', direction: 'desc' },
): ProjectSummary[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...projects].sort((a, b) => {
    let comparison = 0
    if (sort.key === 'name') {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    } else if (sort.key === 'created') {
      comparison = compareTime(a.created_at, b.created_at)
    } else {
      comparison = compareTime(a.updated_at, b.updated_at)
    }
    if (comparison !== 0) return comparison * direction
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}

function compareTime(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime()
}
