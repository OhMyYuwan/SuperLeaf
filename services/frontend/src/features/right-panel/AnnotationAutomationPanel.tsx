import { useEffect, useMemo } from 'react'
import { FileText, Play, Square, Workflow } from 'lucide-react'
import { countAutomationReviewTargets, useAutomationStore } from '../../stores/automationStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import {
  flattenFileCandidates,
  sortFilesCurrentFirst,
  type MentionCandidate,
} from '../../services/mentions'
import { MentionCodeMirrorInput } from '../shared/MentionCodeMirrorInput'
import { confirmLargeFileAttachment } from '../shared/fileSizeGate'
import { formatAutomationTargetName } from './automationTargetLabels'

export function AnnotationAutomationPanel() {
  const activeDoc = useDocumentStore((s) => s.getActive())
  const tree = useFilesystemStore((s) => s.tree)
  const loadTree = useFilesystemStore((s) => s.loadTree)
  const providers = useSettingsStore((s) => s.providers)
  const workflows = useWorkflowStore((s) => s.workflows)
  const workflowsLoaded = useWorkflowStore((s) => s.loaded)
  const loadWorkflows = useWorkflowStore((s) => s.load)
  const definitions = useWorkflowStore((s) => s.definitions)
  const definitionsLoaded = useWorkflowStore((s) => s.definitionsLoaded)
  const loadDefinitions = useWorkflowStore((s) => s.loadDefinitions)

  const targetKind = useAutomationStore((s) => s.targetKind)
  const targetId = useAutomationStore((s) => s.targetId)
  const instruction = useAutomationStore((s) => s.instruction)
  const maxChunkChars = useAutomationStore((s) => s.maxChunkChars)
  const fullContextEvery = useAutomationStore((s) => s.fullContextEvery)
  const running = useAutomationStore((s) => s.running)
  const currentIndex = useAutomationStore((s) => s.currentIndex)
  const total = useAutomationStore((s) => s.total)
  const completed = useAutomationStore((s) => s.completed)
  const error = useAutomationStore((s) => s.error)
  const lastMessage = useAutomationStore((s) => s.lastMessage)
  const sessionId = useAutomationStore((s) => s.sessionId)
  const sessionConversationId = useAutomationStore((s) => s.sessionConversationId)
  const sessionDocHash = useAutomationStore((s) => s.sessionDocHash)
  const setTargetKind = useAutomationStore((s) => s.setTargetKind)
  const setTargetId = useAutomationStore((s) => s.setTargetId)
  const setInstruction = useAutomationStore((s) => s.setInstruction)
  const setMaxChunkChars = useAutomationStore((s) => s.setMaxChunkChars)
  const setFullContextEvery = useAutomationStore((s) => s.setFullContextEvery)
  const start = useAutomationStore((s) => s.start)
  const stop = useAutomationStore((s) => s.stop)

  const availableAgents = workflows.filter((workflow) => !workflow.is_disabled)
  const availableTargets = targetKind === 'agent' ? availableAgents : definitions
  const providerNamesById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  )
  const paragraphCount = activeDoc ? countAutomationReviewTargets(activeDoc) : 0
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0
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

  return (
    <>
      <div className="automation-tab-header">
        <div>
          <p>按段落提交当前文档，让 Agent 或 workflow 连续生成批注。</p>
        </div>
      </div>

      <div className="automation-status-grid">
        <div className="automation-status-card automation-status-card-document">
          <span><FileText size={12} /> 当前文档</span>
          <strong>{activeDoc?.metadata.title || '未打开文档'}</strong>
        </div>
        <div className="automation-status-card automation-status-card-metric">
          <span>段落</span>
          <strong>{paragraphCount}</strong>
        </div>
      </div>

      {(sessionId || sessionDocHash) && (
        <div className="automation-session-card">
          <div>
            <span>Session</span>
            <code>{sessionId || '未启动'}</code>
          </div>
          <div>
            <span>Doc hash</span>
            <code>{sessionDocHash || '-'}</code>
          </div>
          <div>
            <span>Conversation</span>
            <code>{sessionConversationId || '等待首次返回'}</code>
          </div>
        </div>
      )}

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
                {formatAutomationTargetName(targetKind, target, providerNamesById)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="automation-field">
        <span>自动批注意图</span>
        <MentionCodeMirrorInput
          value={instruction}
          onChange={setInstruction}
          files={fileCandidates}
          placeholder="输入自动批注意图，用 @ 引用项目文件作为参考…"
          rows={4}
          disabled={running}
          className="automation-intent-input"
          onCandidatePicked={handleCandidatePicked}
        />
      </label>

      <label className="automation-field narrow">
        <span>超长段落保护（字符）</span>
        <input
          type="number"
          min={600}
          max={8000}
          step={200}
          value={maxChunkChars}
          onChange={(event) => setMaxChunkChars(Number(event.target.value))}
          disabled={running}
        />
      </label>

      <label className="automation-field narrow">
        <span>全文刷新间隔（段）</span>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={fullContextEvery}
          onChange={(event) => setFullContextEvery(Number(event.target.value))}
          disabled={running}
        />
      </label>

      <div className="automation-progress">
        <div className="automation-progress-head">
          <span>{running ? `正在审核 ${currentIndex}/${total}` : `已完成 ${completed}/${total || paragraphCount}`}</span>
          <span>{progressPercent}%</span>
        </div>
        <div className="automation-progress-track">
          <div style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      {lastMessage && <div className="automation-message">{lastMessage}</div>}
      {error && <div className="automation-error">{error}</div>}

      <div className="automation-actions">
        {running ? (
          <button className="ghost-btn small danger" onClick={stop}>
            <Square size={13} /> 停止
          </button>
        ) : (
          <button
            className="primary-btn"
            onClick={() => void start()}
            disabled={!activeDoc || !targetId || paragraphCount === 0}
          >
            <Play size={14} /> 开始自动批注
          </button>
        )}
        <span className="automation-hint">
          <Workflow size={12} />
          首段和每隔 N 段会重新提交全文；正文变化会自动暂停。
        </span>
      </div>
    </>
  )
}
