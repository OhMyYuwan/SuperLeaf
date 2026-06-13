/**
 * Small string / byte / time formatters shared across the TeamTab modules.
 */

export function compactEndpointLabel(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//u, '')
}

export function shortDiagnosticId(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 14) return raw
  return `${raw.slice(0, 7)}…${raw.slice(-5)}`
}

export function shortChecksum(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  if (raw.length <= 16) return raw
  return `${raw.slice(0, 12)}...${raw.slice(-8)}`
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

export function formatDiagnosticTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
