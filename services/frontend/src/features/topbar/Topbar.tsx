/**
 * Topbar — application header: brand block + focused workspace actions.
 */

import { Link } from 'react-router-dom'
import { ViewControl } from './ViewControl'
import { UserMenu } from './UserMenu'
import { NotificationBell } from './NotificationBell'
import { PresenceIndicator } from './PresenceIndicator'
import { useProjectStore } from '../../stores/projectStore'
import './topbar.css'

interface TopbarProps {
  onOpenPersonalPanel?: () => void
}

export function Topbar({
  onOpenPersonalPanel,
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
        <div className="subtitle">Agent 原生的本地科研写作工作台</div>
      </div>
      <div className="topbar-actions">
        <PresenceIndicator />
        <ViewControl />
        <NotificationBell />
        <UserMenu onOpenPersonalPanel={onOpenPersonalPanel} />
      </div>
    </header>
  )
}
