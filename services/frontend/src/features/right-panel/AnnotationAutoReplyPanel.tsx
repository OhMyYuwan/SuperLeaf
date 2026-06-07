import { useEffect, useMemo, useState } from 'react'
import { FileText, MessageCircle, Play } from 'lucide-react'
import { useAnnotationStore } from '../../stores/annotationStore'
import {
  latestSuggestion,
  useAnnotationAgentSuggestionStore,
} from '../../stores/annotationAgentSuggestionStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useNativeAgentStore } from '../../stores/nativeAgentStore'
import { showToast } from '../shared/toast'

export function AnnotationAutoReplyPanel() {
  const activeDoc = useDocumentStore((s) => s.getActive())
  const annotationsById = useAnnotationStore((s) => s.items)
  const nativeAgents = useNativeAgentStore((s) => s.agents)
  const nativeLoaded = useNativeAgentStore((s) => s.loaded)
  const nativeError = useNativeAgentStore((s) => s.error)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const suggestionsByAnnotation = useAnnotationAgentSuggestionStore((s) => s.suggestionsByAnnotation)
  const runningByDoc = useAnnotationAgentSuggestionStore((s) => s.runningByDoc)
  const lastRunByDoc = useAnnotationAgentSuggestionStore((s) => s.lastRunByDoc)
  const runAutoReply = useAnnotationAgentSuggestionStore((s) => s.runAutoReply)
  const hydrateSuggestions = useAnnotationAgentSuggestionStore((s) => s.hydrateForDoc)

  const [agentId, setAgentId] = useState('')
  const [includeStale, setIncludeStale] = useState(true)

  const activeDocId = activeDoc?.id
  const availableAgents = useMemo(
    () => nativeAgents.filter((agent) => agent.is_enabled),
    [nativeAgents],
  )
  const selectedAgentId = agentId || availableAgents[0]?.id || ''
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

  useEffect(() => {
    if (!nativeLoaded) void loadNativeAgents()
  }, [nativeLoaded, loadNativeAgents])

  useEffect(() => {
    if (!activeDocId) return
    void hydrateSuggestions(activeDocId)
  }, [activeDocId, hydrateSuggestions])

  const handleRun = async () => {
    if (!activeDoc || !selectedAgentId) return
    const result = await runAutoReply(activeDoc.id, selectedAgentId, { includeStale })
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
          <span>Agent</span>
          <select
            value={selectedAgentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={running || availableAgents.length === 0}
          >
            {availableAgents.length === 0 && <option value="">暂无可用原生 Agent</option>}
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
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
      {nativeError && <div className="automation-error">{nativeError}</div>}

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
