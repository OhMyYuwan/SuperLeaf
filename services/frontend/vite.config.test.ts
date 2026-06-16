import { describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './vite.config'

const frontendRoot = dirname(fileURLToPath(import.meta.url))

describe('vite dev server security defaults', () => {
  it('binds to loopback and only allows the frontend project root by default', () => {
    const server = typeof config === 'function' ? config({ command: 'serve', mode: 'development' }).server : config.server

    expect(server?.host).toBe('127.0.0.1')
    expect(server?.fs?.strict).toBe(true)
    expect(server?.fs?.allow).toEqual([frontendRoot])
  })
})
