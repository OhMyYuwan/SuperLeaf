import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectsApi, type ProjectSkillCacheResult, type ProjectSummary } from '../services/projectsApi'
import type { Skill } from '../services/backendApi'
import { useNativeAgentStore } from '../stores/nativeAgentStore'
import { useProjectStore } from '../stores/projectStore'

vi.mock('../services/projectsApi', () => ({
  projectsApi: {
    list: vi.fn(),
    updateSkillCache: vi.fn(),
  },
}))

const mockListProjects = vi.mocked(projectsApi.list)
const mockUpdateSkillCache = vi.mocked(projectsApi.updateSkillCache)

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1',
    user_id: 'user-1',
    name: 'Paper Skill',
    main_doc_id: 'doc-1',
    compiler: 'latexmk',
    project_type: 'skill',
    is_skill_project: true,
    project_skill_id: 'skill-1',
    skill_cache_version: 1,
    skill_cache_updated_at: '2026-06-08T10:00:00Z',
    created_at: '2026-06-08T09:00:00Z',
    updated_at: '2026-06-08T10:00:00Z',
    my_role: 'owner',
    ...overrides,
  }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    owner_user_id: 'user-1',
    name: 'paper-skill',
    public_name: 'Paper Skill',
    description: 'Project-backed Skill',
    content: '',
    visibility: 'private',
    source: 'project',
    project_id: 'project-1',
    cache_version: 1,
    cache_updated_at: '2026-06-08T10:00:00Z',
    version: 1,
    tags: [],
    can_edit: false,
    used_by_agent_count: 0,
    created_at: '2026-06-08T09:00:00Z',
    updated_at: '2026-06-08T10:00:00Z',
    published_at: null,
    ...overrides,
  }
}

describe('project Skill cache store update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [makeProject()],
      currentProjectId: 'project-1',
      currentProjectRole: 'owner',
      loading: false,
      loaded: true,
      error: null,
    })
    useNativeAgentStore.setState({
      skills: [makeSkill()],
      loading: false,
      loaded: true,
      error: null,
    })
  })

  it('merges the returned project and Skill without reloading project lists', async () => {
    const result: ProjectSkillCacheResult = {
      project: makeProject({
        skill_cache_version: 2,
        skill_cache_updated_at: '2026-06-08T11:00:00Z',
        updated_at: '2026-06-08T11:00:00Z',
      }),
      skill: makeSkill({
        cache_version: 2,
        cache_updated_at: '2026-06-08T11:00:00Z',
        version: 2,
        updated_at: '2026-06-08T11:00:00Z',
      }),
    }
    mockUpdateSkillCache.mockResolvedValue(result)

    const updated = await useProjectStore.getState().updateSkillCache('project-1')

    expect(mockUpdateSkillCache).toHaveBeenCalledWith('project-1')
    expect(mockListProjects).not.toHaveBeenCalled()
    expect(updated).toBe(result)
    expect(useProjectStore.getState().projects[0].skill_cache_version).toBe(2)
    expect(useProjectStore.getState().projects[0].skill_cache_updated_at).toBe('2026-06-08T11:00:00Z')
    expect(useProjectStore.getState().currentProjectRole).toBe('owner')
    expect(useNativeAgentStore.getState().skills[0].cache_version).toBe(2)
    expect(useNativeAgentStore.getState().skills[0].cache_updated_at).toBe('2026-06-08T11:00:00Z')
  })
})
