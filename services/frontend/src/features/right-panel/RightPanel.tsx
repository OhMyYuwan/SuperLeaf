/**
 * RightPanel — the Tabs container for the three right-column tabs.
 *
 * Keeps its own `selectedTab` state since the active tab is UI-local and no
 * other component needs to know about it.
 */

import { useEffect, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import type { CachedWorkflow, Provider, WorkflowDefinition, WorkflowDefinitionDraft } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import type { RunEvent, NodeStatus } from '../../stores/workflowStore'
import { DiscussionTab } from './DiscussionTab'
import { TeamTab } from './TeamTab'
import { RunHistoryTab } from './RunHistoryTab'
import { ProjectArchiveTab } from './ProjectArchiveTab'
import { HistoryTab } from '../history/HistoryTab'
import { useProjectStore } from '../../stores/projectStore'
import '../history/history.css'
import './project-archive.css'
import './right-panel.css'

interface RightPanelProps {
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  workflowError: string | null
  definitions: WorkflowDefinition[]
  activeProvider: Provider | null
  activeSelection: Selection | null
  activeDocumentId: string | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  nodeStatusesMap: Record<string, NodeStatus[]>
  currentRoundMap: Record<string, number>
  maxRoundsMap: Record<string, number>
  // Optional controlled-tab props. If omitted, the panel manages its own state.
  selectedTab?: string
  onTabChange?: (tab: string) => void
  onRunWorkflow: (workflowId: string, instruction: string) => void
  onRunDefinition: (definitionId: string, instruction: string) => void
  onTestDefinition: (definitionId: string, prompt: string) => void
  onCreateDefinition: (draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onUpdateDefinition: (id: string, draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onDeleteDefinition: (id: string) => Promise<void>
  onReloadWorkflows: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function RightPanel(props: RightPanelProps) {
  const [internalTab, setInternalTab] = useState('discussion')
  const [versionSubtab, setVersionSubtab] = useState<'archive' | 'document'>('archive')
  const currentProjectRole = useProjectStore((s) => s.currentProjectRole)
  const canManageArchive = currentProjectRole === 'owner'
  const selectedTab = props.selectedTab ?? internalTab
  const onTabChange = props.onTabChange ?? setInternalTab

  useEffect(() => {
    if (!canManageArchive && versionSubtab === 'archive') {
      setVersionSubtab('document')
    }
  }, [canManageArchive, versionSubtab])

  return (
    <div className="panel right-panel">
      <Tabs.Root value={selectedTab} onValueChange={onTabChange} className="tabs-root">
        <Tabs.List className="tabs-list">
          <Tabs.Trigger className="tab-trigger" value="discussion">
            讨论区
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="agents">
            团队管理
          </Tabs.Trigger>
          {/* 工作流 tab 已集成到团队管理的子标签中 */}
          {/* <Tabs.Trigger className="tab-trigger" value="workflow">
            工作流
          </Tabs.Trigger> */}
          <Tabs.Trigger className="tab-trigger" value="history">
            运行
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="versions">
            版本
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="discussion" className="tab-content">
          <DiscussionTab
            workflows={props.workflows}
            documentId={props.activeDocumentId}
            activeSelection={props.activeSelection}
            onJumpToRange={props.onJumpToRange}
          />
        </Tabs.Content>

        <Tabs.Content value="agents" className="tab-content">
          <TeamTab
            workflows={props.workflows}
            workflowsLoaded={props.workflowsLoaded}
            workflowError={props.workflowError}
            definitions={props.definitions}
            activeSelection={props.activeSelection}
            runningMap={props.runningMap}
            eventsMap={props.eventsMap}
            nodeStatusesMap={props.nodeStatusesMap}
            currentRoundMap={props.currentRoundMap}
            maxRoundsMap={props.maxRoundsMap}
            onReload={props.onReloadWorkflows}
            onRunDefinition={props.onRunDefinition}
            onTestDefinition={props.onTestDefinition}
            onCreateDefinition={props.onCreateDefinition}
            onUpdateDefinition={props.onUpdateDefinition}
            onDeleteDefinition={props.onDeleteDefinition}
          />
        </Tabs.Content>

        {/* 工作流 tab 已集成到团队管理的子标签中 */}
        {/* <Tabs.Content value="workflow" className="tab-content">
          <WorkflowTab
            workflows={props.workflows}
            activeSelection={props.activeSelection}
            runningMap={props.runningMap}
            eventsMap={props.eventsMap}
            onRun={props.onRunWorkflow}
          />
        </Tabs.Content> */}

        <Tabs.Content value="history" className="tab-content">
          <RunHistoryTab
            workflows={props.workflows}
            documentId={props.activeDocumentId}
            onJumpToRange={props.onJumpToRange}
          />
        </Tabs.Content>

        <Tabs.Content value="versions" className="tab-content">
          <div className="tab-content-wrapper">
            <div className="history-subnav">
              {canManageArchive && (
                <button
                  className={`history-subnav-btn ${versionSubtab === 'archive' ? 'is-active' : ''}`}
                  onClick={() => setVersionSubtab('archive')}
                >
                  项目归档
                </button>
              )}
              <button
                className={`history-subnav-btn ${versionSubtab === 'document' ? 'is-active' : ''}`}
                onClick={() => setVersionSubtab('document')}
              >
                文档历史
              </button>
            </div>
            {versionSubtab === 'archive' ? (
              <ProjectArchiveTab />
            ) : (
              <HistoryTab documentId={props.activeDocumentId} embedded />
            )}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
