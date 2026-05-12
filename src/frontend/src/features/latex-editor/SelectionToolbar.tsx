/**
 * SelectionToolbar — floating toolbar that appears near the editor selection.
 *
 * Rendered inside the LatexEditor scroll container. Positioned at the
 * selection's top-right corner (or wherever the user's mouse lifted). Hidden
 * when there's no selection.
 *
 * Currently just offers "add comment". Future actions (quick-run workflows,
 * format shortcuts) could be added here.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'

interface SelectionToolbarProps {
  // Absolute coordinates in the editor's scroll container's coordinate space.
  x: number
  y: number
  onAddComment: () => void
}

export function SelectionToolbar({ x, y, onAddComment }: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  // Nudge the toolbar so it stays within the editor box.
  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const parent = ref.current.offsetParent?.getBoundingClientRect()
    if (!parent) return
    let dx = 0
    let dy = 0
    if (rect.right > parent.right - 8) dx = parent.right - rect.right - 8
    if (rect.left < parent.left + 8) dx = parent.left - rect.left + 8
    if (rect.top < parent.top + 8) dy = parent.top - rect.top + 8
    setOffset({ x: dx, y: dy })
  }, [x, y])

  return (
    <div
      ref={ref}
      className="selection-toolbar"
      style={{
        position: 'absolute',
        left: x + offset.x,
        top: y + offset.y,
        transform: 'translate(-50%, -100%)',
      }}
      onMouseDown={(e) => e.preventDefault() /* keep editor selection alive */}
    >
      <button className="selection-toolbar-btn" onClick={onAddComment} title="添加批注">
        <MessageSquarePlus size={13} />
        批注
      </button>
    </div>
  )
}
