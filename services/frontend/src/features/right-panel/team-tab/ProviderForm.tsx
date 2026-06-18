/**
 * ProviderForm — create a new provider (Dify / Claude / Nanobot / native /
 * Codex Local / Claude Local). Handles browser-side discovery and health
 * probing for the local-agent kinds before persisting.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ProviderDraft, ProviderModel } from '../../../services/backendApi'
import { providerApi } from '../../../services/backendApi'
import {
  DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT,
  discoverBrowserNanobotAgents,
  nanobotLocalAgentHostEndpointFromRaw,
  storeBrowserNanobotApiKey,
} from '../../../services/nanobotBrowserClient'
import { listBrowserCodexModels, probeBrowserCodex } from '../../../services/codexBrowserClient'
import { probeBrowserClaude } from '../../../services/claudeBrowserClient'
import { bootstrapLocalAgentHostAuth } from '../../../services/localAgentHostAutoAuth'
import { useSettingsStore } from '../../../stores/settingsStore'
import { localAgentName } from './agent-presentation'
import {
  DEFAULT_CLAUDE_SETTINGS,
  DEFAULT_CODEX_SETTINGS,
  ClaudeSettingsFields,
  CodexSettingsFields,
} from './provider-settings'
import { DEFAULT_DIFY_LOCAL_ENDPOINT, LOCAL_AGENT_PROVIDER_KINDS } from './constants'

export function ProviderForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useSettingsStore((s) => s.create)
  const probe = useSettingsStore((s) => s.probe)
  const loadProviders = useSettingsStore((s) => s.load)
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '',
    kind: 'dify-local',
    endpoint: DEFAULT_DIFY_LOCAL_ENDPOINT,
    api_key: '',
    activate: true,
    transport: 'backend',
    workspace_path: '',
    ...DEFAULT_CODEX_SETTINGS,
    ...DEFAULT_CLAUDE_SETTINGS,
  })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [codexModels, setCodexModels] = useState<ProviderModel[]>([])
  const [codexModelsLoading, setCodexModelsLoading] = useState(false)

  useEffect(() => {
    if (draft.kind !== 'codex-local') {
      setCodexModels([])
      setCodexModelsLoading(false)
      return
    }
    const endpoint = draft.endpoint.trim()
    if (!endpoint) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setCodexModelsLoading(true)
      bootstrapLocalAgentHostAuth()
        .then(() => listBrowserCodexModels(endpoint))
        .then((models) => {
          if (cancelled) return
          setCodexModels(models)
        })
        .catch(() => {
          if (cancelled) return
          setCodexModels([])
        })
        .finally(() => {
          if (!cancelled) setCodexModelsLoading(false)
        })
    }, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft.kind, draft.endpoint])

  const handleKindChange = (kind: ProviderDraft['kind']) => {
    setDraft((d) => ({
      ...d,
      kind,
      transport: LOCAL_AGENT_PROVIDER_KINDS.has(kind) ? 'browser' : 'backend',
      endpoint:
        kind === 'dify-cloud'
          ? 'https://api.dify.ai/v1'
          : kind === 'claude-direct'
            ? 'https://api.anthropic.com'
            : kind === 'native'
              ? 'https://api.openai.com/v1'
              : LOCAL_AGENT_PROVIDER_KINDS.has(kind)
                ? DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT
                : DEFAULT_DIFY_LOCAL_ENDPOINT,
      api_key: LOCAL_AGENT_PROVIDER_KINDS.has(kind) && !d.api_key.trim() ? 'dummy' : d.api_key,
      ...(kind === 'codex-local' ? DEFAULT_CODEX_SETTINGS : {}),
      ...(kind === 'claude-local' ? DEFAULT_CLAUDE_SETTINGS : {}),
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const filledDraft: ProviderDraft = {
      ...draft,
      api_key: (draft.kind === 'nanobot' || draft.kind === 'codex-local' || draft.kind === 'claude-local') && !draft.api_key.trim() ? 'dummy' : draft.api_key,
    }
    if (!filledDraft.name.trim() || !filledDraft.endpoint.trim() || !filledDraft.api_key.trim()) {
      setFormError('名称 / endpoint / API key 都不能为空')
      return
    }
    if ((filledDraft.kind === 'codex-local' || filledDraft.kind === 'claude-local') && !filledDraft.workspace_path?.trim()) {
      setFormError(`${localAgentName(filledDraft.kind)} 需要填写代码项目 workspace path`)
      return
    }
    setSubmitting(true)
    let browserAgents: Awaited<ReturnType<typeof discoverBrowserNanobotAgents>> | null = null
    let codexHealth: Record<string, unknown> | null = null
    let claudeHealth: Record<string, unknown> | null = null
    let codexModelsForSync = codexModels
    if (LOCAL_AGENT_PROVIDER_KINDS.has(filledDraft.kind)) {
      await bootstrapLocalAgentHostAuth()
    }
    if (filledDraft.kind === 'nanobot' && filledDraft.transport === 'browser') {
      try {
        browserAgents = await discoverBrowserNanobotAgents(filledDraft.endpoint, filledDraft.api_key)
      } catch (err) {
        setSubmitting(false)
        setFormError(
          err instanceof Error
            ? `浏览器无法访问本机 Nanobot：${err.message}`
            : '浏览器无法访问本机 Nanobot',
        )
        return
      }
    }
    if (filledDraft.kind === 'codex-local') {
      try {
        codexHealth = await probeBrowserCodex(filledDraft.endpoint)
      } catch (err) {
        setSubmitting(false)
        setFormError(
          err instanceof Error
            ? `浏览器无法访问本机 Codex：${err.message}`
            : '浏览器无法访问本机 Codex',
        )
        return
      }
      if (codexModelsForSync.length === 0) {
        try {
          codexModelsForSync = await listBrowserCodexModels(filledDraft.endpoint)
        } catch {
          codexModelsForSync = []
        }
      }
    }
    if (filledDraft.kind === 'claude-local') {
      try {
        claudeHealth = await probeBrowserClaude(filledDraft.endpoint)
      } catch (err) {
        setSubmitting(false)
        setFormError(
          err instanceof Error
            ? `浏览器无法访问本机 Claude：${err.message}`
            : '浏览器无法访问本机 Claude',
        )
        return
      }
    }
    const result = await create(filledDraft)
    if (result) {
      if (filledDraft.kind === 'nanobot' && filledDraft.transport === 'browser' && browserAgents) {
        storeBrowserNanobotApiKey(result.id, filledDraft.api_key)
        const localAgentHostEndpoint = nanobotLocalAgentHostEndpointFromRaw(browserAgents[0]?.raw)
        await providerApi.syncBrowserNanobotModels(result.id, {
          provider_name: result.name,
          models: browserAgents,
          local_agent_host_endpoint: localAgentHostEndpoint,
        })
        await loadProviders()
      } else if (filledDraft.kind === 'codex-local' && codexHealth) {
        await providerApi.syncBrowserCodexAgent(result.id, { health: codexHealth, models: codexModelsForSync })
        await loadProviders()
      } else if (filledDraft.kind === 'claude-local' && claudeHealth) {
        await providerApi.syncBrowserClaudeAgent(result.id, { health: claudeHealth })
        await loadProviders()
      } else {
        await probe(result.id)
      }
      setSubmitting(false)
      onClose()
      onCreated()
    } else {
      setSubmitting(false)
      setFormError('创建失败，查看控制台')
    }
  }

  return (
    <form className="provider-form embedded" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          <span>名称</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={
              draft.kind === 'nanobot'
                ? 'Agent 名字，比如 PhD Mentor'
                : 'My Dify'
            }
            autoFocus
          />
        </label>
        <label>
          <span>类型</span>
          <select value={draft.kind} onChange={(e) => handleKindChange(e.target.value as ProviderDraft['kind'])}>
            <option value="dify-local">Dify (本地)</option>
            <option value="dify-cloud">Dify Cloud</option>
            <option value="claude-direct">Claude API 直连</option>
            <option value="nanobot">Nanobot</option>
            <option value="native">原生 Agent</option>
            <option value="codex-local">Codex Local</option>
            <option value="claude-local">Claude Local</option>
          </select>
        </label>
      </div>
      <label className="full">
        <span>Endpoint</span>
        <input
          value={draft.endpoint}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          placeholder={
            draft.kind === 'nanobot'
              ? DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT
              : draft.kind === 'codex-local'
                ? DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT
              : draft.kind === 'claude-local'
                ? DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT
              : draft.kind === 'native'
                ? 'https://api.openai.com/v1'
                : DEFAULT_DIFY_LOCAL_ENDPOINT
          }
        />
      </label>
      {(draft.kind === 'codex-local' || draft.kind === 'claude-local') && (
        <>
          <label className="full">
            <span>Workspace Path</span>
            <input
              value={draft.workspace_path ?? ''}
              onChange={(e) => setDraft({ ...draft, workspace_path: e.target.value })}
              placeholder="/Users/me/code/my-paper-project"
            />
          </label>
          {draft.kind === 'codex-local' ? (
            <CodexSettingsFields
              draft={draft}
              modelOptions={codexModels}
              modelLoading={codexModelsLoading}
              onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
            />
          ) : (
            <ClaudeSettingsFields
              draft={draft}
              onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
            />
          )}
        </>
      )}
      {draft.kind === 'nanobot' && (
        <label className="full">
          <span>调用位置</span>
          <select
            value={draft.transport ?? 'browser'}
            onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'backend' | 'browser' })}
          >
            <option value="browser">浏览器直连本机 Nanobot</option>
            <option value="backend">后端直连 Nanobot</option>
          </select>
        </label>
      )}
      <label className="full">
        <span>API Key</span>
        <input
          type="password"
          value={draft.api_key}
          onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
          placeholder="app-xxxxx / sk-xxxxx"
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.activate}
          onChange={(e) => setDraft({ ...draft, activate: e.target.checked })}
        />
        <span>设为默认供应商</span>
      </label>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onClose} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="spin" /> : '保存'}
        </button>
      </div>
    </form>
  )
}
