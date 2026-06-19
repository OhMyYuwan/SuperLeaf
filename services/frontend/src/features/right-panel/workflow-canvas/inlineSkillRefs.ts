import type { Skill } from '../../../services/backendApi'

export interface InlineAgentSkillRef {
  alias: string
  skill_id?: string
  source_skill_id?: string
  release_id?: string
  namespace?: string
  slug?: string
  version?: string
  checksum?: string
  display_name?: string
  source?: string
  marketplace_id?: string
  install_command?: string
}

export function readInlineSkillRefs(value: unknown): InlineAgentSkillRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isPlainObject(item)) return []
    const skillId = stringValue(item.skill_id)
    const sourceSkillId = stringValue(item.source_skill_id)
    const releaseId = stringValue(item.release_id)
    if (!skillId && !releaseId) return []
    const displayName = stringValue(item.display_name)
    return [{
      alias: normalizeInlineSkillAlias(
        stringValue(item.alias) || displayName || stringValue(item.slug) || skillId || sourceSkillId || releaseId,
      ),
      skill_id: skillId || undefined,
      source_skill_id: sourceSkillId || undefined,
      release_id: releaseId || undefined,
      namespace: stringValue(item.namespace) || undefined,
      slug: stringValue(item.slug) || undefined,
      version: stringValue(item.version) || undefined,
      checksum: stringValue(item.checksum) || undefined,
      display_name: displayName || undefined,
      source: stringValue(item.source) || undefined,
      marketplace_id: stringValue(item.marketplace_id) || undefined,
      install_command: stringValue(item.install_command) || undefined,
    }]
  })
}

export function addInlineSkillRef(current: InlineAgentSkillRef[], skill: Skill): InlineAgentSkillRef[] {
  const displayName = skill.public_name || skill.name
  const alias = uniqueAlias(normalizeInlineSkillAlias(displayName), current)
  const installMetadata = releaseInstallMetadata(skill)
  return [
    ...current,
    {
      alias,
      skill_id: skill.release_id ? undefined : skill.id,
      source_skill_id: skill.release_id ? skill.id : undefined,
      release_id: skill.release_id || undefined,
      version: skill.release_version || undefined,
      checksum: skill.release_checksum || undefined,
      display_name: displayName,
      source: skill.source,
      marketplace_id: installMetadata.marketplace_id || undefined,
      install_command: installMetadata.install_command || undefined,
    },
  ]
}

export function updateInlineSkillRefAlias(
  current: InlineAgentSkillRef[],
  index: number,
  alias: string,
): InlineAgentSkillRef[] {
  return current.map((item, itemIndex) => {
    if (itemIndex !== index) return item
    return { ...item, alias: uniqueAlias(normalizeInlineSkillAlias(alias), current, index) }
  })
}

export function removeInlineSkillRef(current: InlineAgentSkillRef[], index: number): InlineAgentSkillRef[] {
  return current.filter((_, itemIndex) => itemIndex !== index)
}

export function inlineSkillRefKey(ref: InlineAgentSkillRef): string {
  if (ref.skill_id) return `skill:${ref.skill_id}`
  if (ref.source_skill_id) return `source-skill:${ref.source_skill_id}`
  return `release:${ref.release_id ?? ref.alias}`
}

export function normalizeInlineSkillAlias(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'skill'
}

function uniqueAlias(alias: string, current: InlineAgentSkillRef[], ignoreIndex = -1): string {
  const used = new Set(
    current
      .map((item, index) => (index === ignoreIndex ? '' : item.alias))
      .filter(Boolean),
  )
  if (!used.has(alias)) return alias
  for (let index = 2; index < 1000; index += 1) {
    const next = `${alias}-${index}`
    if (!used.has(next)) return next
  }
  return `${alias}-${Date.now()}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function releaseInstallMetadata(skill: Skill): Pick<InlineAgentSkillRef, 'marketplace_id' | 'install_command'> {
  const parsed = parseInstallSpec(skill.release_install_spec)
  return {
    marketplace_id: stringValue(parsed.marketplace_id) || (skill.source === 'marketplace' ? skill.public_name : ''),
    install_command: stringValue(parsed.install_command),
  }
}

function parseInstallSpec(value: unknown): Record<string, unknown> {
  const text = stringValue(value)
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
