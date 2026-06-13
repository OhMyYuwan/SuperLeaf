import { appendFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type CollabLogLevel = 'info' | 'warning' | 'error' | 'critical'

const DATA_DIR = process.env.COLLAB_DATA_DIR ?? path.join(os.homedir(), '.yuwanlab', 'collab-data')
const DEFAULT_LOG_DIR = process.env.COLLAB_LOG_DIR ?? path.join(path.dirname(DATA_DIR), 'logs')
const ERROR_LEVELS = new Set<CollabLogLevel>(['warning', 'error', 'critical'])

export interface CollabServerEventFields {
  level?: CollabLogLevel
  docId?: string
  userId?: string
  operation?: string
  code?: string
  message?: string
  details?: Record<string, unknown>
}

export interface CollabServerLogOptions {
  logDir?: string
}

export async function recordCollabServerEvent(
  event: string,
  fields: CollabServerEventFields = {},
  options: CollabServerLogOptions = {},
): Promise<void> {
  const level = fields.level ?? 'info'
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  }

  setIfPresent(payload, 'doc_id', fields.docId)
  setIfPresent(payload, 'user_id', fields.userId)
  setIfPresent(payload, 'operation', fields.operation)
  setIfPresent(payload, 'code', fields.code)
  setIfPresent(payload, 'message', fields.message)
  if (fields.details && Object.keys(fields.details).length > 0) {
    payload.details = fields.details
  }

  const logDir = options.logDir ?? DEFAULT_LOG_DIR
  const line = `${JSON.stringify(payload)}\n`
  try {
    await mkdir(logDir, { recursive: true })
    await appendFile(path.join(logDir, 'collaboration-server.log'), line, 'utf8')
    if (ERROR_LEVELS.has(level)) {
      await appendFile(path.join(logDir, 'collaboration-server-errors.log'), line, 'utf8')
    }
  } catch (err) {
    console.error('[collab-server] failed to write collaboration audit log:', err)
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function setIfPresent(payload: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value) {
    payload[key] = value
  }
}
