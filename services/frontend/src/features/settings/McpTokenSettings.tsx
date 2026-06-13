/**
 * McpTokenSettings — MCP token management UI for IDE/CLI integration.
 *
 * Lets users create long-lived bearer tokens for external MCP clients (Codex,
 * Claude Code, VS Code). Tokens are shown in plaintext exactly once on creation;
 * afterwards only the hint is visible. Revoked tokens are grayed out.
 */

import { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff, Key, Plus, Trash2, Check } from 'lucide-react'
import { BACKEND_BASE, mcpTokenApi, type McpToken, type McpTokenCreateIn } from '../../services/backendApi'

export function McpTokenSettings() {
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadTokens()
  }, [])

  async function loadTokens() {
    setLoading(true)
    try {
      const data = await mcpTokenApi.list()
      setTokens(data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke(tokenId: string) {
    if (!confirm('确定要撤销此 token 吗？撤销后将无法恢复，所有使用该 token 的客户端将失去访问权限。')) {
      return
    }
    try {
      await mcpTokenApi.revoke(tokenId)
      await loadTokens()
    } catch (err) {
      alert(`撤销失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div>
      <div className="settings-section-title">MCP Token</div>
      <p className="settings-hint">
        为 Codex、Claude Code、VS Code 等 IDE 创建长效 token。这些 token 让外部客户端直接连接后端 MCP，无需浏览器或 Local Host。
      </p>
      <p className="settings-hint">
        MCP endpoint: <code>{BACKEND_BASE}/mcp</code> · Header: <code>Authorization: Bearer slmcp_...</code>
      </p>

      {error && <div className="error-bar">{error}</div>}

      {loading ? (
        <div className="loading-hint">加载中...</div>
      ) : tokens.length === 0 && !showForm ? (
        <div className="empty-providers">还没有创建 MCP token。点击下方按钮创建第一个。</div>
      ) : (
        <ul className="provider-list">
          {tokens.map((token) => (
            <McpTokenRow key={token.id} token={token} onRevoke={handleRevoke} />
          ))}
        </ul>
      )}

      {showForm ? (
        <McpTokenForm onClose={() => setShowForm(false)} onCreated={loadTokens} />
      ) : (
        <button className="primary-btn" onClick={() => setShowForm(true)} disabled={loading}>
          <Plus size={14} /> 创建 MCP Token
        </button>
      )}
    </div>
  )
}

interface McpTokenRowProps {
  token: McpToken
  onRevoke: (id: string) => void
}

function McpTokenRow({ token, onRevoke }: McpTokenRowProps) {
  const isExpired = token.expires_at && new Date(token.expires_at) < new Date()
  const inactive = token.revoked_at !== null || isExpired

  return (
    <li className={`provider-item ${inactive ? 'inactive' : ''}`}>
      <div className="provider-icon">
        <Key size={16} />
      </div>
      <div className="provider-details">
        <div className="provider-name">
          {token.name || '(未命名)'}
          <span className="token-hint">...{token.token_hint}</span>
        </div>
        <div className="provider-meta">
          <span className={`scope-badge scope-${token.scope}`}>{token.scope}</span>
          {token.revoked_at && <span className="status-badge revoked">已撤销</span>}
          {!token.revoked_at && isExpired && <span className="status-badge expired">已过期</span>}
          {!token.revoked_at && !isExpired && <span className="status-badge active">有效</span>}
          <span className="provider-meta-item">
            创建于 {new Date(token.created_at).toLocaleDateString('zh-CN')}
          </span>
          {token.last_used_at && (
            <span className="provider-meta-item">
              最后使用 {new Date(token.last_used_at).toLocaleDateString('zh-CN')}
            </span>
          )}
        </div>
      </div>
      {!token.revoked_at && (
        <button
          className="icon-btn danger"
          onClick={() => onRevoke(token.id)}
          title="撤销 token"
        >
          <Trash2 size={14} />
        </button>
      )}
    </li>
  )
}

interface McpTokenFormProps {
  onClose: () => void
  onCreated: () => void
}

function McpTokenForm({ onClose, onCreated }: McpTokenFormProps) {
  const [draft, setDraft] = useState<McpTokenCreateIn>({
    name: '',
    scope: 'read',
    expires_in_days: 30,
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await mcpTokenApi.create(draft)
      setCreatedToken(result.plaintext)
      setShowToken(true)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function copyToken() {
    if (createdToken) {
      await navigator.clipboard.writeText(createdToken)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (createdToken) {
    return (
      <div className="provider-form">
        <div className="form-success">
          <h3>Token 创建成功</h3>
          <p className="warning-text">
            ⚠️ 请立即复制保存此 token。关闭后将无法再次查看完整内容。
          </p>
          <p className="settings-hint">
            MCP endpoint: <code>{BACKEND_BASE}/mcp</code>
          </p>
          <div className="token-display">
            <code className={showToken ? 'visible' : 'hidden'}>
              {showToken ? createdToken : '•'.repeat(50)}
            </code>
            <div className="token-actions">
              <button
                className="icon-btn"
                onClick={() => setShowToken(!showToken)}
                title={showToken ? '隐藏' : '显示'}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                className="icon-btn"
                onClick={copyToken}
                title="复制"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <button className="primary-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="provider-form" onSubmit={handleSubmit}>
      <h3>创建 MCP Token</h3>

      {error && <div className="error-bar">{error}</div>}

      <label>
        <span>名称</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="例如: my-vscode, codex-cli"
          required
        />
      </label>

      <label>
        <span>作用域</span>
        <select
          value={draft.scope}
          onChange={(e) => setDraft({ ...draft, scope: e.target.value as 'read' | 'write' })}
        >
          <option value="read">read（只读：列表、读取、搜索）</option>
          <option value="write">write（读写：包含编辑和创建）</option>
        </select>
      </label>

      <label>
        <span>有效期</span>
        <select
          value={draft.expires_in_days ?? 30}
          onChange={(e) => {
            const val = e.target.value
            setDraft({ ...draft, expires_in_days: val === 'never' ? null : Number(val) })
          }}
        >
          <option value="7">7 天</option>
          <option value="30">30 天</option>
          <option value="90">90 天</option>
          <option value="365">1 年</option>
          <option value="never">永不过期</option>
        </select>
      </label>

      <div className="form-actions">
        <button type="button" className="secondary-btn" onClick={onClose} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={submitting}>
          {submitting ? '创建中...' : '创建'}
        </button>
      </div>
    </form>
  )
}
