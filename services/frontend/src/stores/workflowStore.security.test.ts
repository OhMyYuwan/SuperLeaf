import { describe, expect, it } from 'vitest'

const fsPromisesSpecifier = 'node:fs/promises'
const workflowStoreUrl = new URL('./workflowStore.ts', import.meta.url)

async function readSource(url: URL) {
  const { readFile } = (await import(fsPromisesSpecifier)) as {
    readFile: (path: URL, encoding: 'utf8') => Promise<string>
  }
  return readFile(url, 'utf8')
}

describe('workflowStore log privacy', () => {
  it('does not log workflow request bodies, SSE payloads, or outputs', async () => {
    const source = await readSource(workflowStoreUrl)

    expect(source).not.toContain('[workflow.run] dispatching')
    expect(source).not.toContain('[sse]')
    expect(source).not.toContain('[workflow.finished]')
    expect(source).not.toContain('[workflow.failed]')
    expect(source).not.toContain('[workflow.orchestrated.failed]')
    expect(source).not.toContain('console.log')
    expect(source).not.toContain('console.error')
  })
})
