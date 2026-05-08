import { useEffect, useMemo, useState } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { SettingsDialog } from './features/settings'
import { Topbar } from './features/topbar'
import { FileTree, OutlineList } from './features/file-tree'
import {
  EditorToolbar,
  EditorColumn,
  PreviewColumn,
  AnnotationColumn,
} from './features/workspace-center'
import { RightPanel } from './features/right-panel'
import { useDocumentStore } from './stores/documentStore'
import { useEditorStore } from './stores/editorStore'
import { useSettingsStore } from './stores/settingsStore'
import { useWorkflowStore } from './stores/workflowStore'
import { useAnnotationStore } from './stores/annotationStore'
import { seedDocuments } from './stores/seedData'
import type { DecorationSpec, DocChangeInfo } from './features/latex-editor'
import './App.css'

function App() {
  // Document + editor state --------------------------------------------------
  const documents = useDocumentStore((s) => s.documents)
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId)
  const setActive = useDocumentStore((s) => s.setActive)
  const updateContent = useDocumentStore((s) => s.updateContent)
  const seed = useDocumentStore((s) => s.seed)

  const updateSelection = useEditorStore((s) => s.updateSelection)
  const activeSelection = useEditorStore((s) =>
    activeDocumentId ? s.states[activeDocumentId]?.selection ?? null : null,
  )

  // Provider + workflow state ------------------------------------------------
  const loadProviders = useSettingsStore((s) => s.load)
  const activeProvider = useSettingsStore((s) => s.providers.find((p) => p.is_active) ?? null)
  const backendReachable = useSettingsStore((s) => s.backendReachable)

  const workflows = useWorkflowStore((s) => s.workflows)
  const workflowsLoaded = useWorkflowStore((s) => s.loaded)
  const workflowError = useWorkflowStore((s) => s.error)
  const loadWorkflows = useWorkflowStore((s) => s.load)
  const runningMap = useWorkflowStore((s) => s.running)
  const eventsMap = useWorkflowStore((s) => s.lastRunEvents)
  const runWorkflow = useWorkflowStore((s) => s.run)

  const annotationItemsById = useAnnotationStore((s) => s.items)

  // UI-only state -----------------------------------------------------------
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)

  // Derived ------------------------------------------------------------------
  const activeDoc = activeDocumentId ? documents[activeDocumentId] : null
  const fileList = useMemo(() => Object.values(documents), [documents])

  const decorationSpecs: DecorationSpec[] = useMemo(() => {
    if (!activeDocumentId) return []
    return Object.values(annotationItemsById)
      .filter(
        (it) =>
          it.documentId === activeDocumentId &&
          it.status === 'pending',
      )
      .map((it) => ({
        id: it.id,
        from: it.range.from,
        to: it.range.to,
        kind: it.kind,
        severity: it.severity,
      }))
  }, [annotationItemsById, activeDocumentId])

  // Bootstrap ----------------------------------------------------------------
  useEffect(() => {
    if (Object.keys(useDocumentStore.getState().documents).length === 0) {
      seed(seedDocuments)
    }
    loadProviders()
    loadWorkflows()
  }, [seed, loadProviders, loadWorkflows])

  // Cross-component handlers -------------------------------------------------
  const handleRunWorkflow = (workflowId: string, instruction: string) => {
    if (!activeDocumentId) {
      alert('请先选择一个文件')
      return
    }
    if (!activeSelection) {
      alert('请先在编辑器中选中一段文字，再运行。')
      return
    }
    const selectionText = activeSelection.text
    const userPrompt = instruction.trim() || '请针对以下文本给出评审意见。'
    runWorkflow(workflowId, {
      document_id: activeDocumentId,
      range_start: activeSelection.from,
      range_end: activeSelection.to,
      inputs: {
        target_text: selectionText,
        section_title: activeSelection.context.sectionTitle ?? '',
        before: activeSelection.context.before,
        after: activeSelection.context.after,
        instruction: userPrompt,
      },
      // Chat-mode needs `query`; workflow-mode ignores it. Wrap the user's
      // instruction with the selection so a plain LLM node has everything.
      query: `${userPrompt}\n\n---\n${selectionText}`,
    })
  }

  const handleEditorChange = (next: string) => {
    if (!activeDocumentId) return
    updateContent(activeDocumentId, next)
  }

  const handleDocChange = (changes: DocChangeInfo[]) => {
    if (!activeDocumentId) return
    useAnnotationStore.getState().applyDocumentChange(activeDocumentId, changes)
  }

  const handleSelectionChange = (info: { from: number; to: number; text: string }) => {
    if (!activeDocumentId) return
    updateSelection(activeDocumentId, { from: info.from, to: info.to })
  }

  const handleDecorationClick = (id: string) => {
    setActiveAnnotationId((prev) => (prev === id ? null : id))
  }

  // Render -------------------------------------------------------------------
  return (
    <div className="app-shell">
      <Topbar
        backendReachable={backendReachable}
        providerName={activeProvider?.name ?? null}
        providerStatus={activeProvider?.status ?? null}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <main className="workspace">
        <PanelGroup orientation="horizontal" style={{ height: '100%' }}>
          <Panel defaultSize={20} minSize={16}>
            <div className="panel left-panel">
              <FileTree files={fileList} activeId={activeDocumentId} onSelect={setActive} />
              <OutlineList sections={activeDoc ? activeDoc.structure.sections : null} />
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={50} minSize={36}>
            <div className="panel editor-panel">
              <EditorToolbar doc={activeDoc} selection={activeSelection} />
              <div className="editor-split">
                <EditorColumn
                  doc={activeDoc}
                  decorations={decorationSpecs}
                  activeAnnotationId={activeAnnotationId}
                  onChange={handleEditorChange}
                  onSelectionChange={handleSelectionChange}
                  onDocChange={handleDocChange}
                  onDecorationClick={handleDecorationClick}
                />
                <PreviewColumn doc={activeDoc} />
                <AnnotationColumn
                  documentId={activeDocumentId}
                  activeId={activeAnnotationId}
                  onFocus={setActiveAnnotationId}
                />
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={30} minSize={24}>
            <RightPanel
              workflows={workflows}
              workflowsLoaded={workflowsLoaded}
              workflowError={workflowError}
              activeProvider={activeProvider}
              activeSelection={activeSelection}
              runningMap={runningMap}
              eventsMap={eventsMap}
              onRunWorkflow={handleRunWorkflow}
              onReloadWorkflows={loadWorkflows}
            />
          </Panel>
        </PanelGroup>
      </main>
    </div>
  )
}

export default App
