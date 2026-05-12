/**
 * CommentComposer — inline composer for creating a user comment.
 *
 * Shows:
 *   - The selected text as a quote block
 *   - A MentionInput where the user types the comment
 *   - On submit, calls `onSubmit({ content, mentionedAgents, mentionedFiles })`
 */

import { useMemo, useRef, useState, useEffect } from 'react'
import { Send, X } from 'lucide-react'
import type { CachedWorkflow } from '../../services/backendApi'
import {
  parseMentions,
  uniqueMentionedAgents,
  uniqueMentionedFiles,
  uniqueMentionedWorkflows,
  type AgentCandidate,
  type FileCandidate,
  type MentionCandidate,
  type WorkflowCandidate,
} from '../../services/mentions'
import { MentionInput, type MentionInputHandle } from '../shared/MentionInput'
import { confirmLargeFileAttachment } from '../shared/fileSizeGate'

interface CommentComposerProps {
  selectedText: string
  agents: CachedWorkflow[]
  workflows?: readonly WorkflowCandidate[]
  files: readonly FileCandidate[]
  onSubmit: (params: {
    content: string
    mentionedAgents: AgentCandidate[]
    mentionedWorkflows: WorkflowCandidate[]
    mentionedFiles: FileCandidate[]
  }) => void
  onCancel: () => void
}

export function CommentComposer({
  selectedText,
  agents,
  workflows = [],
  files,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [text, setText] = useState('')
  const inputRef = useRef<MentionInputHandle>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const agentCandidates: AgentCandidate[] = useMemo(
    () =>
      agents
        .filter((a) => !a.is_disabled)
        .map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name })),
    [agents],
  )

  const handleCandidatePicked = (c: MentionCandidate): boolean => {
    if (c.kind === 'file') return confirmLargeFileAttachment(c)
    return true
  }

  const submit = () => {
    const content = text.trim()
    if (!content) return
    const candidates: MentionCandidate[] = [...agentCandidates, ...workflows, ...files]
    const mentions = parseMentions(content, candidates)
    const mentionedAgents = uniqueMentionedAgents(mentions)
    const mentionedWorkflows = uniqueMentionedWorkflows(mentions)
    const mentionedFiles = uniqueMentionedFiles(mentions)
    onSubmit({ content, mentionedAgents, mentionedWorkflows, mentionedFiles })
  }

  const handleKeyOnContainer = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && e.target === e.currentTarget) {
      onCancel()
    }
  }

  return (
    <div className="comment-composer" onKeyDown={handleKeyOnContainer}>
      <div className="comment-composer-header">
        <span className="comment-composer-title">新增批注</span>
        <button className="icon-btn" onClick={onCancel} title="取消 (Esc)">
          <X size={14} />
        </button>
      </div>
      <blockquote className="comment-composer-quote">
        {truncate(selectedText, 200)}
      </blockquote>
      <div className="comment-composer-field">
        <MentionInput
          ref={inputRef}
          value={text}
          onChange={setText}
          agents={agentCandidates}
          workflows={workflows}
          files={files}
          placeholder="输入评论，用 @ 召唤 Agent / Workflow 或引用文件…"
          rows={4}
          onCandidatePicked={handleCandidatePicked}
          onSubmit={submit}
        />
      </div>
      <div className="comment-composer-hint">
        提示：输入 <kbd>@</kbd> 选 Agent / Workflow / 文件；按 <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> 发送。
      </div>
      <div className="comment-composer-actions">
        <button className="ghost-btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="primary-btn"
          onClick={submit}
          disabled={!text.trim()}
        >
          <Send size={12} /> 发送
        </button>
      </div>
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
