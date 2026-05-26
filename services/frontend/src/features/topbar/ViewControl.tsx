/**
 * ViewControl — 视图控制按钮，支持多选显示/隐藏各个面板
 */

import { useState, useRef, useEffect } from 'react'
import { Eye } from 'lucide-react'
import { useViewStore } from '../../stores/viewStore'

export function ViewControl() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const leftPanel = useViewStore((s) => s.leftPanel)
  const editorColumn = useViewStore((s) => s.editorColumn)
  const previewColumn = useViewStore((s) => s.previewColumn)
  const annotationColumn = useViewStore((s) => s.annotationColumn)
  const rightPanel = useViewStore((s) => s.rightPanel)

  const toggleLeftPanel = useViewStore((s) => s.toggleLeftPanel)
  const toggleEditorColumn = useViewStore((s) => s.toggleEditorColumn)
  const togglePreviewColumn = useViewStore((s) => s.togglePreviewColumn)
  const toggleAnnotationColumn = useViewStore((s) => s.toggleAnnotationColumn)
  const toggleRightPanel = useViewStore((s) => s.toggleRightPanel)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // 至少保留一个中栏列可见
  const centerColumnsCount = [editorColumn, previewColumn, annotationColumn].filter(Boolean).length

  return (
    <div className="view-control" ref={menuRef}>
      <button
        className="ghost-btn"
        onClick={() => setOpen(!open)}
        title="调整工作区布局"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Eye size={16} />
        视图
      </button>
      {open && (
        <div className="view-control-menu">
          <label className="view-control-item">
            <input
              type="checkbox"
              checked={leftPanel}
              onChange={toggleLeftPanel}
            />
            <span className="view-control-text">
              <span className="view-control-label">项目导航</span>
              <span className="view-control-hint">文件与大纲</span>
            </span>
          </label>
          <div className="view-control-divider" />
          <label className="view-control-item">
            <input
              type="checkbox"
              checked={editorColumn}
              onChange={toggleEditorColumn}
              disabled={centerColumnsCount === 1 && editorColumn}
            />
            <span>编辑器</span>
          </label>
          <label className="view-control-item">
            <input
              type="checkbox"
              checked={previewColumn}
              onChange={togglePreviewColumn}
              disabled={centerColumnsCount === 1 && previewColumn}
            />
            <span>预览</span>
          </label>
          <label className="view-control-item">
            <input
              type="checkbox"
              checked={annotationColumn}
              onChange={toggleAnnotationColumn}
              disabled={centerColumnsCount === 1 && annotationColumn}
            />
            <span>批注</span>
          </label>
          <div className="view-control-divider" />
          <label className="view-control-item">
            <input
              type="checkbox"
              checked={rightPanel}
              onChange={toggleRightPanel}
            />
            <span className="view-control-text">
              <span className="view-control-label">协作区</span>
              <span className="view-control-hint">讨论、Agent 与自动化</span>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
