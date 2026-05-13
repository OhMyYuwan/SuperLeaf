import { useCollaborationStore } from '../../stores/collaborationStore'
import type { ConnectionStatus } from '../../services/collaborationProvider'
import './collaboration-status.css'

export function CollaborationStatus() {
  const status = useCollaborationStore((s) => s.status)
  const peers = useCollaborationStore((s) => s.peers)

  if (status === 'disconnected') return null

  return (
    <div className="collab-status">
      <span className={`collab-dot ${dotClass(status)}`} title={labelFor(status)} />
      {peers.length > 0 && (
        <div className="collab-peers">
          {peers.map((p) => (
            <span
              key={p.id}
              className="collab-peer-chip"
              style={{ borderColor: p.color }}
              title={p.name}
            >
              {p.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {status === 'connecting' && <span className="collab-label">连接中...</span>}
    </div>
  )
}

function dotClass(status: ConnectionStatus): string {
  switch (status) {
    case 'synced': return 'green'
    case 'connected': return 'yellow'
    case 'connecting': return 'yellow pulse'
    default: return 'red'
  }
}

function labelFor(status: ConnectionStatus): string {
  switch (status) {
    case 'synced': return '已同步'
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    default: return '未连接'
  }
}
