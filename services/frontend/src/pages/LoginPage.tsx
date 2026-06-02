/**
 * LoginPage — email + password sign-in.
 *
 * On success: redirect to the location stored in `state.from` (set by
 * ProtectedRoute on the bounce-out) or `/projects` as a fallback.
 *
 * If there are zero registered users yet, the friendlier flow is to nudge
 * the user toward /register where they'll be told they'll become admin.
 * We don't probe ahead of time — the register page handles its own copy.
 */

import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useUserStore } from '../stores/userStore'
import { BackendError } from '../services/backendApi'
import { AuthSplitShell } from './components/AuthSplitShell'
import { AUTH_SLIDES } from './authSlides'
import './auth.css'

interface LocationState {
  from?: string
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useUserStore((s) => s.login)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSlideId, setActiveSlideId] = useState(AUTH_SLIDES[0].id)

  return (
    <AuthSplitShell
      slides={AUTH_SLIDES}
      activeSlideId={activeSlideId}
      onSlideChange={setActiveSlideId}
      asideLabel="SuperLeaf 产品介绍"
    >
      <div className="auth-card auth-card-split">
        <div className="auth-brand">SuperLeaf</div>
        <h2 className="auth-title">登录</h2>
        <p className="auth-subtle">进入你的协作写作工作台，继续上一次的项目进度。</p>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || !email.trim() || !password) return
            setBusy(true)
            setError(null)
            void (async () => {
              try {
                await login({ email: email.trim(), password })
                const from = (location.state as LocationState | null)?.from || '/projects'
                navigate(from, { replace: true })
              } catch (e) {
                setError(extractMessage(e))
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
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
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-primary" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="auth-footer">
          还没有账号？<Link to="/register">去注册</Link>
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
