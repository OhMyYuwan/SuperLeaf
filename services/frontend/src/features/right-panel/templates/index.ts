/**
 * Workflow Definition templates — ready-to-import presets.
 *
 * Each preset is a `WorkflowDefinitionDraft` with placeholder `__PICK_AGENT__`
 * ids for agent nodes. The user is expected to open the canvas editor after
 * import and swap in real Agent selections. The orchestrator already surfaces
 * unconfigured nodes via the degraded-workflow banner so there is no risk
 * of silently running a broken template.
 */

import type { WorkflowDefinitionDraft } from '../../../services/backendApi'
import debate from './debate.json'
import consensus from './consensus.json'

export interface WorkflowTemplate {
  id: 'debate' | 'consensus'
  label: string
  description: string
  draft: WorkflowDefinitionDraft
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'debate',
    label: 'Debate · 双评审 + 仲裁',
    description: '两个评审 Agent 并行给意见，一个仲裁 Agent 给最终结论。',
    draft: debate as WorkflowDefinitionDraft,
  },
  {
    id: 'consensus',
    label: 'Consensus · 多轮收敛',
    description: '两个 Agent 在 Loop 容器内并行评议，仲裁 Agent 判断是否收敛。',
    draft: consensus as WorkflowDefinitionDraft,
  },
]

/** Return a fresh deep-cloned copy of the template so multiple imports stay
 *  independent. JSON round-trip is fine here since templates contain no
 *  Dates, functions, or cyclic refs. */
export function cloneTemplate(id: WorkflowTemplate['id']): WorkflowDefinitionDraft | null {
  const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === id)
  if (!tpl) return null
  return JSON.parse(JSON.stringify(tpl.draft)) as WorkflowDefinitionDraft
}
