/**
 * UserMessageContent — 渲染用户发出的消息气泡内容。
 *
 * 长输入会被折叠为预览（行数和字符数双限），点击切换展开/收起；@-mention 用
 * 与输入框一致的彩色 chip 渲染，让气泡保持原始输入的视觉风格。
 */

import { Fragment, useCallback, useMemo, useState } from 'react'
import { parseMentions, segmentText, type MentionCandidate } from '../../../services/mentions'

const USER_MESSAGE_PREVIEW_CHAR_LIMIT = 260
const USER_MESSAGE_PREVIEW_LINE_LIMIT = 6

export function UserMessageContent({
  content,
  allCandidates,
}: {
  content: string
  allCandidates: MentionCandidate[]
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => createUserMessagePreview(content), [content])
  const collapsible = preview !== content
  // Render with the same colored mention chips the input box uses, so the
  // bubble keeps the visual identity of what the user actually typed.
  const renderText = useCallback(
    (text: string) => {
      if (!text.includes('@')) return text
      const mentions = parseMentions(text, allCandidates)
      if (mentions.length === 0) return text
      const segments = segmentText(text, mentions)
      return segments.map((seg, i) => {
        if (seg.type === 'text') return <Fragment key={i}>{seg.content}</Fragment>
        const cls =
          seg.candidate.kind === 'file'
            ? 'mention-tag mention-tag-file'
            : seg.candidate.kind === 'workflow'
              ? 'mention-tag mention-tag-workflow'
              : 'mention-tag'
        return (
          <span key={i} className={cls}>
            {seg.raw}
          </span>
        )
      })
    },
    [allCandidates],
  )

  if (!collapsible) {
    return <div className="message-content">{renderText(content)}</div>
  }

  return (
    <button
      type="button"
      className={`message-content user-message-content ${
        expanded ? 'is-expanded' : 'is-collapsed'
      }`}
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
      aria-label={expanded ? '收起完整输入' : '展开完整输入'}
      title={expanded ? '收起完整输入' : '展开完整输入'}
    >
      {renderText(expanded ? content : preview)}
    </button>
  )
}

function createUserMessagePreview(content: string): string {
  const lines = content.split(/\r\n|\r|\n/)
  const lineLimited =
    lines.length > USER_MESSAGE_PREVIEW_LINE_LIMIT
      ? lines.slice(0, USER_MESSAGE_PREVIEW_LINE_LIMIT).join('\n')
      : content
  const chars = Array.from(lineLimited)
  const charLimited =
    chars.length > USER_MESSAGE_PREVIEW_CHAR_LIMIT
      ? chars.slice(0, USER_MESSAGE_PREVIEW_CHAR_LIMIT).join('')
      : lineLimited
  const preview = charLimited.trimEnd()
  return preview === content ? content : `${preview}…`
}
