import { create } from 'zustand'
import {
  nativeAgentApi,
  type NativeAgent,
  type NativeAgentCredential,
  type NativeAgentCredentialDraft,
  type NativeAgentCredentialPatch,
  type NativeAgentDraft,
  type NativeAgentPatch,
  type Skill,
  type SkillDraft,
  type SkillPatch,
} from '../services/backendApi'

interface NativeAgentState {
  credentials: NativeAgentCredential[]
  skills: Skill[]
  agents: NativeAgent[]
  loading: boolean
  loaded: boolean
  error: string | null
  loadAll: () => Promise<void>
  createCredential: (draft: NativeAgentCredentialDraft) => Promise<NativeAgentCredential | null>
  updateCredential: (id: string, patch: NativeAgentCredentialPatch) => Promise<NativeAgentCredential | null>
  removeCredential: (id: string) => Promise<boolean>
  probeCredential: (id: string) => Promise<NativeAgentCredential | null>
  createSkill: (draft: SkillDraft) => Promise<Skill | null>
  updateSkill: (id: string, patch: SkillPatch) => Promise<Skill | null>
  publishSkill: (id: string) => Promise<Skill | null>
  unpublishSkill: (id: string) => Promise<Skill | null>
  removeSkill: (id: string) => Promise<boolean>
  createAgent: (draft: NativeAgentDraft) => Promise<NativeAgent | null>
  updateAgent: (id: string, patch: NativeAgentPatch) => Promise<NativeAgent | null>
  removeAgent: (id: string) => Promise<boolean>
}

export const useNativeAgentStore = create<NativeAgentState>((set, get) => ({
  credentials: [],
  skills: [],
  agents: [],
  loading: false,
  loaded: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null })
    try {
      const [credentials, skills, agents] = await Promise.all([
        nativeAgentApi.credentials.list(),
        nativeAgentApi.skills.list(),
        nativeAgentApi.agents.list(),
      ])
      set({ credentials, skills, agents, loading: false, loaded: true })
    } catch (err) {
      set({ loading: false, error: toErrorMessage(err) })
    }
  },

  createCredential: async (draft) => {
    try {
      const row = await nativeAgentApi.credentials.create(draft)
      set({ credentials: [...get().credentials, row], error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  updateCredential: async (id, patch) => {
    try {
      const row = await nativeAgentApi.credentials.update(id, patch)
      set({ credentials: mergeById(get().credentials, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  removeCredential: async (id) => {
    try {
      await nativeAgentApi.credentials.remove(id)
      set({ credentials: get().credentials.filter((item) => item.id !== id), error: null })
      return true
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return false
    }
  },

  probeCredential: async (id) => {
    try {
      const row = await nativeAgentApi.credentials.probe(id)
      set({ credentials: mergeById(get().credentials, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  createSkill: async (draft) => {
    try {
      const row = await nativeAgentApi.skills.create(draft)
      set({ skills: mergeById(get().skills, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  updateSkill: async (id, patch) => {
    try {
      const row = await nativeAgentApi.skills.update(id, patch)
      set({ skills: mergeById(get().skills, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  publishSkill: async (id) => {
    try {
      const row = await nativeAgentApi.skills.publish(id)
      set({ skills: mergeById(get().skills, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  unpublishSkill: async (id) => {
    try {
      const row = await nativeAgentApi.skills.unpublish(id)
      set({ skills: mergeById(get().skills, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  removeSkill: async (id) => {
    try {
      await nativeAgentApi.skills.remove(id)
      set({ skills: get().skills.filter((item) => item.id !== id), error: null })
      return true
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return false
    }
  },

  createAgent: async (draft) => {
    try {
      const row = await nativeAgentApi.agents.create(draft)
      set({ agents: mergeById(get().agents, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  updateAgent: async (id, patch) => {
    try {
      const row = await nativeAgentApi.agents.update(id, patch)
      set({ agents: mergeById(get().agents, row), error: null })
      return row
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return null
    }
  },

  removeAgent: async (id) => {
    try {
      await nativeAgentApi.agents.remove(id)
      set({ agents: get().agents.filter((item) => item.id !== id), error: null })
      return true
    } catch (err) {
      set({ error: toErrorMessage(err) })
      return false
    }
  },
}))

function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const found = items.some((item) => item.id === next.id)
  if (!found) return [next, ...items]
  return items.map((item) => (item.id === next.id ? next : item))
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '原生 Agent 操作失败'
}
