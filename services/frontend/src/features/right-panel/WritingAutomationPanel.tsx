import { useEffect, useMemo } from 'react'
import { FileText, Pen, Play, Square } from 'lucide-react'
import { useDocumentStore } from '../../stores/documentStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import {
  countPolishableParagraphs,
  useWritingStore,
  type WritingMode,
} from '../../stores/writingStore'
import {
  flattenFileCandidates,
  sortFilesCurrentFirst,
  type MentionCandidate,
} from '../../services/mentions'
import { MentionCodeMirrorInput } from '../shared/MentionCodeMirrorInput'
import { confirmLargeFileAttachment } from '../shared/fileSizeGate'

export function WritingAutomationPanel() {
  const activeDoc = useDocumentStore((s) => s.getActive())
  const tree = useFilesystemStore((s) => s.tree)
  const loadTree = useFilesystemStore((s) => s.loadTree)
  const workflows = useWorkflowStore((s) => s.workflows)
  const workflowsLoaded = useWorkflowStore((s) => s.loaded)
  const loadWorkflows = useWorkflowStore((s) => s.load)
  const definitions = useWorkflowStore((s) => s.definitions)
  const definitionsLoaded = useWorkflowStore((s) => s.definitionsLoaded)
  const loadDefinitions = useWorkflowStore((s) => s.loadDefinitions)

  const targetKind = useWritingStore((s) => s.targetKind)
  const targetId = useWritingStore((s) => s.targetId)
  const instruction = useWritingStore((s) => s.instruction)
  const mode = useWritingStore((s) => s.mode)
  const running = useWritingStore((s) => s.running)
  const currentIndex = useWritingStore((s) => s.currentIndex)
  const total = useWritingStore((s) => s.total)
  const completed = useWritingStore((s) => s.completed)
  const error = useWritingStore((s) => s.error)
  const lastMessage = useWritingStore((s) => s.lastMessage)
  const lastWriteChars = useWritingStore((s) => s.lastWriteChars)
  const setTargetKind = useWritingStore((s) => s.setTargetKind)
  const setTargetId = useWritingStore((s) => s.setTargetId)
  const setInstruction = useWritingStore((s) => s.setInstruction)
  const setMode = useWritingStore((s) => s.setMode)
  const start = useWritingStore((s) => s.start)
  const stop = useWritingStore((s) => s.stop)

  const availableAgents = workflows.filter((wf) => !wf.is_disabled)
  const availableTargets = targetKind === 'agent' ? availableAgents : definitions
  const fileCandidates = useMemo(
    () => sortFilesCurrentFirst(flattenFileCandidates(tree), activeDoc?.id ?? null),
    [tree, activeDoc?.id],
  )

  useEffect(() => {
    if (!workflowsLoaded) void loadWorkflows()
    if (!definitionsLoaded) void loadDefinitions()
  }, [workflowsLoaded, definitionsLoaded, loadWorkflows, loadDefinitions])

  useEffect(() => {
    if (!tree) void loadTree()
  }, [tree, loadTree])

  useEffect(() => {
    if (targetId || availableTargets.length === 0) return
    setTargetId(availableTargets[0].id)
  }, [targetId, availableTargets, setTargetId])

  const handleCandidatePicked = (candidate: MentionCandidate): boolean => {
    if (candidate.kind === 'file') return confirmLargeFileAttachment(candidate)
    return true
  }

  const docCharCount = activeDoc?.content.length ?? 0
  const docHasContent = docCharCount > 0
  const polishParagraphCount = activeDoc ? countPolishableParagraphs(activeDoc) : 0
  const isPolish = mode === 'polish-paragraphs'
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0

  const startDisabled =
    !activeDoc
    || !targetId
    || !instruction.trim()
    || running
    || (isPolish && polishParagraphCount === 0)

  return (
    <>
      <div className="automation-tab-header">
        <div>
          <p>把文档作为上下文，让 Agent 起草、润色或追加内容，结果实时写入文档。</p>
        </div>
      </div>

      <div className="automation-status-grid">
        <div>
          <span><FileText size={12} /> 当前文档</span>
          <strong>{activeDoc?.metadata.title || '未打开文档'}</strong>
        </div>
        <div>
          <span>{isPolish ? '可润色段落' : '文档字数'}</span>
          <strong>{isPolish ? polishParagraphCount : docCharCount}</strong>
        </div>
      </div>

      <div className="automation-control-grid">
        <label>
          <span>目标类型</span>
          <select
            value={targetKind}
            onChange={(event) => setTargetKind(event.target.value as 'agent' | 'workflow')}
            disabled={running}
          >
            <option value="agent">Agent</option>
            <option value="workflow">Workflow</option>
          </select>
        </label>

        <label>
          <span>{targetKind === 'agent' ? 'Agent' : 'Workflow'}</span>
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={running || availableTargets.length === 0}
          >
            {availableTargets.length === 0 && <option value="">暂无可用目标</option>}
            {availableTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="automation-field narrow">
        <span>写入模式</span>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as WritingMode)}
          disabled={running}
        >
          <option value="draft">全文起草（整体替换 / 起草到空白）</option>
          <option value="polish-paragraphs">逐段润色（按段落循环替换）</option>
          <option value="append">追加段落（输出加到文末）</option>
        </select>
      </label>

      {mode === 'draft' && docHasContent && (
        <div className="automation-message">注意：原内容会被 Agent 输出整体覆盖。</div>
      )}
      {mode === 'polish-paragraphs' && polishParagraphCount === 0 && (
        <div className="automation-message">当前文档没有可润色的段落（请先添加正文，或改用「全文起草」）。</div>
      )}

      <label className="automation-field">
        <span>自动写入意图</span>
        <MentionCodeMirrorInput
          value={instruction}
          onChange={setInstruction}
          files={fileCandidates}
          placeholder={
            mode === 'polish-paragraphs'
              ? '描述润色风格，例如「学术化、压缩冗长句，保留所有 \\cite 与 \\ref」…'
              : mode === 'append'
                ? '描述要追加的内容，例如「在末尾追加一个 Limitations 章节」…'
                : '描述要起草的内容，例如「起草一篇 ML 顶会论文初稿，包含完整章节」…'
          }
          rows={5}
          disabled={running}
          className="automation-intent-input"
          onCandidatePicked={handleCandidatePicked}
        />
      </label>

      {isPolish && (total > 0 || running) && (
        <div className="automation-progress">
          <div className="automation-progress-head">
            <span>{running ? `正在润色 ${currentIndex}/${total}` : `已完成 ${completed}/${total}`}</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="automation-progress-track">
            <div style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      {lastMessage && <div className="automation-message">{lastMessage}</div>}
      {error && <div className="automation-error">{error}</div>}

      <div className="automation-actions">
        {running && isPolish ? (
          <button className="ghost-btn small danger" onClick={stop}>
            <Square size={13} /> 停止
          </button>
        ) : (
          <button
            className="primary-btn"
            onClick={() => void start()}
            disabled={startDisabled}
          >
            <Play size={14} /> {running
              ? '正在写入…'
              : mode === 'polish-paragraphs'
                ? '开始逐段润色'
                : mode === 'append'
                  ? '开始追加'
                  : '开始全文起草'}
          </button>
        )}
        <span className="automation-hint">
          <Pen size={12} />
          {lastWriteChars > 0 && !running
            ? `上次共写入 ${lastWriteChars} 字。`
            : isPolish
              ? '逐段循环：每段单独提交并就地替换；可中途停止。'
              : '单次调用：把整篇文档一次性发给 Agent，输出在 ``` 围栏中提取后写入。'}
        </span>
      </div>
    </>
  )
}
