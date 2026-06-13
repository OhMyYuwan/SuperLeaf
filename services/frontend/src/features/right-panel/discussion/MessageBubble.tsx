/**
 * MessageBubble — 单条消息气泡。
 *
 * 根据 role 分发：
 * - agent → AgentRoleLine + AgentMarkdown 渲染富文本
 * - user → UserMessageContent（带折叠的纯文本气泡）
 * - 其他 → 原始文本
 *
 * 如果消息绑定了原文档区间，气泡尾部显示「跳转到原文」按钮。
 */

import type { AgentRunStats } from '../../../stores/conversationStore'
import type { Message } from '../../../services/backendApi'
import type { MentionCandidate } from '../../../services/mentions'
import { AgentMarkdown } from '../../shared/AgentMarkdown'
import { AgentRoleLine } from './AgentRoleLine'
import { UserMessageContent } from './UserMessageContent'

interface MessageBubbleProps {
  message: Message
  agentDisplayName: string
  runStats?: AgentRunStats
  allCandidates: MentionCandidate[]
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function MessageBubble({
  message,
  agentDisplayName,
  runStats,
  allCandidates,
  onJumpToRange,
}: MessageBubbleProps) {
  const hasRange = message.range_start !== null && message.range_end !== null
  return (
    <div className={`message-bubble ${message.role}`}>
      {message.role === 'agent' ? (
        <>
          <AgentRoleLine name={agentDisplayName} runStats={runStats} />
          <AgentMarkdown source={message.content} className="message-content" />
        </>
      ) : message.role === 'user' ? (
        <UserMessageContent content={message.content} allCandidates={allCandidates} />
      ) : (
        <div className="message-content">{message.content}</div>
      )}
      {message.error && <div className="message-error">错误：{message.error}</div>}
      {hasRange && onJumpToRange && (
        <button
          className="message-jump-btn"
          onClick={() =>
            onJumpToRange({ from: message.range_start!, to: message.range_end! })
          }
        >
          ↗ 跳转到原文
        </button>
      )}
    </div>
  )
}
