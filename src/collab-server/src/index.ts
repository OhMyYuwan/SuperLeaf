import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { setupWSConnection } from './ws-handler.js'
import { initPersistence, handleHttpRequest } from './persistence.js'

const PORT = parseInt(process.env.COLLAB_PORT ?? '4444', 10)
const HOST = process.env.COLLAB_HOST ?? '0.0.0.0'
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000'

const server = http.createServer((req, res) => {
  // HTTP API for FastAPI to read document text / push initial content.
  handleHttpRequest(req, res)
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  // URL format: /<docId>?token=<sessionToken>
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const docId = url.pathname.slice(1)
  const token = url.searchParams.get('token')

  if (!docId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  // Verify auth token with the FastAPI backend.
  const user = await verifyToken(token, BACKEND_URL)
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
): Promise<AuthUser | null> {
  if (!token) return null
  try {
    const res = await fetch(`${backendUrl}/api/auth/verify?token=${encodeURIComponent(token)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { user_id: string; display_name: string }
    return { id: data.user_id, name: data.display_name }
  } catch {
    return null
  }
}

export interface AuthUser {
  id: string
  name: string
}

initPersistence()

server.listen(PORT, HOST, () => {
  console.log(`[collab-server] listening on ${HOST}:${PORT}`)
  console.log(`[collab-server] backend: ${BACKEND_URL}`)
})
