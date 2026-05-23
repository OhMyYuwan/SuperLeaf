/**
 * writingStore — 自动写入模式专属 store。
 *
 * 与 automationStore（自动批注）彻底隔离。三种模式：
 *
 * 1. `draft`              — 全文起草。单次大调用：把意图（+ 已有正文）
 *                            发给 Agent，得到完整文档，整体替换。空文档时
 *                            自动跳过 PRE-EXISTING TEXT。
 * 2. `polish-paragraphs`  — 逐段润色。按段循环，每段独立 Agent 调用，
 *                            就地替换该段落。写入后维护 cumulativeDelta
 *                            校正后续段落 range；可中途停止。
 * 3. `append`             — 追加段落。单次大调用：Agent 输出追加到末尾。
 *
 * 协作模式下直接操作 yText，让编辑器实时看到变化；非协作模式 fallback
 * 到 documentStore.updateContent。
 */

import { create } from 'zustand'
import type { Document, DocumentFormat, Paragraph, Section } from '../types/document'
import {
  flattenFileCandidates,
  parseMentions,
  resolveAttachedFiles,
  stripMentions,
  uniqueMentionedFiles,
  type AttachedFile,
} from '../services/mentions'
import { useCollaborationStore } from './collaborationStore'
import { useDocumentStore } from './documentStore'
import { useFilesystemStore } from './filesystemStore'
import { useWorkflowStore } from './workflowStore'

export type WritingTargetKind = 'agent' | 'workflow'
export type WritingMode = 'draft' | 'polish-paragraphs' | 'append'

interface WritingState {
  targetKind: WritingTargetKind
  targetId: string
  instruction: string
  mode: WritingMode
  running: boolean
  stopRequested: boolean
  currentIndex: number
  total: number
  completed: number
  error: string | null
  lastMessage: string | null
  lastWriteChars: number
  sessionId: string

  setTargetKind: (kind: WritingTargetKind) => void
  setTargetId: (id: string) => void
  setInstruction: (instruction: string) => void
  setMode: (mode: WritingMode) => void
  start: () => Promise<void>
  stop: () => void
}

const DEFAULT_INSTRUCTION = ''
const POLISH_CHUNK_CHARS = 2600
const AUTO_MARKER_RE = /^\s*%\s*AUTO\b/im
const LATEX_BEGIN_DOCUMENT_RE = /\\begin\s*\{\s*document\s*\}/i

const WRITE_CONTRACT_BASE_DRAFT = [
  '[WRITE MODE CONTRACT — DRAFT]',
  '- 你正在为整篇文档起草内容。直接输出可写入的目标文本。',
  '- 围栏外不要任何说明、前言或后记。',
  '- 如果存在已有文档（PRE-EXISTING TEXT），保留它的 preamble、宏包、风格；只补全或重写正文。',
].join('\n')

const WRITE_CONTRACT_BASE_POLISH = [
  '[WRITE MODE CONTRACT — POLISH PARAGRAPH]',
  '- 你正在润色一个段落。仅输出润色后的段落文本本身，覆盖该段。',
  '- 不要扩张到下一段，不要总结其他段落，不要添加章节标题或编号。',
  '- 围栏外不要任何说明。保留原段落的语义、引用和占位符。',
  '- 如果该段无需修改，原样输出（仍然包在围栏中）。',
].join('\n')

const WRITE_CONTRACT_BASE_APPEND = [
  '[WRITE MODE CONTRACT — APPEND]',
  '- 你正在为文档追加新内容（不是修改已有内容）。',
  '- 只输出要追加到文末的新文本（章节、段落或附录）。围栏外不要任何说明。',
  '- 与已有正文风格一致。',
].join('\n')

function formatRulesFor(format: DocumentFormat): string[] {
  if (format === 'tex') {
    return [
      '',
      '[FORMAT — LaTeX (.tex)]',
      '- 输出 LaTeX 源码，包在 ```latex ... ``` 围栏里。',
      '- 使用 LaTeX 命令：`\\section{...}`、`\\subsection{...}`、`\\textbf{...}`、`\\emph{...}`、`\\cite{key}`、`\\ref{label}`、行内数学 `$...$`、行间 `\\[...\\]` 或 `equation` 环境、列表用 `itemize/enumerate`。',
      '- **不要使用 Markdown 语法**：不要 `# 标题`、`**加粗**`、`*斜体*`、`- 项目`（除非在 `itemize` 内）、`[文本](url)`、` ```代码块``` `（围栏只能是最外层的输出围栏）。',
      '- 中文标点照常使用，但保留所有原有的 `\\` 命令和 `{}` 大括号结构；不要把 `\\cite{X}` 改写成 `[X]`。',
      '- 如果输出包含特殊字符（`%` `&` `_` `#` `$` `{` `}`），按 LaTeX 规则正确转义。',
    ]
  }
  if (format === 'md') {
    return [
      '',
      '[FORMAT — Markdown (.md)]',
      '- 输出 Markdown，包在 ```markdown ... ``` 围栏里。',
      '- 使用 Markdown 语法：`# 标题`、`**加粗**`、`*斜体*`、`-` / `1.` 列表、`[文本](url)`、行内代码 `` ` ``、行间用缩进或 ` ``` ` 块（注意外层围栏！）。',
      '- **不要使用 LaTeX 命令**：不要 `\\section`、`\\textbf`、`\\cite`、`\\ref`；如果原文有数学，沿用 `$...$` 或 `$$...$$` 即可。',
      '- 输出中如果需要嵌套代码块，使用波浪线 `~~~` 或更多反引号以避免与外层 ``` 冲突。',
    ]
  }
  return [
    '',
    '[FORMAT — Plain Text (.txt)]',
    '- 输出纯文本，包在 ```text ... ``` 围栏里。',
    '- 不要使用 LaTeX 命令或 Markdown 标记，仅普通段落 + 空行分段。',
  ]
}

function buildWriteContract(mode: WritingMode, format: DocumentFormat): string {
  const base =
    mode === 'draft'
      ? WRITE_CONTRACT_BASE_DRAFT
      : mode === 'append'
        ? WRITE_CONTRACT_BASE_APPEND
        : WRITE_CONTRACT_BASE_POLISH
  const rules = formatRulesFor(format)
  return [base, ...rules, '[END WRITE MODE CONTRACT]'].join('\n')
}

interface WriteChunk {
  index: number
  total: number
  range: { from: number; to: number }
  text: string
  sectionTitle: string
}

export const useWritingStore = create<WritingState>((set, get) => ({
  targetKind: 'agent',
  targetId: '',
  instruction: DEFAULT_INSTRUCTION,
  mode: 'draft',
  running: false,
  stopRequested: false,
  currentIndex: 0,
  total: 0,
  completed: 0,
  error: null,
  lastMessage: null,
  lastWriteChars: 0,
  sessionId: '',

  setTargetKind: (targetKind) => set({ targetKind, targetId: '', error: null }),
  setTargetId: (targetId) => set({ targetId, error: null }),
  setInstruction: (instruction) => set({ instruction }),
  setMode: (mode) => set({ mode, error: null }),

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
    if (!state.targetId) {
      set({ error: '请选择一个 Agent 或 workflow。' })
      return
    }
    if (!state.instruction.trim()) {
      set({ error: '请输入写入意图。' })
      return
    }

    const wfState = useWorkflowStore.getState()
    if (wfState.running[state.targetId]) {
      set({ error: '该 Agent / workflow 正在运行，请等其完成或停止后再试。' })
      return
    }

    const sessionId = makeSessionId(activeDoc.id)
    const references = await resolveInstructionReferences(state.instruction)
    const userIntent = references.instruction || state.instruction.trim()
    const attachedFiles = references.attachedFiles

    set({
      running: true,
      stopRequested: false,
      error: null,
      sessionId,
      lastWriteChars: 0,
      currentIndex: 0,
      total: 0,
      completed: 0,
      lastMessage: attachedFiles.length > 0
        ? `准备写入：模式 ${state.mode}，已附带 ${attachedFiles.length} 个参考文件。`
        : `准备写入：模式 ${state.mode}。`,
    })

    try {
      if (state.mode === 'polish-paragraphs') {
        await runPolishLoop({
          doc: activeDoc,
          targetKind: state.targetKind,
          targetId: state.targetId,
          userIntent,
          sessionId,
          attachedFiles,
          isStopRequested: () => get().stopRequested,
          onProgress: (patch) => set(patch),
        })
      } else {
        await runSingleCall({
          doc: activeDoc,
          mode: state.mode,
          targetKind: state.targetKind,
          targetId: state.targetId,
          userIntent,
          sessionId,
          attachedFiles,
          onProgress: (patch) => set(patch),
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ error: msg, lastMessage: '写入流程异常中止。' })
    } finally {
      set({ running: false, stopRequested: false })
    }
  },
}))

// =============================================================
//  Single-call modes (draft / append)
// =============================================================

async function runSingleCall(args: {
  doc: Document
  mode: 'draft' | 'append'
  targetKind: WritingTargetKind
  targetId: string
  userIntent: string
  sessionId: string
  attachedFiles: AttachedFile[]
  onProgress: (patch: Partial<WritingState>) => void
}): Promise<void> {
  const { doc, mode, targetKind, targetId, userIntent, sessionId, attachedFiles, onProgress } = args
  const range = { from: 0, to: doc.content.length }
  const contract = buildWriteContract(mode, doc.format)
  const includePreExisting = doc.content.trim().length > 0
  const query = buildSingleCallQuery({
    doc,
    mode,
    userIntent,
    contract,
    includePreExisting,
    attachedFiles,
  })
  const effectiveInstruction = `${contract}\n\n${userIntent}`
  const body = makeBody({
    doc,
    range,
    sessionId,
    writeMode: mode,
    targetText: includePreExisting ? doc.content : '',
    instruction: effectiveInstruction,
    query,
    attachedFiles,
  })

  onProgress({ total: 1, currentIndex: 1 })
  const failed = await dispatchAgent({ targetKind, targetId, body })
  if (failed) {
    onProgress({ error: failed, lastMessage: '写入失败。' })
    return
  }

  const events = useWorkflowStore.getState().lastRunEvents[targetId] ?? []
  const raw = extractRawOutput(events)
  if (!raw) {
    onProgress({ lastMessage: 'Agent 未产出可写入内容（输出为空）。' })
    return
  }
  const fenced = extractFencedBlock(raw)
  const written = applyWriteOutput({
    docId: doc.id,
    mode: mode === 'append' ? 'append' : 'replace-doc',
    range,
    text: fenced.text,
  })
  onProgress({
    completed: 1,
    lastWriteChars: written,
    lastMessage: fenced.fallback
      ? `已写入 ${written} 字（注意：未识别到代码围栏，已直接写入完整原文）。`
      : `写入完成：${written} 字。`,
  })
}

// =============================================================
//  Polish loop
// =============================================================

async function runPolishLoop(args: {
  doc: Document
  targetKind: WritingTargetKind
  targetId: string
  userIntent: string
  sessionId: string
  attachedFiles: AttachedFile[]
  isStopRequested: () => boolean
  onProgress: (patch: Partial<WritingState>) => void
}): Promise<void> {
  const {
    doc, targetKind, targetId, userIntent, sessionId, attachedFiles, isStopRequested, onProgress,
  } = args
  const chunks = buildParagraphChunks(doc, POLISH_CHUNK_CHARS)
  if (chunks.length === 0) {
    onProgress({ error: '当前文档没有可润色的段落。' })
    return
  }
  onProgress({ total: chunks.length, currentIndex: 0, completed: 0 })

  let cumulativeDelta = 0
  let okCount = 0
  let totalWritten = 0
  let firstFallback = false

  for (let i = 0; i < chunks.length; i += 1) {
    if (isStopRequested()) {
      onProgress({ lastMessage: `已停止，完成 ${okCount}/${chunks.length} 段。` })
      break
    }
    const chunk = chunks[i]
    onProgress({
      currentIndex: i + 1,
      lastMessage: `正在润色第 ${i + 1}/${chunks.length} 段…`,
    })

    const adjustedRange = {
      from: chunk.range.from + cumulativeDelta,
      to: chunk.range.to + cumulativeDelta,
    }

    // 重新读取该范围的当前文本，作为最新原文给 agent（可能因之前段落的写入有局部改动）
    const liveText = readCurrentText(doc.id, adjustedRange)
    const query = buildPolishQuery({
      doc,
      chunk: { ...chunk, text: liveText || chunk.text },
      userIntent,
      attachedFiles,
    })
    const effectiveInstruction = `${buildWriteContract('polish-paragraphs', doc.format)}\n\n${userIntent}`
    const body = makeBody({
      doc,
      range: adjustedRange,
      sessionId,
      writeMode: 'polish-paragraphs',
      targetText: liveText || chunk.text,
      instruction: effectiveInstruction,
      query,
      attachedFiles,
      paragraphIndex: i + 1,
      paragraphTotal: chunks.length,
      sectionTitle: chunk.sectionTitle,
    })

    const failed = await dispatchAgent({ targetKind, targetId, body })
    if (failed) {
      onProgress({
        error: failed,
        lastMessage: `第 ${i + 1} 段润色失败，已停止。`,
      })
      return
    }
    const events = useWorkflowStore.getState().lastRunEvents[targetId] ?? []
    const raw = extractRawOutput(events)
    if (!raw) {
      onProgress({ lastMessage: `第 ${i + 1} 段：Agent 输出为空，已跳过。` })
      continue
    }
    const fenced = extractFencedBlock(raw)
    if (fenced.fallback && !firstFallback) firstFallback = true

    const oldLen = adjustedRange.to - adjustedRange.from
    const written = applyWriteOutput({
      docId: doc.id,
      mode: 'replace-range',
      range: adjustedRange,
      text: fenced.text,
    })
    cumulativeDelta += written - oldLen
    totalWritten += written
    okCount += 1
    onProgress({
      completed: okCount,
      lastWriteChars: totalWritten,
      lastMessage: `已完成第 ${i + 1}/${chunks.length} 段（写入 ${written} 字）。`,
    })
  }

  if (!isStopRequested()) {
    onProgress({
      lastMessage: firstFallback
        ? `润色完成：${okCount}/${chunks.length} 段，共 ${totalWritten} 字（部分段落未识别围栏，已写入原文）。`
        : `润色完成：${okCount}/${chunks.length} 段，共 ${totalWritten} 字。`,
    })
  }
}

// =============================================================
//  Agent dispatch
// =============================================================

async function dispatchAgent(args: {
  targetKind: WritingTargetKind
  targetId: string
  body: Record<string, unknown>
}): Promise<string | null> {
  const { targetKind, targetId, body } = args
  const workflow = useWorkflowStore.getState()
  let failed: string | null = null
  if (targetKind === 'workflow') {
    await workflow.executeDefinition(targetId, body as never, {
      autoIngestToAnnotations: false,
      onFailed: (error) => { failed = error },
    })
  } else {
    await workflow.run(targetId, body as never, {
      autoIngestToAnnotations: false,
      onFailed: (error) => { failed = error },
    })
    const events = useWorkflowStore.getState().lastRunEvents[targetId] ?? []
    const last = events[events.length - 1]
    if (!failed && last?.kind === 'ylw.run.failed') {
      const payload = last.payload as { error?: string } | string
      failed = typeof payload === 'string' ? payload : payload.error ?? 'Agent run failed'
    }
  }
  return failed
}

// =============================================================
//  Body & query builders
// =============================================================

function makeBody(args: {
  doc: Document
  range: { from: number; to: number }
  sessionId: string
  writeMode: WritingMode
  targetText: string
  instruction: string
  query: string
  attachedFiles: AttachedFile[]
  paragraphIndex?: number
  paragraphTotal?: number
  sectionTitle?: string
}): Record<string, unknown> {
  const contextFiles = args.attachedFiles.map((file) => ({
    name: file.path || file.name,
    document_id: file.path || file.name,
    content: contextFileContent(file),
  }))
  return {
    document_id: args.doc.id,
    range_start: args.range.from,
    range_end: args.range.to,
    conversation_id: args.sessionId,
    inputs: {
      write_mode: args.writeMode,
      automation_output_mode: 'write', // legacy compat
      target_text: args.targetText,
      instruction: args.instruction,
      attached_files: args.attachedFiles,
      doc_format: args.doc.format,
      paragraph_index: args.paragraphIndex ?? 0,
      paragraph_total: args.paragraphTotal ?? 0,
      section_title: args.sectionTitle ?? '',
    },
    query: args.query,
    context_files: contextFiles,
  }
}

function buildSingleCallQuery(args: {
  doc: Document
  mode: 'draft' | 'append'
  userIntent: string
  contract: string
  includePreExisting: boolean
  attachedFiles: AttachedFile[]
}): string {
  const fenceFormat = pickFenceFormat(args.doc.format)
  const lines: string[] = [
    args.contract,
    '',
    `[USER INTENT]`,
    args.userIntent,
    '',
    `[WRITE MODE] ${args.mode}`,
    `[DOC FORMAT] ${args.doc.format} (输出围栏建议使用 \`\`\`${fenceFormat}\`\`\`)`,
  ]
  if (args.includePreExisting) {
    lines.push(
      '',
      args.mode === 'append' ? '[EXISTING DOCUMENT — APPEND AFTER THIS]' : '[PRE-EXISTING TEXT]',
      args.doc.content,
      args.mode === 'append' ? '[END EXISTING DOCUMENT]' : '[END PRE-EXISTING TEXT]',
    )
  }
  if (args.attachedFiles.length > 0) {
    lines.push('', renderAttachedFilesForPrompt(args.attachedFiles))
  }
  return lines.join('\n')
}

function buildPolishQuery(args: {
  doc: Document
  chunk: WriteChunk
  userIntent: string
  attachedFiles: AttachedFile[]
}): string {
  const fenceFormat = pickFenceFormat(args.doc.format)
  const lines: string[] = [
    buildWriteContract('polish-paragraphs', args.doc.format),
    '',
    `[USER INTENT]`,
    args.userIntent,
    '',
    `[WRITE MODE] polish-paragraphs`,
    `[DOC FORMAT] ${args.doc.format} (输出围栏建议使用 \`\`\`${fenceFormat}\`\`\`)`,
    `[PARAGRAPH] ${args.chunk.index}/${args.chunk.total}`,
    args.chunk.sectionTitle ? `[SECTION] ${args.chunk.sectionTitle}` : '',
    '',
    '[FULL DOCUMENT FOR CONTEXT]',
    args.doc.content,
    '[END FULL DOCUMENT]',
    '',
    '[TARGET PARAGRAPH TO POLISH]',
    args.chunk.text,
    '[END TARGET PARAGRAPH]',
  ].filter((l) => l !== '')
  if (args.attachedFiles.length > 0) {
    lines.push('', renderAttachedFilesForPrompt(args.attachedFiles))
  }
  return lines.join('\n')
}

function pickFenceFormat(format: DocumentFormat): string {
  if (format === 'tex') return 'latex'
  if (format === 'md') return 'markdown'
  return 'text'
}

// =============================================================
//  Output extraction
// =============================================================

function extractRawOutput(
  events: ReturnType<typeof useWorkflowStore.getState>['lastRunEvents'][string],
): string {
  if (!events) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i]
    if (evt.kind !== 'ylw.run.finished' && evt.kind !== 'workflow.completed') continue
    const payload = evt.payload as { outputs?: unknown } | unknown
    const outputs = (payload as { outputs?: unknown })?.outputs ?? payload
    const text = pickStringField(outputs, ['text', 'answer', 'result', 'content', 'output'])
    if (text) return text
  }
  let accumulated = ''
  for (const evt of events) {
    if (evt.kind !== 'native.agent.output.delta') continue
    const payload = evt.payload as { delta?: string; text?: string } | unknown
    const delta = (payload as { delta?: string })?.delta
      ?? (payload as { text?: string })?.text
      ?? ''
    if (typeof delta === 'string') accumulated += delta
  }
  return accumulated.trim()
}

function pickStringField(obj: unknown, keys: string[]): string {
  if (typeof obj === 'string') return obj.trim()
  if (!obj || typeof obj !== 'object') return ''
  const record = obj as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const FENCE_RE = /```(?:[a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)\n```/

function extractFencedBlock(raw: string): { text: string; fallback: boolean } {
  const m = FENCE_RE.exec(raw)
  if (m && m[1]) {
    return { text: m[1].trim(), fallback: false }
  }
  return { text: raw.trim(), fallback: true }
}

// =============================================================
//  Write back (collab-aware)
// =============================================================

type ApplyMode = 'replace-doc' | 'append' | 'replace-range'

function readCurrentText(docId: string, range: { from: number; to: number }): string {
  const collab = useCollaborationStore.getState()
  if (collab.provider && collab.currentDocId === docId) {
    const text = collab.provider.yText.toString()
    return text.slice(range.from, Math.min(range.to, text.length))
  }
  const live = useDocumentStore.getState().documents[docId]?.content ?? ''
  return live.slice(range.from, Math.min(range.to, live.length))
}

function applyWriteOutput(args: {
  docId: string
  mode: ApplyMode
  range: { from: number; to: number }
  text: string
}): number {
  const collab = useCollaborationStore.getState()
  const yText =
    collab.provider && collab.currentDocId === args.docId
      ? collab.provider.yText
      : null

  if (yText) {
    const ydoc = collab.provider!.doc
    const liveLen = yText.length
    const liveText = yText.toString()
    // eslint-disable-next-line no-console
    console.log('[writingStore] applyWriteOutput via yText', {
      mode: args.mode,
      docId: args.docId,
      yTextLen: liveLen,
      writeChars: args.text.length,
      range: args.range,
    })
    let written = args.text.length
    ydoc.transact(() => {
      switch (args.mode) {
        case 'replace-doc':
          if (liveLen > 0) yText.delete(0, liveLen)
          if (args.text.length > 0) yText.insert(0, args.text)
          break
        case 'append': {
          const trimmed = liveText.replace(/\s+$/u, '')
          const trailingDropped = liveLen - trimmed.length
          if (trailingDropped > 0) yText.delete(trimmed.length, trailingDropped)
          const sep = trimmed.length > 0 ? '\n\n' : ''
          yText.insert(trimmed.length, sep + args.text)
          written = sep.length + args.text.length
          break
        }
        case 'replace-range': {
          const from = Math.max(0, Math.min(args.range.from, liveLen))
          const to = Math.max(from, Math.min(args.range.to, liveLen))
          if (to > from) yText.delete(from, to - from)
          if (args.text.length > 0) yText.insert(from, args.text)
          break
        }
      }
    })
    return written
  }

  const docStore = useDocumentStore.getState()
  const live = docStore.documents[args.docId]?.content ?? ''
  // eslint-disable-next-line no-console
  console.log('[writingStore] applyWriteOutput via documentStore', {
    mode: args.mode,
    docId: args.docId,
    liveLen: live.length,
    writeChars: args.text.length,
    range: args.range,
  })
  let next: string
  let written = args.text.length
  switch (args.mode) {
    case 'replace-doc':
      next = args.text
      break
    case 'append': {
      const trimmed = live.replace(/\s+$/u, '')
      const sep = trimmed.length > 0 ? '\n\n' : ''
      next = trimmed + sep + args.text
      written = sep.length + args.text.length
      break
    }
    case 'replace-range': {
      const liveLen = live.length
      const from = Math.max(0, Math.min(args.range.from, liveLen))
      const to = Math.max(from, Math.min(args.range.to, liveLen))
      next = live.slice(0, from) + args.text + live.slice(to)
      break
    }
  }
  docStore.updateContent(args.docId, next)
  return written
}

// =============================================================
//  Paragraph chunking (self-contained — no shared state with
//  automationStore; we keep it independent on purpose)
// =============================================================

function buildParagraphChunks(doc: Document, maxChars: number): WriteChunk[] {
  const paragraphs = [...(doc.structure.paragraphs ?? [])]
    .filter((p) => p.text.trim().length > 0)
    .filter((p) => shouldIncludeParagraph(doc, p))
    .sort((a, b) => a.range.from - b.range.from)

  const raw = paragraphs.flatMap((p) => splitParagraph(doc, p, maxChars))
  return raw.map((c, idx) => ({ ...c, index: idx + 1, total: raw.length }))
}

function shouldIncludeParagraph(doc: Document, paragraph: Paragraph): boolean {
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
): Array<Omit<WriteChunk, 'index' | 'total'>> {
  if (paragraph.text.length <= maxChars) {
    return [{
      range: paragraph.range,
      text: paragraph.text,
      sectionTitle: sectionTitleAt(doc.structure.sections, paragraph.range.from),
    }]
  }
  const out: Array<Omit<WriteChunk, 'index' | 'total'>> = []
  let cursor = paragraph.range.from
  while (cursor < paragraph.range.to) {
    const desiredEnd = Math.min(cursor + maxChars, paragraph.range.to)
    const end = findSplitPoint(doc.content, cursor, desiredEnd, paragraph.range.to)
    out.push({
      range: { from: cursor, to: end },
      text: doc.content.slice(cursor, end),
      sectionTitle: sectionTitleAt(doc.structure.sections, cursor),
    })
    cursor = skipWhitespace(doc.content, end, paragraph.range.to)
  }
  return out
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

export function countPolishableParagraphs(doc: Document): number {
  return (doc.structure.paragraphs ?? [])
    .filter((p) => p.text.trim().length > 0)
    .filter((p) => shouldIncludeParagraph(doc, p))
    .length
}

// =============================================================
//  Mention resolution & attached file rendering
// =============================================================

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
      console.warn('[writingStore] failed to fetch @mentioned file', file.path, error)
    },
  })
  return {
    instruction: stripMentions(rawInstruction, mentions).trim(),
    attachedFiles,
  }
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

function makeSessionId(docId: string): string {
  return `write-${docId}-${Date.now().toString(36)}`
}
