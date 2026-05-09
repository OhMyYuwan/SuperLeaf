/**
 * RightPanel — the Tabs container for the three right-column tabs.
 *
 * Keeps its own `selectedTab` state since the active tab is UI-local and no
 * other component needs to know about it.
 */

import { useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import type { CachedWorkflow, Provider } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import type { RunEvent } from '../../stores/workflowStore'
import { DiscussionTab } from './DiscussionTab'
import { TeamTab } from './TeamTab'
import { WorkflowTab } from './WorkflowTab'
import { RunHistoryTab } from './RunHistoryTab'
import './right-panel.css'

interface RightPanelProps {
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  workflowError: string | null
  activeProvider: Provider | null
  activeSelection: Selection | null
  activeDocumentId: string | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  // Optional controlled-tab props. If omitted, the panel manages its own state.
  selectedTab?: string
  onTabChange?: (tab: string) => void
  onRunWorkflow: (workflowId: string, instruction: string) => void
  onReloadWorkflows: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function RightPanel(props: RightPanelProps) {
  const [internalTab, setInternalTab] = useState('discussion')
  const selectedTab = props.selectedTab ?? internalTab
  const onTabChange = props.onTabChange ?? setInternalTab

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
          <Tabs.Trigger className="tab-trigger" value="workflow">
            工作流
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="history">
            历史
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="discussion" className="tab-content">
          <DiscussionTab />
        </Tabs.Content>

        <Tabs.Content value="agents" className="tab-content">
          <TeamTab
            workflows={props.workflows}
            workflowsLoaded={props.workflowsLoaded}
            workflowError={props.workflowError}
            onReload={props.onReloadWorkflows}
          />
        </Tabs.Content>

        <Tabs.Content value="workflow" className="tab-content">
          <WorkflowTab
            workflows={props.workflows}
            activeSelection={props.activeSelection}
            runningMap={props.runningMap}
            eventsMap={props.eventsMap}
            onRun={props.onRunWorkflow}
          />
        </Tabs.Content>

        <Tabs.Content value="history" className="tab-content">
          <RunHistoryTab
            workflows={props.workflows}
            documentId={props.activeDocumentId}
            onJumpToRange={props.onJumpToRange}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
