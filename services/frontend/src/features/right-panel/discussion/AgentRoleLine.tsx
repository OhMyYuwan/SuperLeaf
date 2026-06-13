/**
 * AgentRoleLine — Agent 消息气泡上方那一行小标签：名字、读写文件计数、本机/远端
 * 会话 ID、MCP bridge 状态。只读展示，不持有自身状态。
 */

import type { AgentRunStats } from '../../../stores/conversationStore'
import { formatBridgeStatus, formatSessionRuntime, formatShortSessionId } from './format'

export function AgentRoleLine({
  name,
  runStats,
}: {
  name: string
  runStats?: AgentRunStats
}) {
  const parts: string[] = []
  if (runStats?.filesRead) parts.push(`读文件 ${runStats.filesRead}`)
  if (runStats?.filesWritten) parts.push(`写文件 ${runStats.filesWritten}`)
  if (runStats?.stopped) parts.push('已停止')
  if (runStats?.waitingReminder) parts.push(runStats.waitingReminder)
  const bridgeLabel = formatBridgeStatus(runStats?.bridgeStatus)
  const localSession = formatShortSessionId(runStats?.localSessionId)
  const externalSession = formatShortSessionId(runStats?.externalSessionId)
  const runtimeLabel = formatSessionRuntime(runStats?.sessionRuntime)
  return (
    <div className="message-role">
      <span>{name}</span>
      {parts.length > 0 && <span className="agent-run-stats">{parts.join(' · ')}</span>}
      {localSession && (
        <span
          className="agent-session-status local"
          title={[
            `Local Host session: ${runStats?.localSessionId}`,
            runStats?.workspacePath ? `Workspace: ${runStats.workspacePath}` : '',
          ].filter(Boolean).join('\n')}
        >
          本机会话 {localSession}
        </span>
      )}
      {externalSession && (
        <span
          className="agent-session-status external"
          title={`${runtimeLabel} session: ${runStats?.externalSessionId}`}
        >
          {runtimeLabel} {externalSession}
        </span>
      )}
      {bridgeLabel && (
        <span
          className={`agent-bridge-status ${runStats?.bridgeStatus ?? ''}`}
          title={runStats?.bridgeError || bridgeLabel}
        >
          {bridgeLabel}
        </span>
      )}
    </div>
  )
}
