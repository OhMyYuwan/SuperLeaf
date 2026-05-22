/**
 * WorkspacePage — the writing workspace, mounted under /projects/:projectId/*.
 *
 * Bootstrap order on mount or when :projectId changes:
 *   1. setCurrent(projectId)           (X-Project-Id is now wired)
 *   2. resetProjectScopedStores()      (drop the previous project's caches)
 *   3. loadTree / loadProviders / loadWorkflows / loadDefinitions
 *
 * Step 1 must run before step 3 because the loaders read the header via
 * `buildHeaders` in backendApi. Step 2 happens between to avoid rendering
 * stale doc/file/annotation state from the prior project for one tick.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { Topbar } from '../features/topbar'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { FileTree, OutlineList } from '../features/file-tree'
import {
  EditorToolbar,
  EditorColumn,
  PreviewColumn,
  AnnotationColumn,
} from '../features/workspace-center'
import { RightPanel } from '../features/right-panel'
import { ErrorBoundary } from '../features/shared/ErrorBoundary'
import { ProjectEventBridge } from '../features/shared/ProjectEventBridge'
import { CollaborationStatus } from '../features/shared/CollaborationStatus'
import { useDocumentStore } from '../stores/documentStore'
import { useEditorStore } from '../stores/editorStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { useCollaborationStore } from '../stores/collaborationStore'
import { useAnnotationStore } from '../stores/annotationStore'
import { useFilesystemStore } from '../stores/filesystemStore'
import { useViewStore } from '../stores/viewStore'
import { useProjectStore } from '../stores/projectStore'
import { useUserStore } from '../stores/userStore'
import { resetProjectScopedStores } from '../stores/_reset'
import { BackendError } from '../services/backendApi'
import { filesystemApi, type TreeDoc, type TreeFolder } from '../services/filesystemApi'
import { projectEventStream } from '../services/projectEventStream'
import type { SourceJump } from '../services/previewSourceMap'
import type { DecorationSpec, DocChangeInfo } from '../features/latex-editor'
import { collectLatexCitationCompletions } from '../features/latex-editor/latex-completion-data'
import type { Document } from '../types/document'

const OUTER_PANEL_AUTO_COLLAPSE_PERCENT = 5
const OUTLINE_COLLAPSED_HEIGHT = '44px'
const DEFAULT_REVIEW_PROMPT =
  '请直接用 Markdown 针对以下文本给出清晰、可执行的评审意见。不要输出 JSON，也不要拆分 annotations/suggestions/risks。'

export function WorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>()

  // Document + editor state --------------------------------------------------
  const documents = useDocumentStore((s) => s.documents)
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId)
  const updateContent = useDocumentStore((s) => s.updateContent)
  const loadBackendDoc = useDocumentStore((s) => s.loadBackendDoc)
  const refreshFromBackend = useDocumentStore((s) => s.refreshFromBackend)
  const saveBackendDoc = useDocumentStore((s) => s.saveBackendDoc)
  const flushPendingSave = useDocumentStore((s) => s.flushPendingSave)
  const upsertBackendDoc = useDocumentStore((s) => s.upsertFromBackendDoc)
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
  const moveEntity = useFilesystemStore((s) => s.moveEntity)
  const uploadFile = useFilesystemStore((s) => s.uploadFile)
  const uploadFolder = useFilesystemStore((s) => s.uploadFolder)
  const uploadProjectZip = useFilesystemStore((s) => s.uploadProjectZip)
  const renameProject = useFilesystemStore((s) => s.renameProject)
  const activePreviewFile = useFilesystemStore((s) => s.activePreviewFile)
  const setPreviewFile = useFilesystemStore((s) => s.setPreviewFile)
  const convertFileToDoc = useFilesystemStore((s) => s.convertFileToDoc)

  // Provider + workflow state ------------------------------------------------
  const loadProviders = useSettingsStore((s) => s.load)
  const activeProvider = useSettingsStore((s) => s.providers.find((p) => p.is_active) ?? null)
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
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null)
  const [editorScrollTo, setEditorScrollTo] = useState<{ pos: number; to?: number; seq: number } | null>(null)
  const [rightTab, setRightTab] = useState<string>('discussion')
  const [pendingComment, setPendingComment] = useState<{
    range: { from: number; to: number }
    targetText: string
  } | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [personalPanelOpen, setPersonalPanelOpen] = useState(false)
  const loadingBibDocIds = useRef(new Set<string>())
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projectReady = !!projectId && currentProjectId === projectId

  const handlePanelLayout = (sizes: number[]) => {
    let panelIndex = 0
    if (leftPanelVisible && !leftCollapsed) {
      if (
        sizes[panelIndex] !== undefined &&
        sizes[panelIndex] < OUTER_PANEL_AUTO_COLLAPSE_PERCENT
      ) {
        setLeftCollapsed(true)
      }
      panelIndex++
    }
    panelIndex++
    if (rightPanelVisible && !rightCollapsed) {
      if (
        sizes[panelIndex] !== undefined &&
        sizes[panelIndex] < OUTER_PANEL_AUTO_COLLAPSE_PERCENT
      ) {
        setRightCollapsed(true)
      }
    }
  }

  // Derived ------------------------------------------------------------------
  const activeDoc = activeDocumentId ? documents[activeDocumentId] : null
  const citationCompletions = useMemo(() => {
    const sources = Object.values(documents)
      .filter(isCitationSourceDoc)
      .map((doc) => ({
        name: doc.metadata.title,
        content: doc.content,
      }))
    return collectLatexCitationCompletions(sources)
  }, [documents])

  const decorationSpecs: DecorationSpec[] = useMemo(() => {
    if (!activeDocumentId) return []
    return Object.values(annotationItemsById)
      .filter((it) => it.documentId === activeDocumentId && it.status === 'pending')
      .map((it) => ({
        id: it.id,
        from: it.range.from,
        to: it.range.to,
        kind: it.kind,
        severity: it.severity,
      }))
  }, [annotationItemsById, activeDocumentId])

  // Pull annotation evaluations + review states from backend when a doc
  // opens or switches. server-wins overwrite of the local zustand persist
  // cache (REQ-0034).
  useEffect(() => {
    if (!projectReady) return
    if (!activeDocumentId) return
    void useAnnotationStore.getState().hydrateForDoc(activeDocumentId)
  }, [activeDocumentId, projectReady])

  // Overleaf keeps bibliography keys in project metadata. Our project tree is
  // backed by backend docs, so load `.bib` docs quietly into the document cache
  // and derive citation metadata from their live content.
  useEffect(() => {
    if (!projectReady || !tree) return
    const bibDocs = collectBibTreeDocs(tree.root)
    for (const bibDoc of bibDocs) {
      if (documents[bibDoc.id]) continue
      if (loadingBibDocIds.current.has(bibDoc.id)) continue
      loadingBibDocIds.current.add(bibDoc.id)
      void filesystemApi.getDoc(bibDoc.id)
        .then((doc) => {
          upsertBackendDoc(doc)
        })
        .catch((err) => {
          console.warn('[WorkspacePage] failed to load bibliography doc', bibDoc.name, err)
        })
        .finally(() => {
          loadingBibDocIds.current.delete(bibDoc.id)
        })
    }
  }, [documents, projectReady, tree, upsertBackendDoc])

  // Collaboration: connect/disconnect Yjs when the active document changes.
  const currentUser = useUserStore((s) => s.currentUser)
  const collabConnect = useCollaborationStore((s) => s.connect)
  const collabDisconnect = useCollaborationStore((s) => s.disconnect)
  const setCollaborating = useDocumentStore((s) => s.setCollaborating)

  useEffect(() => {
    if (!projectReady || !activeDocumentId || !currentUser) {
      collabDisconnect()
      return
    }
    void collabConnect(activeDocumentId, {
      id: currentUser.id,
      name: currentUser.display_name ?? currentUser.email,
    }).then(() => {
      setCollaborating(activeDocumentId, true)
    })
    return () => {
      setCollaborating(activeDocumentId, false)
      collabDisconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentId, projectReady, currentUser?.id])

  // Document content is no longer persisted (servers is the source of truth,
  // see documentStore persist config). On mount / hard refresh, if we have a
  // persisted activeDocumentId but no in-memory copy, fetch it.
  useEffect(() => {
    if (!projectReady) return
    if (!activeDocumentId) return
    if (documents[activeDocumentId]) return
    void loadBackendDoc(activeDocumentId).catch((err) => {
      console.error('[workspace] initial loadBackendDoc failed', err)
      if (err instanceof BackendError && (err.status === 400 || err.status === 404)) {
        useDocumentStore.setState({ activeDocumentId: null })
      }
    })
    // documents intentionally excluded — we only want this on mount / activeId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentId, projectReady])

  // Multi-device catch-up: when the tab regains focus or visibility, hydrate
  // annotations only if the SSE stream had a disconnect since the last hydrate.
  // SSE already delivers all incremental changes in real time, so a full
  // hydrate on every focus is wasteful (causes 3 extra requests per window
  // switch). We only need it to catch up on events missed during a disconnect.
  // On reconnect we also hydrate immediately rather than waiting for the next
  // focus, so the user never sees stale decorations after a network blip.
  useEffect(() => {
    if (!projectReady) return
    const hydrateIfNeeded = () => {
      if (activeDocumentId && projectEventStream.needsHydrate()) {
        void useAnnotationStore.getState().hydrateForDoc(activeDocumentId)
      }
    }
    const refresh = () => {
      void loadTree()
      if (activeDocumentId) void refreshFromBackend(activeDocumentId)
      hydrateIfNeeded()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    // Hydrate immediately on SSE reconnect — don't wait for the next focus.
    const unsubReconnect = projectEventStream.onReconnect(() => {
      if (activeDocumentId) {
        void useAnnotationStore.getState().hydrateForDoc(activeDocumentId)
      }
    })
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      unsubReconnect()
    }
  }, [activeDocumentId, loadTree, projectReady, refreshFromBackend])

  // Bootstrap on project switch ---------------------------------------------
  useEffect(() => {
    if (!projectId) return
    const projectStore = useProjectStore.getState()
    const previousProjectId = projectStore.currentProjectId
    const switchingProject = previousProjectId !== projectId
    if (switchingProject) {
      resetProjectScopedStores()
    }
    projectStore.setCurrent(projectId)
    if (!projectStore.loaded && !projectStore.loading) {
      projectStore.load()
    }
    loadTree()
    loadProviders()
    loadWorkflows()
    loadDefinitions()
  }, [projectId, loadTree, loadProviders, loadWorkflows, loadDefinitions])

  // Keyboard shortcuts -------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
    setPreviewFile(null)
    if (activeDocumentId && activeDocumentId !== docId) {
      await flushPendingSave(activeDocumentId)
    }
    await loadBackendDoc(docId)
  }

  const handleOpenFile = async (file: import('../services/filesystemApi').TreeFile) => {
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
    if (activeDocumentId) {
      await flushPendingSave(activeDocumentId)
      useDocumentStore.setState({ activeDocumentId: null })
    }
    setPreviewFile(file)
    const { previewColumn, setVisibility } = useViewStore.getState()
    if (!previewColumn) setVisibility({ previewColumn: true })
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
    const userPrompt = instruction.trim() || DEFAULT_REVIEW_PROMPT
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
    const userPrompt = instruction.trim() || DEFAULT_REVIEW_PROMPT
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

  const handleTestDefinition = (definitionId: string, prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed) {
      alert('请输入测试 Prompt')
      return
    }
    executeDefinition(definitionId, {
      document_id: activeDocumentId ?? 'workflow-test',
      range_start: activeSelection?.from ?? 0,
      range_end: activeSelection?.to ?? trimmed.length,
      inputs: {
        text: activeSelection?.text || trimmed,
        test_prompt: trimmed,
      },
      query: trimmed,
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

  const handlePreviewSourceJump = (jump: SourceJump) => {
    if (!activeDocumentId) return
    const to = jump.selectText ? jump.pos + jump.selectText.length : undefined
    setEditorScrollTo({ pos: jump.pos, to, seq: Date.now() })
  }

  return (
    <div className="app-shell">
      <ProjectEventBridge />
      <Topbar
        onOpenPersonalPanel={() => setPersonalPanelOpen(true)}
      />
      <SettingsDialog open={personalPanelOpen} onOpenChange={setPersonalPanelOpen} />

      <main className="workspace">
        <PanelGroup
          orientation="horizontal"
          className="workspace-panel-group"
          onLayoutChanged={(layout) => handlePanelLayout(Object.values(layout))}
        >
          {leftPanelVisible && !leftCollapsed && (
            <>
              <Panel defaultSize={20} minSize={OUTER_PANEL_AUTO_COLLAPSE_PERCENT}>
                <ErrorBoundary label="文件树">
                  <div className="panel left-panel">
                    <PanelGroup
                      key={outlineCollapsed ? 'left-outline-collapsed' : 'left-outline-open'}
                      orientation="vertical"
                      className="left-panel-split"
                    >
                      <Panel
                        defaultSize={outlineCollapsed ? undefined : '54%'}
                        minSize={outlineCollapsed ? '160px' : '32%'}
                      >
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
                          onMoveEntity={moveEntity}
                          onUploadFile={uploadFile}
                          onUploadFolder={uploadFolder}
                          onUploadProjectZip={uploadProjectZip}
                          onRenameProject={renameProject}
                        />
                      </Panel>
                      {!outlineCollapsed && (
                        <PanelResizeHandle className="resize-handle vertical" />
                      )}
                      <Panel
                        defaultSize={outlineCollapsed ? OUTLINE_COLLAPSED_HEIGHT : '46%'}
                        minSize={outlineCollapsed ? OUTLINE_COLLAPSED_HEIGHT : '28%'}
                        maxSize={outlineCollapsed ? OUTLINE_COLLAPSED_HEIGHT : '68%'}
                      >
                        <OutlineList
                          sections={activeDoc ? activeDoc.structure.sections : null}
                          docId={activeDocumentId}
                          collapsed={outlineCollapsed}
                          onToggleCollapsed={() => setOutlineCollapsed((v) => !v)}
                          onSectionClick={(sec) => setEditorScrollTo({ pos: sec.range.from, seq: Date.now() })}
                        />
                      </Panel>
                    </PanelGroup>
                  </div>
                </ErrorBoundary>
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
              <div className="editor-toolbar-shell">
                <EditorToolbar doc={activeDoc} selection={activeSelection} />
                <CollaborationStatus />
              </div>
              <PanelGroup
                orientation="horizontal"
                className="editor-content-split"
                style={{ flex: 1, minHeight: 0, height: 'auto' }}
              >
                {annotationColumnVisible && (
                  <>
                    <Panel defaultSize={22} minSize={16}>
                      <ErrorBoundary label="批注列">
                        <AnnotationColumn
                          documentId={activeDocumentId}
                          activeId={activeAnnotationId}
                          onFocus={setActiveAnnotationId}
                          onHover={setHoveredAnnotationId}
                          pendingComment={pendingComment}
                          onDismissPendingComment={() => setPendingComment(null)}
                          agents={workflows}
                        />
                      </ErrorBoundary>
                    </Panel>
                    {(editorColumnVisible || previewColumnVisible) && (
                      <PanelResizeHandle className="resize-handle" />
                    )}
                  </>
                )}
                {editorColumnVisible && (
                  <>
                    <Panel defaultSize={40} minSize={20}>
                      <ErrorBoundary label="编辑器">
                        <EditorColumn
                          doc={activeDoc}
                          decorations={decorationSpecs}
                          activeAnnotationId={activeAnnotationId}
                          hoveredAnnotationId={hoveredAnnotationId}
                          scrollTo={editorScrollTo}
                          citationCompletions={citationCompletions}
                          onChange={handleEditorChange}
                          onSelectionChange={handleSelectionChange}
                          onDocChange={handleDocChange}
                          onDecorationClick={handleDecorationClick}
                          onAddComment={(p) => {
                            setPendingComment(p)
                            if (!annotationColumnVisible) {
                              useViewStore.getState().setVisibility({ annotationColumn: true })
                            }
                          }}
                        />
                      </ErrorBoundary>
                    </Panel>
                    {previewColumnVisible && (
                      <PanelResizeHandle className="resize-handle" />
                    )}
                  </>
                )}
                {previewColumnVisible && (
                  <Panel defaultSize={38} minSize={20}>
                    <ErrorBoundary label="预览">
                      <PreviewColumn
                        doc={activeDoc}
                        previewFile={activePreviewFile}
                        onSourceJump={handlePreviewSourceJump}
                      />
                    </ErrorBoundary>
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
                  <Panel defaultSize={30} minSize={OUTER_PANEL_AUTO_COLLAPSE_PERCENT}>
                    <ErrorBoundary label="右侧面板">
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
                  onTestDefinition={handleTestDefinition}
                  onCreateDefinition={createDefinition}
                  onUpdateDefinition={updateDefinition}
                  onDeleteDefinition={deleteDefinition}
                  onReloadWorkflows={loadWorkflows}
                  onJumpToRange={(range) =>
                    setEditorScrollTo({ pos: range.from, seq: Date.now() })
                  }
                />
                    </ErrorBoundary>
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

function collectBibTreeDocs(folder: TreeFolder): TreeDoc[] {
  return [
    ...folder.docs.filter((doc) => isBibDocumentName(doc.name)),
    ...folder.folders.flatMap((child) => collectBibTreeDocs(child)),
  ]
}

function isCitationSourceDoc(doc: Document): boolean {
  const title = doc.metadata.title.toLowerCase()
  return (
    isBibDocumentName(title) ||
    /\\bibitem(?:\[[^\]]*])?\{[^}]+\}/.test(doc.content) ||
    /@[A-Za-z]+\s*[{(]\s*[^,\s{}()]+,/.test(doc.content)
  )
}

function isBibDocumentName(name: string): boolean {
  return name.toLowerCase().endsWith('.bib')
}
