import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, ShieldCheck, UserRound } from 'lucide-react'
import {
  BackendStatusBar,
  PersonalSettingsContent,
  PersonalSettingsTabs,
  type PersonalSettingsTab,
} from '../features/settings/SettingsDialog'
import { UserMenu } from '../features/topbar/UserMenu'
import { useSettingsStore } from '../stores/settingsStore'
import { useUserStore } from '../stores/userStore'
import '../features/topbar/topbar.css'
import './account.css'

export function AccountPage() {
  const navigate = useNavigate()
  const currentUser = useUserStore((s) => s.currentUser)
  const load = useSettingsStore((s) => s.load)
  const loaded = useSettingsStore((s) => s.loaded)
  const loading = useSettingsStore((s) => s.loading)
  const backendReachable = useSettingsStore((s) => s.backendReachable)
  const error = useSettingsStore((s) => s.error)
  const [activeTab, setActiveTab] = useState<PersonalSettingsTab>('account')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!loaded && !loading) {
      void load()
    }
  }, [load, loaded, loading])

  const refresh = async () => {
    await load()
    setRefreshKey((value) => value + 1)
  }

  const displayName = currentUser?.display_name || currentUser?.email || '当前用户'

  return (
    <div className="account-page">
      <header className="account-header">
        <div className="account-brand">
          <Link to="/projects" className="brand">SuperLeaf</Link>
          <span className="brand-sep">/</span>
          <span className="project-pill">Account</span>
        </div>
        <div className="account-header-actions">
          <button type="button" className="secondary-btn" onClick={() => navigate('/projects')}>
            <ArrowLeft size={14} /> 返回项目
          </button>
          <button type="button" className="secondary-btn" onClick={() => void refresh()}>
            <RefreshCw size={14} /> 刷新
          </button>
          <UserMenu />
        </div>
      </header>

      <main className="account-main">
        <section
          className={`account-overview ${currentUser?.is_admin ? 'has-admin-entry' : ''}`}
          aria-label="个人面板概览"
        >
          <div className="account-identity">
            <span className="account-avatar" aria-hidden>
              <UserRound size={20} />
            </span>
            <div>
              <h1>{displayName}</h1>
              <p>{currentUser?.email}</p>
            </div>
          </div>
          {currentUser?.is_admin && (
            <button
              type="button"
              className="account-admin-entry"
              onClick={() => navigate('/admin')}
            >
              <span className="account-admin-icon" aria-hidden>
                <ShieldCheck size={18} />
              </span>
              <span>
                <strong>管理员控制台</strong>
                <small>管理用户与邀请码</small>
              </span>
            </button>
          )}
        </section>

        <BackendStatusBar reachable={backendReachable} error={error} onRetry={() => void refresh()} />

        <div className="account-layout">
          <aside className="account-sidebar" aria-label="个人面板分区">
            <PersonalSettingsTabs
              activeTab={activeTab}
              onTabChange={setActiveTab}
              className="account-tabs"
            />
          </aside>
          <section className="account-content" aria-label="个人面板内容">
            <PersonalSettingsContent key={refreshKey} activeTab={activeTab} />
          </section>
        </div>
      </main>
    </div>
  )
}
