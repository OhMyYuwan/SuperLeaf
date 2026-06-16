import { describe, expect, it } from 'vitest'
import config from './vite.config'

describe('vite dev server security defaults', () => {
  it('binds to loopback and keeps filesystem strict by default', () => {
    const server = typeof config === 'function' ? config({ command: 'serve', mode: 'development' }).server : config.server

    expect(server?.host).toBe('127.0.0.1')
    expect(server?.fs?.strict).toBe(true)
    expect(server?.fs?.allow).toEqual([])
  })
})
