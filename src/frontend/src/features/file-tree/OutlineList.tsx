/**
 * OutlineList — hierarchical section list derived from the active document.
 *
 * `onSectionClick` is wired for future jump-to-section behavior; currently a
 * no-op when omitted.
 */

import { BookOpen, ChevronRight } from 'lucide-react'
import type { Section } from '../../types/document'

interface OutlineListProps {
  sections: Section[] | null
  onSectionClick?: (section: Section) => void
}

export function OutlineList({ sections, onSectionClick }: OutlineListProps) {
  return (
    <div className="panel-section">
      <div className="section-title">
        <BookOpen size={16} /> 文档大纲
      </div>
      <div className="outline-list">
        {sections !== null && sections.length === 0 && (
          <div className="outline-empty">此文档无章节标题</div>
        )}
        {sections?.map((sec) => (
          <button
            key={sec.id}
            className="outline-item"
            style={{ paddingLeft: 8 + sec.level * 14 }}
            title={sec.title}
            onClick={() => onSectionClick?.(sec)}
          >
            <ChevronRight size={14} />
            <span>{sec.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
