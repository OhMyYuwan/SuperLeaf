/**
 * UserMenu — Topbar avatar with logout.
 *
 * Reads currentUser from userStore. The avatar's initial = first character
 * of display_name (fallback email). Clicking opens a Radix dropdown with
 * email + a logout action that calls userStore.logout() and routes back to
 * /login.
 */

import { useNavigate } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'

interface UserMenuProps {
  onOpenPersonalPanel?: () => void
}

export function UserMenu({ onOpenPersonalPanel }: UserMenuProps) {
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
          {onOpenPersonalPanel && (
            <DropdownMenu.Item
              className="user-menu-item"
              onSelect={onOpenPersonalPanel}
            >
              <UserRound size={14} /> 个人面板
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
