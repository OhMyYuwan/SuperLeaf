/**
 * LocalApprovalPanel — 显示本机 Agent 等待用户确认的 approval 列表，并允许接受
 * /拒绝。每张卡上方显示标题和方法（mcp/permissions/file/command），下方根据状态
 * 渲染按钮或最终结论。
 */

import { Check, X } from 'lucide-react'
import type { LocalAgentApprovalEntry } from '../../../stores/conversationStore'
import { formatApprovalMethod, localApprovalStatusLabel } from './format'

interface LocalApprovalPanelProps {
  approvals: LocalAgentApprovalEntry[]
  onAccept: (requestId: string) => void
  onReject: (requestId: string) => void
}

export function LocalApprovalPanel({
  approvals,
  onAccept,
  onReject,
}: LocalApprovalPanelProps) {
  return (
    <div className="local-approval-panel" aria-live="polite">
      {approvals.map((approval) => {
        const decided = approval.status !== 'pending'
        return (
          <div key={approval.id} className={`local-approval-card status-${approval.status}`}>
            <div className="local-approval-main">
              <div className="local-approval-title-row">
                <span className="local-approval-title">{approval.title || 'Codex 请求确认'}</span>
                <span className="local-approval-method">{formatApprovalMethod(approval)}</span>
              </div>
              <div className="local-approval-summary">
                {approval.summary || approval.detail || 'Codex 正在等待你的确认。'}
              </div>
              {approval.error && (
                <div className="local-approval-error">{approval.error}</div>
              )}
            </div>
            <div className="local-approval-actions">
              {approval.status === 'pending' ? (
                <>
                  <button className="local-approval-accept" onClick={() => onAccept(approval.id)}>
                    <Check size={12} /> Accept
                  </button>
                  <button className="local-approval-reject" onClick={() => onReject(approval.id)}>
                    <X size={12} /> Reject
                  </button>
                </>
              ) : (
                <span className="local-approval-status">
                  {decided ? localApprovalStatusLabel(approval.status) : ''}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
