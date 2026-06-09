import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

const DATA_DIR = process.env.COLLAB_DATA_DIR ?? path.join(os.homedir(), '.yuwanlab', 'collab-data')
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'
const INTERNAL_TOKEN = process.env.COLLAB_INTERNAL_TOKEN?.trim() ?? ''
const INTERNAL_TOKEN_HEADER = 'x-superleaf-internal-token'

let persistence: LeveldbPersistence

interface LeveldbPersistenceWithDocNames extends LeveldbPersistence {
  getAllDocNames: () => Promise<string[]>
}

export interface HttpIntegration {
  getActiveDocIds: () => string[]
  getLoadedDocText: (docId: string) => string | null
}

export function initPersistence() {
  persistence = new LeveldbPersistence(DATA_DIR)
  console.log(`[collab-server] persistence: ${DATA_DIR}`)
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
        }
      } else {
        console.warn(`[collab-server] seed fetch failed for ${docId}: ${res.status}`)
      }
    } catch (err) {
      console.warn(`[collab-server] failed to seed doc ${docId} from backend:`, err)
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
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    const docId = decodeURIComponent(textMatch[1])
    const loadedText = integration.getLoadedDocText(docId)
    if (loadedText !== null) {
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

  res.writeHead(404)
  res.end('Not Found')
}

async function getPersistedDocText(docId: string, res: http.ServerResponse): Promise<void> {
  try {
    const docNames = await (persistence as LeveldbPersistenceWithDocNames).getAllDocNames()
    if (!docNames.includes(docId)) {
      writeJson(res, 404, {
        code: 'collab_doc_not_initialized',
        doc_id: docId,
        initialized: false,
      })
      return
    }
    const doc = await persistence.getYDoc(docId)
    const text = doc.getText('content').toString()
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
