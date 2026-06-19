import { describe, expect, it } from 'vitest'
import type { Skill } from '../../../services/backendApi'
import {
  addInlineSkillRef,
  readInlineSkillRefs,
  updateInlineSkillRefAlias,
} from './inlineSkillRefs'

describe('inline workflow Skill refs', () => {
  it('adds selected Skills with unique node-scoped aliases', () => {
    const first = addInlineSkillRef([], skill({ id: 'skill-a', name: 'Reviewer' }))
    const second = addInlineSkillRef(first, skill({ id: 'skill-b', name: 'Reviewer' }))

    expect(second).toEqual([
      expect.objectContaining({ alias: 'reviewer', skill_id: 'skill-a' }),
      expect.objectContaining({ alias: 'reviewer-2', skill_id: 'skill-b' }),
    ])
  })

  it('keeps release refs and drops invalid empty entries', () => {
    const refs = readInlineSkillRefs([
      {
        alias: 'official-reviewer',
        release_id: 'rel-1',
        namespace: 'official',
        marketplace_id: 'OhMyYuwan@reviewer',
        install_command: 'npx --yes skills add https://example.test/reviewer --agent codex --copy --yes',
      },
      { alias: '', skill_id: '' },
      null,
    ])

    expect(refs).toEqual([
      expect.objectContaining({
        alias: 'official-reviewer',
        release_id: 'rel-1',
        namespace: 'official',
        marketplace_id: 'OhMyYuwan@reviewer',
        install_command: 'npx --yes skills add https://example.test/reviewer --agent codex --copy --yes',
      }),
    ])
  })

  it('uses release refs for Skills backed by server cache releases', () => {
    const refs = addInlineSkillRef([], skill({
      id: 'skill-a',
      name: 'Reviewer',
      release_id: 'release-a',
      release_version: '1.0.0',
      release_checksum: 'abc123',
    }))

    expect(refs[0]).toEqual(expect.objectContaining({
      alias: 'reviewer',
      release_id: 'release-a',
      source_skill_id: 'skill-a',
      version: '1.0.0',
      checksum: 'abc123',
    }))
    expect(refs[0]?.skill_id).toBeUndefined()
  })

  it('copies marketplace install metadata from release install spec', () => {
    const refs = addInlineSkillRef([], skill({
      id: 'skill-a',
      name: 'Reviewer',
      source: 'marketplace',
      public_name: 'OhMyYuwan@reviewer',
      release_id: 'release-a',
      release_install_spec: JSON.stringify({
        marketplace_id: 'OhMyYuwan@reviewer',
        install_command: 'npx --yes skills add https://example.test/reviewer --agent codex --copy --yes',
      }),
    }))

    expect(refs[0]).toEqual(expect.objectContaining({
      marketplace_id: 'OhMyYuwan@reviewer',
      install_command: 'npx --yes skills add https://example.test/reviewer --agent codex --copy --yes',
    }))
  })

  it('normalizes edited aliases for projection folder names', () => {
    const refs = addInlineSkillRef([], skill({ id: 'skill-a', name: 'Draft Review' }))

    expect(updateInlineSkillRefAlias(refs, 0, 'Draft Review!!')[0]?.alias).toBe('draft-review')
  })
})

function skill(patch: Partial<Skill> & Pick<Skill, 'id' | 'name'>): Skill {
  return {
    owner_user_id: 'user-a',
    public_name: '',
    description: '',
    content: '',
    visibility: 'private',
    source: 'upload',
    project_id: '',
    cache_version: 1,
    cache_updated_at: null,
    version: 1,
    tags: [],
    can_edit: true,
    used_by_agent_count: 0,
    created_at: '2026-06-19T00:00:00Z',
    updated_at: '2026-06-19T00:00:00Z',
    published_at: null,
    ...patch,
  }
}
