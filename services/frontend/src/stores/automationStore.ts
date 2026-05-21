import { create } from 'zustand'
import type { Document, Paragraph, Section } from '../types/document'
import {
  flattenFileCandidates,
  parseMentions,
  resolveAttachedFiles,
  stripMentions,
  uniqueMentionedFiles,
  type AttachedFile,
} from '../services/mentions'
import { useDocumentStore } from './documentStore'
import { useFilesystemStore } from './filesystemStore'
import { useWorkflowStore } from './workflowStore'

export type AutomationTargetKind = 'agent' | 'workflow'
export type OutputMode = 'annotate' | 'write'
export type WriteTarget = 'append' | 'replace-doc' | 'replace-chunk'

interface AutomationChunk {
  index: number
  total: number
  range: { from: number; to: number }
  text: string
  sectionTitle: string
}

interface AutomationSession {
  id: string
  docId: string
  docHash: string
  conversationId: string
}

interface PaperContext {
  brief: string
  fullLatex: string
}

interface AutomationState {
  targetKind: AutomationTargetKind
  targetId: string
  instruction: string
  maxChunkChars: number
  fullContextEvery: number
  outputMode: OutputMode
  writeTarget: WriteTarget
  running: boolean
  stopRequested: boolean
  currentIndex: number
  total: number
  completed: number
  error: string | null
  lastMessage: string | null
  sessionId: string
  sessionConversationId: string
  sessionDocHash: string

  setTargetKind: (kind: AutomationTargetKind) => void
  setTargetId: (id: string) => void
  setInstruction: (instruction: string) => void
  setMaxChunkChars: (value: number) => void
  setFullContextEvery: (value: number) => void
  setOutputMode: (mode: OutputMode) => void
  setWriteTarget: (target: WriteTarget) => void
  start: () => Promise<void>
  stop: () => void
}

const DEFAULT_INSTRUCTION = '请以自动批注模式审核这个段落，指出需要修改、补充、压缩或澄清的地方。'
const MIN_CHUNK_CHARS = 600
const MAX_CHUNK_CHARS = 8000
const MIN_REFRESH_EVERY = 1
const MAX_REFRESH_EVERY = 50
const AUTO_MARKER_RE = /^\s*%\s*AUTO\b/im
const LATEX_BEGIN_DOCUMENT_RE = /\\begin\s*\{\s*document\s*\}/i
const AUTO_ANNOTATION_CONTRACT = [
  '[ANNOTATION SKILL CONTRACT]',
  '- `% AUTO ...` 是用户写给自动化批注流程的局部指令，不是论文正文；它可以要求你特别检查紧随其后的文本或当前块。',
  '- 默认只审阅文档正文。LaTeX `\\begin{document}` 之前的导言区（包、宏、排版或编译配置）不要生成批注，除非 `% AUTO` 明确要求检查导言区。',
  '- 坐标必须相对 `目标段落` 的原文，从 0 开始；不要使用全文绝对坐标。',
  '- 优先输出严格 JSON 对象，只使用 `annotations` 字段。不要输出 `suggestions` 或 `risks` 字段，也不要在 JSON 外添加说明文字。',
  '- `annotations[]`: `{ "from": number, "to": number, "content": string, "type": "comment|question|warning|praise", "severity": "low|medium|high", "tags": string[] }`。',
  '- 如果要表达改写建议或风险提醒，也写成一条普通 annotation 的 `content`；不要拆成其他卡片类型。',
  '- 没有可执行问题时返回 `{ "annotations": [] }`。',
  '[END ANNOTATION SKILL CONTRACT]',
].join('\n')
const AUTO_WRITE_CONTRACT = [
  '[WRITE MODE CONTRACT]',
  '- 你正在执行直接写入模式。请直接输出目标文本内容，不要输出 JSON，不要输出批注卡片。',
  '- 输出的内容将被直接写入文档，请确保格式与文档格式（LaTeX/Markdown/纯文本）一致。',
  '- 不要在输出中包含任何解释、前言或后记。只输出要写入文档的内容本身。',
  '- 如果段落中包含以 % AUTO 开头的 LaTeX 注释，请把它理解为用户写给自动化流程的局部提示，不要输出到文档中。',
  '[END WRITE MODE CONTRACT]',
].join('\n')

export const useAutomationStore = create<AutomationState>((set, get) => ({
  targetKind: 'agent',
  targetId: '',
  instruction: DEFAULT_INSTRUCTION,
  maxChunkChars: 2600,
  fullContextEvery: 8,
  outputMode: 'annotate',
  writeTarget: 'append',
  running: false,
  stopRequested: false,
  currentIndex: 0,
  total: 0,
  completed: 0,
  error: null,
  lastMessage: null,
  sessionId: '',
  sessionConversationId: '',
  sessionDocHash: '',

  setTargetKind: (targetKind) => set({ targetKind, targetId: '', error: null }),
  setTargetId: (targetId) => set({ targetId, error: null }),
  setInstruction: (instruction) => set({ instruction }),
  setMaxChunkChars: (value) => {
    const maxChunkChars = Math.max(MIN_CHUNK_CHARS, Math.min(MAX_CHUNK_CHARS, Math.round(value)))
    set({ maxChunkChars })
  },
  setFullContextEvery: (value) => {
    const fullContextEvery = Math.max(
      MIN_REFRESH_EVERY,
      Math.min(MAX_REFRESH_EVERY, Math.round(value)),
    )
    set({ fullContextEvery })
  },
  setOutputMode: (outputMode) => set({ outputMode }),
  setWriteTarget: (writeTarget) => set({ writeTarget }),

  stop: () => {
    set({ stopRequested: true, lastMessage: '正在停止：当前段落完成后会停止。' })
  },

  start: async () => {
    const state = get()
    if (state.running) return

    const activeDoc = useDocumentStore.getState().getActive()
    if (!activeDoc) {
      set({ error: '请先打开一篇文档。' })
      return
    }

    const snapshot = cloneDocumentSnapshot(activeDoc)
    const docHash = hashContent(snapshot.content)
    const chunks = buildParagraphChunks(snapshot, state.maxChunkChars)
    if (chunks.length === 0) {
      set({ error: '当前文档没有可审核的段落。' })
      return
    }

    const targetKind = state.targetKind
    const targetId = state.targetId
    if (!targetId) {
      set({ error: '请选择一个 Agent 或 workflow。' })
      return
    }

    const outputMode = state.outputMode
    const writeTarget = state.writeTarget

    const session: AutomationSession = {
      id: makeSessionId(snapshot.id),
      docId: snapshot.id,
      docHash,
      conversationId: '',
    }
    const paperContext = buildPaperContext(snapshot, docHash)
    const references = await resolveInstructionReferences(state.instruction)
    const instruction = references.instruction || DEFAULT_INSTRUCTION
    const fullContextEvery = state.fullContextEvery

    const replaceDocWarning =
      outputMode === 'write' && writeTarget === 'replace-doc' && chunks.length > 1
        ? `（注意：替换整个文档模式下，每个段落都会覆写整篇文档，最终只保留最后一段的输出）`
        : ''

    set({
      running: true,
      stopRequested: false,
      currentIndex: 0,
      total: chunks.length,
      completed: 0,
      error: null,
      lastMessage: references.attachedFiles.length > 0
        ? `准备处理 ${chunks.length} 个段落，已附带 ${references.attachedFiles.length} 个参考文件，并锁定当前文档快照。${replaceDocWarning}`
        : `准备处理 ${chunks.length} 个段落，并锁定当前文档快照。${replaceDocWarning}`,
      sessionId: session.id,
      sessionConversationId: '',
      sessionDocHash: docHash,
    })

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (get().stopRequested) {
          set({ lastMessage: `已停止，完成 ${get().completed}/${chunks.length} 个段落。` })
          break
        }

        if (outputMode === 'annotate') {
          const liveDoc = useDocumentStore.getState().documents[snapshot.id]
          if (!liveDoc || hashContent(liveDoc.content) !== docHash) {
            set({
              error: '文档内容已变化，自动化已暂停。请重新启动自动化以锁定新的上下文。',
              lastMessage: `已暂停，完成 ${get().completed}/${chunks.length} 个段落。`,
            })
            break
          }
        }

        const chunk = chunks[i]
        const includeFullContext = shouldRefreshFullContext(i, fullContextEvery)
        set({
          currentIndex: i + 1,
          lastMessage: includeFullContext
            ? `正在处理第 ${i + 1}/${chunks.length} 个段落，并刷新全文上下文。`
            : `正在处理第 ${i + 1}/${chunks.length} 个段落。`,
        })

        const result = await runChunk({
          doc: snapshot,
          chunk,
          targetKind,
          targetId,
          instruction,
          session,
          paperContext,
          includeFullContext,
          attachedFiles: references.attachedFiles,
          outputMode,
          writeTarget,
        })
        if (result.conversationId) {
          session.conversationId = result.conversationId
          set({ sessionConversationId: result.conversationId })
        }
        if (result.error) {
          set({ error: result.error, lastMessage: `第 ${i + 1} 个段落失败。` })
          break
        }

        set({ completed: i + 1, lastMessage: `已完成 ${i + 1}/${chunks.length} 个段落。` })
      }
    } finally {
      set((latest) => ({
        running: false,
        stopRequested: false,
        lastMessage: latest.error
          ? latest.lastMessage
          : latest.completed >= latest.total
            ? outputMode === 'write'
              ? `自动写入完成：${latest.completed}/${latest.total} 个段落。`
              : `自动批注完成：${latest.completed}/${latest.total} 个段落。`
            : latest.lastMessage,
      }))
    }
  },
}))

async function runChunk(args: {
  doc: Document
  chunk: AutomationChunk
  targetKind: AutomationTargetKind
  targetId: string
  instruction: string
  session: AutomationSession
  paperContext: PaperContext
  includeFullContext: boolean
  attachedFiles: AttachedFile[]
  outputMode: OutputMode
  writeTarget: WriteTarget
}): Promise<{ error: string | null; conversationId?: string }> {
  const {
    doc,
    chunk,
    targetKind,
    targetId,
    instruction,
    session,
    paperContext,
    includeFullContext,
    attachedFiles,
    outputMode,
    writeTarget,
  } = args
  const workflow = useWorkflowStore.getState()
  const query = buildAutomationQuery({
    chunk,
    instruction,
    session,
    paperContext,
    includeFullContext,
    targetKind,
    attachedFiles,
    outputMode,
  })
  const contextFiles = attachedFilesToContextFiles(attachedFiles)
  const autoIngest = outputMode === 'annotate'
  const body = {
    document_id: doc.id,
    range_start: chunk.range.from,
    range_end: chunk.range.to,
    conversation_id: targetKind === 'agent' ? session.conversationId : session.id,
    inputs: {
      automation_mode:
        outputMode === 'write' ? 'paragraph_auto_write' : 'paragraph_auto_annotation',
      automation_output_mode: outputMode,
      automation_write_target: outputMode === 'write' ? writeTarget : '',
      automation_session_id: session.id,
      automation_doc_hash: session.docHash,
      automation_context_refresh: includeFullContext,
      target_text: chunk.text,
      text: chunk.text,
      paragraph_index: chunk.index,
      paragraph_total: chunk.total,
      section_title: chunk.sectionTitle,
      paper_brief: paperContext.brief,
      full_latex_context: includeFullContext ? paperContext.fullLatex : '',
      attached_files: attachedFiles,
      instruction,
    },
    query,
    context_files: contextFiles,
  }

  if (targetKind === 'workflow') {
    let failed: string | null = null
    await workflow.executeDefinition(targetId, body, {
      autoIngestToAnnotations: autoIngest,
      onFailed: (error) => { failed = error },
    })
    if (outputMode === 'write' && !failed) {
      const rawText = extractWriteOutput(targetId)
      if (rawText) applyWriteOutput({ docId: doc.id, chunk, rawText, writeTarget })
    }
    return { error: failed }
  }

  let failed: string | null = null
  let conversationId = session.conversationId
  await workflow.run(targetId, body, {
    autoIngestToAnnotations: autoIngest,
    onCompleted: (payload) => {
      if (payload.conversation_id) conversationId = payload.conversation_id
    },
    onFailed: (error) => { failed = error },
  })
  const events = useWorkflowStore.getState().lastRunEvents[targetId] ?? []
  const last = events[events.length - 1]
  if (!failed && last?.kind === 'ylw.run.failed') {
    const payload = last.payload as { error?: string } | string
    failed = typeof payload === 'string' ? payload : payload.error ?? 'Agent run failed'
  }
  if (outputMode === 'write' && !failed) {
    const rawText = extractWriteOutput(targetId)
    if (rawText) applyWriteOutput({ docId: doc.id, chunk, rawText, writeTarget })
  }
  return { error: failed, conversationId }
}

function extractWriteOutput(targetId: string): string {
  const events = useWorkflowStore.getState().lastRunEvents[targetId] ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i]
    if (evt.kind !== 'ylw.run.finished' && evt.kind !== 'workflow.completed') continue
    const payload = evt.payload as { outputs?: unknown } | unknown
    const outputs = (payload as { outputs?: unknown })?.outputs ?? payload
    const text = pickWriteText(outputs)
    if (text) return text
  }
  return ''
}

function pickWriteText(outputs: unknown): string {
  if (typeof outputs === 'string') return outputs.trim()
  if (!outputs || typeof outputs !== 'object') return ''
  const record = outputs as Record<string, unknown>
  const keys = ['text', 'answer', 'result', 'content', 'output']
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function applyWriteOutput(args: {
  docId: string
  chunk: AutomationChunk
  rawText: string
  writeTarget: WriteTarget
}): void {
  const docStore = useDocumentStore.getState()
  const liveContent = docStore.documents[args.docId]?.content ?? ''
  let newContent: string
  switch (args.writeTarget) {
    case 'append':
      newContent = liveContent.trimEnd() + '\n\n' + args.rawText
      break
    case 'replace-doc':
      newContent = args.rawText
      break
    case 'replace-chunk':
      newContent = liveContent.slice(0, args.chunk.range.from)
        + args.rawText
        + liveContent.slice(args.chunk.range.to)
      break
  }
  docStore.updateContent(args.docId, newContent)
}

function buildAutomationQuery(args: {
  chunk: AutomationChunk
  instruction: string
  session: AutomationSession
  paperContext: PaperContext
  includeFullContext: boolean
  targetKind: AutomationTargetKind
  attachedFiles: AttachedFile[]
  outputMode: OutputMode
}): string {
  const {
    chunk,
    instruction,
    session,
    paperContext,
    includeFullContext,
    targetKind,
    attachedFiles,
    outputMode,
  } = args
  const isWrite = outputMode === 'write'
  return [
    isWrite
      ? '你正在执行 YuwanLabWriter 自动写入模式。'
      : '你正在执行 YuwanLabWriter 自动批注模式。',
    isWrite
      ? '这是无人值守的连续写作任务：请把本次任务视为同一个自动化 session 中的一步，输出会被直接写入文档。'
      : '这是无人值守的连续审稿任务：请把本次任务视为同一个自动化 session 中的一步。',
    targetKind === 'agent'
      ? '如果你支持会话记忆，请延续之前对全文的理解；不要把每个段落当成全新论文。'
      : '当前 workflow run 可能是无状态的，因此请严格依赖本次请求提供的上下文。',
    isWrite
      ? '请直接输出要写入文档的目标文本本身；不要输出 JSON、不要输出批注卡片、不要添加解释。'
      : '只输出适合生成批注卡片的意见、建议或风险提示；不要直接重写整篇文章。',
    '如果段落中包含以 % AUTO 开头的 LaTeX 注释，请把它理解为用户写给自动化流程的局部提示，不要当作论文正文。',
    isWrite ? AUTO_WRITE_CONTRACT : AUTO_ANNOTATION_CONTRACT,
    '',
    `[AUTOMATION SESSION] ${session.id}`,
    `[DOCUMENT HASH] ${session.docHash}`,
    '',
    includeFullContext
      ? `[FULL LATEX SNAPSHOT]\n${paperContext.fullLatex}\n[END FULL LATEX SNAPSHOT]`
      : `[COMPACT PAPER CONTEXT]\n${paperContext.brief}\n[END COMPACT PAPER CONTEXT]`,
    targetKind === 'agent' && attachedFiles.length > 0
      ? renderAttachedFilesForPrompt(attachedFiles)
      : '',
    '',
    `段落：${chunk.index}/${chunk.total}`,
    chunk.sectionTitle ? `章节：${chunk.sectionTitle}` : '',
    `任务：${instruction}`,
    '',
    '--- 目标段落开始 ---',
    chunk.text,
    '--- 目标段落结束 ---',
  ].filter(Boolean).join('\n')
}

async function resolveInstructionReferences(rawInstruction: string): Promise<{
  instruction: string
  attachedFiles: AttachedFile[]
}> {
  const tree = useFilesystemStore.getState().tree
  const fileCandidates = flattenFileCandidates(tree)
  if (fileCandidates.length === 0) {
    return { instruction: rawInstruction.trim(), attachedFiles: [] }
  }

  const mentions = parseMentions(rawInstruction, fileCandidates)
  const mentionedFiles = uniqueMentionedFiles(mentions)
  if (mentionedFiles.length === 0) {
    return { instruction: rawInstruction.trim(), attachedFiles: [] }
  }

  const attachedFiles = await resolveAttachedFiles(mentionedFiles, {
    onFetchError: (file, error) => {
      console.warn('[automationStore] failed to fetch @mentioned file', file.path, error)
    },
  })
  return {
    instruction: stripMentions(rawInstruction, mentions).trim(),
    attachedFiles,
  }
}

function attachedFilesToContextFiles(attachedFiles: readonly AttachedFile[]) {
  return attachedFiles.map((file) => ({
    name: file.path || file.name,
    document_id: file.path || file.name,
    content: contextFileContent(file),
  }))
}

function contextFileContent(file: AttachedFile): string {
  if (file.omitted) {
    return `[file omitted: ${file.omit_reason ?? 'attachment budget exceeded'}]`
  }
  if (file.kind === 'doc') {
    return file.content ?? ''
  }
  return [
    `[binary file: ${file.name}]`,
    `path: ${file.path}`,
    file.mime ? `mime: ${file.mime}` : '',
    file.url ? `url: ${file.url}` : '',
  ].filter(Boolean).join('\n')
}

function renderAttachedFilesForPrompt(attachedFiles: readonly AttachedFile[]): string {
  const lines: string[] = ['[ATTACHED FILES]']
  for (const file of attachedFiles) {
    const header = [
      `[FILE: ${file.name}`,
      `path=${file.path}`,
      `kind=${file.kind}`,
      `size=${file.original_size_bytes}B`,
      file.truncated ? 'truncated=true' : '',
      file.mime ? `mime=${file.mime}` : '',
      file.url ? `url=${file.url}` : '',
    ].filter(Boolean).join(' | ')
    lines.push(`${header}]`)
    lines.push(contextFileContent(file))
    lines.push(`[END FILE: ${file.name}]`)
  }
  lines.push('[END ATTACHED FILES]')
  return lines.join('\n')
}

function buildParagraphChunks(doc: Document, maxChars: number): AutomationChunk[] {
  const paragraphs = [...(doc.structure.paragraphs ?? [])]
    .filter((p) => p.text.trim().length > 0)
    .filter((p) => shouldIncludeAutomationParagraph(doc, p))
    .sort((a, b) => a.range.from - b.range.from)

  const rawChunks = paragraphs.flatMap((paragraph) => splitParagraph(doc, paragraph, maxChars))
  return rawChunks.map((chunk, idx) => ({
    ...chunk,
    index: idx + 1,
    total: rawChunks.length,
  }))
}

export function countAutomationReviewTargets(doc: Document): number {
  return (doc.structure.paragraphs ?? [])
    .filter((paragraph) => paragraph.text.trim().length > 0)
    .filter((paragraph) => shouldIncludeAutomationParagraph(doc, paragraph))
    .length
}

function shouldIncludeAutomationParagraph(doc: Document, paragraph: Paragraph): boolean {
  const text = paragraph.text.trim()
  if (!text) return false
  if (AUTO_MARKER_RE.test(text)) return true
  if (doc.format !== 'tex') return true
  return !isBeforeLatexDocumentBody(doc.content, paragraph.range)
}

function isBeforeLatexDocumentBody(content: string, range: { from: number; to: number }): boolean {
  const match = LATEX_BEGIN_DOCUMENT_RE.exec(content)
  if (!match) return false
  const bodyStart = match.index + match[0].length
  return range.to <= bodyStart
}

function splitParagraph(
  doc: Document,
  paragraph: Paragraph,
  maxChars: number,
): Array<Omit<AutomationChunk, 'index' | 'total'>> {
  if (paragraph.text.length <= maxChars) {
    return [{
      range: paragraph.range,
      text: paragraph.text,
      sectionTitle: sectionTitleAt(doc.structure.sections, paragraph.range.from),
    }]
  }

  const chunks: Array<Omit<AutomationChunk, 'index' | 'total'>> = []
  let cursor = paragraph.range.from
  while (cursor < paragraph.range.to) {
    const desiredEnd = Math.min(cursor + maxChars, paragraph.range.to)
    const end = findSplitPoint(doc.content, cursor, desiredEnd, paragraph.range.to)
    chunks.push({
      range: { from: cursor, to: end },
      text: doc.content.slice(cursor, end),
      sectionTitle: sectionTitleAt(doc.structure.sections, cursor),
    })
    cursor = skipWhitespace(doc.content, end, paragraph.range.to)
  }
  return chunks
}

function cloneDocumentSnapshot(doc: Document): Document {
  return {
    ...doc,
    content: doc.content,
    metadata: { ...doc.metadata },
    structure: {
      sections: doc.structure.sections.map((section) => ({
        ...section,
        range: { ...section.range },
        children: [...section.children],
      })),
      paragraphs: doc.structure.paragraphs.map((paragraph) => ({
        ...paragraph,
        range: { ...paragraph.range },
      })),
      citations: doc.structure.citations.map((citation) => ({
        ...citation,
        range: { ...citation.range },
      })),
    },
  }
}

function buildPaperContext(doc: Document, docHash: string): PaperContext {
  const title = doc.metadata.title || '未命名文档'
  const abstract = extractLatexAbstract(doc.content)
  const outline = doc.structure.sections
    .slice(0, 80)
    .map((section) => `${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title}`)
    .join('\n') || '无章节结构'
  const autoHints = extractAutoHints(doc.content)

  const brief = [
    `标题：${title}`,
    `文档格式：${doc.format}`,
    `文档 hash：${docHash}`,
    abstract ? `摘要：${truncateText(abstract, 1800)}` : '',
    `章节结构：\n${outline}`,
    autoHints.length > 0
      ? `% AUTO 提示：\n${autoHints.slice(0, 40).join('\n')}`
      : '% AUTO 提示：无',
  ].filter(Boolean).join('\n\n')

  return {
    brief,
    fullLatex: doc.content,
  }
}

function extractLatexAbstract(content: string): string {
  const match = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/)
  return match?.[1]?.trim() ?? ''
}

function extractAutoHints(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line, idx) => ({ line: line.trim(), lineNo: idx + 1 }))
    .filter(({ line }) => /^%\s*AUTO\b/i.test(line))
    .map(({ line, lineNo }) => `L${lineNo}: ${line}`)
}

function shouldRefreshFullContext(index: number, fullContextEvery: number): boolean {
  return index === 0 || index % fullContextEvery === 0
}

function makeSessionId(docId: string): string {
  return `auto-${docId}-${Date.now().toString(36)}`
}

function hashContent(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}...`
}

function findSplitPoint(content: string, from: number, desiredEnd: number, maxEnd: number): number {
  if (desiredEnd >= maxEnd) return maxEnd
  const window = content.slice(from, desiredEnd)
  const candidates = ['\n', '。', '.', ';', '；', ',', '，', ' ']
  for (const marker of candidates) {
    const idx = window.lastIndexOf(marker)
    if (idx > Math.floor(window.length * 0.45)) {
      return from + idx + marker.length
    }
  }
  return desiredEnd
}

function skipWhitespace(content: string, from: number, maxEnd: number): number {
  let pos = from
  while (pos < maxEnd && /\s/.test(content[pos] ?? '')) pos += 1
  return pos
}

function sectionTitleAt(sections: Section[], pos: number): string {
  let best: Section | undefined
  for (const section of sections) {
    if (pos >= section.range.from && pos < section.range.to) {
      if (!best || section.level > best.level) best = section
    }
  }
  return best?.title ?? ''
}
