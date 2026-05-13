/**
 * SettingsDialog — provider registry UI in a Radix Dialog.
 *
 * Shows saved providers with status chips. Users can add, probe, activate, and
 * remove providers. API keys are write-only: once saved they never leave the
 * backend (UI gets back a boolean `has_api_key`).
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, CircleAlert, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { Provider, ProviderDraft } from '../../services/backendApi'
import { BACKEND_BASE, getLocalServiceUrl } from '../../services/backendApi'
import { useSettingsStore } from '../../stores/settingsStore'
import './settings.css'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content className="settings-dialog">
          <div className="settings-header">
            <div>
              <Dialog.Title className="settings-title">Provider 设置</Dialog.Title>
              <Dialog.Description className="settings-subtitle">
                配置后端连接的 LLM / Workflow provider。API Key 将加密存储于本地 SQLite。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <BackendStatusBar reachable={backendReachable} error={error} onRetry={load} />

          <div className="settings-body">
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
