/**
 * RegisterPage — email + password + display name self-serve register.
 *
 * First-user heuristic: the register response includes `is_admin`. If the
 * server hands back an admin user, this is the bootstrap account that
 * inherits all pre-existing projects. We surface a small banner so the
 * operator knows.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUserStore } from '../stores/userStore'
import { BackendError } from '../services/backendApi'
import './auth.css'

export function RegisterPage() {
  const navigate = useNavigate()
  const register = useUserStore((s) => s.register)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      })
      navigate('/projects', { replace: true })
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">YuwanLabWriter</div>
        <h1 className="auth-title">注册</h1>
        <p className="auth-subtle">
          首位注册的用户将成为系统管理员，并继承已有的项目与服务凭据。
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label">
            邮箱
            <input
              autoFocus
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
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-primary" disabled={busy}>
            {busy ? '注册中…' : '注册并登录'}
          </button>
        </form>
        <div className="auth-footer">
          已有账号？<Link to="/login">去登录</Link>
        </div>
      </div>
    </div>
  )
}

function extractMessage(e: unknown): string {
  if (e instanceof BackendError) return e.detail || `请求失败 (${e.status})`
  if (e instanceof Error) return e.message
  return String(e)
}
