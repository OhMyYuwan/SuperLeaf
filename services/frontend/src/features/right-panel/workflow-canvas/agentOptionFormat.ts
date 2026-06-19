import type { CachedWorkflow } from '../../../services/backendApi'
import { formatAgentDisplayName } from '../discussion/format'

export function formatWorkflowAgentOption(
  agent: Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'>,
  providerNamesById: ReadonlyMap<string, string>,
): string {
  return formatAgentDisplayName(agent, providerNamesById)
}
