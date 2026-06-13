/**
 * Generic record / provider-meta readers shared across the TeamTab modules.
 *
 * Provider `meta` is an untyped `Record<string, unknown>` coming from the
 * backend, so these helpers do the defensive narrowing in one place.
 */

export function stringMeta(meta: Record<string, unknown>, key: string): string {
  const value = meta[key]
  return typeof value === 'string' ? value : ''
}

export function objectMeta(meta: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = meta[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function stringRecordValue(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

export function numberRecordValue(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function booleanRecordValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

export function enumMeta(meta: Record<string, unknown>, key: string, allowed: string[], fallback: string): string {
  const value = stringMeta(meta, key)
  return allowed.includes(value) ? value : fallback
}

export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string') return splitArgs(value)
  return []
}

export function splitArgs(value: string): string[] {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean)
}

export function joinArgs(value: string[] | undefined): string {
  return (value ?? []).join(' ')
}
