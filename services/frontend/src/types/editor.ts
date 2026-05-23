/**
 * Layer 1: Editor State & Selection
 *
 * 编辑器状态是用户操作的直接产物：
 * - 用户选中文本 → Selection
 * - 选区自动提取上下文 → SelectionContext
 * - 这是 Agent 输入的起点
 */

export interface EditorState {
  documentId: string
  selection: Selection | null
  selectionRange: { from: number; to: number }
  cursor: number
  viewport: {
    from: number
    to: number
    firstVisibleLine?: number
  }  // 当前可见区域
  focusedParagraphId?: string  // 光标所在段落
}

export interface Selection {
  from: number
  to: number
  text: string
  paragraphIds: string[]  // 选区覆盖的段落 IDs
  context: SelectionContext  // 自动提取的上下文
}

export interface SelectionContext {
  // 上下文窗口（用于 Agent 理解选区的位置）
  before: string  // 前文（最多 N 个段落或 M 个字符）
  after: string   // 后文

  // 结构化上下文
  sectionTitle?: string  // 所在章节标题
  sectionId?: string

  // 如果 Agent 需要全文（某些 Agent 如 Synthesizer 需要）
  fullDocument?: string

  // 元数据
  selectionLength: number
  paragraphCount: number
}
