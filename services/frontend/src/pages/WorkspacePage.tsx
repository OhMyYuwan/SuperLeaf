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
import { ArrowRightToLine, ChevronLeft, ChevronRight } from 'lucide-react'
import { useParams } from 'react-router-dom'
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels'
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
import { useRecentDocStore } from '../stores/recentDocStore'
import { resetProjectScopedStores } from '../stores/_reset'
import { BackendError } from '../services/backendApi'
import { filesystemApi, type TreeDoc, type TreeFolder } from '../services/filesystemApi'
import { projectEventStream } from '../services/projectEventStream'
import type { SourceJump } from '../services/previewSourceMap'
import type { DecorationSpec, DocChangeInfo, EditorRestoreState } from '../features/latex-editor'
import type { PdfSourceSyncRequest } from '../features/preview/LatexPreview'
import {
  collectLatexCitationCompletions,
  collectLatexCommandCompletions,
  collectLatexFilePaths,
  collectLatexLabels,
} from '../features/latex-editor/latex-completion-data'
import type { Document } from '../types/document'

const OUTER_PANEL_AUTO_COLLAPSE_PERCENT = 5
const SIDE_PANEL_COLLAPSED_SIZE = 0
const SIDE_PANEL_ANIMATION_MS = 180
const OUTLINE_COLLAPSED_HEIGHT = '44px'
const WORKSPACE_PANEL_SIZES = {
  outer: {
    left: { defaultSize: 10, minSize: OUTER_PANEL_AUTO_COLLAPSE_PERCENT },
    center: { defaultSize: 68, minSize: 40 },
    right: { defaultSize: 22, minSize: OUTER_PANEL_AUTO_COLLAPSE_PERCENT },
  },
  inner: {
    annotation: { defaultSize: 12, minSize: 12 },
    editor: { defaultSize: 44, minSize: 24 },
    preview: { defaultSize: 44, minSize: 24 },
  },
} as const
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
  const updateEditorViewState = useEditorStore((s) => s.updateViewState)
  const activeSelection = useEditorStore((s) =>
    activeDocumentId ? s.states[activeDocumentId]?.selection ?? null : null,
  )
  const activeEditorRestoreState = activeDocumentId
    ? useEditorStore.getState().states[activeDocumentId] ?? null
    : null

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
  const [editorScrollTo, setEditorScrollTo] = useState<{
    documentId: string
    pos: number
    to?: number
    seq: number
  } | null>(null)
  const [pdfSyncRequest, setPdfSyncRequest] = useState<PdfSourceSyncRequest | null>(null)
  const [rightTab, setRightTab] = useState<string>('discussion')
  const [pendingComment, setPendingComment] = useState<{
    range: { from: number; to: number }
    targetText: string
  } | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [personalPanelOpen, setPersonalPanelOpen] = useState(false)
  const leftOuterPanelRef = useRef<PanelImperativeHandle | null>(null)
  const rightOuterPanelRef = useRef<PanelImperativeHandle | null>(null)
  const leftExpandedSizeRef = useRef<number>(WORKSPACE_PANEL_SIZES.outer.left.defaultSize)
  const rightExpandedSizeRef = useRef<number>(WORKSPACE_PANEL_SIZES.outer.right.defaultSize)
  const sidePanelAnimationFrameRef = useRef<{ left: number | null; right: number | null }>({
    left: null,
    right: null,
  })
  const sidePanelAnimatingRef = useRef({ left: false, right: false })
  const loadingBibDocIds = useRef(new Set<string>())
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const routeProjectName = useProjectStore((s) =>
    projectId ? s.projects.find((project) => project.id === projectId)?.name ?? '' : '',
  )
  const projectReady = !!projectId && currentProjectId === projectId
  const switchingProject = !!projectId && currentProjectId !== projectId
  const showProjectTransition = switchingProject || (projectReady && treeLoading && !tree)
  const autoOpenAttemptedFor = useRef<string | null>(null)

  const cancelSidePanelAnimation = (side: 'left' | 'right') => {
    const frame = sidePanelAnimationFrameRef.current[side]
    if (frame !== null) {
      cancelAnimationFrame(frame)
      sidePanelAnimationFrameRef.current[side] = null
    }
    sidePanelAnimatingRef.current[side] = false
  }

  const animateSidePanelSize = (
    side: 'left' | 'right',
    panel: PanelImperativeHandle,
    targetSize: number,
  ) => {
    cancelSidePanelAnimation(side)
    const startSize = panel.getSize().asPercentage
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduceMotion || Math.abs(startSize - targetSize) < 0.1) {
      panel.resize(`${targetSize}%`)
      return
    }

    sidePanelAnimatingRef.current[side] = true
    const startedAt = performance.now()

    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / SIDE_PANEL_ANIMATION_MS)
      const eased = 1 - Math.pow(1 - progress, 3)
      const nextSize = startSize + (targetSize - startSize) * eased
      panel.resize(`${nextSize}%`)

      if (progress < 1) {
        sidePanelAnimationFrameRef.current[side] = requestAnimationFrame(tick)
        return
      }

      panel.resize(`${targetSize}%`)
      sidePanelAnimationFrameRef.current[side] = null
      sidePanelAnimatingRef.current[side] = false
    }

    sidePanelAnimationFrameRef.current[side] = requestAnimationFrame(tick)
  }

  const handleSidePanelResize = (side: 'left' | 'right', size: PanelSize) => {
    if (
      sidePanelAnimatingRef.current[side] ||
      size.asPercentage <= OUTER_PANEL_AUTO_COLLAPSE_PERCENT
    ) {
      return
    }

    if (side === 'left') {
      leftExpandedSizeRef.current = size.asPercentage
      return
    }

    rightExpandedSizeRef.current = size.asPercentage
  }

  const toggleSidePanelCollapsed = (side: 'left' | 'right') => {
    const isLeft = side === 'left'
    const panel = isLeft ? leftOuterPanelRef.current : rightOuterPanelRef.current
    const collapsed = isLeft ? leftCollapsed : rightCollapsed
    const setCollapsed = isLeft ? setLeftCollapsed : setRightCollapsed
    const expandedSizeRef = isLeft ? leftExpandedSizeRef : rightExpandedSizeRef
    const nextCollapsed = !collapsed

    if (panel && nextCollapsed) {
      const currentSize = panel.getSize().asPercentage
      if (currentSize > OUTER_PANEL_AUTO_COLLAPSE_PERCENT) {
        expandedSizeRef.current = currentSize
      }
    }

    setCollapsed(nextCollapsed)
    if (!panel) return
    animateSidePanelSize(
      side,
      panel,
      nextCollapsed ? SIDE_PANEL_COLLAPSED_SIZE : expandedSizeRef.current,
    )
  }

  const handlePanelLayout = (sizes: number[]) => {
    let panelIndex = 0
    if (leftPanelVisible) {
      if (
        !leftCollapsed &&
        !sidePanelAnimatingRef.current.left &&
        sizes[panelIndex] !== undefined &&
        sizes[panelIndex] < OUTER_PANEL_AUTO_COLLAPSE_PERCENT
      ) {
        setLeftCollapsed(true)
      }
      panelIndex++
    }
    panelIndex++
    if (rightPanelVisible) {
      if (
        !rightCollapsed &&
        !sidePanelAnimatingRef.current.right &&
        sizes[panelIndex] !== undefined &&
        sizes[panelIndex] < OUTER_PANEL_AUTO_COLLAPSE_PERCENT
      ) {
        setRightCollapsed(true)
      }
    }
  }

  useEffect(() => {
    const animationFrames = sidePanelAnimationFrameRef.current
    const animatingState = sidePanelAnimatingRef.current
    return () => {
      for (const side of ['left', 'right'] as const) {
        const frame = animationFrames[side]
        if (frame !== null) {
          cancelAnimationFrame(frame)
        }
        animationFrames[side] = null
        animatingState[side] = false
      }
    }
  }, [])

  // Derived ------------------------------------------------------------------
  const activeDoc = activeDocumentId ? documents[activeDocumentId] : null
  const activeEditorScrollTo =
    activeDocumentId && editorScrollTo?.documentId === activeDocumentId ? editorScrollTo : null
  const citationCompletions = useMemo(() => {
    const sources = Object.values(documents)
      .filter(isCitationSourceDoc)
      .map((doc) => ({
        name: doc.metadata.title,
        content: doc.content,
      }))
    return collectLatexCitationCompletions(sources)
  }, [documents])

  const filePathCompletions = useMemo(() => {
    if (!tree) return []
    return collectLatexFilePaths(tree.root)
  }, [tree])

  const labelCompletions = useMemo(() => {
    const sources = Object.values(documents)
      .filter((doc) => doc.format === 'tex')
      .map((doc) => ({ name: doc.metadata.title, content: doc.content }))
    return collectLatexLabels(sources)
  }, [documents])

  const commandCompletions = useMemo(() => {
    const sources = Object.values(documents)
      .filter((doc) => doc.format === 'tex')
      .map((doc) => ({ name: doc.metadata.title, content: doc.content }))
    return collectLatexCommandCompletions(sources)
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
    let cancelled = false
    void collabConnect(projectId, activeDocumentId, {
      id: currentUser.id,
      name: currentUser.display_name ?? currentUser.email,
    }).then(() => {
      if (cancelled) return
      const collab = useCollaborationStore.getState()
      if (collab.currentProjectId !== projectId || collab.currentDocId !== activeDocumentId) return
      setCollaborating(activeDocumentId, true)
    })
    return () => {
      cancelled = true
      setCollaborating(activeDocumentId, false)
      collabDisconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentId, projectId, projectReady, currentUser?.id])

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
        useRecentDocStore.getState().forget(projectId)
      }
    })
    // documents intentionally excluded — we only want this on mount / activeId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentId, projectReady])

  // Remember the active doc per project so re-entering opens the same one.
  useEffect(() => {
    if (!projectReady || !activeDocumentId) return
    useRecentDocStore.getState().record(projectId, activeDocumentId)
  }, [activeDocumentId, projectReady, projectId])

  // Auto-open the last active doc (or a sensible default) when entering a
  // project with a blank editor. Only attempted once per project entry so the
  // user closing the doc doesn't immediately reopen it.
  useEffect(() => {
    if (!projectReady || !tree) return
    if (activeDocumentId) return
    if (autoOpenAttemptedFor.current === projectId) return
    autoOpenAttemptedFor.current = projectId

    const remembered = useRecentDocStore.getState().get(projectId)
    const target = (remembered && findTreeDoc(tree.root, remembered))
      ? remembered
      : pickDefaultDoc(tree.root)
    if (!target) return

    void loadBackendDoc(target).catch((err) => {
      console.warn('[workspace] auto-open last doc failed', err)
      if (err instanceof BackendError && (err.status === 400 || err.status === 404)) {
        useRecentDocStore.getState().forget(projectId)
      }
    })
  }, [projectReady, tree, activeDocumentId, projectId, loadBackendDoc])

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
      autoOpenAttemptedFor.current = null
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

  const clearActiveAnnotationIfSelectionLeft = (
    documentId: string,
    selection: { from: number; to: number },
  ) => {
    if (!activeAnnotationId) return
    const item = annotationItemsById[activeAnnotationId]
    if (!item || item.documentId !== documentId) {
      setActiveAnnotationId(null)
      return
    }

    const selectionFrom = Math.min(selection.from, selection.to)
    const selectionTo = Math.max(selection.from, selection.to)
    const caretInside =
      selectionFrom === selectionTo &&
      selectionFrom >= item.range.from &&
      selectionFrom <= item.range.to
    const selectionOverlaps =
      selectionFrom < item.range.to &&
      selectionTo > item.range.from

    if (!caretInside && !selectionOverlaps) {
      setActiveAnnotationId(null)
    }
  }

  const handleEditorViewStateChange = (documentId: string, state: EditorRestoreState) => {
    updateEditorViewState(documentId, state)
    clearActiveAnnotationIfSelectionLeft(documentId, state.selectionRange)
    setEditorScrollTo((prev) => {
      if (!prev || prev.documentId !== documentId) return prev
      const expectedTo = prev.to ?? prev.pos
      return state.selectionRange.from === prev.pos && state.selectionRange.to === expectedTo
        ? null
        : prev
    })
  }

  const handleDecorationClick = (id: string) => {
    setActiveAnnotationId((prev) => (prev === id ? null : id))
  }

  const handleAnnotationFocus = (id: string | null) => {
    setActiveAnnotationId(id)
    if (!id) return
    const item = annotationItemsById[id]
    if (!item || item.documentId !== activeDocumentId) return
    setEditorScrollTo({
      documentId: item.documentId,
      pos: item.range.from,
      to: item.range.to,
      seq: Date.now(),
    })
  }

  const handlePreviewSourceJump = (jump: SourceJump) => {
    if (!activeDocumentId) return
    const to = jump.selectText ? jump.pos + jump.selectText.length : undefined
    setEditorScrollTo({ documentId: activeDocumentId, pos: jump.pos, to, seq: Date.now() })
  }

  const handleSyncCodeToPdf = () => {
    if (!activeDocumentId || activeDoc?.format !== 'tex') return
    const state = useEditorStore.getState().states[activeDocumentId]
    const pos = state?.selectionRange.from ?? activeSelection?.from ?? state?.cursor ?? 0
    setPdfSyncRequest({
      documentId: activeDocumentId,
      pos,
      seq: Date.now(),
    })
  }

  const canSyncCodeToPdf = !!(
    activeDocumentId &&
    activeDoc?.format === 'tex' &&
    editorColumnVisible &&
    previewColumnVisible &&
    !activePreviewFile
  )

  return (
    <div className="app-shell">
      <ProjectEventBridge />
      <Topbar
        onOpenPersonalPanel={() => setPersonalPanelOpen(true)}
      />
      <SettingsDialog open={personalPanelOpen} onOpenChange={setPersonalPanelOpen} />

      <main className="workspace" aria-busy={showProjectTransition}>
        <PanelGroup
          orientation="horizontal"
          className="workspace-panel-group"
          onLayoutChanged={(layout) => handlePanelLayout(Object.values(layout))}
        >
          {leftPanelVisible && (
            <>
              <Panel
                id="project-navigation-panel"
                panelRef={leftOuterPanelRef}
                collapsible
                collapsedSize={`${SIDE_PANEL_COLLAPSED_SIZE}%`}
                defaultSize={WORKSPACE_PANEL_SIZES.outer.left.defaultSize}
                minSize={WORKSPACE_PANEL_SIZES.outer.left.minSize}
                onResize={(size) => handleSidePanelResize('left', size)}
              >
                <ErrorBoundary label="项目导航">
                  <div
                    className={`panel left-panel side-panel-content is-left ${
                      leftCollapsed ? 'is-collapsed' : 'is-expanded'
                    }`}
                    aria-hidden={leftCollapsed}
                    inert={leftCollapsed}
                  >
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
                          onSectionClick={(sec) => {
                            if (!activeDocumentId) return
                            setEditorScrollTo({
                              documentId: activeDocumentId,
                              pos: sec.range.from,
                              seq: Date.now(),
                            })
                          }}
                        />
                      </Panel>
                    </PanelGroup>
                  </div>
                </ErrorBoundary>
              </Panel>
              <PanelResizeHandle
                disabled={leftCollapsed}
                className={`resize-handle ${leftCollapsed ? 'is-hidden' : ''}`}
              />
            </>
          )}

          {leftPanelVisible && (
            <button
              type="button"
              className={`panel-collapse-btn left ${leftCollapsed ? 'collapsed' : ''}`}
              onClick={() => toggleSidePanelCollapsed('left')}
              title={leftCollapsed ? '展开项目导航' : '收起项目导航'}
              aria-label={leftCollapsed ? '展开项目导航' : '收起项目导航'}
            >
              {leftCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          )}

          <Panel
            defaultSize={WORKSPACE_PANEL_SIZES.outer.center.defaultSize}
            minSize={WORKSPACE_PANEL_SIZES.outer.center.minSize}
          >
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
                    <Panel
                      defaultSize={WORKSPACE_PANEL_SIZES.inner.annotation.defaultSize}
                      minSize={WORKSPACE_PANEL_SIZES.inner.annotation.minSize}
                    >
                      <ErrorBoundary label="批注列">
                        <AnnotationColumn
                          documentId={activeDocumentId}
                          activeId={activeAnnotationId}
                          onFocus={handleAnnotationFocus}
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
                    <Panel
                      defaultSize={WORKSPACE_PANEL_SIZES.inner.editor.defaultSize}
                      minSize={WORKSPACE_PANEL_SIZES.inner.editor.minSize}
                    >
                      <ErrorBoundary label="编辑器">
                        <EditorColumn
                          doc={activeDoc}
                          decorations={decorationSpecs}
                          activeAnnotationId={activeAnnotationId}
                          hoveredAnnotationId={hoveredAnnotationId}
                          scrollTo={activeEditorScrollTo}
                          restoreState={activeEditorRestoreState}
                          citationCompletions={citationCompletions}
                          filePathCompletions={filePathCompletions}
                          labelCompletions={labelCompletions}
                          commandCompletions={commandCompletions}
                          onChange={handleEditorChange}
                          onSelectionChange={handleSelectionChange}
                          onDocChange={handleDocChange}
                          onViewStateChange={handleEditorViewStateChange}
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
                      <PanelResizeHandle className="resize-handle editor-preview-sync-handle">
                        <button
                          type="button"
                          className="code-to-pdf-sync-btn"
                          onClick={handleSyncCodeToPdf}
                          disabled={!canSyncCodeToPdf}
                          title="在 PDF 中显示当前位置"
                          aria-label="在 PDF 中显示当前位置"
                        >
                          <ArrowRightToLine size={15} />
                        </button>
                      </PanelResizeHandle>
                    )}
                  </>
                )}
                {previewColumnVisible && (
                  <Panel
                    defaultSize={WORKSPACE_PANEL_SIZES.inner.preview.defaultSize}
                    minSize={WORKSPACE_PANEL_SIZES.inner.preview.minSize}
                  >
                    <ErrorBoundary label="预览">
                      <PreviewColumn
                        doc={activeDoc}
                        previewFile={activePreviewFile}
                        onSourceJump={handlePreviewSourceJump}
                        syncToPdfRequest={pdfSyncRequest}
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
                type="button"
                className={`panel-collapse-btn right ${rightCollapsed ? 'collapsed' : ''}`}
                onClick={() => toggleSidePanelCollapsed('right')}
                title={rightCollapsed ? '展开协作区' : '收起协作区'}
                aria-label={rightCollapsed ? '展开协作区' : '收起协作区'}
              >
                {rightCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
              </button>
              <PanelResizeHandle
                disabled={rightCollapsed}
                className={`resize-handle ${rightCollapsed ? 'is-hidden' : ''}`}
              />
              <Panel
                id="collaboration-panel"
                panelRef={rightOuterPanelRef}
                collapsible
                collapsedSize={`${SIDE_PANEL_COLLAPSED_SIZE}%`}
                defaultSize={WORKSPACE_PANEL_SIZES.outer.right.defaultSize}
                minSize={WORKSPACE_PANEL_SIZES.outer.right.minSize}
                onResize={(size) => handleSidePanelResize('right', size)}
              >
                <ErrorBoundary label="协作区">
                  <div
                    className={`side-panel-content is-right ${
                      rightCollapsed ? 'is-collapsed' : 'is-expanded'
                    }`}
                    aria-hidden={rightCollapsed}
                    inert={rightCollapsed}
                  >
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
                      onJumpToRange={(range) => {
                        if (!activeDocumentId) return
                        setEditorScrollTo({
                          documentId: activeDocumentId,
                          pos: range.from,
                          seq: Date.now(),
                        })
                      }}
                    />
                  </div>
                </ErrorBoundary>
              </Panel>
            </>
          )}
        </PanelGroup>
        {showProjectTransition && (
          <div className="project-switch-overlay" role="status" aria-live="polite">
            <div className="project-switch-indicator">
              <div className="project-switch-label">
                {switchingProject ? '切换项目中' : '载入项目中'}
              </div>
              <div className="project-switch-name">
                {routeProjectName || '正在准备工作区'}
              </div>
              <div className="project-switch-progress" aria-hidden="true">
                <span />
              </div>
            </div>
          </div>
        )}
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

function findTreeDoc(folder: TreeFolder, docId: string): TreeDoc | null {
  for (const doc of folder.docs) {
    if (doc.id === docId) return doc
  }
  for (const child of folder.folders) {
    const hit = findTreeDoc(child, docId)
    if (hit) return hit
  }
  return null
}

function pickDefaultDoc(root: TreeFolder): string | null {
  const allDocs = collectAllDocs(root).filter((d) => !isBibDocumentName(d.name))
  if (allDocs.length === 0) return null

  const named = (target: string) =>
    allDocs.find((d) => d.name.toLowerCase() === target)
  const byExt = (ext: string) =>
    allDocs.find((d) => d.name.toLowerCase().endsWith(ext))

  return (
    named('main.tex')?.id ??
    named('main.md')?.id ??
    byExt('.tex')?.id ??
    byExt('.md')?.id ??
    allDocs[0].id
  )
}

function collectAllDocs(folder: TreeFolder): TreeDoc[] {
  return [
    ...folder.docs,
    ...folder.folders.flatMap((child) => collectAllDocs(child)),
  ]
}
