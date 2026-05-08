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
import './right-panel.css'

interface RightPanelProps {
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  workflowError: string | null
  activeProvider: Provider | null
  activeSelection: Selection | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  onRunWorkflow: (workflowId: string, instruction: string) => void
  onReloadWorkflows: () => void
}

export function RightPanel(props: RightPanelProps) {
  const [selectedTab, setSelectedTab] = useState('discussion')
  return (
    <div className="panel right-panel">
      <Tabs.Root value={selectedTab} onValueChange={setSelectedTab} className="tabs-root">
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
        </Tabs.List>

        <Tabs.Content value="discussion" className="tab-content">
          <DiscussionTab />
        </Tabs.Content>

        <Tabs.Content value="agents" className="tab-content">
          <TeamTab
            workflows={props.workflows}
            workflowsLoaded={props.workflowsLoaded}
            workflowError={props.workflowError}
            activeProvider={props.activeProvider}
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
      </Tabs.Root>
    </div>
  )
}
