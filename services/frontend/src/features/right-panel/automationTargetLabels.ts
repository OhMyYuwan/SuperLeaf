import type { CachedWorkflow, NativeAgent, WorkflowDefinition } from '../../services/backendApi'
import { formatAgentDisplayName } from './discussion/format'

export function formatAutomationTargetName(
  targetKind: 'agent' | 'workflow',
  target: Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'> | Pick<WorkflowDefinition, 'name'>,
  providerNamesById: ReadonlyMap<string, string>,
): string {
  if (targetKind === 'agent' && 'id' in target && 'provider_id' in target) {
    return formatAgentDisplayName(target, providerNamesById)
  }
  return target.name
}

export function formatNativeAgentDisplayName(
  agent: Pick<NativeAgent, 'id' | 'provider_id' | 'name'>,
  credentialNamesById: ReadonlyMap<string, string>,
): string {
  return formatAgentDisplayName(agent, credentialNamesById)
}
