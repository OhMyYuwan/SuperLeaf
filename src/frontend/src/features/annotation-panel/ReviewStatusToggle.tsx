/**
 * ReviewStatusToggle — four-way segment switcher for an annotation's
 * `reviewStatus` (V3 Phase 4). Orthogonal to CardStatus: an archived card
 * can still be marked `dismissed`, etc.
 *
 * Default value (when nothing has been set yet) is `open`. The store keeps
 * only non-default values when persisted to localStorage.
 */

import type { ReviewStatus } from '../../stores/annotationStore'

const OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: 'open', label: '未处理' },
  { value: 'considered', label: '已考虑' },
  { value: 'addressed', label: '已处理' },
  { value: 'dismissed', label: '不采纳' },
]

interface ReviewStatusToggleProps {
  value: ReviewStatus
  onChange: (next: ReviewStatus) => void
  disabled?: boolean
  /** Render in a more compact form for embedded use inside ann-head. */
  compact?: boolean
}

export function ReviewStatusToggle({
  value,
  onChange,
  disabled = false,
  compact = false,
}: ReviewStatusToggleProps) {
  return (
    <div className={`review-status-toggle ${compact ? 'is-compact' : ''}`} role="radiogroup">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`review-status-btn ${value === opt.value ? `is-active is-${opt.value}` : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (disabled || value === opt.value) return
            onChange(opt.value)
          }}
          disabled={disabled}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
