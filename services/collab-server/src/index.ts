import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { recordCollabServerEvent } from './audit-log.js'
import {
  DOC_REPLACED_CLOSE_CODE,
  DOC_REPLACED_CLOSE_REASON,
  COLLAB_WS_MAX_MESSAGE_BYTES,
  getActiveDocIds,
  getLoadedDocText,
  invalidateDoc,
  replaceDocText,
  setupWSConnection,
} from './ws-handler.js'
import { initPersistence, handleHttpRequest } from './persistence.js'
import {
  COLLAB_MAX_PENDING_UPGRADES,
  createUpgradeAuthLimiter,
  verifyToken,
  type AuthUser,
  type VerifiedCollabSession,
} from './upgrade-auth.js'

const PORT = parseInt(process.env.COLLAB_PORT ?? '4444', 10)
const HOST = process.env.COLLAB_HOST ?? '0.0.0.0'
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'
const WS_PATH_PREFIX = normalizePathPrefix(process.env.COLLAB_WS_PATH_PREFIX ?? '')
const COLLAB_TOKEN_PROTOCOL_PREFIX = 'superleaf-collab-token.'
const COLLAB_GENERATION_PROTOCOL_PREFIX = 'superleaf-collab-generation.'
const upgradeAuthLimiter = createUpgradeAuthLimiter()

const server = http.createServer((req, res) => {
  // HTTP API for FastAPI to read document text / push initial content.
  handleHttpRequest(req, res, {
    getActiveDocIds,
    getLoadedDocText,
    replaceDocText,
    invalidateDoc,
  })
})

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: COLLAB_WS_MAX_MESSAGE_BYTES,
})

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

  if (!token) {
    void recordCollabServerEvent('websocket_upgrade_rejected', {
      level: 'warning',
      docId,
      operation: 'websocket_upgrade',
      code: 'missing_auth_token',
    })
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  const releaseAuthSlot = upgradeAuthLimiter.tryAcquire()
  if (!releaseAuthSlot) {
    void recordCollabServerEvent('websocket_upgrade_rejected', {
      level: 'warning',
      docId,
      operation: 'websocket_upgrade',
      code: 'auth_budget_exhausted',
      details: {
        pending_upgrades: upgradeAuthLimiter.pendingCount,
        max_pending_upgrades: COLLAB_MAX_PENDING_UPGRADES,
      },
    })
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }

  let session: VerifiedCollabSession | null = null
  try {
    // Verify auth token with the FastAPI backend.
    session = await verifyToken(token, BACKEND_URL, docId)
  } finally {
    releaseAuthSlot()
  }
  if (!session) {
    void recordCollabServerEvent('websocket_upgrade_rejected', {
      level: 'warning',
      docId,
      operation: 'websocket_upgrade',
      code: 'auth_failed',
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
      token,
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
      authorizeMessage: async () => {
        const session = await verifyToken(ctx.token, BACKEND_URL, ctx.docId)
        return Boolean(
          session
          && session.user.id === ctx.user.id
          && session.collabGeneration === ctx.authoritativeGeneration
        )
      },
    })
  },
)

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
