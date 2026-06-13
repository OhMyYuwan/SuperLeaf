/**
 * EditProposalCard — 一条 Agent 提议的局部文本修改。
 *
 * 卡片可折叠/展开。展开时显示理由（reason）和 ±diff 行；pending 时给出
 * Accept/Reject 按钮，stale 时给出"原文已变"的人工核对提示。点击标题区会跳到
 * 原文（按提案存档时的字面 range，不含 RelativePosition 重映射 —— 跳转只是导
 * 航提示，可接受少量偏移）。
 */

import { Check, ChevronDown, ChevronRight, FileEdit, X } from 'lucide-react'
import type { ProposalEntry } from '../../../stores/conversationStore'

interface EditProposalCardProps {
  proposal: ProposalEntry
  collapsed: boolean
  onToggleCollapsed: () => void
  onAccept: () => void
  onReject: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function EditProposalCard({
  proposal,
  collapsed,
  onToggleCollapsed,
  onAccept,
  onReject,
  onJumpToRange,
}: EditProposalCardProps) {
  const isPending = proposal.status === 'pending'
  const statusLabel = (() => {
    switch (proposal.status) {
      case 'accepted':
        return '已采纳'
      case 'rejected':
        return '已拒绝'
      case 'stale':
        return '原文已变化'
      default:
        return '待确认'
    }
  })()
  const summary =
    proposal.reason ||
    proposal.new_text.slice(0, 40) ||
    proposal.original_text.slice(0, 40) ||
    '空替换'
  const handleJump = () => {
    if (!onJumpToRange) return
    // Use the literal range from the proposal — RelativePosition resolution
    // happens at accept-time. Jumping is only a navigation hint, so an
    // off-by-a-few from concurrent edits is acceptable.
    onJumpToRange({ from: proposal.range_start, to: proposal.range_end })
  }
  return (
    <div
      className={`edit-proposal-card status-${proposal.status} ${
        collapsed ? 'is-collapsed' : 'is-expanded'
      }`}
    >
      <div className="edit-proposal-header">
        <button
          type="button"
          className="edit-proposal-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? '展开提案详情' : '折叠提案详情'}
        >
          <span className="edit-proposal-chevron">
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        <button
          type="button"
          className="edit-proposal-jump"
          onClick={handleJump}
          title="跳转到原文位置"
        >
          <FileEdit size={13} />
          <span className="edit-proposal-title">Agent 提议修改</span>
        </button>
        <span className={`edit-proposal-status ${proposal.status}`}>{statusLabel}</span>
      </div>
      {collapsed ? (
        <div className="edit-proposal-summary">{summary}</div>
      ) : (
        <>
          {proposal.reason && (
            <div className="edit-proposal-reason">{proposal.reason}</div>
          )}
          <div className="edit-proposal-diff">
            {proposal.original_text && (
              <div className="edit-proposal-diff-row removed">
                <span className="diff-marker">−</span>
                <span className="diff-text">{proposal.original_text}</span>
              </div>
            )}
            {proposal.new_text && (
              <div className="edit-proposal-diff-row added">
                <span className="diff-marker">+</span>
                <span className="diff-text">{proposal.new_text}</span>
              </div>
            )}
            {!proposal.original_text && !proposal.new_text && (
              <div className="edit-proposal-diff-empty">空替换</div>
            )}
          </div>
          {proposal.status === 'stale' && (
            <div className="edit-proposal-stale-hint">
              原文在你接受前已经变化，自动应用会覆盖你的改动。请人工核对后再处理。
            </div>
          )}
          {isPending && (
            <div className="edit-proposal-actions">
              <button className="edit-proposal-accept" onClick={onAccept}>
                <Check size={12} /> 接受
              </button>
              <button className="edit-proposal-reject" onClick={onReject}>
                <X size={12} /> 拒绝
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
