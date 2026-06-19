import {
  nativeAgentApi,
  type LocalAgentHostPackageInfo,
} from './backendApi'
import {
  normalizeLocalAgentHostEndpoint,
  readLocalAgentHostAuthToken,
  storeLocalAgentHostAuthToken,
} from './browserToolBridge'

let bootstrapPromise: Promise<boolean> | null = null
let lastBootstrapAt = 0

function localAgentHostAutoAuthEnabled(): boolean {
  return import.meta.env.VITE_LOCAL_AGENT_HOST_AUTO_AUTH === '1'
}

export function bootstrapLocalAgentHostAuthFromPackageInfo(info: LocalAgentHostPackageInfo | null | undefined): boolean {
  if (!info) return false
  const endpoint = normalizeLocalAgentHostEndpoint(info.endpoint || 'http://127.0.0.1:8787')
  const token = String(info.local_auth_token || '').trim()
  if (!token) return Boolean(readLocalAgentHostAuthToken(endpoint))
  storeLocalAgentHostAuthToken(endpoint, token)
  return true
}

export async function bootstrapLocalAgentHostAuth(): Promise<boolean> {
  if (!localAgentHostAutoAuthEnabled()) return false
  if (bootstrapPromise) return bootstrapPromise
  if (Date.now() - lastBootstrapAt < 10_000) {
    return Boolean(readLocalAgentHostAuthToken('http://127.0.0.1:8787'))
  }
  bootstrapPromise = nativeAgentApi.localAgentHost.info()
    .then((info) => bootstrapLocalAgentHostAuthFromPackageInfo(info))
    .catch(() => false)
    .finally(() => {
      lastBootstrapAt = Date.now()
      bootstrapPromise = null
    })
  return bootstrapPromise
}
