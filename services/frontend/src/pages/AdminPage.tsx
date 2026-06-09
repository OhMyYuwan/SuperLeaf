import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Mail,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react'
import { BackendError } from '../services/backendApi'
import {
  adminApi,
  type RegistrationInvite,
  type RegistrationInviteEmailStatus,
  type RegistrationInviteIssue,
} from '../services/adminApi'
import type { User } from '../services/authApi'
import { useUserStore } from '../stores/userStore'
import { UserMenu } from '../features/topbar/UserMenu'
import '../features/topbar/topbar.css'
import './admin.css'

type Tab = 'users' | 'invites'

export function AdminPage() {
  const navigate = useNavigate()
  const currentUser = useUserStore((s) => s.currentUser)
  const [tab, setTab] = useState<Tab>('invites')
  const [users, setUsers] = useState<User[]>([])
  const [invites, setInvites] = useState<RegistrationInvite[]>([])
  const [emailStatus, setEmailStatus] = useState<RegistrationInviteEmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [issue, setIssue] = useState<RegistrationInviteIssue | null>(null)
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState({
    email: '',
    expiresInDays: 7,
    note: '',
    sendEmail: false,
  })

  const activeInvites = useMemo(
    () => invites.filter((invite) => inviteState(invite) === 'active').length,
    [invites],
  )

  const loadAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextUsers, nextInvites, nextEmailStatus] = await Promise.all([
        adminApi.listUsers(),
        adminApi.listInvites(),
        adminApi.emailStatus(),
      ])
      setUsers(nextUsers)
      setInvites(nextInvites)
      setEmailStatus(nextEmailStatus)
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  const refreshInvites = async () => {
    setInvites(await adminApi.listInvites())
  }

  const handleCreateInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    if (actionBusy) return
    setActionBusy('create-invite')
    setError(null)
    setCopied(false)
    try {
      const created = await adminApi.createInvite({
        email: form.email.trim(),
        expires_in_days: form.expiresInDays,
        note: form.note.trim(),
        send_email: form.sendEmail,
      })
      setIssue(created)
      setForm((value) => ({ ...value, note: '', sendEmail: false }))
      await refreshInvites()
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setActionBusy(null)
    }
  }

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('复制失败，请手动选择链接。')
    }
  }

  const handleUserPatch = async (user: User, patch: Partial<User>) => {
    setActionBusy(`user-${user.id}`)
    setError(null)
    try {
      const updated = await adminApi.updateUser(user.id, {
        is_admin: patch.is_admin,
        is_disabled: patch.is_disabled,
        display_name: patch.display_name,
      })
      setUsers((items) => items.map((item) => (item.id === updated.id ? updated : item)))
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setActionBusy(null)
    }
  }

  const handleDeleteUser = async (user: User) => {
    if (!window.confirm(`删除账号 ${user.email}？此操作会删除该用户。`)) return
    setActionBusy(`delete-${user.id}`)
    setError(null)
    try {
      await adminApi.deleteUser(user.id)
      setUsers((items) => items.filter((item) => item.id !== user.id))
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setActionBusy(null)
    }
  }

  const handleRevokeInvite = async (invite: RegistrationInvite) => {
    setActionBusy(`revoke-${invite.id}`)
    setError(null)
    try {
      const revoked = await adminApi.revokeInvite(invite.id)
      setInvites((items) => items.map((item) => (item.id === revoked.id ? revoked : item)))
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setActionBusy(null)
    }
  }

  const handleResendInvite = async (invite: RegistrationInvite) => {
    setActionBusy(`resend-${invite.id}`)
    setError(null)
    setCopied(false)
    try {
      const resent = await adminApi.resendInvite(invite.id)
      setIssue(resent)
      await refreshInvites()
    } catch (e) {
      setError(extractMessage(e))
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <Link to="/projects" className="brand">SuperLeaf</Link>
          <span className="brand-sep">/</span>
          <span className="project-pill">Admin</span>
        </div>
        <div className="admin-header-actions">
          <button type="button" className="secondary-btn" onClick={() => navigate('/projects')}>
            <ArrowLeft size={14} /> 返回项目
          </button>
          <button type="button" className="secondary-btn" onClick={() => void loadAll()}>
            <RefreshCw size={14} /> 刷新
          </button>
          <UserMenu />
        </div>
      </header>

      <main className="admin-main">
        <section className="admin-overview" aria-label="管理员概览">
          <div className="admin-stat">
            <span>用户</span>
            <strong>{users.length}</strong>
          </div>
          <div className="admin-stat">
            <span>管理员</span>
            <strong>{users.filter((user) => user.is_admin).length}</strong>
          </div>
          <div className="admin-stat">
            <span>可用邀请</span>
            <strong>{activeInvites}</strong>
          </div>
          <div className="admin-stat">
            <span>SMTP</span>
            <strong>{emailStatus?.smtp_configured ? '已配置' : '未配置'}</strong>
          </div>
        </section>

        <div className="admin-tabs" role="tablist" aria-label="管理员页面">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'invites'}
            className={tab === 'invites' ? 'active' : ''}
            onClick={() => setTab('invites')}
          >
            <Mail size={14} /> 邀请码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'users'}
            className={tab === 'users' ? 'active' : ''}
            onClick={() => setTab('users')}
          >
            <UserCheck size={14} /> 用户
          </button>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {loading && <div className="admin-empty">加载中...</div>}

        {!loading && tab === 'invites' && (
          <div className="admin-grid">
            <section className="admin-section">
              <div className="admin-section-heading">
                <h2>创建邀请码</h2>
                <span>{emailStatus?.from_email || '复制链接可用'}</span>
              </div>
              <form className="invite-form" onSubmit={handleCreateInvite}>
                <label>
                  邮箱
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((value) => ({ ...value, email: e.target.value }))}
                    placeholder="user@example.edu"
                  />
                </label>
                <label>
                  有效天数
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={form.expiresInDays}
                    onChange={(e) =>
                      setForm((value) => ({ ...value, expiresInDays: Number(e.target.value) }))
                    }
                  />
                </label>
                <label className="invite-form-wide">
                  备注
                  <input
                    type="text"
                    value={form.note}
                    onChange={(e) => setForm((value) => ({ ...value, note: e.target.value }))}
                    maxLength={1000}
                    placeholder="课题组、班级或用途"
                  />
                </label>
                <label className="invite-checkbox">
                  <input
                    type="checkbox"
                    checked={form.sendEmail}
                    disabled={!emailStatus?.smtp_configured}
                    onChange={(e) =>
                      setForm((value) => ({ ...value, sendEmail: e.target.checked }))
                    }
                  />
                  发送邮件
                </label>
                <button
                  type="submit"
                  className="primary-btn invite-submit"
                  disabled={actionBusy === 'create-invite'}
                >
                  <Mail size={14} /> {actionBusy === 'create-invite' ? '创建中...' : '创建邀请'}
                </button>
              </form>

              {issue && (
                <div className="invite-issue">
                  <div>
                    <span>最近生成</span>
                    <strong>{issue.email || '通用邀请'}</strong>
                  </div>
                  <code>{issue.invite_url}</code>
                  <div className="invite-issue-actions">
                    <button type="button" className="secondary-btn" onClick={() => void handleCopy(issue.invite_url)}>
                      {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                      {copied ? '已复制' : '复制链接'}
                    </button>
                    <button type="button" className="secondary-btn" onClick={() => void handleCopy(issue.token)}>
                      <Copy size={14} /> 复制邀请码
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="admin-section admin-section-wide">
              <div className="admin-section-heading">
                <h2>邀请记录</h2>
                <span>{invites.length} 条</span>
              </div>
              <InviteTable
                invites={invites}
                actionBusy={actionBusy}
                onRevoke={handleRevokeInvite}
                onResend={handleResendInvite}
              />
            </section>
          </div>
        )}

        {!loading && tab === 'users' && (
          <section className="admin-section">
            <div className="admin-section-heading">
              <h2>用户管理</h2>
              <span>{currentUser?.email}</span>
            </div>
            <UserTable
              users={users}
              currentUserId={currentUser?.id ?? ''}
              actionBusy={actionBusy}
              onPatch={handleUserPatch}
              onDelete={handleDeleteUser}
            />
          </section>
        )}
      </main>
    </div>
  )
}

function UserTable({
  users,
  currentUserId,
  actionBusy,
  onPatch,
  onDelete,
}: {
  users: User[]
  currentUserId: string
  actionBusy: string | null
  onPatch: (user: User, patch: Partial<User>) => void
  onDelete: (user: User) => void
}) {
  if (users.length === 0) {
    return <div className="admin-empty">暂无用户</div>
  }
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>账号</th>
            <th>角色</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>最近登录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="admin-user-cell">
                  <strong>{user.display_name || user.email}</strong>
                  <span>{user.email}</span>
                </div>
              </td>
              <td>
                <StatusBadge tone={user.is_admin ? 'green' : 'slate'}>
                  {user.is_admin ? '管理员' : '成员'}
                </StatusBadge>
              </td>
              <td>
                <StatusBadge tone={user.is_disabled ? 'red' : 'green'}>
                  {user.is_disabled ? '停用' : '可用'}
                </StatusBadge>
              </td>
              <td>{formatDate(user.created_at)}</td>
              <td>{formatDate(user.last_login_at)}</td>
              <td>
                <div className="admin-row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={user.is_admin ? '取消管理员' : '设为管理员'}
                    disabled={actionBusy === `user-${user.id}`}
                    onClick={() => onPatch(user, { is_admin: !user.is_admin })}
                  >
                    <ShieldCheck size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={user.is_disabled ? '启用账号' : '停用账号'}
                    disabled={actionBusy === `user-${user.id}`}
                    onClick={() => onPatch(user, { is_disabled: !user.is_disabled })}
                  >
                    {user.is_disabled ? <UserCheck size={14} /> : <UserX size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除用户"
                    disabled={user.id === currentUserId || actionBusy === `delete-${user.id}`}
                    onClick={() => onDelete(user)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InviteTable({
  invites,
  actionBusy,
  onRevoke,
  onResend,
}: {
  invites: RegistrationInvite[]
  actionBusy: string | null
  onRevoke: (invite: RegistrationInvite) => void
  onResend: (invite: RegistrationInvite) => void
}) {
  if (invites.length === 0) {
    return <div className="admin-empty">暂无邀请</div>
  }
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>邮箱</th>
            <th>状态</th>
            <th>邮件</th>
            <th>尾号</th>
            <th>过期时间</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => {
            const state = inviteState(invite)
            const canAct = state === 'active'
            return (
              <tr key={invite.id}>
                <td>{invite.email || '通用邀请'}</td>
                <td>
                  <StatusBadge tone={stateTone(state)}>{stateLabel(state)}</StatusBadge>
                </td>
                <td>
                  <StatusBadge tone={sendTone(invite.send_status)}>
                    {sendLabel(invite.send_status)}
                  </StatusBadge>
                </td>
                <td>
                  <code className="token-hint">{invite.token_hint || '-'}</code>
                </td>
                <td>{formatDate(invite.expires_at)}</td>
                <td className="admin-note">{invite.note || '-'}</td>
                <td>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="重新生成并发送"
                      disabled={!canAct || !invite.email || actionBusy === `resend-${invite.id}`}
                      onClick={() => onResend(invite)}
                    >
                      <RotateCw size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="撤销邀请"
                      disabled={!canAct || actionBusy === `revoke-${invite.id}`}
                      onClick={() => onRevoke(invite)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatusBadge({ tone, children }: { tone: 'green' | 'red' | 'amber' | 'blue' | 'slate'; children: React.ReactNode }) {
  return <span className={`admin-badge admin-badge-${tone}`}>{children}</span>
}

function inviteState(invite: RegistrationInvite): 'active' | 'used' | 'revoked' | 'expired' {
  if (invite.used_at) return 'used'
  if (invite.revoked_at) return 'revoked'
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return 'expired'
  return 'active'
}

function stateLabel(state: ReturnType<typeof inviteState>): string {
  const labels = {
    active: '可用',
    used: '已使用',
    revoked: '已撤销',
    expired: '已过期',
  }
  return labels[state]
}

function stateTone(state: ReturnType<typeof inviteState>): 'green' | 'red' | 'amber' | 'blue' | 'slate' {
  if (state === 'active') return 'green'
  if (state === 'used') return 'blue'
  if (state === 'expired') return 'amber'
  return 'red'
}

function sendLabel(status: string): string {
  const labels: Record<string, string> = {
    not_requested: '未发送',
    queued: '发送中',
    sent: '已发送',
    failed: '失败',
    not_configured: '未配置',
    revoked: '已撤销',
    used: '已使用',
  }
  return labels[status] ?? status
}

function sendTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'slate' {
  if (status === 'sent') return 'green'
  if (status === 'queued') return 'blue'
  if (status === 'failed' || status === 'not_configured') return 'red'
  if (status === 'used') return 'amber'
  return 'slate'
}

function formatDate(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function extractMessage(e: unknown): string {
  if (e instanceof BackendError) return e.detail || `请求失败 (${e.status})`
  if (e instanceof Error) return e.message
  return String(e)
}
