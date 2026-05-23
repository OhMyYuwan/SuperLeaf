/**
 * SettingsDialog — provider registry UI in a Radix Dialog.
 *
 * Shows saved providers with status chips. Users can add, probe, activate, and
 * remove providers. API keys are write-only: once saved they never leave the
 * backend (UI gets back a boolean `has_api_key`).
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, CircleAlert, GitBranch, KeyRound, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { GitHubAccountStatus, GitHubDeviceStart, Provider, ProviderDraft } from '../../services/backendApi'
import { BACKEND_BASE, getLocalServiceUrl, githubApi } from '../../services/backendApi'
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
            {activeTab === 'account' && <GitHubAccountSettings />}

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
      if (url) window.open(url, 'yuwanlab-github-device', 'width=720,height=760')
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
          <p>授权绑定到当前 YuwanLabWriter 用户，直到 GitHub 权限失效或你主动断开。</p>
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
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '',
    kind: 'dify-local',
    endpoint: 'http://localhost:8080/v1',
    api_key: '',
    activate: true,
  })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleKindChange = (kind: ProviderDraft['kind']) => {
    setDraft((d) => ({
      ...d,
      kind,
      endpoint:
        kind === 'dify-cloud'
          ? 'https://api.dify.ai/v1'
          : kind === 'claude-direct'
            ? 'https://api.anthropic.com'
            : kind === 'nanobot'
              ? getLocalServiceUrl(8902)
              : 'http://localhost:8080/v1',
      api_key: kind === 'nanobot' && !d.api_key.trim() ? 'dummy' : d.api_key,
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const filledDraft: ProviderDraft = {
      ...draft,
      api_key: draft.kind === 'nanobot' && !draft.api_key.trim() ? 'dummy' : draft.api_key,
    }
    if (!filledDraft.name.trim() || !filledDraft.endpoint.trim() || !filledDraft.api_key.trim()) {
      setFormError('name / endpoint / api_key 都不能为空')
      return
    }
    setSubmitting(true)
    const result = await create(filledDraft)
    setSubmitting(false)
    if (result) {
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
          </select>
        </label>
      </div>
      <label className="full">
        <span>Endpoint</span>
        <input
          value={draft.endpoint}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          placeholder={getLocalServiceUrl(8902)}
        />
      </label>
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

function kindLabel(kind: Provider['kind']) {
  if (kind === 'dify-local') return 'Dify (本地)'
  if (kind === 'dify-cloud') return 'Dify Cloud'
  if (kind === 'claude-direct') return 'Claude API 直连'
  if (kind === 'nanobot') return 'Nanobot'
  return kind
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
