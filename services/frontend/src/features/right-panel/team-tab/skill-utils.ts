/**
 * Skill helpers: labels, npx recipe parsing, tag normalisation and market
 * filtering. Pure functions used by the skill management components.
 */

import type { Skill, SkillMarketplaceEntry, SkillPatch } from '../../../services/backendApi'

export function skillLabel(skill: Skill): string {
  return skill.public_name || skill.name
}

export function customNpxCommand(source: string, skillName: string): string {
  if (!source) return ''
  const parts = ['npx', '--yes', 'skills', 'add', source]
  if (skillName && !isDirectSkillSource(source)) {
    parts.push('--skill', skillName)
  }
  parts.push('--agent', 'codex', '--copy', '--yes')
  return parts.join(' ')
}

export function isDirectSkillSource(source: string): boolean {
  return source.includes('github.com/') && source.includes('/tree/')
}

export function parseSkillAddCommand(command: string): { source: string; skillName: string } | null {
  const parts = splitCommand(command)
  const skillsIndex = parts.findIndex((part, index) => part === 'skills' && parts[index + 1] === 'add')
  if (skillsIndex < 0 || !parts[skillsIndex + 2]) return null
  const rest = parts.slice(skillsIndex + 3)
  let skillName = ''
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (part === '--skill' && rest[index + 1]) {
      skillName = rest[index + 1]
      break
    }
    if (part.startsWith('--skill=')) {
      skillName = part.slice('--skill='.length)
      break
    }
  }
  return { source: parts[skillsIndex + 2], skillName }
}

function splitCommand(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ''))
}

export function recipePreviewName(source: string, skillName: string, command: string): string {
  const parsed = command ? parseSkillAddCommand(command) : null
  const resolvedSource = source || parsed?.source || ''
  const resolvedSkill = skillName || parsed?.skillName || ''
  const github = resolvedSource.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/)
  if (github) {
    const tail = github[2].replace(/\/$/, '').split('/').pop()?.replace(/\.git$/, '') ?? ''
    if (tail.includes('@')) return tail
    if (resolvedSkill) return `${github[1]}@${resolvedSkill}`
  }
  return resolvedSkill || inferSkillNameFromSource(resolvedSource)
}

export function skillPillLabel(skill: Skill, pendingShare = false): string {
  if (skill.visibility === 'system' || skill.source === 'bundled') return '内置'
  if (skill.source === 'project') return '项目'
  if (skill.source === 'marketplace') return '市场'
  if (skill.source === 'custom') return '自定义 npx'
  if (skill.visibility === 'public') return pendingShare ? '共享·待更新' : '共享'
  return '私有'
}

export function skillPillTone(skill: Skill): string {
  if (skill.visibility === 'public' || skill.source === 'bundled' || skill.source === 'marketplace') return 'ok'
  if (skill.source === 'project') return 'ok'
  if (skill.source === 'custom') return 'neutral'
  return ''
}

export function normalizeTagText(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

export function skillPatchChanged(skill: Skill, patch: SkillPatch): boolean {
  const currentTags = [...(skill.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort()
  const nextTags = [...(patch.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort()
  return (
    (skill.description ?? '').trim() !== (patch.description ?? '').trim() ||
    (skill.content ?? '').trim() !== (patch.content ?? '').trim() ||
    currentTags.join('\n') !== nextTags.join('\n')
  )
}

export function inferSkillName(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim() || 'SKILL'
    if (trimmed.toLowerCase().startsWith('name:')) return trimmed.split(':').slice(1).join(':').trim() || 'SKILL'
  }
  return 'SKILL'
}

export function inferSkillNameFromSource(source: string): string {
  const cleaned = source.trim().replace(/\/$/, '')
  const last = cleaned.split('/').pop()?.replace(/\.git$/, '')
  return last || 'custom-skill'
}

export function skillMarketMatches(entry: SkillMarketplaceEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    entry.id,
    entry.name,
    entry.display_name,
    entry.author_github,
    entry.description,
    entry.license,
    ...(entry.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}
