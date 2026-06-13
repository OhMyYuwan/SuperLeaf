import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { errorMessage, recordCollabServerEvent } from './audit-log.js'
import {
  DOC_REPLACED_CLOSE_CODE,
  DOC_REPLACED_CLOSE_REASON,
  getActiveDocIds,
  getLoadedDocText,
  invalidateDoc,
  replaceDocText,
  setupWSConnection,
} from './ws-handler.js'
import { initPersistence, handleHttpRequest } from './persistence.js'

const PORT = parseInt(process.env.COLLAB_PORT ?? '4444', 10)
const HOST = process.env.COLLAB_HOST ?? '0.0.0.0'
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'
const WS_PATH_PREFIX = normalizePathPrefix(process.env.COLLAB_WS_PATH_PREFIX ?? '')
const COLLAB_TOKEN_PROTOCOL_PREFIX = 'superleaf-collab-token.'
const COLLAB_GENERATION_PROTOCOL_PREFIX = 'superleaf-collab-generation.'

const server = http.createServer((req, res) => {
  // HTTP API for FastAPI to read document text / push initial content.
  handleHttpRequest(req, res, {
    getActiveDocIds,
    getLoadedDocText,
    replaceDocText,
    invalidateDoc,
  })
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  // URL format: /<docId>
  // Optional gateway format: /<COLLAB_WS_PATH_PREFIX>/<docId>
  // Auth token is supplied via WebSocket subprotocol, not a URL query string.
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const docId = getDocIdFromPath(url.pathname)
  const protocols = parseCollabProtocols(req.headers['sec-websocket-protocol'])
  const { token, clientGeneration } = protocols

  if (!docId) {
    void recordCollabServerEvent('websocket_upgrade_rejected', {
      level: 'warning',
      operation: 'websocket_upgrade',
      code: 'invalid_doc_path',
      details: { path: url.pathname },
    })
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  // Verify auth token with the FastAPI backend.
  const session = await verifyToken(token, BACKEND_URL, docId)
  if (!session) {
    void recordCollabServerEvent('websocket_upgrade_rejected', {
      level: 'warning',
      docId,
      operation: 'websocket_upgrade',
      code: token ? 'auth_failed' : 'missing_auth_token',
    })
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (clientGeneration !== session.collabGeneration) {
      void recordCollabServerEvent('websocket_upgrade_rejected', {
        level: 'warning',
        docId,
        operation: 'websocket_upgrade',
        code: 'stale_collab_generation',
        details: {
          client_generation: clientGeneration,
          authoritative_generation: session.collabGeneration,
        },
      })
      ws.close(DOC_REPLACED_CLOSE_CODE, DOC_REPLACED_CLOSE_REASON)
      return
    }
    wss.emit('connection', ws, req, {
      docId,
      user: session.user,
      token: token!,
      clientGeneration,
      authoritativeGeneration: session.collabGeneration,
    })
  })
})

wss.on(
  'connection',
  (
    ws: WebSocket,
    _req: http.IncomingMessage,
    ctx: {
      docId: string
      user: AuthUser
      token: string
      clientGeneration: number | null
      authoritativeGeneration: number
    },
  ) => {
    setupWSConnection(ws, ctx.docId, ctx.user, ctx.token, {
      clientGeneration: ctx.clientGeneration,
      authoritativeGeneration: ctx.authoritativeGeneration,
    })
  },
)

async function verifyToken(
  token: string | null,
  backendUrl: string,
  docId: string,
): Promise<VerifiedCollabSession | null> {
  if (!token) return null
  try {
    const url = new URL('/api/auth/verify', backendUrl)
    url.searchParams.set('doc_id', docId)
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    if (!res.ok) {
      await recordCollabServerEvent('token_verify_failed', {
        level: 'warning',
        docId,
        operation: 'token_verify',
        code: 'token_verify_failed',
        details: { status: res.status },
      })
      return null
    }
    const data = (await res.json()) as {
      user_id: string
      display_name: string
      collab_generation?: number
    }
    const collabGeneration = data.collab_generation
    if (!Number.isSafeInteger(collabGeneration)) {
      await recordCollabServerEvent('token_verify_failed', {
        level: 'warning',
        docId,
        operation: 'token_verify',
        code: 'missing_collab_generation',
      })
      return null
    }
    return {
      user: { id: data.user_id, name: data.display_name },
      collabGeneration: collabGeneration as number,
    }
  } catch (err) {
    await recordCollabServerEvent('token_verify_exception', {
      level: 'error',
      docId,
      operation: 'token_verify',
      code: 'token_verify_exception',
      message: errorMessage(err),
    })
    return null
  }
}

function parseCollabProtocols(raw: string | string[] | undefined): {
  token: string | null
  clientGeneration: number | null
} {
  const header = Array.isArray(raw) ? raw.join(',') : raw
  let token: string | null = null
  let clientGeneration: number | null = null
  if (!header) return { token, clientGeneration }
  for (const item of header.split(',')) {
    const protocol = item.trim()
    if (protocol.startsWith(COLLAB_TOKEN_PROTOCOL_PREFIX)) {
      const parsedToken = protocol.slice(COLLAB_TOKEN_PROTOCOL_PREFIX.length).trim()
      token = parsedToken || null
    } else if (protocol.startsWith(COLLAB_GENERATION_PROTOCOL_PREFIX)) {
      const rawGeneration = protocol.slice(COLLAB_GENERATION_PROTOCOL_PREFIX.length).trim()
      const parsedGeneration = Number(rawGeneration)
      clientGeneration = Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null
    }
  }
  return { token, clientGeneration }
}

export interface AuthUser {
  id: string
  name: string
}

interface VerifiedCollabSession {
  user: AuthUser
  collabGeneration: number
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
