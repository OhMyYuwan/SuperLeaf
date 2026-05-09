/**
 * CommentComposer — inline composer for creating a user comment.
 *
 * Shows:
 *   - The selected text as a quote block
 *   - A textarea where the user types the comment
 *   - When the user types `@`, a dropdown appears with the list of available
 *     agents. Selecting one inserts `@AgentName ` at the cursor.
 *   - On submit, calls `onSubmit({ content, mentionedAgentIds })`
 *
 * Accepts the list of agents directly so the component stays pure.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import type { CachedWorkflow } from '../../services/backendApi'
import { parseMentions, uniqueMentionedAgents } from '../../services/mentions'

interface CommentComposerProps {
  selectedText: string
  agents: CachedWorkflow[]
  onSubmit: (params: {
    content: string
    mentionedAgents: { id: string; name: string }[]
  }) => void
  onCancel: () => void
}

interface MentionMenu {
  // Position of the "@" character in the textarea's value string.
  atPos: number
  // The query string after the "@" (used to filter agent list).
  query: string
}

export function CommentComposer({
  selectedText,
  agents,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState<MentionMenu | null>(null)
  const [highlightIdx, setHighlightIdx] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const agentCandidates = useMemo(() => agents.map((a) => ({ id: a.id, name: a.name })), [agents])

  // Filter agents by the current @ query.
  const filteredAgents = useMemo(() => {
    if (!menu) return []
    const q = menu.query.toLowerCase()
    return agentCandidates.filter((a) => a.name.toLowerCase().includes(q))
  }, [menu, agentCandidates])

  // Keep highlight in range as filter changes.
  useEffect(() => {
    if (filteredAgents.length === 0) {
      setHighlightIdx(0)
      return
    }
    setHighlightIdx((i) => Math.min(i, filteredAgents.length - 1))
  }, [filteredAgents])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    setText(newText)
    updateMention(newText, e.target.selectionStart)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => (i + 1) % filteredAgents.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => (i - 1 + filteredAgents.length) % filteredAgents.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectAgent(filteredAgents[highlightIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === 'Escape') {
      onCancel()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  const updateMention = (newText: string, caret: number) => {
    // Walk back from caret looking for an unterminated `@` (i.e. whitespace
    // or start-of-string before it, and no whitespace between `@` and caret).
    let at = -1
    for (let i = caret - 1; i >= 0; i--) {
      const ch = newText[i]
      if (ch === '@') {
        if (i === 0 || /[\s\(\[,;:。，、；：]/.test(newText[i - 1])) {
          at = i
        }
        break
      }
      if (/\s/.test(ch)) break
    }
    if (at === -1) {
      setMenu(null)
      return
    }
    const query = newText.slice(at + 1, caret)
    setMenu({ atPos: at, query })
  }

  const selectAgent = (agent: { id: string; name: string }) => {
    if (!menu || !textareaRef.current) return
    const before = text.slice(0, menu.atPos)
    const after = text.slice(menu.atPos + 1 + menu.query.length)
    const inserted = `@${agent.name} `
    const newText = before + inserted + after
    setText(newText)
    setMenu(null)
    // Restore caret position after the inserted mention.
    requestAnimationFrame(() => {
      const caret = before.length + inserted.length
      textareaRef.current?.setSelectionRange(caret, caret)
      textareaRef.current?.focus()
    })
  }

  const submit = () => {
    const content = text.trim()
    if (!content) return
    const mentions = parseMentions(content, agentCandidates)
    const mentionedAgents = uniqueMentionedAgents(mentions)
    onSubmit({ content, mentionedAgents })
  }

  return (
    <div className="comment-composer">
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
        <textarea
          ref={textareaRef}
          className="comment-composer-textarea"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入评论，用 @ 召唤 Agent 回答..."
          rows={4}
        />
        {menu && filteredAgents.length > 0 && (
          <div className="mention-menu">
            {filteredAgents.map((a, i) => (
              <div
                key={a.id}
                className={`mention-item ${i === highlightIdx ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectAgent(a)
                }}
              >
                <span className="mention-at">@</span>
                <span className="mention-name">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="comment-composer-hint">
        提示：输入 <kbd>@</kbd> 选 Agent；按 <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> 发送。
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
