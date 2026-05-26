/**
 * ProjectMembersPanel — 项目成员管理 UI
 *
 * 允许项目所有者邀请其他用户协作编辑项目（Overleaf 风格）
 */

import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2, Users } from 'lucide-react'
import {
  projectMemberApi,
  type ProjectMember,
  type ProjectMemberAddIn,
  type RecentCollaborator,
} from '../../services/backendApi'
import { showToast } from '../shared/toast'
import './settings.css'

interface ProjectMembersPanelProps {
  projectId: string
  projectOwnerId: string
  currentUserId: string
}

export function ProjectMembersPanel({ projectId, projectOwnerId, currentUserId }: ProjectMembersPanelProps) {
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [recentCollaborators, setRecentCollaborators] = useState<RecentCollaborator[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  const isOwner = currentUserId === projectOwnerId

  useEffect(() => {
    let cancelled = false

    const loadMembers = async () => {
      try {
        setLoading(true)
        const [data, recent] = await Promise.all([
          projectMemberApi.list(projectId),
          isOwner ? projectMemberApi.recentCollaborators() : Promise.resolve([]),
        ])
        if (cancelled) return
        setMembers(data)
        setRecentCollaborators(recent)
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load members:', err)
        showToast('加载成员列表失败', { level: 'error' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadMembers()
    return () => {
      cancelled = true
    }
  }, [projectId, isOwner])

  const handleRemove = async (userId: string, userName: string) => {
    if (!confirm(`确定移除成员 "${userName}"？`)) return
    try {
      await projectMemberApi.remove(projectId, userId)
      setMembers((current) => current.filter((member) => member.user_id !== userId))
      showToast('成员已移除', { level: 'success' })
    } catch (err) {
      console.error('Failed to remove member:', err)
      showToast('移除成员失败', { level: 'error' })
    }
  }

  const handleAdd = async (body: ProjectMemberAddIn) => {
    try {
      const newMember = await projectMemberApi.add(projectId, body)
      setMembers((current) => {
        if (current.some((member) => member.id === newMember.id)) return current
        return [...current, newMember]
      })
      void projectMemberApi
        .recentCollaborators()
        .then(setRecentCollaborators)
        .catch((err) => console.warn('Failed to refresh recent collaborators:', err))
      setShowForm(false)
      showToast('成员已添加', { level: 'success' })
    } catch (err: unknown) {
      console.error('Failed to add member:', err)
      const message = err instanceof Error ? err.message : String(err)
      const msg = message.includes('404') ? '用户不存在' : '添加成员失败'
      showToast(msg, { level: 'error' })
    }
  }

  return (
    <div className="project-members-panel">
      <div className="panel-header">
        <div className="header-title">
          <Users size={16} />
          <span>项目成员</span>
        </div>
        {isOwner && !showForm && (
          <button className="ghost-btn small" onClick={() => setShowForm(true)}>
            <Plus size={14} /> 邀请成员
          </button>
        )}
      </div>

      {loading ? (
        <div className="loading-state">
          <Loader2 size={16} className="spin" /> 加载中...
        </div>
      ) : (
        <>
          {members.length === 0 && !showForm && (
            <div className="empty-state">
              还没有协作成员。{isOwner && '点击上方按钮邀请其他用户。'}
            </div>
          )}

          <ul className="member-list">
            {members.map((member) => (
              <li key={member.id} className="member-row">
                <div className="member-info">
                  <div className="member-name">{member.user_display_name}</div>
                  <div className="member-email">{member.user_email}</div>
                </div>
                <div className="member-actions">
                  <span className="role-badge">{member.role === 'editor' ? '编辑' : '查看'}</span>
                  {isOwner && (
                    <button
                      className="ghost-btn small danger"
                      onClick={() => handleRemove(member.user_id, member.user_display_name)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {showForm && (
            <MemberInviteForm
              recentCollaborators={recentCollaborators}
              onSubmit={handleAdd}
              onCancel={() => setShowForm(false)}
            />
          )}
        </>
      )}
    </div>
  )
}

function MemberInviteForm({
  recentCollaborators,
  onSubmit,
  onCancel,
}: {
  recentCollaborators: RecentCollaborator[]
  onSubmit: (body: ProjectMemberAddIn) => Promise<void>
  onCancel: () => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    await onSubmit({ email: email.trim(), role })
    setSubmitting(false)
  }

  return (
    <form className="member-invite-form" onSubmit={handleSubmit}>
      <div className="member-invite-email-field">
        <label>
          <span>邮箱地址</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            autoFocus
            required
          />
        </label>
        <div className="recent-collaborators" aria-label="近期合作者">
          <div className="recent-collaborators-title">近期合作者</div>
          {recentCollaborators.length > 0 ? (
            <div className="recent-collaborator-list">
              {recentCollaborators.map((item) => (
                <button
                  key={item.user_id}
                  type="button"
                  className="recent-collaborator-chip"
                  onClick={() => setEmail(item.email)}
                  title={`${item.display_name || item.email} · ${item.email}`}
                >
                  {(item.display_name || item.email)} · {item.email}
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-collaborators-empty">暂无近期合作者</div>
          )}
        </div>
      </div>
      <label>
        <span>权限</span>
        <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
          <option value="editor">编辑（可修改文档）</option>
          <option value="viewer">查看（只读）</option>
        </select>
      </label>
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="spin" /> : '邀请'}
        </button>
      </div>
    </form>
  )
}
