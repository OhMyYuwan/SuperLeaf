/**
 * SettingsDialog — provider registry UI in a Radix Dialog.
 *
 * Shows saved providers with status chips. Users can add, probe, activate, and
 * remove providers. API keys are write-only: once saved they never leave the
 * backend (UI gets back a boolean `has_api_key`).
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, CircleAlert, GitBranch, KeyRound, Layers3, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { GitHubAccountStatus, GitHubDeviceStart, Provider, ProviderDraft, ProviderModel } from '../../services/backendApi'
import {
  BACKEND_BASE,
  getBrowserLocalServiceUrl,
  getLocalServiceUrl,
  githubApi,
  providerApi,
} from '../../services/backendApi'
import {
  discoverBrowserNanobotAgents,
  nanobotLocalAgentHostEndpointFromRaw,
  storeBrowserNanobotApiKey,
} from '../../services/nanobotBrowserClient'
import { listBrowserCodexModels, probeBrowserCodex } from '../../services/codexBrowserClient'
import { probeBrowserClaude } from '../../services/claudeBrowserClient'
import { useSettingsStore } from '../../stores/settingsStore'
import './settings.css'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type SettingsTab = 'account' | 'providers'

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const load = useSettingsStore((s) => s.load)
  const loaded = useSettingsStore((s) => s.loaded)
  const backendReachable = useSettingsStore((s) => s.backendReachable)
  const providers = useSettingsStore((s) => s.providers)
  const error = useSettingsStore((s) => s.error)

  useEffect(() => {
    if (open && !loaded) {
      load()
    }
  }, [open, loaded, load])

  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('account')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content className="settings-dialog">
          <div className="settings-header">
            <div>
              <Dialog.Title className="settings-title">个人面板</Dialog.Title>
              <Dialog.Description className="settings-subtitle">
                登录 GitHub 账号，也可以配置当前用户的本地 provider。密钥会加密存储于本地 SQLite。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <BackendStatusBar reachable={backendReachable} error={error} onRetry={load} />

          <div className="settings-tabs" role="tablist" aria-label="个人面板设置">
            <button
              className={activeTab === 'account' ? 'active' : ''}
              onClick={() => setActiveTab('account')}
              role="tab"
              aria-selected={activeTab === 'account'}
            >
              GitHub 账户
            </button>
            <button
              className={activeTab === 'providers' ? 'active' : ''}
              onClick={() => setActiveTab('providers')}
              role="tab"
              aria-selected={activeTab === 'providers'}
            >
              Agent
            </button>
          </div>

          <div className="settings-body">
            {activeTab === 'account' && (
              <>
                <GitHubAccountSettings />
                <ProjectListSettings />
              </>
            )}

            {activeTab === 'providers' && (
              <>
                <div className="settings-section-title">Provider</div>

                {loaded && providers.length === 0 && !showForm && (
                  <div className="empty-providers">
                    还没有配置 provider。点击下方按钮添加第一个。
                  </div>
                )}

                <ul className="provider-list">
                  {providers.map((p) => (
                    <ProviderRow key={p.id} provider={p} />
                  ))}
                </ul>

                {showForm ? (
                  <ProviderForm onClose={() => setShowForm(false)} />
                ) : (
                  <button className="primary-btn" onClick={() => setShowForm(true)}>
                    <Plus size={14} /> 添加 Provider
                  </button>
                )}
              </>
            )}

          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ProjectListSettings() {
  const projectListGrouping = useSettingsStore((s) => s.projectListGrouping)
  const setProjectListGrouping = useSettingsStore((s) => s.setProjectListGrouping)

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3><Layers3 size={14} /> Project 列表</h3>
          <p>控制 /projects 页面如何组织 Paper 和 Skill 项目。</p>
        </div>
      </div>
      <div className="settings-segmented" role="radiogroup" aria-label="Project 列表分组方式">
        <button
          type="button"
          role="radio"
          aria-checked={projectListGrouping === 'grouped'}
          className={projectListGrouping === 'grouped' ? 'active' : ''}
          onClick={() => setProjectListGrouping('grouped')}
        >
          Paper / Skill 分区
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={projectListGrouping === 'mixed'}
          className={projectListGrouping === 'mixed' ? 'active' : ''}
          onClick={() => setProjectListGrouping('mixed')}
        >
          混合列表
        </button>
      </div>
    </section>
  )
}

function GitHubAccountSettings() {
  const configuredGithubClientId = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? ''
  const [account, setAccount] = useState<GitHubAccountStatus | null>(null)
  const [clientId, setClientId] = useState(configuredGithubClientId)
  const [deviceAuth, setDeviceAuth] = useState<GitHubDeviceStart | null>(null)
  const [devicePolling, setDevicePolling] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadAccount = async () => {
    setError(null)
    try {
      setAccount(await githubApi.account())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 GitHub 账户失败')
    }
  }

  useEffect(() => {
    void loadAccount()
  }, [])

  useEffect(() => {
    if (!deviceAuth) return
    let cancelled = false
    const startedAt = Date.now()
    let timer: number | undefined

    const poll = (delaySeconds: number) => {
      timer = window.setTimeout(async () => {
        if (cancelled) return
        if (Date.now() - startedAt > deviceAuth.expires_in * 1000) {
          setDevicePolling(false)
          setDeviceAuth(null)
          setError('GitHub 验证码已过期，请重新发起验证。')
          return
        }
        setDevicePolling(true)
        try {
          const result = await githubApi.pollDevice(
            deviceAuth.device_code,
            clientId.trim() || undefined,
          )
          if (cancelled) return
          if (result.status === 'connected' && result.account) {
            setAccount(result.account)
            setDeviceAuth(null)
            setMessage(`GitHub 已连接 @${result.account.login}。`)
          } else if (result.status === 'slow_down') {
            setMessage('GitHub 要求放慢检查频率，继续等待授权。')
            poll(result.interval ?? delaySeconds + 5)
          } else if (result.status === 'failed') {
            setDeviceAuth(null)
            setError(result.error || 'GitHub 设备授权失败')
          } else {
            setMessage('正在等待 GitHub 授权完成。')
            poll(delaySeconds)
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : '检查 GitHub 授权失败')
        } finally {
          if (!cancelled) setDevicePolling(false)
        }
      }, Math.max(delaySeconds, 5) * 1000)
    }

    poll(deviceAuth.interval)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [deviceAuth, clientId])

  const startDeviceAuth = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await githubApi.startDevice(clientId.trim() || undefined)
      setDeviceAuth(result)
      setMessage(`请在 GitHub 输入验证码 ${result.user_code}，授权完成后这里会自动连接。`)
      const url = result.verification_uri_complete || result.verification_uri
      if (url) window.open(url, 'superleaf-github-device', 'width=720,height=760')
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动 GitHub 验证失败')
    } finally {
      setBusy(false)
    }
  }

  const connectToken = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await githubApi.connectToken(token)
      setAccount(next)
      setToken('')
      setMessage(`GitHub 已连接 @${next.login}。`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接 GitHub token 失败')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!confirm('断开 GitHub 账户？项目归档仍会保留，但上传/私有下载需要重新授权。')) return
    setBusy(true)
    setError(null)
    try {
      await githubApi.disconnect()
      setAccount({ connected: false, login: '', name: '', avatar_url: '', scope: '', updated_at: null })
      setMessage('GitHub 账户已断开。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '断开 GitHub 账户失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3><GitBranch size={14} /> GitHub 账户</h3>
          <p>授权绑定到当前 SuperLeaf 用户，直到 GitHub 权限失效或你主动断开。</p>
        </div>
        {account?.connected ? (
          <button className="ghost-btn small danger" onClick={() => void disconnect()} disabled={busy}>
            断开
          </button>
        ) : (
          <button className="ghost-btn small" onClick={() => void startDeviceAuth()} disabled={busy || devicePolling}>
            {devicePolling ? <Loader2 size={12} className="spin" /> : <KeyRound size={12} />}
            GitHub 验证
          </button>
        )}
      </div>

      <div className="github-account-card">
        <span>{account?.connected ? `已连接 @${account.login}` : '未连接 GitHub'}</span>
        {account?.scope && <code>{account.scope}</code>}
      </div>

      {!configuredGithubClientId && !account?.connected && (
        <label className="settings-inline-field">
          <span>OAuth App Client ID</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="GitHub OAuth App Client ID"
            disabled={busy || devicePolling}
          />
        </label>
      )}

      {deviceAuth && (
        <div className="github-device-card">
          <span>GitHub 验证码</span>
          <strong>{deviceAuth.user_code}</strong>
          <a href={deviceAuth.verification_uri_complete || deviceAuth.verification_uri} target="_blank" rel="noreferrer">
            打开 GitHub 验证
          </a>
        </div>
      )}

      {!account?.connected && (
        <div className="settings-token-row">
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="或粘贴 fine-grained token / PAT"
            type="password"
            disabled={busy}
          />
          <button className="ghost-btn small" onClick={() => void connectToken()} disabled={busy || !token.trim()}>
            连接
          </button>
        </div>
      )}

      {message && <div className="settings-success">{message}</div>}
      {error && <div className="form-error">{error}</div>}
    </section>
  )
}

function BackendStatusBar({
  reachable,
  error,
  onRetry,
}: {
  reachable: boolean | null
  error: string | null
  onRetry: () => void
}) {
  if (reachable === null) return null
  if (reachable) {
    return (
      <div className="status-bar ok">
        <CheckCircle2 size={14} /> 后端已连接
      </div>
    )
  }
  return (
    <div className="status-bar error">
      <CircleAlert size={14} />
      <span>无法连接到后端（{BACKEND_BASE}）。{error ? ` · ${truncate(error, 120)}` : ''}</span>
      <button className="inline-btn" onClick={onRetry}>
        <RefreshCw size={12} /> 重试
      </button>
    </div>
  )
}

function ProviderRow({ provider }: { provider: Provider }) {
  const activate = useSettingsStore((s) => s.activate)
  const probe = useSettingsStore((s) => s.probe)
  const remove = useSettingsStore((s) => s.remove)
  const [busy, setBusy] = useState<'probe' | 'activate' | 'remove' | null>(null)

  const handleProbe = async () => {
    setBusy('probe')
    await probe(provider.id)
    setBusy(null)
  }
  const handleActivate = async () => {
    setBusy('activate')
    await activate(provider.id)
    setBusy(null)
  }
  const handleRemove = async () => {
    if (!confirm(`删除 "${provider.name}"？此操作不可撤销。`)) return
    setBusy('remove')
    await remove(provider.id)
    setBusy(null)
  }

  return (
    <li className={`provider-row ${provider.is_active ? 'active' : ''}`}>
      <div className="provider-main">
        <div className="provider-name-row">
          <span className="provider-name">{provider.name}</span>
          <span className={`status-chip ${provider.status}`}>
            {provider.status === 'ok' && <CheckCircle2 size={11} />}
            {provider.status === 'error' && <CircleAlert size={11} />}
            {provider.status}
          </span>
          {provider.is_active && <span className="active-chip">激活</span>}
        </div>
        <div className="provider-meta">
          <span className="kind">{kindLabel(provider.kind)}</span>
          <span className="endpoint">{provider.endpoint}</span>
        </div>
        {provider.status_detail && (
          <div className={`detail ${provider.status}`}>{provider.status_detail}</div>
        )}
      </div>
      <div className="provider-actions">
        <button className="ghost-btn small" onClick={handleProbe} disabled={!!busy}>
          {busy === 'probe' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          测连
        </button>
        {!provider.is_active && (
          <button className="ghost-btn small" onClick={handleActivate} disabled={!!busy}>
            激活
          </button>
        )}
        <button className="ghost-btn small danger" onClick={handleRemove} disabled={!!busy}>
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  )
}

function ProviderForm({ onClose }: { onClose: () => void }) {
  const create = useSettingsStore((s) => s.create)
  const loadProviders = useSettingsStore((s) => s.load)
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '',
    kind: 'dify-local',
    endpoint: 'http://localhost:8080/v1',
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
      listBrowserCodexModels(endpoint)
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
      transport: kind === 'nanobot' || kind === 'codex-local' || kind === 'claude-local' ? 'browser' : 'backend',
      endpoint:
        kind === 'dify-cloud'
          ? 'https://api.dify.ai/v1'
          : kind === 'claude-direct'
            ? 'https://api.anthropic.com'
            : kind === 'nanobot'
              ? getBrowserLocalServiceUrl(8787)
              : kind === 'codex-local'
                ? getBrowserLocalServiceUrl(8787)
                : kind === 'claude-local'
                  ? getBrowserLocalServiceUrl(8787)
                : 'http://localhost:8080/v1',
      api_key: (kind === 'nanobot' || kind === 'codex-local' || kind === 'claude-local') && !d.api_key.trim() ? 'dummy' : d.api_key,
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
      setFormError('name / endpoint / api_key 都不能为空')
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
    setSubmitting(false)
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
      }
      if (filledDraft.kind === 'codex-local' && codexHealth) {
        await providerApi.syncBrowserCodexAgent(result.id, { health: codexHealth, models: codexModelsForSync })
        await loadProviders()
      }
      if (filledDraft.kind === 'claude-local' && claudeHealth) {
        await providerApi.syncBrowserClaudeAgent(result.id, { health: claudeHealth })
        await loadProviders()
      }
      onClose()
    } else {
      setFormError('创建失败，查看控制台')
    }
  }

  return (
    <form className="provider-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          <span>名称</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="My Dify / My Nanobot"
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
            draft.kind === 'nanobot' || draft.kind === 'codex-local' || draft.kind === 'claude-local'
              ? getBrowserLocalServiceUrl(8787)
              : getLocalServiceUrl(8902)
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
          placeholder="dummy / app-xxxxx / sk-xxxxx"
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.activate}
          onChange={(e) => setDraft({ ...draft, activate: e.target.checked })}
        />
        <span>保存后立即激活</span>
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

const DEFAULT_CODEX_SETTINGS = {
  codex_model: '',
  codex_effort: 'low',
  codex_summary: 'none',
  codex_service_tier: '',
  codex_sandbox: 'danger-full-access',
  codex_approval_policy: 'on-request',
  codex_prompt_mode: 'fast-edit',
  codex_tool_mode: 'mcp-first',
  codex_context_mode: 'lease',
} satisfies Partial<ProviderDraft>

const DEFAULT_CLAUDE_SETTINGS = {
  claude_model: '',
  claude_prompt_mode: 'fast-edit',
  claude_tool_mode: 'mcp-first',
} satisfies Partial<ProviderDraft>

function CodexSettingsFields({
  draft,
  modelOptions,
  modelLoading,
  onChange,
}: {
  draft: ProviderDraft
  modelOptions: ProviderModel[]
  modelLoading?: boolean
  onChange: (patch: Partial<ProviderDraft>) => void
}) {
  const selectedModel = draft.codex_model ?? ''
  const selectedModelInOptions = !selectedModel || modelOptions.some((model) => model.id === selectedModel)
  return (
    <div className="codex-settings-compact">
      <label className="codex-field codex-field-full">
        <span>Model</span>
          <select
            className="codex-select"
            value={selectedModel}
            onChange={(e) => onChange({ codex_model: e.target.value })}
          >
            <option value="">使用本机默认</option>
            {!selectedModelInOptions && (
              <option value={selectedModel}>当前已保存：{selectedModel}</option>
            )}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {codexModelOptionLabel(model)}
              </option>
            ))}
            {modelOptions.length === 0 && (
              <option value="" disabled>
                {modelLoading ? '正在读取本机模型…' : '连接后自动加载模型'}
              </option>
            )}
          </select>
      </label>
      <CodexSegmentedControl
        label="Access"
        value={draft.codex_sandbox === 'read-only' ? 'read-only' : 'danger-full-access'}
        options={[
          { value: 'danger-full-access', label: 'Full' },
          { value: 'read-only', label: '只读' },
        ]}
        onChange={(value) => onChange({ codex_sandbox: value as ProviderDraft['codex_sandbox'] })}
      />
      <CodexSegmentedControl
        label="Mode"
        value={draft.codex_prompt_mode ?? 'fast-edit'}
        options={[
          { value: 'fast-edit', label: '快速编辑' },
          { value: 'full-agent', label: '完整 Agent' },
        ]}
        onChange={(value) => onChange({ codex_prompt_mode: value as ProviderDraft['codex_prompt_mode'] })}
      />
      <CodexSegmentedControl
        label="Tools"
        value={draft.codex_tool_mode ?? 'mcp-first'}
        options={[
          { value: 'mcp-first', label: 'MCP' },
          { value: 'browser-preflight', label: '浏览器优先' },
          { value: 'marker-only', label: '标记' },
        ]}
        onChange={(value) => onChange({ codex_tool_mode: value as ProviderDraft['codex_tool_mode'] })}
      />
      <CodexSegmentedControl
        label="Context"
        value={draft.codex_context_mode ?? 'lease'}
        options={[
          { value: 'lease', label: '轻量缓存' },
          { value: 'legacy-blocks', label: '兼容完整提示' },
        ]}
        onChange={(value) => onChange({ codex_context_mode: value as ProviderDraft['codex_context_mode'] })}
      />
      <details className="codex-advanced">
        <summary>高级设置</summary>
        <div className="codex-advanced-grid">
          <CodexSegmentedControl
            label="Reasoning"
            value={draft.codex_effort ?? 'low'}
            options={[
              { value: 'low', label: 'low' },
              { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' },
              { value: 'none', label: 'none' },
            ]}
            onChange={(value) => onChange({ codex_effort: value as ProviderDraft['codex_effort'] })}
          />
          <CodexSegmentedControl
            label="Summary"
            value={draft.codex_summary ?? 'none'}
            options={[
              { value: 'none', label: 'none' },
              { value: 'auto', label: 'auto' },
              { value: 'concise', label: 'concise' },
              { value: 'detailed', label: 'detailed' },
            ]}
            onChange={(value) => onChange({ codex_summary: value as ProviderDraft['codex_summary'] })}
          />
          <label className="codex-field codex-field-full">
            <span>Service Tier</span>
            <input
              value={draft.codex_service_tier ?? ''}
              onChange={(e) => onChange({ codex_service_tier: e.target.value })}
              placeholder="本机默认"
            />
          </label>
        </div>
      </details>
    </div>
  )
}

function CodexSegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="codex-field">
      <span>{label}</span>
      <div className="codex-segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            onClick={() => onChange(option.value)}
            aria-pressed={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ClaudeSettingsFields({
  draft,
  onChange,
}: {
  draft: ProviderDraft
  onChange: (patch: Partial<ProviderDraft>) => void
}) {
  return (
    <>
      <div className="form-row">
        <label>
          <span>Claude Model</span>
          <select
            value={draft.claude_model ?? ''}
            onChange={(e) => onChange({ claude_model: e.target.value })}
          >
            <option value="">使用本机默认</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </label>
        <label>
          <span>Prompt Mode</span>
          <select
            value={draft.claude_prompt_mode ?? 'fast-edit'}
            onChange={(e) => onChange({ claude_prompt_mode: e.target.value as ProviderDraft['claude_prompt_mode'] })}
          >
            <option value="fast-edit">快速编辑</option>
            <option value="full-agent">完整 Agent</option>
          </select>
        </label>
      </div>
      <label className="full">
        <span>Tool Mode</span>
        <select
          value={draft.claude_tool_mode ?? 'mcp-first'}
          onChange={(e) => onChange({ claude_tool_mode: e.target.value as ProviderDraft['claude_tool_mode'] })}
        >
          <option value="mcp-first">MCP first</option>
          <option value="browser-preflight">Browser preflight first</option>
          <option value="marker-only">Marker fallback only</option>
        </select>
      </label>
    </>
  )
}

function kindLabel(kind: Provider['kind']) {
  if (kind === 'dify-local') return 'Dify (本地)'
  if (kind === 'dify-cloud') return 'Dify Cloud'
  if (kind === 'claude-direct') return 'Claude API 直连'
  if (kind === 'nanobot') return 'Nanobot'
  if (kind === 'codex-local') return 'Codex Local'
  if (kind === 'claude-local') return 'Claude Local'
  return kind
}

function localAgentName(kind: Provider['kind']): string {
  if (kind === 'claude-local') return 'Claude Local'
  if (kind === 'codex-local') return 'Codex Local'
  return 'Local Agent'
}

function codexModelOptionLabel(model: ProviderModel): string {
  const label = model.name || model.model || model.id
  return model.is_default || model.raw?.isDefault === true || model.raw?.is_default === true ? `${label}（默认）` : label
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
