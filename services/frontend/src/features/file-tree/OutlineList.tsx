/**
 * OutlineList — hierarchical, collapsible section list (Overleaf-style).
 *
 * The parser emits a flat `Section[]` where each node carries its `children`
 * (section IDs). We rebuild a tree in-memory and render it recursively so
 * each node with children renders an expand/collapse toggle. State for
 * expanded nodes is kept locally and reset when the document changes.
 *
 * Reference: reference/overleaf/services/web/frontend/js/features/outline
 */

import { useMemo, useState, useEffect } from 'react'
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import type { Section } from '../../types/document'

interface OutlineListProps {
  sections: Section[] | null
  docId?: string | null
  collapsed?: boolean
  onToggleCollapsed?: () => void
  onSectionClick?: (section: Section) => void
}

interface OutlineNode {
  section: Section
  children: OutlineNode[]
}

export function OutlineList({
  sections,
  docId,
  collapsed = false,
  onToggleCollapsed,
  onSectionClick,
}: OutlineListProps) {
  const tree = useMemo(() => buildOutlineTree(sections ?? []), [sections])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setExpanded({})
  }, [docId])

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: prev[id] === false }))

  return (
    <div className={`panel-section outline-section${collapsed ? ' collapsed' : ''}`}>
      <div className="section-title outline-section-title">
        <span className="outline-title-label">
          <BookOpen size={16} /> 文档大纲
        </span>
        <button
          className="outline-collapse-btn"
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开大纲' : '折叠大纲'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {!collapsed && (
        <div className="outline-list">
          {sections !== null && sections.length === 0 && (
            <div className="outline-empty">此文档无章节标题</div>
          )}
          {tree.map((node) => (
            <OutlineNodeView
              key={node.section.id}
              node={node}
              depth={0}
              expandedMap={expanded}
              onToggle={toggle}
              onSectionClick={onSectionClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface OutlineNodeViewProps {
  node: OutlineNode
  depth: number
  expandedMap: Record<string, boolean>
  onToggle: (id: string) => void
  onSectionClick?: (section: Section) => void
}

function OutlineNodeView({
  node,
  depth,
  expandedMap,
  onToggle,
  onSectionClick,
}: OutlineNodeViewProps) {
  const hasChildren = node.children.length > 0
  const isExpanded = expandedMap[node.section.id] !== false
  const leftPad = 8 + depth * 14

  return (
    <div className="outline-node">
      <div className="outline-item-row" style={{ paddingLeft: leftPad }}>
        {hasChildren ? (
          <button
            className="outline-toggle-btn"
            onClick={() => onToggle(node.section.id)}
            title={isExpanded ? '折叠' : '展开'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="outline-toggle-placeholder" />
        )}
        <button
          className="outline-item-link"
          title={node.section.title}
          onClick={() => onSectionClick?.(node.section)}
        >
          <span className="outline-node-name">{node.section.title}</span>
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div className="outline-children">
          {node.children.map((child) => (
            <OutlineNodeView
              key={child.section.id}
              node={child}
              depth={depth + 1}
              expandedMap={expandedMap}
              onToggle={onToggle}
              onSectionClick={onSectionClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The parser emits a flat list; each section knows its *child* section IDs but
 * no parent link. Walk the list and reparent children under their owners, then
 * return only roots (sections that no other section claims as a child).
 */
function buildOutlineTree(sections: Section[]): OutlineNode[] {
  if (sections.length === 0) return []
  const nodes = new Map<string, OutlineNode>()
  for (const sec of sections) {
    nodes.set(sec.id, { section: sec, children: [] })
  }
  const claimed = new Set<string>()
  for (const sec of sections) {
    const parent = nodes.get(sec.id)
    if (!parent) continue
    for (const childId of sec.children) {
      const child = nodes.get(childId)
      if (!child) continue
      parent.children.push(child)
      claimed.add(childId)
    }
  }
  const roots: OutlineNode[] = []
  for (const sec of sections) {
    if (!claimed.has(sec.id)) {
      const node = nodes.get(sec.id)
      if (node) roots.push(node)
    }
  }
  return roots
}
