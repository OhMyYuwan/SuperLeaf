/**
 * DiscussionComposer — 讨论面板下方的输入条。
 *
 * 处理：
 * - @-mention（agent / workflow / file），用 MentionInput 渲染候选
 * - 已附带的选区 chip（点击可跳转回原区间）
 * - 已 mention 的文件 chip 列表（可移除）
 * - 发送/停止按钮（streaming 时切换为停止）
 *
 * 容器组件传入候选集和回调；自身只持有当前输入文本，最大限度减少父级重渲染。
 */

import { memo, useCallback, useMemo, useState } from 'react'
import { Send, Square, X } from 'lucide-react'
import {
  parseMentions,
  uniqueMentionedFiles,
  type AgentCandidate,
  type FileCandidate,
  type MentionCandidate,
  type WorkflowCandidate,
} from '../../../services/mentions'
import { MentionInput } from '../../shared/MentionInput'
import { confirmLargeFileAttachment } from '../../shared/fileSizeGate'
import type { Selection } from '../../../types/editor'

interface DiscussionComposerProps {
  allCandidates: MentionCandidate[]
  agentCandidates: AgentCandidate[]
  workflowCandidates: WorkflowCandidate[]
  fileCandidates: FileCandidate[]
  activeSelection: Selection | null
  isStreaming: boolean
  onSend: (rawText: string) => void
  onStop: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
  /**
   * Fired the first keystroke after the input has been empty / a send has
   * cleared it. Used to fold any open proposal cards once the user starts
   * composing the next message.
   */
  onUserActivity?: () => void
}

export const DiscussionComposer = memo(function DiscussionComposer({
  allCandidates,
  agentCandidates,
  workflowCandidates,
  fileCandidates,
  activeSelection,
  isStreaming,
  onSend,
  onStop,
  onJumpToRange,
  onUserActivity,
}: DiscussionComposerProps) {
  const [inputText, setInputText] = useState('')
  const handleInputChange = useCallback(
    (next: string) => {
      setInputText((prev) => {
        if (prev.length === 0 && next.length > 0) {
          onUserActivity?.()
        }
        return next
      })
    },
    [onUserActivity],
  )

  const pendingFileMentions = useMemo(() => {
    if (!inputText.includes('@')) return [] as FileCandidate[]
    const mentions = parseMentions(inputText, allCandidates)
    return uniqueMentionedFiles(mentions)
  }, [inputText, allCandidates])

  const removeFileMention = (fileId: string) => {
    const mentions = parseMentions(inputText, allCandidates)
    const targets = [...mentions]
      .filter((m) => m.candidate.kind === 'file' && m.candidate.id === fileId)
      .sort((a, b) => b.start - a.start)
    let next = inputText
    for (const m of targets) {
      next = next.slice(0, m.start) + next.slice(m.end)
    }
    setInputText(next.replace(/\s{2,}/g, ' '))
  }

  const handleSubmit = () => {
    const raw = inputText.trim()
    if (!raw) return
    onSend(raw)
    setInputText('')
  }

  return (
    <div className="message-input-row">
      {activeSelection && activeSelection.to > activeSelection.from && (
        <div
          className="discussion-selection-chip"
          title={activeSelection.text}
          onClick={() =>
            onJumpToRange?.({ from: activeSelection.from, to: activeSelection.to })
          }
        >
          <span className="chip-label">选区已附带</span>
          <span className="chip-preview">
            {activeSelection.text.length > 40
              ? `${activeSelection.text.slice(0, 40)}…`
              : activeSelection.text}
          </span>
          <span className="chip-range">
            {activeSelection.from}–{activeSelection.to}
          </span>
        </div>
      )}
      {pendingFileMentions.length > 0 && (
        <div className="discussion-attached-chips">
          {pendingFileMentions.map((f) => (
            <div key={f.id} className="discussion-attached-chip" title={f.path}>
              <span className="chip-label">附件</span>
              <span className="chip-preview">{f.name}</span>
              <button
                className="chip-remove"
                title="移除该附件"
                onClick={() => removeFileMention(f.id)}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <MentionInput
        value={inputText}
        onChange={handleInputChange}
        agents={agentCandidates}
        workflows={workflowCandidates}
        files={fileCandidates}
        placeholder="输入消息，用 @ 召唤 Agent / Workflow 或引用文件…"
        disabled={isStreaming}
        autoResize
        className="discussion-mention-input"
        menuPlacement="composer-panel"
        onCandidatePicked={(c) =>
          c.kind === 'file' ? confirmLargeFileAttachment(c) : true
        }
        onSubmit={handleSubmit}
      />
      <button
        className={`primary-btn ${isStreaming ? 'stop-btn' : ''}`}
        onClick={isStreaming ? onStop : handleSubmit}
        disabled={!isStreaming && !inputText.trim()}
        title={isStreaming ? '停止当前 Agent' : '发送'}
      >
        {isStreaming ? <Square size={14} /> : <Send size={14} />}
      </button>
    </div>
  )
})
