/**
 * EvaluationPanel — collapsible card-internal section for rating a single
 * Agent output (V3 Phase 4 task 4.1).
 *
 * Two modes:
 *   - summary row (collapsed): shows verdict icon + up to 3 tag pills +
 *     relative time of the latest evaluation
 *   - editor (expanded): verdict buttons, reason textarea, tag picker
 *     (base tags + historical tags + custom input), adoption dropdown,
 *     training-candidate checkbox
 *
 * Saving keeps the panel expanded so users can batch multiple evaluations
 * without the UX collapsing between them (the plan doc §333 requires this).
 */

import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Pencil, Trash2, X } from 'lucide-react'
import {
  useAnnotationStore,
  type AgentEvaluation,
  type EvaluationAdoption,
  type EvaluationVerdict,
} from '../../stores/annotationStore'
import { useDocumentStore } from '../../stores/documentStore'
import { captureEvaluationContext } from '../../services/evaluationContext'
import { TagPill, type TagCategory } from '../shared/TagPill'

const BASE_TAGS: { label: string; category: TagCategory }[] = [
  // positive
  { label: '高价值', category: 'positive' },
  { label: '可操作', category: 'positive' },
  { label: '定位准确', category: 'positive' },
  { label: '解释清楚', category: 'positive' },
  { label: '可直接采用', category: 'positive' },
  { label: '节省时间', category: 'positive' },
  // negative
  { label: '太泛', category: 'negative' },
  { label: '不准确', category: 'negative' },
  { label: '幻觉风险', category: 'negative' },
  { label: '不可操作', category: 'negative' },
  { label: '重复', category: 'negative' },
  { label: '没看上下文', category: 'negative' },
  { label: '格式错误', category: 'negative' },
  { label: '过长', category: 'negative' },
  { label: '过短', category: 'negative' },
  // usage
  { label: '需要补引用', category: 'usage' },
  { label: '需要补实验', category: 'usage' },
  { label: '需要补动机', category: 'usage' },
  { label: '需要补定义', category: 'usage' },
  { label: '需要重写表达', category: 'usage' },
  { label: '需要压缩', category: 'usage' },
]

const BASE_TAG_LOOKUP: Record<string, TagCategory> = (() => {
  const m: Record<string, TagCategory> = {}
  for (const t of BASE_TAGS) m[t.label.toLowerCase()] = t.category
  return m
})()

const ADOPTION_OPTIONS: { value: EvaluationAdoption; label: string }[] = [
  { value: 'unknown', label: '未知' },
  { value: 'used', label: '已采用' },
  { value: 'partially_used', label: '部分采用' },
  { value: 'not_used', label: '未采用' },
  { value: 'later', label: '待定' },
]

const EMPTY_EVALUATIONS: AgentEvaluation[] = []

interface EvaluationPanelProps {
  annotationId: string
  /** thread message id when evaluating a specific Agent turn; defaults to
   *  annotationId when evaluating the annotation headline. */
  defaultTargetId?: string
  defaultTargetType?: AgentEvaluation['targetType']
  /** Hide the editor form; only show the saved evaluation list. */
  readOnly?: boolean
}

export function EvaluationPanel({
  annotationId,
  defaultTargetId,
  defaultTargetType = 'agent_output',
  readOnly = false,
}: EvaluationPanelProps) {
  const evaluations = useAnnotationStore(
    (s) => s.evaluationsByAnnotation[annotationId] ?? EMPTY_EVALUATIONS,
  )
  const annotationItem = useAnnotationStore((s) => s.items[annotationId])
  const addEvaluation = useAnnotationStore((s) => s.addEvaluation)
  const updateEvaluation = useAnnotationStore((s) => s.updateEvaluation)
  const deleteEvaluation = useAnnotationStore((s) => s.deleteEvaluation)
  const allTags = useAnnotationStore((s) => s.allEvaluationTags)

  const historicalTags = useMemo(() => {
    const baseSet = new Set(BASE_TAGS.map((t) => t.label.toLowerCase()))
    return allTags().filter((t) => !baseSet.has(t.toLowerCase()))
  }, [allTags, evaluations.length])

  const [expanded, setExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<EvaluationVerdict | null>(null)
  const [reason, setReason] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [adoption, setAdoption] = useState<EvaluationAdoption>('unknown')
  const [trainingCandidate, setTrainingCandidate] = useState<boolean | null>(null)
  const [customTagInput, setCustomTagInput] = useState('')

  const resetForm = () => {
    setEditingId(null)
    setVerdict(null)
    setReason('')
    setTags([])
    setAdoption('unknown')
    setTrainingCandidate(null)
    setCustomTagInput('')
  }

  const loadEvaluationIntoForm = (ev: AgentEvaluation) => {
    setEditingId(ev.id)
    setVerdict(ev.verdict)
    setReason(ev.reason)
    setTags(ev.tags)
    setAdoption(ev.adoption)
    setTrainingCandidate(ev.trainingCandidate)
    setCustomTagInput('')
    setExpanded(true)
  }

  const toggleTag = (label: string) => {
    const cleaned = label.replace(/^#+/, '').trim()
    if (!cleaned) return
    const lower = cleaned.toLowerCase()
    setTags((prev) => {
      const idx = prev.findIndex((t) => t.toLowerCase() === lower)
      return idx >= 0 ? prev.filter((_, i) => i !== idx) : [...prev, cleaned]
    })
  }

  const addCustomTag = () => {
    const cleaned = customTagInput.replace(/^#+/, '').trim()
    if (!cleaned) return
    const lower = cleaned.toLowerCase()
    if (!tags.some((t) => t.toLowerCase() === lower)) {
      setTags((prev) => [...prev, cleaned])
    }
    setCustomTagInput('')
  }

  const canSave = verdict !== null && reason.trim().length > 0

  const handleSave = () => {
    if (!canSave || verdict === null) return
    const effectiveTraining =
      trainingCandidate ?? (verdict === 'positive' && reason.trim().length > 0)

    const doc = annotationItem
      ? useDocumentStore.getState().documents[annotationItem.documentId] ?? null
      : null
    const context =
      annotationItem && !readOnly
        ? captureEvaluationContext(annotationItem, doc)
        : {}

    if (editingId) {
      updateEvaluation(annotationId, editingId, {
        verdict,
        reason: reason.trim(),
        tags,
        adoption,
        trainingCandidate: effectiveTraining,
        context,
      })
    } else if (annotationItem) {
      addEvaluation(
        annotationId,
        {
          targetType: defaultTargetType,
          targetId: defaultTargetId ?? annotationId,
          verdict,
          reason: reason.trim(),
          tags,
          adoption,
          trainingCandidate: effectiveTraining,
          context,
        },
        annotationItem.documentId,
      )
    }
    // Keep the panel expanded after save per plan doc §333; just reset the
    // form so the user can add another eval.
    resetForm()
  }

  const latest = evaluations[evaluations.length - 1]

  return (
    <div className="eval-panel" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="eval-panel-header"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="eval-panel-title">
          Agent 评价 {evaluations.length > 0 ? `· ${evaluations.length} 条` : ''}
        </span>
        {!expanded && latest && (
          <span className="eval-panel-summary">
            <span className={`eval-verdict-mini eval-verdict-${latest.verdict}`}>
              {latest.verdict === 'positive' ? '✅' : '❎'}
            </span>
            {latest.tags.slice(0, 3).map((t) => (
              <TagPill
                key={t}
                label={t}
                category={BASE_TAG_LOOKUP[t.toLowerCase()] ?? 'custom'}
                compact
              />
            ))}
            {latest.tags.length > 3 && (
              <span className="eval-more">+{latest.tags.length - 3}</span>
            )}
            <span className="eval-time-dim">· {relativeTime(latest.updatedAt)}</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="eval-panel-body">
          {evaluations.length > 0 && (
            <ul className="eval-list">
              {evaluations.map((ev) => (
                <li key={ev.id} className="eval-row">
                  <span className={`eval-verdict-mini eval-verdict-${ev.verdict}`}>
                    {ev.verdict === 'positive' ? '✅' : '❎'}
                  </span>
                  <div className="eval-row-main">
                    <div className="eval-row-reason">{ev.reason}</div>
                    {ev.tags.length > 0 && (
                      <div className="eval-row-tags">
                        {ev.tags.map((t) => (
                          <TagPill
                            key={t}
                            label={t}
                            category={BASE_TAG_LOOKUP[t.toLowerCase()] ?? 'custom'}
                            compact
                          />
                        ))}
                      </div>
                    )}
                    <div className="eval-row-meta">
                      {adoptionLabel(ev.adoption)} · {relativeTime(ev.updatedAt)}
                      {ev.trainingCandidate ? ' · 已加入训练数据集' : ''}
                    </div>
                  </div>
                  <div className="eval-row-actions">
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          className="eval-icon-btn"
                          title="编辑"
                          onClick={() => loadEvaluationIntoForm(ev)}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          className="eval-icon-btn danger"
                          title="删除"
                          onClick={() => {
                            if (confirm('删除这条评价？')) {
                              deleteEvaluation(annotationId, ev.id)
                              if (editingId === ev.id) resetForm()
                            }
                          }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="eval-form">
            {readOnly ? (
              evaluations.length === 0 && (
                <div className="eval-empty">尚无评价</div>
              )
            ) : (
              <>
                <div className="eval-field">
                  <label className="eval-label">评价</label>
                  <div className="eval-verdict-row">
                    <button
                      type="button"
                      className={`eval-verdict-btn positive ${verdict === 'positive' ? 'is-active' : ''}`}
                      onClick={() => setVerdict('positive')}
                    >
                      ✅ 有用
                    </button>
                    <button
                      type="button"
                      className={`eval-verdict-btn negative ${verdict === 'negative' ? 'is-active' : ''}`}
                      onClick={() => setVerdict('negative')}
                    >
                      ❎ 无用
                    </button>
                  </div>
                </div>

            <div className="eval-field">
              <label className="eval-label" htmlFor={`eval-reason-${annotationId}`}>
                一句话原因 <span className="eval-required">*</span>
              </label>
              <textarea
                id={`eval-reason-${annotationId}`}
                className="eval-reason"
                rows={2}
                placeholder="比如：指出了 Method 缺少动机解释"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>

            <div className="eval-field">
              <label className="eval-label" htmlFor={`eval-adoption-${annotationId}`}>
                采用情况
              </label>
              <select
                id={`eval-adoption-${annotationId}`}
                className="eval-select"
                value={adoption}
                onChange={(e) => setAdoption(e.target.value as EvaluationAdoption)}
              >
                {ADOPTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="eval-field">
              <label className="eval-label">基础标签</label>
              <div className="eval-tag-grid">
                {BASE_TAGS.map((t) => {
                  const active = tags.some((s) => s.toLowerCase() === t.label.toLowerCase())
                  return (
                    <TagPill
                      key={t.label}
                      label={t.label}
                      category={t.category}
                      active={active}
                      onClick={() => toggleTag(t.label)}
                    />
                  )
                })}
              </div>
            </div>

            {historicalTags.length > 0 && (
              <div className="eval-field">
                <label className="eval-label">历史标签（点击追加）</label>
                <div className="eval-tag-grid">
                  {historicalTags.map((t) => {
                    const active = tags.some((s) => s.toLowerCase() === t.toLowerCase())
                    return (
                      <TagPill
                        key={t}
                        label={t}
                        active={active}
                        onClick={() => toggleTag(t)}
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {tags.length > 0 && (
              <div className="eval-field">
                <label className="eval-label">已选</label>
                <div className="eval-tag-grid">
                  {tags.map((t) => (
                    <TagPill
                      key={t}
                      label={t}
                      category={BASE_TAG_LOOKUP[t.toLowerCase()] ?? 'custom'}
                      onRemove={() => toggleTag(t)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="eval-field">
              <label className="eval-label" htmlFor={`eval-custom-${annotationId}`}>
                自定义标签（Enter 添加）
              </label>
              <input
                id={`eval-custom-${annotationId}`}
                className="eval-custom-input"
                placeholder="#..."
                value={customTagInput}
                onChange={(e) => setCustomTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomTag()
                  }
                }}
              />
            </div>

            <label className="eval-training-row">
              <input
                type="checkbox"
                checked={
                  trainingCandidate ??
                  (verdict === 'positive' && reason.trim().length > 0)
                }
                onChange={(e) => setTrainingCandidate(e.target.checked)}
              />
              <span>加入训练数据集</span>
              <span className="eval-training-hint">
                导出训练数据时可按此标记过滤
              </span>
            </label>

            <div className="eval-form-actions">
              {editingId && (
                <button type="button" className="eval-btn ghost" onClick={resetForm}>
                  <X size={12} /> 取消编辑
                </button>
              )}
              <button
                type="button"
                className="eval-btn primary"
                onClick={handleSave}
                disabled={!canSave}
                title={canSave ? '' : '请选择 ✅/❎ 并填写一句话原因'}
              >
                <Check size={12} /> {editingId ? '更新' : '保存'}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function adoptionLabel(a: EvaluationAdoption): string {
  const match = ADOPTION_OPTIONS.find((o) => o.value === a)
  return match?.label ?? a
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const deltaSec = Math.floor((Date.now() - then) / 1000)
  if (deltaSec < 60) return '刚刚'
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} 分钟前`
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)} 小时前`
  return `${Math.floor(deltaSec / 86400)} 天前`
}
