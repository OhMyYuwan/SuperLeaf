/**
 * NotificationBell — Topbar 通知铃铛 + 下拉列表
 */

import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { http } from '../../services/backendApi'
import './notification-bell.css'

interface NotificationItem {
  id: string
  user_id: string
  kind: string
  title: string
  body: string
  target_id: string
  target_type: string
  is_read: boolean
  created_at: string
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadUnreadCount()
    const interval = setInterval(loadUnreadCount, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (open) loadNotifications()
  }, [open])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const loadUnreadCount = async () => {
    try {
      const data = await http<{ count: number }>('/api/notifications/unread-count', { scope: 'global' })
      setUnreadCount(data.count)
    } catch { /* ignore */ }
  }

  const loadNotifications = async () => {
    try {
      const data = await http<NotificationItem[]>('/api/notifications', { scope: 'global' })
      setNotifications(data)
    } catch { /* ignore */ }
  }

  const markRead = async (id: string) => {
    try {
      await http<void>(`/api/notifications/${id}/read`, { method: 'POST', scope: 'global' })
      setNotifications(notifications.map(n => n.id === id ? { ...n, is_read: true } : n))
      setUnreadCount(Math.max(0, unreadCount - 1))
    } catch { /* ignore */ }
  }

  const markAllRead = async () => {
    try {
      await http<void>('/api/notifications/read-all', { method: 'POST', scope: 'global' })
      setNotifications(notifications.map(n => ({ ...n, is_read: true })))
      setUnreadCount(0)
    } catch { /* ignore */ }
  }

  return (
    <div className="notification-bell" ref={ref}>
      <button
        className="notification-bell-btn"
        onClick={() => setOpen(!open)}
        aria-label="通知"
        title="通知"
      >
        <Bell size={16} />
        {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
      </button>

      {open && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <span>通知</span>
            {unreadCount > 0 && (
              <button className="notification-mark-all" onClick={markAllRead}>
                全部已读
              </button>
            )}
          </div>
          <div className="notification-list">
            {notifications.length === 0 ? (
              <div className="notification-empty">暂无通知</div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  className={`notification-item ${n.is_read ? 'read' : 'unread'}`}
                  onClick={() => !n.is_read && markRead(n.id)}
                >
                  <div className="notification-title">{n.title}</div>
                  <div className="notification-body">{n.body}</div>
                  <div className="notification-time">{formatTime(n.created_at)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return d.toLocaleDateString()
  } catch {
    return iso
  }
}
