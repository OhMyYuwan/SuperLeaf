/**
 * Misc presentational helpers shared by agent cards and forms.
 */

import type { Provider, ProviderModel } from '../../../services/backendApi'

export function agentColor(kind: string): string {
  if (kind === 'claude-local') return '#8b5cf6'
  if (kind === 'codex-local') return '#111827'
  if (kind === 'native') return '#059669'
  if (kind === 'nanobot') return '#0ea5e9'
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}

export function providerConsoleLabel(kind: Provider['kind']): string {
  if (kind === 'claude-direct') return 'Claude 控制台'
  if (kind === 'claude-local') return '本机 Claude'
  if (kind === 'nanobot') return 'Nanobot 服务'
  if (kind === 'codex-local') return '本机 Codex'
  if (kind === 'native') return '原生 Agent Provider'
  return 'Dify 控制台'
}

export function localAgentName(kind: Provider['kind']): string {
  if (kind === 'claude-local') return 'Claude Local'
  if (kind === 'codex-local') return 'Codex Local'
  return 'Local Agent'
}

export function codexModelOptionLabel(model: ProviderModel): string {
  const label = model.name || model.model || model.id
  return model.is_default || model.raw?.isDefault === true || model.raw?.is_default === true ? `${label}（默认）` : label
}

export function realCodexModelOptions(models: ProviderModel[]): ProviderModel[] {
  return models.filter((model) => model.id !== 'codex' && model.model !== 'codex')
}

export function modelsFromProviderMeta(meta: Record<string, unknown>): ProviderModel[] {
  const models = meta.models
  if (Array.isArray(models)) {
    return models
      .map((item): ProviderModel | null => {
        if (typeof item === 'string') {
          return { id: item, name: item, description: '' }
        }
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = String(record.id ?? record.name ?? '').trim()
        if (!id) return null
        return {
          id,
          name: String(record.name ?? record.model ?? id),
          description: String(record.description ?? ''),
          model: typeof record.model === 'string' ? record.model : undefined,
          hidden: Boolean(record.hidden),
          is_default: Boolean(record.is_default),
          default_reasoning_effort: typeof record.default_reasoning_effort === 'string'
            ? record.default_reasoning_effort
            : undefined,
          supported_reasoning_efforts: Array.isArray(record.supported_reasoning_efforts)
            ? record.supported_reasoning_efforts.map((value) => String(value).trim()).filter(Boolean)
            : undefined,
          service_tiers: Array.isArray(record.service_tiers)
            ? record.service_tiers as ProviderModel['service_tiers']
            : undefined,
          default_service_tier: typeof record.default_service_tier === 'string'
            ? record.default_service_tier
            : undefined,
          raw: record.raw && typeof record.raw === 'object'
            ? record.raw as Record<string, unknown>
            : undefined,
        }
      })
      .filter((item): item is ProviderModel => item !== null)
  }
  const ids = meta.model_ids
  if (!Array.isArray(ids)) return []
  return ids
    .map((id) => String(id).trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id, description: '' }))
}
