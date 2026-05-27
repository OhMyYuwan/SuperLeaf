export interface SuperLeafRuntimeConfig {
  backendUrl?: string
  collabWsUrl?: string
}

declare global {
  interface Window {
    __SUPERLEAF_CONFIG__?: SuperLeafRuntimeConfig
  }
}

export function getRuntimeConfigValue(key: keyof SuperLeafRuntimeConfig): string | undefined {
  if (typeof window === 'undefined') return undefined
  const config = window.__SUPERLEAF_CONFIG__
  if (!config || !Object.prototype.hasOwnProperty.call(config, key)) return undefined
  return config[key] ?? ''
}

export function normalizeHttpBase(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  return value.replace(/\/+$/, '')
}

export function resolveWebSocketBase(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (!value) return ''
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`
  if (value.startsWith('/') && typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}${value}`
  }
  return value
}
