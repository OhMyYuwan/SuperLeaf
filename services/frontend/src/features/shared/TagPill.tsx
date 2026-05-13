/**
 * TagPill — fluorescent capsule used by the V3 Phase 4 evaluation UI.
 *
 * Three sources of color:
 *   - explicit `category` for known tag classes (positive / negative / usage)
 *   - explicit `customColor` if the caller wants to override
 *   - otherwise djb2(label) % POOL → stable per label across reloads
 *
 * The hash is intentionally not crypto-grade; we just need consistency so the
 * same custom tag always renders the same color in the panel.
 */

import { X } from 'lucide-react'
import './tag-pill.css'

export type TagCategory = 'positive' | 'negative' | 'usage' | 'custom'

const PALETTE = [
  'lime',
  'cyan',
  'sky',
  'violet',
  'pink',
  'amber',
  'emerald',
  'rose',
] as const

type Hue = (typeof PALETTE)[number]

const CATEGORY_HUE: Record<Exclude<TagCategory, 'custom'>, Hue> = {
  positive: 'emerald',
  negative: 'rose',
  usage: 'sky',
}

interface TagPillProps {
  label: string
  category?: TagCategory
  active?: boolean
  onClick?: () => void
  onRemove?: () => void
  /** Render slightly smaller (used inside card-footer summary). */
  compact?: boolean
  title?: string
}

export function TagPill({
  label,
  category = 'custom',
  active = false,
  onClick,
  onRemove,
  compact = false,
  title,
}: TagPillProps) {
  const hue = category === 'custom' ? hueFor(label) : CATEGORY_HUE[category]
  const cls = [
    'tag-pill',
    `tag-pill-${hue}`,
    active ? 'is-active' : '',
    compact ? 'is-compact' : '',
    onClick ? 'is-clickable' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={cls}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      title={title ?? `#${label}`}
    >
      <span className="tag-pill-label">#{label}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-pill-remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`移除 #${label}`}
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}

function hueFor(label: string): Hue {
  let hash = 5381
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) + hash + label.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}
