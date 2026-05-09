/**
 * conversationStore — chat-style discussions per (document, agent).
 *
 * Each conversation is scoped to one document + one agent (workflow). The store
 * tracks active conversations, messages, and streaming state. SSE streaming is
 * handled here so the UI can just render the state.
 */

import { create } from 'zustand'
import {
  conversationApi,
  type Conversation,
  type ConversationCreate,
  type Message,
  type MessageSend,
} from '../services/backendApi'

interface ConversationState {
  conversations: Record<string, Conversation>
  messages: Record<string, Message[]>
  loading: boolean
  error: string | null

  // Streaming state: which conversation is currently receiving a message.
  streaming: Record<string, boolean>
  streamingDelta: Record<string, string>

  loadConversations: (filter?: { documentId?: string; workflowId?: string }) => Promise<void>
  createConversation: (body: ConversationCreate) => Promise<Conversation | null>
  deleteConversation: (id: string) => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  sendMessage: (conversationId: string, body: MessageSend) => Promise<void>
  clearStreamingDelta: (conversationId: string) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: {},
  messages: {},
  loading: false,
  error: null,
  streaming: {},
  streamingDelta: {},

  loadConversations: async (filter) => {
    set({ loading: true, error: null })
    try {
      const list = await conversationApi.list(
        filter
          ? {
              document_id: filter.documentId,
              workflow_id: filter.workflowId,
            }
          : undefined,
      )
      const conversations = Object.fromEntries(list.map((c) => [c.id, c]))
      set({ conversations, loading: false })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  createConversation: async (body) => {
    try {
      const created = await conversationApi.create(body)
      set((s) => ({
        conversations: { ...s.conversations, [created.id]: created },
        messages: { ...s.messages, [created.id]: [] },
      }))
      return created
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  deleteConversation: async (id) => {
    try {
      await conversationApi.delete(id)
      set((s) => {
        const { [id]: _, ...rest } = s.conversations
        const { [id]: __, ...restMsgs } = s.messages
        return { conversations: rest, messages: restMsgs }
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  loadMessages: async (conversationId) => {
    try {
      const msgs = await conversationApi.listMessages(conversationId)
      set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }))
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  sendMessage: async (conversationId, body) => {
    set((s) => ({
      streaming: { ...s.streaming, [conversationId]: true },
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
      error: null,
    }))

    try {
      const resp = await fetch(conversationApi.sendMessageUrl(conversationId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => resp.statusText)
        throw new Error(`Backend ${resp.status}: ${text?.slice(0, 300) || resp.statusText}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        let boundary = findEventBoundary(buf)
        while (boundary !== null) {
          const chunk = buf.slice(0, boundary.start)
          buf = buf.slice(boundary.end)
          const parsed = parseSseMessage(chunk)
          if (parsed) {
            handleMessageEvent(set, conversationId, parsed)
          }
          boundary = findEventBoundary(buf)
        }
      }
    } catch (e) {
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
        error: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
      }))
    }
  },

  clearStreamingDelta: (conversationId) => {
    set((s) => ({ streamingDelta: { ...s.streamingDelta, [conversationId]: '' } }))
  },
}))

function findEventBoundary(buf: string): { start: number; end: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { start: crlf, end: crlf + 4 }
  }
  if (lf !== -1) {
    return { start: lf, end: lf + 2 }
  }
  return null
}

function parseSseMessage(chunk: string): { event: string; data: unknown } | null {
  let eventName = 'message'
  const dataLines: string[] = []
  const normalized = chunk.replace(/\r\n/g, '\n')
  for (const line of normalized.split('\n')) {
    if (!line) continue
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { event: eventName, data }
}

function handleMessageEvent(
  set: (fn: (s: ConversationState) => Partial<ConversationState>) => void,
  conversationId: string,
  evt: { event: string; data: unknown },
) {
  if (evt.event === 'ylw.msg.user') {
    const msg = evt.data as Message
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), msg],
      },
    }))
  } else if (evt.event === 'ylw.msg.delta') {
    const { delta } = evt.data as { delta: string }
    set((s) => ({
      streamingDelta: {
        ...s.streamingDelta,
        [conversationId]: (s.streamingDelta[conversationId] ?? '') + delta,
      },
    }))
  } else if (evt.event === 'ylw.msg.finished') {
    const msg = evt.data as Message
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), msg],
      },
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
    }))
  } else if (evt.event === 'ylw.msg.failed') {
    const { error } = evt.data as { error: string }
    set((s) => ({
      error,
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
    }))
  }
}
