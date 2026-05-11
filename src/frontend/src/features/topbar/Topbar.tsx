/**
 * Topbar — application header: brand block + provider badge + actions.
 *
 * Stateless shell; the active provider info and settings-dialog-open callback
 * are injected so this component can live outside any store wiring.
 */

import { Save, Settings2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ProviderBadge } from './ProviderBadge'
import { ViewControl } from './ViewControl'
import { useProjectStore } from '../../stores/projectStore'
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
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projectName = useProjectStore((s) =>
    currentProjectId ? s.projects.find((p) => p.id === currentProjectId)?.name ?? null : null,
  )

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="brand-row">
          <Link to="/projects" className="brand" title="返回项目列表">YuwanLabWriter</Link>
          {projectName && (
            <>
              <span className="brand-sep" aria-hidden>/</span>
              <span className="project-pill" title={projectName}>{projectName}</span>
            </>
          )}
        </div>
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
