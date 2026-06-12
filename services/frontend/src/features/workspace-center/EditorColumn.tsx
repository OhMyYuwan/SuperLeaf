/**
 * EditorColumn — the leftmost column of the workspace center grid. Mounts the
 * CodeMirror-based LatexEditor and surfaces its callbacks to the parent.
 *
 * When there's an active selection, renders a SelectionToolbar overlay so the
 * user can create a comment anchored to that selection.
 */

import { useState } from 'react'
import { SplitSquareVertical } from 'lucide-react'
import type { Document } from '../../types/document'
import {
  LatexEditor,
  SelectionToolbar,
  type EditorFormat,
  type DecorationSpec,
  type DocChangeInfo,
  type EditorRestoreState,
  type LatexEditorThemeId,
  type SelectionInfo,
} from '../latex-editor'
import type {
  LatexCitationCompletion,
  LatexCommandCompletion,
  LatexFilePathCompletion,
  LatexLabelCompletion,
} from '../latex-editor/latex-completion-data'
import { useCollaborationStore } from '../../stores/collaborationStore'

interface EditorColumnProps {
  doc: Document | null
  decorations: DecorationSpec[]
  activeAnnotationId: string | null
  hoveredAnnotationId?: string | null
  scrollTo: { pos: number; to?: number; seq: number } | null
  restoreState?: EditorRestoreState | null
  onChange: (next: string) => void
  onSelectionChange: (info: { from: number; to: number; text: string }) => void
  onDocChange: (changes: DocChangeInfo[]) => void
  onViewStateChange?: (documentId: string, state: EditorRestoreState) => void
  onDecorationClick: (id: string) => void
  citationCompletions?: LatexCitationCompletion[]
  filePathCompletions?: LatexFilePathCompletion[]
  labelCompletions?: LatexLabelCompletion[]
  commandCompletions?: LatexCommandCompletion[]
  themeId: LatexEditorThemeId
  mathPreviewEnabled: boolean
  onAddComment?: (params: {
    range: { from: number; to: number }
    targetText: string
  }) => void
}

export function EditorColumn({
  doc,
  decorations,
  activeAnnotationId,
  hoveredAnnotationId,
  scrollTo,
  restoreState,
  onChange,
  onSelectionChange,
  onDocChange,
  onViewStateChange,
  onDecorationClick,
  citationCompletions,
  filePathCompletions,
  labelCompletions,
  commandCompletions,
  themeId,
  mathPreviewEnabled,
  onAddComment,
}: EditorColumnProps) {
  const [toolbar, setToolbar] = useState<{
    x: number
    y: number
    range: { from: number; to: number }
    text: string
  } | null>(null)

  const handleSelectionChange = (info: SelectionInfo) => {
    // Forward the minimal (from/to/text) shape to the parent.
    onSelectionChange({ from: info.from, to: info.to, text: info.text })
    if (info.from !== info.to && info.coords && info.text.trim()) {
      setToolbar({
        x: info.coords.x,
        y: info.coords.y,
        range: { from: info.from, to: info.to },
        text: info.text,
      })
    } else {
      setToolbar(null)
    }
  }

  const handleToolbarAddComment = () => {
    if (!toolbar || !onAddComment) return
    onAddComment({ range: toolbar.range, targetText: toolbar.text })
    setToolbar(null)
  }

  return (
    <div className="editor-column">
      <div className="column-header">
        <SplitSquareVertical size={16} /> 编辑器
      </div>
      <div className="latex-editor-host">
        {doc ? (
          <EditorWithCollab
            doc={doc}
            decorations={decorations}
            activeAnnotationId={activeAnnotationId}
            hoveredAnnotationId={hoveredAnnotationId}
            scrollTo={scrollTo}
            restoreState={restoreState}
            onChange={onChange}
            onSelectionChange={handleSelectionChange}
            onDocChange={onDocChange}
            onViewStateChange={onViewStateChange}
            onDecorationClick={onDecorationClick}
            citationCompletions={citationCompletions}
            filePathCompletions={filePathCompletions}
            labelCompletions={labelCompletions}
            commandCompletions={commandCompletions}
            themeId={themeId}
            mathPreviewEnabled={mathPreviewEnabled}
            toolbar={toolbar}
            onAddComment={onAddComment ? handleToolbarAddComment : undefined}
          />
        ) : (
          <div className="editor-empty">请选择一个文件</div>
        )}
      </div>
    </div>
  )
}

function EditorWithCollab({
  doc,
  decorations,
  activeAnnotationId,
  hoveredAnnotationId,
  scrollTo,
  restoreState,
  onChange,
  onSelectionChange,
  onDocChange,
  onViewStateChange,
  onDecorationClick,
  citationCompletions,
  filePathCompletions,
  labelCompletions,
  commandCompletions,
  themeId,
  mathPreviewEnabled,
  toolbar,
  onAddComment,
}: {
  doc: Document
  decorations: DecorationSpec[]
  activeAnnotationId: string | null
  hoveredAnnotationId?: string | null
  scrollTo: { pos: number; to?: number; seq: number } | null
  restoreState?: EditorRestoreState | null
  onChange: (next: string) => void
  onSelectionChange: (info: SelectionInfo) => void
  onDocChange: (changes: DocChangeInfo[]) => void
  onViewStateChange?: (documentId: string, state: EditorRestoreState) => void
  onDecorationClick: (id: string) => void
  citationCompletions?: LatexCitationCompletion[]
  filePathCompletions?: LatexFilePathCompletion[]
  labelCompletions?: LatexLabelCompletion[]
  commandCompletions?: LatexCommandCompletion[]
  themeId: LatexEditorThemeId
  mathPreviewEnabled: boolean
  toolbar: { x: number; y: number } | null
  onAddComment?: () => void
}) {
  const provider = useCollaborationStore((s) => s.provider)
  const status = useCollaborationStore((s) => s.status)
  const currentDocId = useCollaborationStore((s) => s.currentDocId)

  const isCollab = !!(provider && currentDocId === doc.id && status === 'synced')

  return (
    <LatexEditor
      key={doc.id}
      documentId={doc.id}
      value={doc.content}
      format={doc.format as EditorFormat}
      onChange={onChange}
      onSelectionChange={onSelectionChange}
      onDocChange={onDocChange}
      restoreState={restoreState}
      onViewStateChange={onViewStateChange}
      decorations={decorations}
      activeDecorationId={activeAnnotationId}
      panelHoverId={hoveredAnnotationId ?? null}
      onDecorationClick={onDecorationClick}
      citationCompletions={citationCompletions}
      filePathCompletions={filePathCompletions}
      labelCompletions={labelCompletions}
      commandCompletions={commandCompletions}
      themeId={themeId}
      mathPreviewEnabled={mathPreviewEnabled}
      scrollTo={scrollTo}
      yText={isCollab ? provider!.yText : undefined}
      awareness={isCollab ? provider!.awareness : undefined}
      collaborating={isCollab}
      overlay={
        toolbar && onAddComment ? (
          <SelectionToolbar
            x={toolbar.x}
            y={toolbar.y}
            onAddComment={onAddComment}
          />
        ) : null
      }
    />
  )
}
