/**
 * Layer 0: Document Model
 *
 * 文档是唯一真相源。所有操作都围绕 Document 展开：
 * - 用户编辑 → 更新 content → 重新解析 structure
 * - Agent 读取 → 从 structure 提取目标区域 + 上下文
 * - Agent 输出 → 锚定到 Paragraph ID 或 range
 */

export type DocumentFormat = 'tex' | 'md' | 'txt'

export interface Document {
  id: string
  format: DocumentFormat
  content: string  // 原始文本，唯一真相源
  structure: DocumentStructure  // 从 content 解析出的结构
  metadata: DocumentMetadata
  version: number
}

export interface DocumentStructure {
  sections: Section[]  // 章节树（从 \section 或 ## 解析）
  paragraphs: Paragraph[]  // 段落列表（稳定 ID，用于锚定批注）
  citations: Citation[]  // 引用（从 \cite 或 [^1] 解析）
}

export interface Paragraph {
  id: string  // 稳定 ID，基于内容 hash + 位置
  range: { from: number; to: number }  // 在 content 中的字符位置
  text: string
  level: number  // 嵌套层级（0=顶层，1=subsection 内）
  parentSection?: string  // 所属 section ID
}

export interface Section {
  id: string
  title: string
  range: { from: number; to: number }
  level: number  // 1=section, 2=subsection, 3=subsubsection
  children: string[]  // 子 section IDs
}

export interface Citation {
  id: string
  key: string  // cite key
  range: { from: number; to: number }
}

export interface DocumentMetadata {
  title: string
  author: string
  created: Date
  modified: Date
  tags: string[]
}
