import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { getActiveDocIds, setupWSConnection } from './ws-handler.js'
import { initPersistence, handleHttpRequest } from './persistence.js'

const PORT = parseInt(process.env.COLLAB_PORT ?? '4444', 10)
const HOST = process.env.COLLAB_HOST ?? '0.0.0.0'
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'
const WS_PATH_PREFIX = normalizePathPrefix(process.env.COLLAB_WS_PATH_PREFIX ?? '')
const COLLAB_TOKEN_PROTOCOL_PREFIX = 'superleaf-collab-token.'

const server = http.createServer((req, res) => {
  // HTTP API for FastAPI to read document text / push initial content.
  handleHttpRequest(req, res, { getActiveDocIds })
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  // URL format: /<docId>
  // Optional gateway format: /<COLLAB_WS_PATH_PREFIX>/<docId>
  // Auth token is supplied via WebSocket subprotocol, not a URL query string.
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const docId = getDocIdFromPath(url.pathname)
  const token = getTokenFromProtocols(req.headers['sec-websocket-protocol'])

  if (!docId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  // Verify auth token with the FastAPI backend.
  const user = await verifyToken(token, BACKEND_URL, docId)
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { docId, user, token: token! })
  })
})

wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, ctx: { docId: string; user: AuthUser; token: string }) => {
  setupWSConnection(ws, ctx.docId, ctx.user, ctx.token)
})

async function verifyToken(
  token: string | null,
  backendUrl: string,
  docId: string,
): Promise<AuthUser | null> {
  if (!token) return null
  try {
    const url = new URL('/api/auth/verify', backendUrl)
    url.searchParams.set('doc_id', docId)
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { user_id: string; display_name: string }
    return { id: data.user_id, name: data.display_name }
  } catch {
    return null
  }
}

function getTokenFromProtocols(raw: string | string[] | undefined): string | null {
  const header = Array.isArray(raw) ? raw.join(',') : raw
  if (!header) return null
  for (const item of header.split(',')) {
    const protocol = item.trim()
    if (protocol.startsWith(COLLAB_TOKEN_PROTOCOL_PREFIX)) {
      const token = protocol.slice(COLLAB_TOKEN_PROTOCOL_PREFIX.length).trim()
      return token || null
    }
  }
  return null
}

export interface AuthUser {
  id: string
  name: string
}

initPersistence()

server.listen(PORT, HOST, () => {
  console.log(`[collab-server] listening on ${HOST}:${PORT}`)
  console.log(`[collab-server] backend: ${BACKEND_URL}`)
  if (!process.env.COLLAB_INTERNAL_TOKEN?.trim()) {
    console.warn('[collab-server] COLLAB_INTERNAL_TOKEN is not set; document text HTTP API is disabled')
  }
  if (WS_PATH_PREFIX) {
    console.log(`[collab-server] websocket path prefix: ${WS_PATH_PREFIX}`)
  }
})

function normalizePathPrefix(raw: string): string {
  const value = raw.trim()
  if (!value || value === '/') return ''
  return `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

function getDocIdFromPath(pathname: string): string | null {
  let docPath = pathname
  if (WS_PATH_PREFIX) {
    if (pathname === WS_PATH_PREFIX || !pathname.startsWith(`${WS_PATH_PREFIX}/`)) {
      return null
    }
    docPath = pathname.slice(WS_PATH_PREFIX.length)
  }

  const encodedDocId = docPath.replace(/^\/+/, '')
  if (!encodedDocId) return null
  try {
    return decodeURIComponent(encodedDocId)
  } catch {
    return null
  }
}
