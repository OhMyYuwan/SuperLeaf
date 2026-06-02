import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Download, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import {
  datasetApi,
  type DatasetRecord,
  type DatasetRecordStatus,
  type DatasetSourceRule,
  type DatasetSourceType,
} from '../../services/datasetApi'
import type { ProjectSummary } from '../../services/projectsApi'
import { useProjectStore } from '../../stores/projectStore'

const SOURCE_TYPES: DatasetSourceType[] = ['annotations', 'conversations', 'workflow_runs']
const SOURCE_LABELS: Record<DatasetSourceType, string> = {
  annotations: 'Annotations',
  conversations: 'Conversations',
  workflow_runs: 'Workflow Runs',
}
const ISSUE_OPTIONS = ['incorrect', 'missing_context', 'formatting', 'unsafe', 'tool_error', 'other']

interface LabelValues {
  task_success: string
  helpfulness: string
  issues: string[]
  comments: string
  training_candidate: string
}

const EMPTY_VALUES: LabelValues = {
  task_success: 'unclear',
  helpfulness: '',
  issues: [],
  comments: '',
  training_candidate: 'no',
}

export function DataProjectTab() {
  const projectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.loaded)
  const loadProjects = useProjectStore((s) => s.load)
  const role = useProjectStore((s) => s.currentProjectRole)
  const canWrite = role !== 'viewer'

  const [rules, setRules] = useState<DatasetSourceRule[]>([])
  const [records, setRecords] = useState<DatasetRecord[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<DatasetRecordStatus>('all')
  const [sourceProjectId, setSourceProjectId] = useState('')
  const [sourceTypes, setSourceTypes] = useState<Record<DatasetSourceType, boolean>>({
    annotations: true,
    conversations: true,
    workflow_runs: true,
  })
  const [agentFilter, setAgentFilter] = useState('')
  const [skillFilter, setSkillFilter] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [onlyTrainingCandidates, setOnlyTrainingCandidates] = useState(false)
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [values, setValues] = useState<LabelValues>(EMPTY_VALUES)
  const [selectedAt, setSelectedAt] = useState(Date.now())
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const currentProject = projects.find((project) => project.id === projectId)
  const sourceProjects = useMemo(
    () => projects.filter((project) => project.id !== projectId && normalizedProjectType(project) !== 'data'),
    [projectId, projects],
  )
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? records[0] ?? null

  useEffect(() => {
    if (!projectsLoaded) void loadProjects()
  }, [loadProjects, projectsLoaded])

  useEffect(() => {
    if (!sourceProjectId && sourceProjects.length > 0) {
      setSourceProjectId(sourceProjects[0].id)
    }
  }, [sourceProjectId, sourceProjects])

  useEffect(() => {
    if (!projectId) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, statusFilter])

  useEffect(() => {
    if (!selectedRecord && records.length > 0) {
      setSelectedRecordId(records[0].id)
    }
    if (selectedRecord && !records.some((record) => record.id === selectedRecord.id)) {
      setSelectedRecordId(records[0]?.id ?? null)
    }
  }, [records, selectedRecord])

  useEffect(() => {
    if (!selectedRecord) return
    setValues(valuesFromRecord(selectedRecord))
    setSelectedAt(Date.now())
  }, [selectedRecord?.id])

  const reload = async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      await datasetApi.current()
      const [nextRules, nextRecords] = await Promise.all([
        datasetApi.listSourceRules(),
        datasetApi.listRecords({ status: statusFilter, limit: 80 }),
      ])
      setRules(nextRules)
      setRecords(nextRecords.records)
      setTotal(nextRecords.total)
      setSelectedRecordId((previous) => {
        if (previous && nextRecords.records.some((record) => record.id === previous)) return previous
        return nextRecords.records[0]?.id ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Data Project 失败')
    } finally {
      setLoading(false)
    }
  }

  const createRule = async () => {
    if (!sourceProjectId || !canWrite) return
    setWorking('create-rule')
    setError(null)
    setFeedback(null)
    try {
      const selectedTypes = SOURCE_TYPES.filter((type) => sourceTypes[type])
      const sourceProject = projects.find((project) => project.id === sourceProjectId)
      await datasetApi.createSourceRule({
        source_project_id: sourceProjectId,
        name: sourceProject ? `${sourceProject.name} data` : 'Project data',
        source_types: selectedTypes.length > 0 ? selectedTypes : SOURCE_TYPES,
        filters: compactFilters({
          agent_id: agentFilter.trim(),
          skill_id: skillFilter.trim(),
          workflow_id: workflowFilter.trim(),
          only_training_candidates: onlyTrainingCandidates || undefined,
        }),
        is_enabled: true,
      })
      setFeedback('来源规则已创建。')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建来源规则失败')
    } finally {
      setWorking(null)
    }
  }

  const syncRule = async (rule: DatasetSourceRule) => {
    if (!canWrite) return
    setWorking(`sync:${rule.id}`)
    setError(null)
    setFeedback(null)
    try {
      const result = await datasetApi.syncSourceRule(rule.id)
      setFeedback(`同步完成：新增 ${result.created}，跳过 ${result.skipped}，扫描 ${result.scanned}。`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败')
    } finally {
      setWorking(null)
    }
  }

  const saveResponse = async (status: 'draft' | 'submitted') => {
    if (!selectedRecord || !canWrite) return
    setWorking(`response:${status}`)
    setError(null)
    setFeedback(null)
    try {
      const leadTime = Math.max(0, Date.now() - selectedAt)
      const response = status === 'submitted'
        ? await datasetApi.submitResponse(selectedRecord.id, { values: responsePayload(values), lead_time_ms: leadTime })
        : await datasetApi.saveResponse(selectedRecord.id, { status: 'draft', values: responsePayload(values), lead_time_ms: leadTime })
      setFeedback(status === 'submitted' ? '标注已提交。' : '草稿已保存。')
      setRecords((items) => items.map((item) => (
        item.id === selectedRecord.id
          ? { ...item, status: status === 'submitted' ? 'labeled' : item.status, my_response: response }
          : item
      )))
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存标注失败')
    } finally {
      setWorking(null)
    }
  }

  const discardRecord = async () => {
    if (!selectedRecord || !canWrite) return
    setWorking('discard')
    setError(null)
    setFeedback(null)
    try {
      const response = await datasetApi.discardRecord(selectedRecord.id)
      setFeedback('记录已丢弃。')
      setRecords((items) => items.map((item) => (
        item.id === selectedRecord.id ? { ...item, status: 'discarded', my_response: response } : item
      )))
    } catch (err) {
      setError(err instanceof Error ? err.message : '丢弃记录失败')
    } finally {
      setWorking(null)
    }
  }

  const downloadExport = async (status: 'submitted' | 'all') => {
    setWorking(`export:${status}`)
    setError(null)
    setFeedback(null)
    try {
      await datasetApi.downloadExport(status)
      setFeedback('导出已开始。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setWorking(null)
    }
  }

  if (!projectId || currentProject?.project_type !== 'data') {
    return <div className="tab-empty">请打开一个 Data Project。</div>
  }

  return (
    <div className="tab-content-wrapper data-project-tab">
      <div className="data-toolbar">
        <div>
          <h3>Data Project</h3>
          <span>{records.length} / {total} records</span>
        </div>
        <div className="data-toolbar-actions">
          <button className="small-btn" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="small-btn" onClick={() => void downloadExport('submitted')} disabled={working === 'export:submitted'}>
            <Download size={13} /> 导出已提交
          </button>
          <button className="small-btn" onClick={() => void downloadExport('all')} disabled={working === 'export:all'}>
            <Download size={13} /> 导出全部
          </button>
        </div>
      </div>

      {error && <div className="tab-error">{error}</div>}
      {feedback && <div className="data-feedback">{feedback}</div>}
      {!canWrite && <div className="tab-empty">当前为只读权限。</div>}

      <div className="data-grid">
        <div className="data-column">
          <section className="data-section">
            <div className="data-section-head">
              <h4>来源规则</h4>
              <span>{rules.length}</span>
            </div>
            <div className="data-rule-form">
              <label>
                来源项目
                <select value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} disabled={!canWrite}>
                  {sourceProjects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              <div className="data-check-grid">
                {SOURCE_TYPES.map((type) => (
                  <label key={type} className="data-check">
                    <input
                      type="checkbox"
                      checked={sourceTypes[type]}
                      disabled={!canWrite}
                      onChange={(event) => setSourceTypes((prev) => ({ ...prev, [type]: event.target.checked }))}
                    />
                    {SOURCE_LABELS[type]}
                  </label>
                ))}
              </div>
              <div className="data-filter-grid">
                <input value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} placeholder="Agent ID" disabled={!canWrite} />
                <input value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} placeholder="Skill ID" disabled={!canWrite} />
                <input value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)} placeholder="Workflow ID" disabled={!canWrite} />
              </div>
              <label className="data-check">
                <input
                  type="checkbox"
                  checked={onlyTrainingCandidates}
                  disabled={!canWrite}
                  onChange={(event) => setOnlyTrainingCandidates(event.target.checked)}
                />
                Training candidates
              </label>
              <button className="primary-btn" onClick={() => void createRule()} disabled={!canWrite || !sourceProjectId || working === 'create-rule'}>
                <Plus size={13} /> 创建规则
              </button>
            </div>
          </section>

          <section className="data-section">
            <div className="data-section-head">
              <h4>同步</h4>
              <span>{loading ? 'loading' : 'ready'}</span>
            </div>
            {rules.length === 0 ? (
              <div className="tab-empty">暂无来源规则。</div>
            ) : (
              <div className="data-rule-list">
                {rules.map((rule) => (
                  <div key={rule.id} className="data-rule-item">
                    <div>
                      <strong>{rule.name}</strong>
                      <span>{sourceName(rule.source_project_id, projects)}</span>
                    </div>
                    <div className="data-rule-meta">
                      {rule.source_types.map((type) => <span key={type}>{SOURCE_LABELS[type]}</span>)}
                    </div>
                    <button
                      className="small-btn"
                      onClick={() => void syncRule(rule)}
                      disabled={!canWrite || working === `sync:${rule.id}`}
                    >
                      <RefreshCw size={13} /> 同步
                    </button>
                    {rule.last_synced_at && <small>{new Date(rule.last_synced_at).toLocaleString()}</small>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="data-column data-record-column">
          <section className="data-section data-records-section">
            <div className="data-section-head">
              <h4>记录队列</h4>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DatasetRecordStatus)}>
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="in_review">In Review</option>
                <option value="labeled">Labeled</option>
                <option value="discarded">Discarded</option>
              </select>
            </div>
            {records.length === 0 ? (
              <div className="tab-empty">暂无记录。</div>
            ) : (
              <div className="data-record-list">
                {records.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={`data-record-item ${selectedRecord?.id === record.id ? 'is-active' : ''}`}
                    onClick={() => setSelectedRecordId(record.id)}
                  >
                    <span>{recordTitle(record)}</span>
                    <small>{record.source_type} · {record.status}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedRecord && (
        <section className="data-section data-review-section">
          <div className="data-section-head">
            <h4>{recordTitle(selectedRecord)}</h4>
            <span>{selectedRecord.source_type} · {selectedRecord.status}</span>
          </div>
          <RecordPreview record={selectedRecord} />
          <div className="data-label-form">
            <label>
              Task success
              <select value={values.task_success} onChange={(event) => setValues((prev) => ({ ...prev, task_success: event.target.value }))} disabled={!canWrite}>
                <option value="success">success</option>
                <option value="partial">partial</option>
                <option value="failure">failure</option>
                <option value="unclear">unclear</option>
              </select>
            </label>
            <label>
              Helpfulness
              <select value={values.helpfulness} onChange={(event) => setValues((prev) => ({ ...prev, helpfulness: event.target.value }))} disabled={!canWrite}>
                <option value="">unset</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
            </label>
            <label>
              Training candidate
              <select value={values.training_candidate} onChange={(event) => setValues((prev) => ({ ...prev, training_candidate: event.target.value }))} disabled={!canWrite}>
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            </label>
            <div className="data-issues">
              {ISSUE_OPTIONS.map((issue) => (
                <label key={issue} className="data-check">
                  <input
                    type="checkbox"
                    checked={values.issues.includes(issue)}
                    disabled={!canWrite}
                    onChange={(event) => setValues((prev) => ({
                      ...prev,
                      issues: event.target.checked
                        ? [...prev.issues, issue]
                        : prev.issues.filter((item) => item !== issue),
                    }))}
                  />
                  {issue}
                </label>
              ))}
            </div>
            <label className="data-comments">
              Comments
              <textarea value={values.comments} onChange={(event) => setValues((prev) => ({ ...prev, comments: event.target.value }))} rows={3} disabled={!canWrite} />
            </label>
            <div className="data-review-actions">
              <button className="small-btn" onClick={() => void saveResponse('draft')} disabled={!canWrite || working === 'response:draft'}>
                <Save size={13} /> 保存草稿
              </button>
              <button className="primary-btn" onClick={() => void saveResponse('submitted')} disabled={!canWrite || working === 'response:submitted'}>
                <CheckCircle2 size={13} /> 提交标注
              </button>
              <button className="small-btn danger" onClick={() => void discardRecord()} disabled={!canWrite || working === 'discard'}>
                <Trash2 size={13} /> 丢弃
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function RecordPreview({ record }: { record: DatasetRecord }) {
  const chat = Array.isArray(record.fields.chat) ? record.fields.chat : []
  return (
    <div className="data-preview">
      {chat.length > 0 && (
        <div className="data-chat-preview">
          {chat.slice(0, 8).map((message, index) => (
            <div key={`${record.id}-message-${index}`} className="data-chat-row">
              <strong>{messageRole(message)}</strong>
              <span>{messageContent(message)}</span>
            </div>
          ))}
        </div>
      )}
      <PreviewBlock title="Source" value={record.fields.source_text} />
      <PreviewBlock title="Output" value={record.fields.agent_output} />
      {hasValue(record.fields.trace) && <PreviewBlock title="Trace" value={record.fields.trace} />}
    </div>
  )
}

function PreviewBlock({ title, value }: { title: string; value: unknown }) {
  if (!hasValue(value)) return null
  return (
    <div className="data-preview-block">
      <strong>{title}</strong>
      <pre>{formatValue(value)}</pre>
    </div>
  )
}

function valuesFromRecord(record: DatasetRecord): LabelValues {
  const raw = record.my_response?.values ?? {}
  return {
    task_success: stringValue(raw.task_success, 'unclear'),
    helpfulness: raw.helpfulness === undefined || raw.helpfulness === null ? '' : String(raw.helpfulness),
    issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
    comments: stringValue(raw.comments, ''),
    training_candidate: stringValue(raw.training_candidate, 'no'),
  }
}

function responsePayload(values: LabelValues): Record<string, unknown> {
  return {
    task_success: values.task_success,
    helpfulness: values.helpfulness ? Number(values.helpfulness) : null,
    issues: values.issues,
    comments: values.comments.trim(),
    training_candidate: values.training_candidate,
  }
}

function compactFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''))
}

function normalizedProjectType(project: ProjectSummary): 'paper' | 'skill' | 'data' {
  if (project.project_type === 'data') return 'data'
  if (project.project_type === 'skill' || project.is_skill_project) return 'skill'
  return 'paper'
}

function sourceName(projectId: string, projects: ProjectSummary[]): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId.slice(0, 8)
}

function recordTitle(record: DatasetRecord): string {
  const metadata = record.record_metadata ?? {}
  const title = stringValue(metadata.title, '')
  if (title) return title
  const docName = stringValue(metadata.doc_name ?? metadata.document_name, '')
  if (docName) return docName
  return `${record.source_type} ${record.source_id.slice(0, 8)}`
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function messageRole(value: unknown): string {
  if (!value || typeof value !== 'object' || !('role' in value)) return 'message'
  return String((value as { role?: unknown }).role || 'message')
}

function messageContent(value: unknown): string {
  if (!value || typeof value !== 'object' || !('content' in value)) return ''
  return String((value as { content?: unknown }).content || '')
}
