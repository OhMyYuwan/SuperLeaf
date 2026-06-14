import { describe, expect, it } from 'vitest'

const fsPromisesSpecifier = 'node:fs/promises'
const userMenuUrl = new URL('./UserMenu.tsx', import.meta.url)

describe('UserMenu account entry', () => {
  it('opens the standalone account page from the personal panel menu item', async () => {
    const { readFile } = (await import(fsPromisesSpecifier)) as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>
    }
    const source = await readFile(userMenuUrl, 'utf8')

    expect(source).toContain("navigate('/account')")
    expect(source).not.toContain('onOpenPersonalPanel')
  })
})
