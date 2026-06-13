/**
 * SortableConversationItem — 会话下拉列表中的单条会话。
 *
 * 用 dnd-kit 的 useSortable 提供拖拽排序，同时支持重命名/删除/置顶（pin）/锁定
 * 排序位置（fixed sort_index）。重命名进入后内联输入，回车提交、Esc 取消。
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Check,
  GripVertical,
  Lock,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import type { Conversation } from '../../../services/backendApi'
import { formatTime } from './format'

interface SortableConversationItemProps {
  conv: Conversation
  agentName?: string
  active: boolean
  renamingId: string | null
  renameText: string
  onRenameTextChange: (next: string) => void
  onSelect: () => void
  onStartRename: (conv: Conversation, e: React.MouseEvent) => void
  onCommitRename: (id: string) => void
  onCancelRename: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onTogglePin: (conv: Conversation, e: React.MouseEvent) => void
  onToggleFixed: (conv: Conversation, e: React.MouseEvent) => void
}

export function SortableConversationItem({
  conv,
  agentName,
  active,
  renamingId,
  renameText,
  onRenameTextChange,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onTogglePin,
  onToggleFixed,
}: SortableConversationItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: conv.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const isRenaming = renamingId === conv.id
  const isFixed = conv.sort_index !== null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`conversation-dropdown-item ${active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${conv.is_pinned ? 'pinned' : ''}`}
      onClick={() => {
        if (isRenaming) return
        onSelect()
      }}
    >
      <button
        className="conversation-drag-handle"
        title="长按拖动调整顺序"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={12} />
      </button>
      <div className="conversation-dropdown-item-content">
        {isRenaming ? (
          <div className="conversation-rename-row" onClick={(e) => e.stopPropagation()}>
            <input
              className="conversation-rename-input"
              value={renameText}
              onChange={(e) => onRenameTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onCommitRename(conv.id) }
                if (e.key === 'Escape') { e.preventDefault(); onCancelRename() }
              }}
              autoFocus
            />
            <button
              className="conversation-rename-confirm"
              onClick={() => onCommitRename(conv.id)}
              title="确认"
            >
              <Check size={11} />
            </button>
            <button
              className="conversation-rename-cancel"
              onClick={onCancelRename}
              title="取消"
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <>
            <div className="conversation-dropdown-item-header">
              <MessageSquare size={12} />
              <span className="conversation-dropdown-title">
                {conv.title || '未命名对话'}
              </span>
              {active && <Check size={12} className="active-check" />}
            </div>
            {conv.last_message_preview && (
              <div className="conversation-dropdown-preview">
                {conv.last_message_preview}
              </div>
            )}
            <div className="conversation-dropdown-meta">
              {agentName ? `${agentName} · ` : ''}{conv.message_count} 条 · {formatTime(conv.updated_at)}
            </div>
          </>
        )}
      </div>
      {!isRenaming && (
        <div className="conversation-dropdown-actions">
          <button
            className={`conversation-dropdown-pin ${conv.is_pinned ? 'on' : ''}`}
            onClick={(e) => onTogglePin(conv, e)}
            title={conv.is_pinned ? '取消置顶' : '置顶'}
          >
            {conv.is_pinned ? <PinOff size={10} /> : <Pin size={10} />}
          </button>
          <button
            className={`conversation-dropdown-fix ${isFixed ? 'on' : ''}`}
            onClick={(e) => onToggleFixed(conv, e)}
            title={isFixed ? '解除固定位置' : '固定在当前位置'}
          >
            {isFixed ? <Unlock size={10} /> : <Lock size={10} />}
          </button>
          <button
            className="conversation-dropdown-rename"
            onClick={(e) => onStartRename(conv, e)}
            title="重命名"
          >
            <Pencil size={10} />
          </button>
          <button
            className="conversation-dropdown-delete"
            onClick={(e) => onDelete(conv.id, e)}
            title="删除对话"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}
    </div>
  )
}
