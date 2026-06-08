import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsInstances = vi.hoisted(() => [] as FakeWebsocketProvider[])

class FakeAwareness {
  setLocalStateField = vi.fn()
  getStates = () => new Map()
}

class FakeWebsocketProvider {
  awareness = new FakeAwareness()
  protocols: string[]
  synced = false
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(_url: string, _room: string, _doc: unknown, opts: { protocols?: string[] }) {
    this.protocols = opts.protocols ?? []
    wsInstances.push(this)
  }

  on(event: string, fn: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(fn)
    this.listeners.set(event, listeners)
  }

  emitStatus(status: string): void {
    for (const fn of this.listeners.get('status') ?? []) {
      fn({ status })
    }
  }

  emitSync(synced: boolean): void {
    this.synced = synced
    for (const fn of this.listeners.get('sync') ?? []) {
      fn(synced)
    }
  }

  disconnect(): void {}
  connect(): void {}
  destroy(): void {}
}

vi.mock('y-websocket', () => ({
  WebsocketProvider: FakeWebsocketProvider,
}))

describe('CollaborationProvider status', () => {
  beforeEach(() => {
    wsInstances.length = 0
  })

  it('does not downgrade synced to connected on later websocket status events', async () => {
    const { CollaborationProvider } = await import('../services/collaborationProvider')
    const provider = new CollaborationProvider('project-1', 'doc-1', 'token-1', {
      id: 'user-1',
      name: 'User One',
      color: '#30bced',
    })
    const ws = wsInstances[0]

    ws.emitSync(true)
    expect(provider.status).toBe('synced')

    ws.emitStatus('connected')

    expect(provider.status).toBe('synced')
  })
})
