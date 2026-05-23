import { describe, expect, it } from 'vitest'
import {
  buildMarkdownAssetUrlMap,
  normalizeMarkdownAssetPath,
  rewriteMarkdownImageSources,
} from '../features/preview/markdownAssets'
import type { TreeFolder } from '../services/filesystemApi'

describe('markdownAssets', () => {
  it('normalizes safe project-relative image paths', () => {
    expect(normalizeMarkdownAssetPath('assets/github-header-banner.png')).toBe(
      'assets/github-header-banner.png',
    )
    expect(normalizeMarkdownAssetPath('./assets/space%20image.png?raw=1#hero')).toBe(
      'assets/space image.png',
    )
  })

  it('skips external, absolute, anchor, and upward paths', () => {
    expect(normalizeMarkdownAssetPath('https://example.com/image.png')).toBeNull()
    expect(normalizeMarkdownAssetPath('//example.com/image.png')).toBeNull()
    expect(normalizeMarkdownAssetPath('/api/files/file_1')).toBeNull()
    expect(normalizeMarkdownAssetPath('#hero')).toBeNull()
    expect(normalizeMarkdownAssetPath('../secret.png')).toBeNull()
  })

  it('indexes project files by tree path', () => {
    const urls = buildMarkdownAssetUrlMap(tree())
    expect(urls.get('assets/github-header-banner.png')).toContain('/api/files/file_banner')
    expect(urls.get('figures/chart.png')).toContain('/api/files/file_chart')
  })

  it('rewrites only matched markdown image tokens', () => {
    const token = imageToken('assets/github-header-banner.png')
    const external = imageToken('https://example.com/keep.png')
    rewriteMarkdownImageSources([token, external], buildMarkdownAssetUrlMap(tree()))

    expect(token.attrGet('src')).toContain('/api/files/file_banner')
    expect(external.attrGet('src')).toBe('https://example.com/keep.png')
  })
})

function tree(): TreeFolder {
  return {
    id: 'root',
    name: 'Project',
    docs: [],
    files: [],
    folders: [
      folder('assets', [file('file_banner', 'github-header-banner.png')]),
      folder('figures', [file('file_chart', 'chart.png')]),
    ],
  }
}

function folder(name: string, files: TreeFolder['files']): TreeFolder {
  return {
    id: `folder_${name}`,
    name,
    docs: [],
    files,
    folders: [],
  }
}

function file(id: string, name: string): TreeFolder['files'][number] {
  return {
    id,
    name,
    mime_type: 'image/png',
    size_bytes: 100,
    updated_at: '2026-05-19T00:00:00Z',
  }
}

function imageToken(src: string) {
  let currentSrc = src
  return {
    type: 'image',
    children: null,
    attrGet: (name: string) => (name === 'src' ? currentSrc : null),
    attrSet: (name: string, value: string) => {
      if (name === 'src') currentSrc = value
    },
  }
}
