/**
 * PresenceIndicator — 显示当前在线协作成员的头像
 */

import { useEffect, useState } from 'react'
import { http } from '../../services/backendApi'
import { useProjectStore } from '../../stores/projectStore'
import './presence-indicator.css'

interface OnlineUser {
  user_id: string
  display_name: string
}

export function PresenceIndicator() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([])

  useEffect(() => {
    if (!currentProjectId) {
      setOnlineUsers([])
      return
    }
    loadOnline()
    const interval = setInterval(loadOnline, 15000)
    return () => clearInterval(interval)
  }, [currentProjectId])

  const loadOnline = async () => {
    if (!currentProjectId) return
    try {
      const data = await http<OnlineUser[]>(
        `/api/projects/${encodeURIComponent(currentProjectId)}/online`,
        { scope: 'global' },
      )
      setOnlineUsers(data)
    } catch { /* ignore */ }
  }

  if (onlineUsers.length === 0) return null

  return (
    <div className="presence-indicator" title={onlineUsers.map(u => u.display_name).join(', ')}>
      {onlineUsers.slice(0, 4).map((user) => (
        <div key={user.user_id} className="presence-avatar" title={user.display_name}>
          {getInitial(user.display_name)}
        </div>
      ))}
      {onlineUsers.length > 4 && (
        <div className="presence-avatar presence-more">+{onlineUsers.length - 4}</div>
      )}
    </div>
  )
}

function getInitial(name: string): string {
  if (!name) return '?'
  return name.charAt(0).toUpperCase()
}
