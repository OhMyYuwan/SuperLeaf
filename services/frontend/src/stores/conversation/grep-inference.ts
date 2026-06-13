/**
 * 从用户输入文本反推 `project_grep` 的搜索词与文件类型过滤。
 *
 * Nanobot preflight 链路在用户消息里看到「搜索 / 查找 / grep」类语义时，会主动
 * 调用 project_grep 工具；这里负责从原文里挖出引号内的字面量、问句中的关键词、
 * 以及兜底用的标识符，组合成一个 OR 形式的正则。`inferFormatFilter` 给出 .tex /
 * .md / .txt 类的文件类型过滤。
 */

export function inferGrepPattern(text: string): string {
  const terms = new Set<string>()
  for (const pattern of [
    /`([^`]{1,80})`/gu,
    /"([^"]{1,80})"/gu,
    /'([^']{1,80})'/gu,
    /“([^”]{1,80})”/gu,
    /‘([^’]{1,80})’/gu,
  ]) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      addGrepTerm(terms, match[1])
    }
  }

  const searchMatch = text.match(/(?:搜索|查找|检索|grep|find)\s*(?:当前(?:项目|文档|编辑区文档)?(?:中|里)?|所有文档(?:中|里)?)?\s*([^，。；;,.!?！？\n]{1,120})/iu)
  if (searchMatch?.[1]) {
    for (const part of searchMatch[1].split(/(?:\s+或\s+|\s+和\s+|\s+or\s+|\s+and\s+|[、/])/iu)) {
      addGrepTerm(terms, part)
    }
  }

  if (terms.size === 0) {
    const words = text.match(/\b[A-Za-z_][A-Za-z0-9_:-]{1,80}\b/gu) ?? []
    for (const word of words) {
      if (!word.startsWith('project_') && !['SuperLeaf', 'tool', 'grep', 'find'].includes(word)) {
        addGrepTerm(terms, word)
      }
    }
  }

  return [...terms].map(escapeRegex).join('|')
}

export function addGrepTerm(terms: Set<string>, raw: string): void {
  const term = raw
    .replace(/^(?:出现位置|的位置|的出现|中|里|位置|出现|内容|关键词)\s*/u, '')
    .replace(/\s*(?:出现位置|的位置|的出现|中|里|位置|出现|内容|关键词)$/u, '')
    .trim()
  if (!term || term.length > 80) return
  if (/^(?:当前|项目|文档|所有文档|使用|调用|工具|SuperLeaf)$/iu.test(term)) return
  terms.add(term)
}

export function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

export function inferFormatFilter(text: string): string {
  if (/\b(?:tex|latex)\b|\.tex\b/iu.test(text)) return 'tex'
  if (/\b(?:md|markdown)\b|\.md\b/iu.test(text)) return 'md'
  if (/\btxt\b|\.txt\b/iu.test(text)) return 'txt'
  return ''
}
