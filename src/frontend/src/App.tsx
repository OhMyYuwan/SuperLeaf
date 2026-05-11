import { useEffect, useMemo, useState } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
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
import { useFilesystemStore } from './stores/filesystemStore'
import { useViewStore } from './stores/viewStore'
import type { DecorationSpec, DocChangeInfo } from './features/latex-editor'
import './App.css'

function App() {
  // Document + editor state --------------------------------------------------
  const documents = useDocumentStore((s) => s.documents)
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId)
  const updateContent = useDocumentStore((s) => s.updateContent)
  const loadBackendDoc = useDocumentStore((s) => s.loadBackendDoc)
  const saveBackendDoc = useDocumentStore((s) => s.saveBackendDoc)
  const flushPendingSave = useDocumentStore((s) => s.flushPendingSave)
  const saveStatusMap = useDocumentStore((s) => s.saveStatus)

  const updateSelection = useEditorStore((s) => s.updateSelection)
  const activeSelection = useEditorStore((s) =>
    activeDocumentId ? s.states[activeDocumentId]?.selection ?? null : null,
  )

  // Filesystem tree ----------------------------------------------------------
  const tree = useFilesystemStore((s) => s.tree)
  const treeLoading = useFilesystemStore((s) => s.loading)
  const treeError = useFilesystemStore((s) => s.error)
  const expandedFolderIds = useFilesystemStore((s) => s.expandedFolderIds)
  const loadTree = useFilesystemStore((s) => s.loadTree)
  const toggleExpanded = useFilesystemStore((s) => s.toggleExpanded)
  const createFolder = useFilesystemStore((s) => s.createFolder)
  const createDoc = useFilesystemStore((s) => s.createDoc)
  const renameEntity = useFilesystemStore((s) => s.renameEntity)
  const deleteEntity = useFilesystemStore((s) => s.deleteEntity)
  const uploadFile = useFilesystemStore((s) => s.uploadFile)
  const renameProject = useFilesystemStore((s) => s.renameProject)
  const activePreviewFile = useFilesystemStore((s) => s.activePreviewFile)
  const setPreviewFile = useFilesystemStore((s) => s.setPreviewFile)
  const convertFileToDoc = useFilesystemStore((s) => s.convertFileToDoc)

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

  const definitions = useWorkflowStore((s) => s.definitions)
  const loadDefinitions = useWorkflowStore((s) => s.loadDefinitions)
  const createDefinition = useWorkflowStore((s) => s.createDefinition)
  const updateDefinition = useWorkflowStore((s) => s.updateDefinition)
  const deleteDefinition = useWorkflowStore((s) => s.deleteDefinition)
  const executeDefinition = useWorkflowStore((s) => s.executeDefinition)
  const nodeStatusesMap = useWorkflowStore((s) => s.nodeStatuses)
  const currentRoundMap = useWorkflowStore((s) => s.currentRound)
  const maxRoundsMap = useWorkflowStore((s) => s.maxRounds)

  const annotationItemsById = useAnnotationStore((s) => s.items)

  // View control state -------------------------------------------------------
  const leftPanelVisible = useViewStore((s) => s.leftPanel)
  const editorColumnVisible = useViewStore((s) => s.editorColumn)
  const previewColumnVisible = useViewStore((s) => s.previewColumn)
  const annotationColumnVisible = useViewStore((s) => s.annotationColumn)
  const rightPanelVisible = useViewStore((s) => s.rightPanel)

  // UI-only state -----------------------------------------------------------
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)
  const [editorScrollTo, setEditorScrollTo] = useState<{ pos: number; seq: number } | null>(null)
  const [rightTab, setRightTab] = useState<string>('discussion')
  const [pendingComment, setPendingComment] = useState<{
    range: { from: number; to: number }
    targetText: string
  } | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // Auto-collapse when panels reach minimum width
  const handlePanelLayout = (sizes: number[]) => {
    // sizes is an array of panel sizes as percentages for VISIBLE panels only
    // We need to figure out which index corresponds to which panel

    let panelIndex = 0

    // Left panel is at index 0 if visible and not collapsed
    if (leftPanelVisible && !leftCollapsed) {
      if (sizes[panelIndex] !== undefined && sizes[panelIndex] < 12) {
        setLeftCollapsed(true)
      }
      panelIndex++
    }

    // Middle panel (editor) is always visible, so skip it
    panelIndex++

    // Right panel is at the last index if visible and not collapsed
    if (rightPanelVisible && !rightCollapsed) {
      if (sizes[panelIndex] !== undefined && sizes[panelIndex] < 18) {
        setRightCollapsed(true)
      }
    }
  }

  // Derived ------------------------------------------------------------------
  const activeDoc = activeDocumentId ? documents[activeDocumentId] : null

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
    loadTree()
    loadProviders()
    loadWorkflows()
    loadDefinitions()
  }, [loadTree, loadProviders, loadWorkflows, loadDefinitions])

  // Keyboard shortcuts -------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+S (Mac) or Ctrl+S (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (activeDocumentId) {
          saveBackendDoc(activeDocumentId)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeDocumentId, saveBackendDoc])

  // Warn before unload if there are unsaved changes ---------------------------
  useEffect(() => {
    const hasUnsaved = Object.values(saveStatusMap).some(
      (s) => s === 'dirty' || s === 'saving' || s === 'error',
    )
    if (!hasUnsaved) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [saveStatusMap])

  // Cross-component handlers -------------------------------------------------
  const handleOpenDoc = async (docId: string) => {
    // Opening a doc clears any binary-file preview.
    setPreviewFile(null)
    // Auto-save current doc before switching (flush any pending debounce too)
    if (activeDocumentId && activeDocumentId !== docId) {
      await flushPendingSave(activeDocumentId)
    }
    await loadBackendDoc(docId)
  }

  const handleOpenFile = async (file: import('./services/filesystemApi').TreeFile) => {
    const mime = file.mime_type || ''
    const name = file.name.toLowerCase()
    const textExts = ['.tex', '.latex', '.ltx', '.bib', '.sty', '.cls', '.bst', '.md', '.markdown', '.txt']
    const looksText = mime.startsWith('text/') || textExts.some((ext) => name.endsWith(ext))
    if (looksText) {
      try {
        const docId = await convertFileToDoc(file.id)
        await handleOpenDoc(docId)
      } catch (e) {
        console.error('convert file to doc failed', e)
      }
      return
    }
    // Binary asset: show in middle preview column, leave editor empty.
    if (activeDocumentId) {
      await flushPendingSave(activeDocumentId)
      useDocumentStore.setState({ activeDocumentId: null })
    }
    setPreviewFile(file)
    // Ensure preview column is visible.
    const { previewColumn, setVisibility } = useViewStore.getState()
    if (!previewColumn) setVisibility({ previewColumn: true })
  }

  const handleSave = async () => {
    if (!activeDocumentId) return
    await saveBackendDoc(activeDocumentId)
  }

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
      query: `${userPrompt}\n\n---\n${selectionText}`,
    }, { autoIngestToAnnotations: false })
  }

  const handleRunDefinition = (definitionId: string, instruction: string) => {
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
    executeDefinition(definitionId, {
      document_id: activeDocumentId,
      range_start: activeSelection.from,
      range_end: activeSelection.to,
      inputs: {
        text: selectionText,
      },
      query: userPrompt,
    }, { autoIngestToAnnotations: false })
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
  const openTeamManagement = () => {
    useViewStore.getState().setVisibility({ rightPanel: true })
    setRightTab('agents')
  }

  return (
    <div className="app-shell">
      <Topbar
        backendReachable={backendReachable}
        providerName={activeProvider?.name ?? null}
        providerStatus={activeProvider?.status ?? null}
        onOpenSettings={openTeamManagement}
        onSave={handleSave}
      />

      <main className="workspace">
        <PanelGroup orientation="horizontal" style={{ height: '100%' }} onLayout={handlePanelLayout}>
          {leftPanelVisible && !leftCollapsed && (
            <>
              <Panel defaultSize={20} minSize={16}>
                <div className="panel left-panel">
                  <FileTree
                    tree={tree}
                    activeDocId={activeDocumentId}
                    activeFileId={activePreviewFile?.id ?? null}
                    expandedFolderIds={expandedFolderIds}
                    loading={treeLoading}
                    error={treeError}
                    onToggleFolder={toggleExpanded}
                    onOpenDoc={handleOpenDoc}
                    onOpenFile={handleOpenFile}
                    onCreateFolder={createFolder}
                    onCreateDoc={createDoc}
                    onRenameEntity={renameEntity}
                    onDeleteEntity={deleteEntity}
                    onUploadFile={uploadFile}
                    onRenameProject={renameProject}
                  />
                  <OutlineList
                    sections={activeDoc ? activeDoc.structure.sections : null}
                    docId={activeDocumentId}
                    onSectionClick={(sec) => setEditorScrollTo({ pos: sec.range.from, seq: Date.now() })}
                  />
                </div>
              </Panel>
              <PanelResizeHandle className="resize-handle" />
            </>
          )}

          {leftPanelVisible && (
            <button
              className={`panel-collapse-btn left ${leftCollapsed ? 'collapsed' : ''}`}
              onClick={() => setLeftCollapsed(!leftCollapsed)}
              title={leftCollapsed ? '展开左侧面板' : '收起左侧面板'}
            >
              <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
                <path
                  d={leftCollapsed ? 'M2 2L6 6L2 10' : 'M6 2L2 6L6 10'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}

          <Panel defaultSize={50} minSize={36}>
            <div className="panel editor-panel">
              <EditorToolbar doc={activeDoc} selection={activeSelection} />
              <PanelGroup orientation="horizontal" style={{ height: 'calc(100% - 48px)' }}>
                {annotationColumnVisible && (
                  <>
                    <Panel defaultSize={22} minSize={16}>
                      <AnnotationColumn
                        documentId={activeDocumentId}
                        activeId={activeAnnotationId}
                        onFocus={setActiveAnnotationId}
                        pendingComment={pendingComment}
                        onDismissPendingComment={() => setPendingComment(null)}
                        agents={workflows}
                      />
                    </Panel>
                    {(editorColumnVisible || previewColumnVisible) && (
                      <PanelResizeHandle className="resize-handle" />
                    )}
                  </>
                )}
                {editorColumnVisible && (
                  <>
                    <Panel defaultSize={40} minSize={20}>
                      <EditorColumn
                        doc={activeDoc}
                        decorations={decorationSpecs}
                        activeAnnotationId={activeAnnotationId}
                        scrollTo={editorScrollTo}
                        onChange={handleEditorChange}
                        onSelectionChange={handleSelectionChange}
                        onDocChange={handleDocChange}
                        onDecorationClick={handleDecorationClick}
                        onAddComment={(p) => {
                          setPendingComment(p)
                          // If the annotation column is hidden, show it so the
                          // composer is visible.
                          if (!annotationColumnVisible) {
                            useViewStore.getState().setVisibility({ annotationColumn: true })
                          }
                        }}
                      />
                    </Panel>
                    {previewColumnVisible && (
                      <PanelResizeHandle className="resize-handle" />
                    )}
                  </>
                )}
                {previewColumnVisible && (
                  <Panel defaultSize={38} minSize={20}>
                    <PreviewColumn doc={activeDoc} previewFile={activePreviewFile} />
                  </Panel>
                )}
              </PanelGroup>
            </div>
          </Panel>

          {rightPanelVisible && (
            <>
              <button
                className={`panel-collapse-btn right ${rightCollapsed ? 'collapsed' : ''}`}
                onClick={() => setRightCollapsed(!rightCollapsed)}
                title={rightCollapsed ? '展开右侧面板' : '收起右侧面板'}
              >
                <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
                  <path
                    d={rightCollapsed ? 'M6 2L2 6L6 10' : 'M2 2L6 6L2 10'}
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {!rightCollapsed && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel defaultSize={30} minSize={24}>
                    <RightPanel
                  workflows={workflows}
                  workflowsLoaded={workflowsLoaded}
                  workflowError={workflowError}
                  definitions={definitions}
                  activeProvider={activeProvider}
                  activeSelection={activeSelection}
                  activeDocumentId={activeDocumentId}
                  runningMap={runningMap}
                  eventsMap={eventsMap}
                  nodeStatusesMap={nodeStatusesMap}
                  currentRoundMap={currentRoundMap}
                  maxRoundsMap={maxRoundsMap}
                  selectedTab={rightTab}
                  onTabChange={setRightTab}
                  onRunWorkflow={handleRunWorkflow}
                  onRunDefinition={handleRunDefinition}
                  onCreateDefinition={createDefinition}
                  onUpdateDefinition={updateDefinition}
                  onDeleteDefinition={deleteDefinition}
                  onReloadWorkflows={loadWorkflows}
                  onJumpToRange={(range) =>
                    setEditorScrollTo({ pos: range.from, seq: Date.now() })
                  }
                />
                  </Panel>
                </>
              )}
            </>
          )}
        </PanelGroup>
      </main>
    </div>
  )
}

export default App
