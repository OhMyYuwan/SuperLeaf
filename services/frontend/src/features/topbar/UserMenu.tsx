/**
 * UserMenu — Topbar avatar with logout.
 *
 * Reads currentUser from userStore. The avatar's initial = first character
 * of display_name (fallback email). Clicking opens a Radix dropdown with
 * account, admin, and logout actions.
 */

import { useNavigate } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'

export function UserMenu() {
  const navigate = useNavigate()
  const currentUser = useUserStore((s) => s.currentUser)
  const logout = useUserStore((s) => s.logout)

  if (!currentUser) return null

  const displayName = currentUser.display_name || currentUser.email
  const initial = (displayName || '?').trim().charAt(0).toUpperCase() || '?'

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="user-menu-trigger"
          aria-label="账号菜单"
          title={displayName}
        >
          <span className="user-menu-avatar">{initial}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="user-menu-content"
        >
          <div className="user-menu-header">
            <div className="user-menu-name">
              {displayName}
              {currentUser.is_admin && (
                <span className="user-menu-admin" title="管理员">
                  <ShieldCheck size={12} /> Admin
                </span>
              )}
            </div>
            <div className="user-menu-email">{currentUser.email}</div>
          </div>
          <DropdownMenu.Separator className="user-menu-sep" />
          <DropdownMenu.Item
            className="user-menu-item"
            onSelect={() => navigate('/account')}
          >
            <UserRound size={14} /> 个人面板
          </DropdownMenu.Item>
          {currentUser.is_admin && (
            <DropdownMenu.Item
              className="user-menu-item"
              onSelect={() => navigate('/admin')}
            >
              <ShieldCheck size={14} /> 管理员控制台
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className="user-menu-item"
            onSelect={() => void handleLogout()}
          >
            <LogOut size={14} /> 退出登录
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
