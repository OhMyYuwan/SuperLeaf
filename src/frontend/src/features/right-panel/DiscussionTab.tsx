/**
 * DiscussionTab — standalone chat-like mock for the 讨论区 tab.
 *
 * Holds its own local state since nothing else in the app cares yet. When we
 * wire this to a real Dify conversation (W7), lift state to a store and keep
 * this component as a pure renderer.
 */

import { useState } from 'react'

interface Message {
  id: number
  author: string
  content: string
}

const initialMessages: Message[] = [
  { id: 1, author: 'System', content: 'Workflow 已加载，等待用户选择文档块。' },
  { id: 2, author: 'Reviewer', content: '当前章节逻辑完整，但需要更清晰的分层。' },
]

export function DiscussionTab() {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [newMessage, setNewMessage] = useState('')

  const send = () => {
    const text = newMessage.trim()
    if (!text) return
    setMessages((prev) => [...prev, { id: Date.now(), author: 'You', content: text }])
    setNewMessage('')
  }

  return (
    <>
      <div className="chat-list">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-item ${msg.author === 'You' ? 'me' : ''}`}>
            <div className="chat-author">{msg.author}</div>
            <div className="chat-text">{msg.content}</div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="输入消息，发送给 Agent team"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button onClick={send}>发送</button>
      </div>
    </>
  )
}
