import { create } from 'zustand'
import {
  BackendError,
  nativeAgentApi,
  type NativeAgent,
  type NativeAgentCredential,
  type NativeAgentCredentialDraft,
  type NativeAgentCredentialPatch,
  type NativeAgentDraft,
  type McpCatalog,
  type McpExecutionPolicy,
  type McpProbeResult,
  type NativeAgentPatch,
  type NativeMcpServerConfig,
  type NativeMcpServerConfigDraft,
  type NativeMcpServerConfigPatch,
  type NativeAgentSkillInstall,
  type NativeAgentSkillRecipe,
  type Skill,
  type SkillDraft,
  type SkillMarketplace,
  type SkillMarketplaceEntry,
  type SkillPatch,
  type SkillRecipeDraft,
} from '../services/backendApi'

interface NativeAgentState {
  credentials: NativeAgentCredential[]
  skills: Skill[]
  marketplace: SkillMarketplace | null
  marketplaceLoading: boolean
  marketplaceError: string | null
  mcpCatalog: McpCatalog | null
  mcpCatalogLoading: boolean
  mcpCatalogError: string | null
  mcpPolicy: McpExecutionPolicy | null
  mcpPolicyLoading: boolean
  mcpPolicyError: string | null
  mcpServers: NativeMcpServerConfig[]
  mcpServersLoading: boolean
  mcpServersLoaded: boolean
  mcpServersError: string | null
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
  createRecipeSkill: (draft: SkillRecipeDraft) => Promise<Skill | null>
  updateSkill: (id: string, patch: SkillPatch) => Promise<Skill | null>
  publishSkill: (id: string) => Promise<Skill | null>
  unpublishSkill: (id: string) => Promise<Skill | null>
  removeSkill: (id: string) => Promise<boolean>
  loadMarketplace: () => Promise<SkillMarketplace | null>
  loadMcpPolicy: () => Promise<McpExecutionPolicy | null>
  loadMcpCatalog: () => Promise<McpCatalog | null>
  loadMcpServers: () => Promise<NativeMcpServerConfig[] | null>
  createMcpServer: (draft: NativeMcpServerConfigDraft) => Promise<NativeMcpServerConfig | null>
  ensureMcpPresetServer: (presetId: string, env?: Record<string, string>) => Promise<NativeMcpServerConfig | null>
  updateMcpServer: (id: string, patch: NativeMcpServerConfigPatch) => Promise<NativeMcpServerConfig | null>
  deleteMcpServer: (id: string) => Promise<boolean>
  probeMcpServer: (id: string) => Promise<McpProbeResult | null>
  installMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  updateMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  uninstallMarketplaceSkill: (id: string) => Promise<boolean>
  cloneMarketplaceSkillToLocal: (id: string, name: string) => Promise<Skill | null>
  createAgent: (draft: NativeAgentDraft) => Promise<NativeAgent | null>
  updateAgent: (id: string, patch: NativeAgentPatch) => Promise<NativeAgent | null>
  installAgentSkill: (id: string, recipe: NativeAgentSkillRecipe) => Promise<NativeAgentSkillInstall | null>
  removeAgent: (id: string) => Promise<boolean>
  resetAgents: () => void
}

export const useNativeAgentStore = create<NativeAgentState>((set, get) => ({
  credentials: [],
  skills: [],
  marketplace: null,
  marketplaceLoading: false,
  marketplaceError: null,
  mcpCatalog: null,
  mcpCatalogLoading: false,
  mcpCatalogError: null,
  mcpPolicy: null,
  mcpPolicyLoading: false,
  mcpPolicyError: null,
  mcpServers: [],
  mcpServersLoading: false,
  mcpServersLoaded: false,
  mcpServersError: null,
  agents: [],
  loading: false,
  loaded: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null })
    try {
      const [credentials, agents] = await Promise.all([
        nativeAgentApi.credentials.list(),
        nativeAgentApi.agents.list(),
      ])
      const skills = await nativeAgentApi.skills.list()
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

  createRecipeSkill: async (draft) => {
    try {
      const row = await nativeAgentApi.skills.createRecipe(draft)
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

  loadMarketplace: async () => {
    set({ marketplaceLoading: true, marketplaceError: null })
    try {
      const marketplace = await nativeAgentApi.marketplace.list()
      set({ marketplace, marketplaceLoading: false, marketplaceError: null })
      return marketplace
    } catch (err) {
      set({ marketplaceLoading: false, marketplaceError: toErrorMessage(err) })
      return null
    }
  },

  loadMcpPolicy: async () => {
    set({ mcpPolicyLoading: true, mcpPolicyError: null })
    try {
      const policy = await nativeAgentApi.mcp.policy()
      set({ mcpPolicy: policy, mcpPolicyLoading: false, mcpPolicyError: null })
      return policy
    } catch (err) {
      set({ mcpPolicyLoading: false, mcpPolicyError: toErrorMessage(err) })
      return null
    }
  },

  loadMcpCatalog: async () => {
    set({ mcpCatalogLoading: true, mcpCatalogError: null })
    try {
      const catalog = await nativeAgentApi.mcp.catalog()
      set({ mcpCatalog: catalog, mcpCatalogLoading: false, mcpCatalogError: null })
      return catalog
    } catch (err) {
      set({ mcpCatalogLoading: false, mcpCatalogError: toErrorMessage(err) })
      return null
    }
  },

  loadMcpServers: async () => {
    set({ mcpServersLoading: true, mcpServersError: null })
    try {
      const mcpServers = await nativeAgentApi.mcp.servers()
      set({ mcpServers, mcpServersLoading: false, mcpServersLoaded: true, mcpServersError: null })
      return mcpServers
    } catch (err) {
      set({ mcpServersLoading: false, mcpServersLoaded: true, mcpServersError: toErrorMessage(err) })
      return null
    }
  },

  createMcpServer: async (draft) => {
    try {
      const row = await nativeAgentApi.mcp.createServer(draft)
      set({ mcpServers: mergeById(get().mcpServers, row), mcpServersError: null })
      return row
    } catch (err) {
      set({ mcpServersError: toErrorMessage(err) })
      return null
    }
  },

  ensureMcpPresetServer: async (presetId, env) => {
    try {
      const row = await nativeAgentApi.mcp.ensurePresetServer(presetId, { env })
      set({ mcpServers: mergeById(get().mcpServers, row), mcpServersError: null })
      return row
    } catch (err) {
      set({ mcpServersError: toErrorMessage(err) })
      return null
    }
  },

  updateMcpServer: async (id, patch) => {
    try {
      const row = await nativeAgentApi.mcp.updateServer(id, patch)
      set({ mcpServers: mergeById(get().mcpServers, row), mcpServersError: null })
      return row
    } catch (err) {
      set({ mcpServersError: toErrorMessage(err) })
      return null
    }
  },

  deleteMcpServer: async (id) => {
    try {
      await nativeAgentApi.mcp.deleteServer(id)
      set({ mcpServers: get().mcpServers.filter((item) => item.id !== id), mcpServersError: null })
      return true
    } catch (err) {
      set({ mcpServersError: toErrorMessage(err) })
      return false
    }
  },

  probeMcpServer: async (id) => {
    try {
      const result = await nativeAgentApi.mcp.probeServer(id)
      const refreshed = await nativeAgentApi.mcp.servers()
      set({ mcpServers: refreshed, mcpServersError: null })
      return result
    } catch (err) {
      set({ mcpServersError: toErrorMessage(err) })
      return null
    }
  },

  installMarketplaceSkill: async (id) => {
    try {
      const result = await nativeAgentApi.marketplace.install(id)
      set({
        skills: mergeById(get().skills, result.skill),
        marketplace: patchMarketplaceEntry(get().marketplace, result.marketplace_entry),
        marketplaceError: null,
      })
      return result.marketplace_entry
    } catch (err) {
      set({ marketplaceError: toErrorMessage(err) })
      return null
    }
  },

  updateMarketplaceSkill: async (id) => {
    try {
      const result = await nativeAgentApi.marketplace.update(id)
      set({
        skills: mergeById(get().skills, result.skill),
        marketplace: patchMarketplaceEntry(get().marketplace, result.marketplace_entry),
        marketplaceError: null,
      })
      return result.marketplace_entry
    } catch (err) {
      set({ marketplaceError: toErrorMessage(err) })
      return null
    }
  },

  uninstallMarketplaceSkill: async (id) => {
    try {
      await nativeAgentApi.marketplace.uninstall(id)
      const currentEntry = get().marketplace?.skills.find((item) => item.id === id)
      const installedId = currentEntry?.installed_skill_id
      set({
        skills: installedId ? get().skills.filter((item) => item.id !== installedId) : get().skills,
        marketplace: currentEntry
          ? patchMarketplaceEntry(get().marketplace, {
            ...currentEntry,
            installed: false,
            installed_skill_id: null,
            installed_version: '',
            update_available: false,
          })
          : get().marketplace,
        marketplaceError: null,
      })
      return true
    } catch (err) {
      set({ marketplaceError: toErrorMessage(err) })
      return false
    }
  },

  cloneMarketplaceSkillToLocal: async (id, name) => {
    try {
      const result = await nativeAgentApi.marketplace.cloneToLocal(id, name)
      const currentEntry = get().marketplace?.skills.find((item) => item.id === id)
      set({
        skills: mergeById(get().skills, result.skill),
        marketplace: currentEntry
          ? patchMarketplaceEntry(get().marketplace, {
            ...currentEntry,
            installed: false,
            installed_skill_id: null,
            installed_version: '',
            update_available: false,
          })
          : get().marketplace,
        marketplaceError: null,
      })
      return result.skill
    } catch (err) {
      set({ marketplaceError: toErrorMessage(err) })
      return null
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

  installAgentSkill: async (id, recipe) => {
    try {
      const row = await nativeAgentApi.agents.installSkill(id, recipe)
      const refreshed = await nativeAgentApi.agents.list()
      set({ agents: refreshed, error: null })
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

  resetAgents: () => set({ agents: [], loaded: false, error: null }),
}))

function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const found = items.some((item) => item.id === next.id)
  if (!found) return [next, ...items]
  return items.map((item) => (item.id === next.id ? next : item))
}

function patchMarketplaceEntry(
  marketplace: SkillMarketplace | null,
  next: SkillMarketplaceEntry,
): SkillMarketplace | null {
  if (!marketplace || !next) return marketplace
  return {
    ...marketplace,
    skills: marketplace.skills.map((item) => (item.id === next.id ? next : item)),
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof BackendError) return err.detail || err.message
  return err instanceof Error ? err.message : '原生 Agent 操作失败'
}
