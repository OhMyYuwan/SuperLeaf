/**
 * RegisterPage — email + password + display name self-serve register.
 *
 * The first admin can require a deployment bootstrap token. The register
 * response still includes `is_admin`, which tells the client whether this
 * account inherited pre-existing resources.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUserStore } from '../stores/userStore'
import { BackendError } from '../services/backendApi'
import { AuthSplitShell } from './components/AuthSplitShell'
import { AUTH_SLIDES } from './authSlides'
import './auth.css'

export function RegisterPage() {
  const navigate = useNavigate()
  const register = useUserStore((s) => s.register)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSlideId, setActiveSlideId] = useState(AUTH_SLIDES[0].id)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !email.trim() || password.length < 8) return
    setBusy(true)
    setError(null)
    try {
      await register({
        email: email.trim(),
        password,
        display_name: displayName.trim(),
        bootstrap_token: bootstrapToken.trim(),
      })
      navigate('/projects', { replace: true })
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthSplitShell
      slides={AUTH_SLIDES}
      activeSlideId={activeSlideId}
      onSlideChange={setActiveSlideId}
      asideLabel="SuperLeaf 注册引导"
    >
      <div className="auth-card auth-card-split">
        <div className="auth-brand">SuperLeaf</div>
        <h2 className="auth-title">注册</h2>
        <p className="auth-subtle">
          首位管理员需要部署配置中的 Bootstrap Token；开放注册关闭时，后续账号也需由管理员规划创建。
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label">
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>
          <label className="auth-label">
            昵称（可选）
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如：王五"
              autoComplete="name"
              maxLength={128}
            />
          </label>
          <label className="auth-label">
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <span className="auth-hint">至少 8 位，需包含字母与数字。</span>
          </label>
          <label className="auth-label">
            Bootstrap Token（首次初始化）
            <input
              type="password"
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
              autoComplete="one-time-code"
              maxLength={512}
            />
            <span className="auth-hint">由部署者在 `.env` 中设置；公开注册环境可留空。</span>
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-primary" disabled={busy}>
            {busy ? '注册中…' : '注册并登录'}
          </button>
        </form>
        <div className="auth-footer">
          已有账号？<Link to="/login">去登录</Link>
        </div>
      </div>
    </AuthSplitShell>
  )
}

function extractMessage(e: unknown): string {
  if (e instanceof BackendError) return e.detail || `请求失败 (${e.status})`
  if (e instanceof Error) return e.message
  return String(e)
}
