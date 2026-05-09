/**
 * Topbar — application header: brand block + provider badge + actions.
 *
 * Stateless shell; the active provider info and settings-dialog-open callback
 * are injected so this component can live outside any store wiring.
 */

import { Save, Settings2 } from 'lucide-react'
import { ProviderBadge } from './ProviderBadge'
import { ViewControl } from './ViewControl'
import './topbar.css'

interface TopbarProps {
  backendReachable: boolean | null
  providerName: string | null
  providerStatus: string | null
  onOpenSettings: () => void
  onSave?: () => void
}

export function Topbar({
  backendReachable,
  providerName,
  providerStatus,
  onOpenSettings,
  onSave,
}: TopbarProps) {
  return (
    <header className="topbar">
      <div>
        <div className="brand">YuwanLabWriter</div>
        <div className="subtitle">LaTeX-first 本地科研写作工作台</div>
      </div>
      <div className="topbar-actions">
        <ProviderBadge
          reachable={backendReachable}
          providerName={providerName}
          providerStatus={providerStatus}
          onOpen={onOpenSettings}
        />
        <ViewControl />
        <button className="ghost-btn" onClick={onSave}>
          <Save size={16} /> 保存
        </button>
        <button className="ghost-btn" onClick={onOpenSettings}>
          <Settings2 size={16} /> 设置
        </button>
      </div>
    </header>
  )
}
