import { useEffect, useMemo, useState } from 'react'
import { FileText, MessageCircle, Play } from 'lucide-react'
import { useAnnotationStore } from '../../stores/annotationStore'
import {
  latestSuggestion,
  useAnnotationAgentSuggestionStore,
} from '../../stores/annotationAgentSuggestionStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { showToast } from '../shared/toast'
import { formatAutomationTargetName } from './automationTargetLabels'

type AutoReplyTargetKind = 'agent' | 'workflow'

export function AnnotationAutoReplyPanel() {
  const activeDoc = useDocumentStore((s) => s.getActive())
  const annotationsById = useAnnotationStore((s) => s.items)
  const providers = useSettingsStore((s) => s.providers)
  const workflows = useWorkflowStore((s) => s.workflows)
  const workflowsLoaded = useWorkflowStore((s) => s.loaded)
  const workflowsError = useWorkflowStore((s) => s.error)
  const loadWorkflows = useWorkflowStore((s) => s.load)
  const definitions = useWorkflowStore((s) => s.definitions)
  const definitionsLoaded = useWorkflowStore((s) => s.definitionsLoaded)
  const definitionsError = useWorkflowStore((s) => s.definitionsError)
  const loadDefinitions = useWorkflowStore((s) => s.loadDefinitions)
  const suggestionsByAnnotation = useAnnotationAgentSuggestionStore((s) => s.suggestionsByAnnotation)
  const runningByDoc = useAnnotationAgentSuggestionStore((s) => s.runningByDoc)
  const lastRunByDoc = useAnnotationAgentSuggestionStore((s) => s.lastRunByDoc)
  const runAutoReply = useAnnotationAgentSuggestionStore((s) => s.runAutoReply)
  const hydrateSuggestions = useAnnotationAgentSuggestionStore((s) => s.hydrateForDoc)

  const [agentId, setAgentId] = useState('')
  const [targetKind, setTargetKind] = useState<AutoReplyTargetKind>('agent')
  const [includeStale, setIncludeStale] = useState(true)

  const activeDocId = activeDoc?.id
  const availableAgents = useMemo(() => workflows.filter((workflow) => !workflow.is_disabled), [workflows])
  const availableTargets = targetKind === 'agent' ? availableAgents : definitions
  const providerNamesById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  )
  const selectedAgentId = agentId || availableTargets[0]?.id || ''
  const annotations = useMemo(() => {
    if (!activeDoc) return []
    return Object.values(annotationsById).filter(
      (item) =>
        item.documentId === activeDoc.id &&
        item.status !== 'archived' &&
        item.status !== 'deleted' &&
        item.status !== 'superseded',
    )
  }, [activeDoc, annotationsById])
  const staleCount = annotations.filter((item) =>
    latestSuggestion(suggestionsByAnnotation[item.id] ?? [])?.status === 'stale',
  ).length
  const draftedCount = annotations.filter((item) => {
    const status = latestSuggestion(suggestionsByAnnotation[item.id] ?? [])?.status
    return status === 'drafted' || status === 'ready' || status === 'published'
  }).length
  const unprocessedCount = annotations.length - annotations.filter((item) =>
    latestSuggestion(suggestionsByAnnotation[item.id] ?? [])?.status,
  ).length
  const running = activeDoc ? Boolean(runningByDoc[activeDoc.id]) : false
  const lastRun = activeDoc ? lastRunByDoc[activeDoc.id] : undefined
  const targetError = workflowsError || definitionsError

  useEffect(() => {
    if (!workflowsLoaded) void loadWorkflows()
    if (!definitionsLoaded) void loadDefinitions()
  }, [workflowsLoaded, definitionsLoaded, loadWorkflows, loadDefinitions])

  useEffect(() => {
    if (agentId || availableTargets.length === 0) return
    setAgentId(availableTargets[0].id)
  }, [agentId, availableTargets])

  useEffect(() => {
    if (!activeDocId) return
    void hydrateSuggestions(activeDocId)
  }, [activeDocId, hydrateSuggestions])

  const handleRun = async () => {
    if (!activeDoc || !selectedAgentId) return
    const result = await runAutoReply(activeDoc.id, selectedAgentId, { includeStale, targetKind })
    if (!result) return
    showToast(
      `自动回复完成：生成 ${result.processed} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`,
      { level: result.failed > 0 ? 'warning' : 'success' },
    )
  }

  return (
    <>
      <div className="automation-tab-header">
        <div>
          <p>为当前文档批注生成私有修改建议。</p>
        </div>
      </div>

      <div className="automation-status-grid">
        <div className="automation-status-card automation-status-card-document">
          <span><FileText size={12} /> 当前文档</span>
          <strong>{activeDoc?.metadata.title || '未打开文档'}</strong>
        </div>
        <div className="automation-status-card automation-status-card-metric">
          <span>批注</span>
          <strong>{annotations.length}</strong>
        </div>
      </div>

      <div className="automation-status-grid">
        <div className="automation-status-card">
          <span>未处理</span>
          <strong>{Math.max(0, unprocessedCount)}</strong>
        </div>
        <div className="automation-status-card">
          <span>已生成</span>
          <strong>{draftedCount}</strong>
        </div>
        <div className="automation-status-card">
          <span>已过期</span>
          <strong>{staleCount}</strong>
        </div>
      </div>

      <div className="automation-control-grid">
        <label>
          <span>目标类型</span>
          <select
            value={targetKind}
            onChange={(event) => {
              setTargetKind(event.target.value as AutoReplyTargetKind)
              setAgentId('')
            }}
            disabled={running}
          >
            <option value="agent">Agent</option>
            <option value="workflow">Workflow</option>
          </select>
        </label>
        <label>
          <span>{targetKind === 'agent' ? 'Agent' : 'Workflow'}</span>
          <select
            value={selectedAgentId}
            onChange={(event) => setAgentId(event.target.value)}
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

      <label className="automation-checkbox-row">
        <input
          type="checkbox"
          checked={includeStale}
          onChange={(event) => setIncludeStale(event.target.checked)}
          disabled={running}
        />
        <span>包含已过期建议</span>
      </label>

      {lastRun && (
        <div className="automation-message">
          上次生成 {lastRun.processed} 条，跳过 {lastRun.skipped} 条，失败 {lastRun.failed} 条。
        </div>
      )}
      {targetError && <div className="automation-error">{targetError}</div>}

      <div className="automation-actions">
        <button
          className="primary-btn"
          onClick={() => void handleRun()}
          disabled={!activeDoc || !selectedAgentId || annotations.length === 0 || running}
        >
          <Play size={14} /> {running ? '正在处理…' : '开始自动回复'}
        </button>
        <span className="automation-hint">
          <MessageCircle size={12} />
          建议默认只对你可见。
        </span>
      </div>
    </>
  )
}
