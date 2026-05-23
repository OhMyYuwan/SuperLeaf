import { filesystemApi, type TreeFolder } from '../../services/filesystemApi'

interface MarkdownTokenLike {
  type: string
  children?: MarkdownTokenLike[] | null
  attrGet: (name: string) => string | null
  attrSet: (name: string, value: string) => void
}

export function buildMarkdownAssetUrlMap(root: TreeFolder): Map<string, string> {
  const urls = new Map<string, string>()

  const visit = (folder: TreeFolder, pathParts: string[]) => {
    for (const file of folder.files) {
      const normalized = normalizeProjectPath([...pathParts, file.name])
      if (normalized) urls.set(normalized, filesystemApi.fileUrl(file.id))
    }
    for (const child of folder.folders) {
      visit(child, [...pathParts, child.name])
    }
  }

  visit(root, [])
  return urls
}

export function rewriteMarkdownImageSources(
  tokens: readonly MarkdownTokenLike[],
  assetUrls: ReadonlyMap<string, string>,
): void {
  for (const token of tokens) {
    if (token.type === 'image') {
      const src = token.attrGet('src')
      const normalized = normalizeMarkdownAssetPath(src)
      const resolved = normalized ? assetUrls.get(normalized) : null
      if (resolved) token.attrSet('src', resolved)
    }
    if (token.children?.length) {
      rewriteMarkdownImageSources(token.children, assetUrls)
    }
  }
}

export function normalizeMarkdownAssetPath(src: string | null | undefined): string | null {
  const value = (src ?? '').trim()
  if (!value || isExternalOrAbsoluteUrl(value)) return null

  const pathOnly = value.split(/[?#]/, 1)[0]
  if (!pathOnly) return null

  let decoded = pathOnly
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    decoded = pathOnly
  }

  const parts: string[] = []
  for (const rawPart of decoded.split('/')) {
    const part = rawPart.trim()
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }

  return normalizeProjectPath(parts)
}

function normalizeProjectPath(parts: string[]): string | null {
  const cleaned = parts.map((part) => part.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned.join('/') : null
}

function isExternalOrAbsoluteUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)
}
