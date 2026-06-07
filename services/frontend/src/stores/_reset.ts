/**
 * Store reset helpers.
 *
 * `resetProjectScopedStores` — clear when switching between projects within
 *   the same user session. Keeps user / projects list / per-user providers
 *   intact.
 * `resetUserScopedStores` — clear on logout. Strict superset of the project
 *   reset: also drops the project list, settings (per-user providers), and
 *   the cached agents/workflows list (also per-user now).
 *
 * Methods are NOT reset; Zustand keeps actions wired in `create(...)`.
 */

import { useDocumentStore } from './documentStore'
import { useAnnotationStore } from './annotationStore'
import { useAnnotationAgentSuggestionStore } from './annotationAgentSuggestionStore'
import { useFilesystemStore } from './filesystemStore'
import { useCompileStore } from './compileStore'
import { useCollaborationStore } from './collaborationStore'
import { useConversationStore } from './conversationStore'
import { useWorkflowStore } from './workflowStore'

export function resetProjectScopedStores(): void {
  useCollaborationStore.getState().disconnect()

  useDocumentStore.setState({
    documents: {},
    activeDocumentId: null,
    saveStatus: {},
    lastSavedAt: {},
    saveError: {},
    collaborating: {},
    backendVersions: {},
  })

  useAnnotationStore.setState({
    items: {},
    byRun: {},
    reviewStatusByAnnotation: {},
    evaluationsByAnnotation: {},
  })

  useAnnotationAgentSuggestionStore.setState({
    suggestionsByAnnotation: {},
    runningByDoc: {},
    lastRunByDoc: {},
    error: null,
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
    streamingStats: {},
    messageRunStats: {},
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
}

export async function resetUserScopedStores(): Promise<void> {
  // Dynamic imports to avoid a load-order cycle: userStore (which calls this
  // on logout) imports from here, and projectStore/settingsStore import
  // userStore-adjacent helpers indirectly.
  const { useProjectStore } = await import('./projectStore')
  const { useSettingsStore } = await import('./settingsStore')

  resetProjectScopedStores()

  useProjectStore.setState({
    projects: [],
    currentProjectId: null,
    loading: false,
    loaded: false,
    error: null,
  })

  useSettingsStore.setState({
    providers: [],
    loading: false,
    loaded: false,
    error: null,
    backendReachable: null,
  })

  // The cached agents list is per-user now — drop it too.
  useWorkflowStore.setState({
    workflows: [],
    loaded: false,
    error: null,
  })
}
