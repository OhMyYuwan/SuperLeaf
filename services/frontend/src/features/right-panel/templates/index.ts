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
  id: 'debate' | 'consensus' | 'skill-optimization'
  label: string
  description: string
  draft?: WorkflowDefinitionDraft
  /** If set, template is instantiated via backend API instead of local clone. */
  backendTemplateId?: string
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'skill-optimization',
    label: '📊 数据驱动 Skill 优化',
    description: '自动安装 3 个优化 Skill，创建信号分析 → Skill 改写 → 评估的 inline agent Workflow。',
    backendTemplateId: 'builtin-skill-optimization-v1',
  },
  {
    id: 'debate',
    label: 'Debate · 双评审 + 仲裁',
    description: '两个评审 Agent 并行给意见，一个仲裁 Agent 给最终结论。',
    draft: debate as WorkflowDefinitionDraft,
  },
  {
    id: 'consensus',
    label: 'Consensus · 多轮收敛',
    description: '写作者、Reviewer、导师在 Loop 内多轮协作，导师判断是否收敛。',
    draft: consensus as WorkflowDefinitionDraft,
  },
]

/** Return a fresh deep-cloned copy of the template so multiple imports stay
 *  independent. JSON round-trip is fine here since templates contain no
 *  Dates, functions, or cyclic refs.  Returns null for backend templates. */
export function cloneTemplate(id: WorkflowTemplate['id']): WorkflowDefinitionDraft | null {
  const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === id)
  if (!tpl || !tpl.draft) return null
  return JSON.parse(JSON.stringify(tpl.draft)) as WorkflowDefinitionDraft
}

/** Check if a template requires backend instantiation (installs Skills + creates Workflow). */
export function isBackendTemplate(id: string): boolean {
  const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === id)
  return !!tpl?.backendTemplateId
}

/** Get the backend template ID for API instantiation. */
export function getBackendTemplateId(id: string): string | null {
  const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === id)
  return tpl?.backendTemplateId ?? null
}
