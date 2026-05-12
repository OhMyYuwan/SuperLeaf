import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

const DATA_DIR = process.env.COLLAB_DATA_DIR ?? path.join(os.homedir(), '.yuwanlab', 'collab-data')
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'

let persistence: LeveldbPersistence

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
        headers['Cookie'] = `ylw_session=${token}`
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
export function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  const textMatch = url.pathname.match(/^\/docs\/([^/]+)\/text$/)
  if (req.method === 'GET' && textMatch) {
    const docId = decodeURIComponent(textMatch[1])
    void getDocText(docId, res)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
}

async function getDocText(docId: string, res: http.ServerResponse): Promise<void> {
  try {
    const doc = await persistence.getYDoc(docId)
    const text = doc.getText('content').toString()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ doc_id: docId, text, length: text.length }))
    doc.destroy()
  } catch (err) {
    console.error(`[collab-server] getDocText error for ${docId}:`, err)
    res.writeHead(500)
    res.end('Internal Server Error')
  }
}
