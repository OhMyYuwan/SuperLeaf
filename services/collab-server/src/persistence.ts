import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { errorMessage, recordCollabServerEvent } from './audit-log.js'

const DATA_DIR = process.env.COLLAB_DATA_DIR ?? path.join(os.homedir(), '.yuwanlab', 'collab-data')
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'
const HISTORICAL_DEFAULT_INTERNAL_TOKEN = 'superleaf-local-collab-internal-token'
const RAW_INTERNAL_TOKEN = process.env.COLLAB_INTERNAL_TOKEN?.trim() ?? ''
const INTERNAL_TOKEN = RAW_INTERNAL_TOKEN === HISTORICAL_DEFAULT_INTERNAL_TOKEN ? '' : RAW_INTERNAL_TOKEN
const INTERNAL_TOKEN_HEADER = 'x-superleaf-internal-token'

if (RAW_INTERNAL_TOKEN === HISTORICAL_DEFAULT_INTERNAL_TOKEN) {
  console.warn('[collab-server] refusing historical default COLLAB_INTERNAL_TOKEN; document text HTTP API is disabled')
}

let persistence: LeveldbPersistence

interface LeveldbPersistenceWithDocNames extends LeveldbPersistence {
  getAllDocNames: () => Promise<string[]>
}

export interface HttpIntegration {
  getActiveDocIds: () => string[]
  getLoadedDocText: (docId: string) => string | null
  replaceDocText: (
    docId: string,
    text: string,
    collabGeneration?: number,
  ) => Promise<{ active: boolean; length: number; connectionsClosed?: number }>
  invalidateDoc: (docId: string) => Promise<{
    active: boolean
    connectionsClosed?: number
    cleared?: boolean
  }>
}

const MAX_INTERNAL_TEXT_BODY_BYTES = 20 * 1024 * 1024

export function initPersistence() {
  persistence = new LeveldbPersistence(DATA_DIR)
  console.log(`[collab-server] persistence: ${DATA_DIR}`)
  void recordCollabServerEvent('persistence_initialized', {
    operation: 'persistence_init',
    details: { data_dir: DATA_DIR },
  })
}

export function getPersistence(): LeveldbPersistence {
  return persistence
}

/**
 * Load a Y.Doc from LevelDB. If not found, fetch initial content from
 * the FastAPI backend and seed the doc.
 */
export async function loadOrCreateDoc(docId: string, token?: string): Promise<Y.Doc> {
  const doc = await persistence.getYDoc(docId)
  const text = doc.getText('content')

  // If the doc is empty (first time), seed from backend.
  if (text.length === 0) {
    try {
      const headers: Record<string, string> = {}
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
      const res = await fetch(`${BACKEND_URL}/api/internal/docs/${encodeURIComponent(docId)}/content`, { headers })
      if (res.ok) {
        const data = (await res.json()) as { content?: string }
        if (data.content) {
          text.insert(0, data.content)
          await persistence.storeUpdate(docId, Y.encodeStateAsUpdate(doc))
          console.log(`[collab-server] seeded doc ${docId} (${data.content.length} chars)`)
          void recordCollabServerEvent('doc_seed_succeeded', {
            docId,
            operation: 'doc_seed',
            details: { length: data.content.length },
          })
        } else {
          void recordCollabServerEvent('doc_seed_empty_backend_content', {
            docId,
            operation: 'doc_seed',
            details: { status: res.status },
          })
        }
      } else {
        console.warn(`[collab-server] seed fetch failed for ${docId}: ${res.status}`)
        void recordCollabServerEvent('doc_seed_fetch_failed', {
          level: 'warning',
          docId,
          operation: 'doc_seed',
          code: 'backend_seed_fetch_failed',
          details: { status: res.status },
        })
      }
    } catch (err) {
      console.warn(`[collab-server] failed to seed doc ${docId} from backend:`, err)
      void recordCollabServerEvent('doc_seed_fetch_exception', {
        level: 'error',
        docId,
        operation: 'doc_seed',
        code: 'backend_seed_fetch_exception',
        message: errorMessage(err),
      })
    }
  }

  return doc
}

/**
 * Persist a Y.Doc update to LevelDB.
 */
export async function storeUpdate(docId: string, update: Uint8Array): Promise<void> {
  await persistence.storeUpdate(docId, update)
}

/**
 * HTTP API handler for FastAPI integration.
 *
 * Routes:
 *   GET  /docs/:docId/text   — returns current plain text of the document
 *   GET  /health             — health check
 */
export function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  integration: HttpIntegration,
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/docs/active') {
    if (!isAuthorizedInternalRequest(req)) {
      void recordCollabServerEvent('internal_request_unauthorized', {
        level: 'warning',
        operation: 'internal_http',
        code: 'internal_request_unauthorized',
        details: { method: req.method, path: url.pathname },
      })
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    const docIds = integration.getActiveDocIds()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ doc_ids: docIds, count: docIds.length }))
    return
  }

  const textMatch = url.pathname.match(/^\/docs\/([^/]+)\/text$/)
  if (req.method === 'GET' && textMatch) {
    if (!isAuthorizedInternalRequest(req)) {
      void recordCollabServerEvent('internal_request_unauthorized', {
        level: 'warning',
        docId: decodeURIComponent(textMatch[1]),
        operation: 'internal_http',
        code: 'internal_request_unauthorized',
        details: { method: req.method, path: url.pathname },
      })
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    const docId = decodeURIComponent(textMatch[1])
    const loadedText = integration.getLoadedDocText(docId)
    if (loadedText !== null) {
      void recordCollabServerEvent('doc_text_returned', {
        docId,
        operation: 'doc_text',
        details: { source: 'loaded', length: loadedText.length },
      })
      writeJson(res, 200, {
        doc_id: docId,
        text: loadedText,
        length: loadedText.length,
        initialized: true,
        source: 'loaded',
      })
      return
    }
    void getPersistedDocText(docId, res)
    return
  }

  if (req.method === 'PUT' && textMatch) {
    const docId = decodeURIComponent(textMatch[1])
    if (!isAuthorizedInternalRequest(req)) {
      void recordCollabServerEvent('internal_request_unauthorized', {
        level: 'warning',
        docId,
        operation: 'internal_http',
        code: 'internal_request_unauthorized',
        details: { method: req.method, path: url.pathname },
      })
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    void handleReplaceDocText(req, res, integration, docId)
    return
  }

  const invalidateMatch = url.pathname.match(/^\/docs\/([^/]+)\/invalidate$/)
  if (req.method === 'POST' && invalidateMatch) {
    const docId = decodeURIComponent(invalidateMatch[1])
    if (!isAuthorizedInternalRequest(req)) {
      void recordCollabServerEvent('internal_request_unauthorized', {
        level: 'warning',
        docId,
        operation: 'internal_http',
        code: 'internal_request_unauthorized',
        details: { method: req.method, path: url.pathname },
      })
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    void handleInvalidateDoc(req, res, integration, docId)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
}

async function handleReplaceDocText(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  integration: HttpIntegration,
  docId: string,
): Promise<void> {
  try {
    const payload = await readJsonBody(req)
    if (!isReplaceTextPayload(payload)) {
      void recordCollabServerEvent('doc_text_replace_bad_request', {
        level: 'warning',
        docId,
        operation: 'doc_replace',
        code: 'bad_request',
      })
      writeJson(res, 400, { code: 'bad_request', message: 'text must be a string' })
      return
    }

    const result = await integration.replaceDocText(
      docId,
      payload.text,
      payload.collab_generation,
    )
    void recordCollabServerEvent('doc_text_replace_succeeded', {
      docId,
      operation: 'doc_replace',
      details: {
        active: result.active,
        length: result.length,
        collab_generation: payload.collab_generation,
        connections_closed: result.connectionsClosed ?? 0,
      },
    })
    writeJson(res, 200, {
      ok: true,
      doc_id: docId,
      length: result.length,
      active: result.active,
      connections_closed: result.connectionsClosed ?? 0,
    })
  } catch (err) {
    console.error(`[collab-server] replaceDocText error for ${docId}:`, err)
    void recordCollabServerEvent('doc_text_replace_failed', {
      level: 'error',
      docId,
      operation: 'doc_replace',
      code: 'doc_text_replace_failed',
      message: errorMessage(err),
    })
    res.writeHead(500)
    res.end('Internal Server Error')
  }
}

async function handleInvalidateDoc(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  integration: HttpIntegration,
  docId: string,
): Promise<void> {
  try {
    const result = await integration.invalidateDoc(docId)
    void recordCollabServerEvent('doc_invalidate_succeeded', {
      docId,
      operation: 'doc_invalidate',
      details: {
        active: result.active,
        connections_closed: result.connectionsClosed ?? 0,
        cleared: result.cleared ?? false,
      },
    })
    writeJson(res, 200, {
      ok: true,
      doc_id: docId,
      active: result.active,
      connections_closed: result.connectionsClosed ?? 0,
      cleared: result.cleared ?? false,
    })
  } catch (err) {
    console.error(`[collab-server] invalidateDoc error for ${docId}:`, err)
    void recordCollabServerEvent('doc_invalidate_failed', {
      level: 'error',
      docId,
      operation: 'doc_invalidate',
      code: 'doc_invalidate_failed',
      message: errorMessage(err),
    })
    res.writeHead(500)
    res.end('Internal Server Error')
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > MAX_INTERNAL_TEXT_BODY_BYTES) {
      throw new Error('request body too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw || '{}') as unknown
}

function isReplaceTextPayload(
  payload: unknown,
): payload is { text: string; collab_generation?: number } {
  return typeof payload === 'object'
    && payload !== null
    && typeof (payload as { text?: unknown }).text === 'string'
    && (
      (payload as { collab_generation?: unknown }).collab_generation === undefined
      || Number.isSafeInteger((payload as { collab_generation?: unknown }).collab_generation)
    )
}

async function getPersistedDocText(docId: string, res: http.ServerResponse): Promise<void> {
  try {
    const docNames = await (persistence as LeveldbPersistenceWithDocNames).getAllDocNames()
    if (!docNames.includes(docId)) {
      void recordCollabServerEvent('collab_doc_not_initialized', {
        level: 'warning',
        docId,
        operation: 'doc_text',
        code: 'collab_doc_not_initialized',
      })
      writeJson(res, 404, {
        code: 'collab_doc_not_initialized',
        doc_id: docId,
        initialized: false,
      })
      return
    }
    const doc = await persistence.getYDoc(docId)
    const text = doc.getText('content').toString()
    void recordCollabServerEvent('doc_text_returned', {
      docId,
      operation: 'doc_text',
      details: { source: 'persisted', length: text.length },
    })
    writeJson(res, 200, {
      doc_id: docId,
      text,
      length: text.length,
      initialized: true,
      source: 'persisted',
    })
    doc.destroy()
  } catch (err) {
    console.error(`[collab-server] getDocText error for ${docId}:`, err)
    void recordCollabServerEvent('doc_text_read_failed', {
      level: 'error',
      docId,
      operation: 'doc_text',
      code: 'doc_text_read_failed',
      message: errorMessage(err),
    })
    res.writeHead(500)
    res.end('Internal Server Error')
  }
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: object): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function isAuthorizedInternalRequest(req: http.IncomingMessage): boolean {
  if (!INTERNAL_TOKEN) {
    return false
  }
  const supplied = req.headers[INTERNAL_TOKEN_HEADER]
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied
  if (!candidate) {
    return false
  }
  return safeEqual(candidate, INTERNAL_TOKEN)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return false
  }
  return timingSafeEqual(left, right)
}
