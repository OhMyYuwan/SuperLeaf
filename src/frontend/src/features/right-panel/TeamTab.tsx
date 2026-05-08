/**
 * TeamTab — lists Dify apps synced from the active provider.
 *
 * Read-only view: show cards for each cached workflow, plus empty / error
 * states when nothing is synced or provider isn't configured.
 */

import type { CachedWorkflow, Provider } from '../../services/backendApi'

interface TeamTabProps {
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  workflowError: string | null
  activeProvider: Provider | null
  onReload: () => void
}

export function TeamTab({
  workflows,
  workflowsLoaded,
  workflowError,
  activeProvider,
  onReload,
}: TeamTabProps) {
  return (
    <>
      <div className="tab-header-row">
        <span>Dify Agent / Workflow：{workflows.length} 个已同步</span>
        <button className="small-btn" onClick={onReload}>
          刷新
        </button>
      </div>
      {!activeProvider && (
        <div className="tab-empty">
          还未配置或激活 provider。先去"设置"里添加 Dify provider，并点击"测连"完成首次同步。
        </div>
      )}
      {activeProvider && workflowsLoaded && workflows.length === 0 && (
        <div className="tab-empty">
          没有同步到任何 app。确保已在 Dify 里创建应用并生成 API key，然后回到"设置"点击"测连"。
        </div>
      )}
      {workflowError && <div className="tab-error">{workflowError}</div>}
      <div className="agent-grid">
        {workflows.map((wf) => (
          <div key={wf.id} className="agent-card" title={wf.description || wf.kind}>
            <div className="agent-avatar" style={{ background: agentColor(wf.kind) }}>
              {wf.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="agent-info">
              <strong>{wf.name}</strong>
              <span>
                {wf.kind}
                {wf.description ? ` · ${wf.description}` : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function agentColor(kind: string): string {
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}
