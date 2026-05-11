/**
 * Store reset helpers.
 *
 * When the current project changes, every store that caches project-specific
 * data must be cleared so we don't leak project A's tree / docs / annotations
 * into project B's workspace. We only reset the data slices — method
 * references stay intact (Zustand keeps the actions that were wired in
 * `create(...)`), so consumers keep working without re-subscribing.
 *
 * We do NOT reset: projectStore (it owns the switch), workflowStore.workflows
 * (CachedWorkflow list is global), settingsStore, viewStore (UI preferences).
 */

import { useDocumentStore } from './documentStore'
import { useAnnotationStore } from './annotationStore'
import { useFilesystemStore } from './filesystemStore'
import { useCompileStore } from './compileStore'
import { useConversationStore } from './conversationStore'
import { useWorkflowStore } from './workflowStore'
import { useEditorStore } from './editorStore'

export function resetProjectScopedStores(): void {
  useDocumentStore.setState({
    documents: {},
    activeDocumentId: null,
    saveStatus: {},
    lastSavedAt: {},
    saveError: {},
  })

  useAnnotationStore.setState({
    items: {},
    byRun: {},
  })

  useFilesystemStore.setState({
    tree: null,
    loading: false,
    error: null,
    expandedFolderIds: {},
    activePreviewFile: null,
  })

  useCompileStore.setState({
    settings: null,
    lastResult: null,
    compiling: false,
    pdfVersion: 0,
    fullLog: null,
    loadError: null,
  })

  useConversationStore.setState({
    conversations: {},
    messages: {},
    loading: false,
    error: null,
    streaming: {},
    streamingDelta: {},
  })

  useWorkflowStore.setState({
    running: {},
    lastRunEvents: {},
    runHistory: [],
    historyLoading: false,
    historyError: null,
    definitions: [],
    definitionsLoading: false,
    definitionsLoaded: false,
    definitionsError: null,
    nodeStatuses: {},
    currentRound: {},
    maxRounds: {},
  })

  useEditorStore.setState({ states: {} })
}
