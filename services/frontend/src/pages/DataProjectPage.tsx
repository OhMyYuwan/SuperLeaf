import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Database,
  Download,
  FileJson,
  Filter,
  GitBranch,
  Loader2,
  PackageCheck,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { AgentMarkdown } from '../features/shared/AgentMarkdown'
import { Topbar } from '../features/topbar'
import {
  datasetApi,
  type DatasetFilterOption,
  type DatasetFilterOptions,
  type DatasetProject,
  type DatasetRecord,
  type DatasetRecordStatus,
  type DatasetSourceRule,
  type DatasetSourceType,
} from '../services/datasetApi'
import type { ProjectSummary } from '../services/projectsApi'
import { useProjectStore } from '../stores/projectStore'
import './data-project.css'

type SourceFilter = 'all' | DatasetSourceType

interface LabelValues {
  task_success: string
  helpfulness: string
  issues: string[]
  comments: string
  training_candidate: string
}

interface SchemaField {
  name: string
  type: string
  title: string
}

interface SchemaQuestion {
  name: string
  type: string
  title: string
  options: string[]
}

interface FilterLookups {
  agents: Map<string, DatasetFilterOption>
  skills: Map<string, DatasetFilterOption>
  workflows: Map<string, DatasetFilterOption>
}

type MetaRow = [string, unknown]

const SOURCE_TYPES: DatasetSourceType[] = ['annotations', 'conversations', 'workflow_runs']
const SOURCE_LABELS: Record<DatasetSourceType, string> = {
  annotations: 'Annotations',
  conversations: 'Conversations',
  workflow_runs: 'Workflow Runs',
}
const SOURCE_FILTERS: { value: SourceFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'All sources' },
  { value: 'annotations', label: 'Anno', title: SOURCE_LABELS.annotations },
  { value: 'conversations', label: 'Chat', title: SOURCE_LABELS.conversations },
  { value: 'workflow_runs', label: 'Workflow', title: SOURCE_LABELS.workflow_runs },
]
const STATUS_OPTIONS: { value: DatasetRecordStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_review', label: 'In Review' },
  { value: 'labeled', label: 'Labeled' },
  { value: 'discarded', label: 'Discarded' },
]
const CONCRETE_STATUSES: Exclude<DatasetRecordStatus, 'all'>[] = [
  'pending',
  'in_review',
  'labeled',
  'discarded',
]
const ISSUE_OPTIONS = ['incorrect', 'missing_context', 'formatting', 'unsafe', 'tool_error', 'other']
const RECORD_PAGE_LIMIT = 120
const RECORD_SNAPSHOT_LIMIT = 200
const EMPTY_FILTER_OPTIONS: DatasetFilterOptions = {
  agents: [],
  skills: [],
  workflows: [],
}
const EMPTY_VALUES: LabelValues = {
  task_success: 'unclear',
  helpfulness: '',
  issues: [],
  comments: '',
  training_candidate: 'no',
}

export function DataProjectPage({ project }: { project: ProjectSummary }) {
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.loaded)
  const loadProjects = useProjectStore((s) => s.load)
  const role = useProjectStore((s) => s.currentProjectRole)
  const canWrite = role !== 'viewer'

  const [sourceRulesOpen, setSourceRulesOpen] = useState(false)
  const [dataset, setDataset] = useState<DatasetProject | null>(null)
  const [rules, setRules] = useState<DatasetSourceRule[]>([])
  const [records, setRecords] = useState<DatasetRecord[]>([])
  const [snapshotRecords, setSnapshotRecords] = useState<DatasetRecord[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<DatasetRecordStatus>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
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
  const [filterOptionsByProject, setFilterOptionsByProject] = useState<Record<string, DatasetFilterOptions>>({})
  const [loadingFilterProjectId, setLoadingFilterProjectId] = useState<string | null>(null)
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [values, setValues] = useState<LabelValues>(EMPTY_VALUES)
  const [selectedAt, setSelectedAt] = useState(Date.now())
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const sourceProjects = useMemo(
    () => projects.filter((item) => item.id !== project.id && normalizedProjectType(item) !== 'data'),
    [project.id, projects],
  )
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? records[0] ?? null
  const statusCounts = useMemo(
    () => countStatuses(snapshotRecords, total),
    [snapshotRecords, total],
  )
  const schemaQuestions = useMemo(
    () => questionsFromSchema(dataset?.label_schema),
    [dataset?.label_schema],
  )
  const filterOptions = filterOptionsByProject[sourceProjectId] ?? EMPTY_FILTER_OPTIONS
  const filterOptionsLoading = loadingFilterProjectId === sourceProjectId
  const filterLookups = useMemo(
    () => buildFilterLookups(Object.values(filterOptionsByProject)),
    [filterOptionsByProject],
  )
  const enabledRules = rules.filter((rule) => rule.is_enabled)

  useEffect(() => {
    if (!projectsLoaded) void loadProjects()
  }, [loadProjects, projectsLoaded])

  useEffect(() => {
    if (!sourceProjectId && sourceProjects.length > 0) {
      setSourceProjectId(sourceProjects[0].id)
    }
  }, [sourceProjectId, sourceProjects])

  useEffect(() => {
    if (!sourceRulesOpen) return
    const projectIds = Array.from(
      new Set([sourceProjectId, ...rules.map((rule) => rule.source_project_id)].filter(Boolean)),
    )
    const missingProjectIds = projectIds.filter((id) => !filterOptionsByProject[id])
    if (missingProjectIds.length === 0) return
    let isCurrent = true
    setLoadingFilterProjectId(missingProjectIds[0])
    Promise.all(
      missingProjectIds.map(async (id) => [id, await datasetApi.filterOptions(id)] as const),
    )
      .then((entries) => {
        if (!isCurrent) return
        setFilterOptionsByProject((previous) => {
          const next = { ...previous }
          for (const [id, options] of entries) {
            next[id] = options
          }
          return next
        })
      })
      .catch((err) => {
        if (isCurrent) setError(err instanceof Error ? err.message : '加载来源筛选选项失败')
      })
      .finally(() => {
        if (isCurrent) setLoadingFilterProjectId(null)
      })
    return () => {
      isCurrent = false
    }
  }, [filterOptionsByProject, rules, sourceProjectId, sourceRulesOpen])

  useEffect(() => {
    const options = filterOptionsByProject[sourceProjectId]
    if (!options) return
    setAgentFilter((previous) => (previous && !hasOption(options.agents, previous) ? '' : previous))
    setSkillFilter((previous) => (previous && !hasOption(options.skills, previous) ? '' : previous))
    setWorkflowFilter((previous) => (previous && !hasOption(options.workflows, previous) ? '' : previous))
  }, [filterOptionsByProject, sourceProjectId])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, statusFilter, sourceFilter])

  useEffect(() => {
    if (records.length === 0) {
      setSelectedRecordId(null)
      return
    }
    if (!selectedRecordId || !records.some((record) => record.id === selectedRecordId)) {
      setSelectedRecordId(records[0].id)
    }
  }, [records, selectedRecordId])

  useEffect(() => {
    if (!selectedRecord) return
    setValues(valuesFromRecord(selectedRecord))
    setSelectedAt(Date.now())
  }, [selectedRecord?.id])

  useEffect(() => {
    if (!feedback) return
    const timeout = window.setTimeout(() => setFeedback(null), 2600)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  const reload = async () => {
    setLoading(true)
    setError(null)
    try {
      const sourceType = sourceFilter === 'all' ? undefined : sourceFilter
      const [nextDataset, nextRules, nextRecords, nextSnapshot] = await Promise.all([
        datasetApi.current(),
        datasetApi.listSourceRules(),
        datasetApi.listRecords({ status: statusFilter, source_type: sourceType, limit: RECORD_PAGE_LIMIT }),
        datasetApi.listRecords({ status: 'all', limit: RECORD_SNAPSHOT_LIMIT }),
      ])
      setDataset(nextDataset)
      setRules(nextRules)
      setRecords(nextRecords.records)
      setSnapshotRecords(nextSnapshot.records)
      setTotal(nextSnapshot.total)
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
      const sourceProject = projects.find((item) => item.id === sourceProjectId)
      const selectedWorkflow = filterOptions.workflows.find((option) => option.id === workflowFilter.trim())
      const workflowFilterKey = selectedWorkflow?.filter_key === 'workflow_definition_id'
        ? 'workflow_definition_id'
        : 'workflow_id'
      const workflowFilterValue = workflowFilter.trim()
      await datasetApi.createSourceRule({
        source_project_id: sourceProjectId,
        name: sourceProject ? `${sourceProject.name} data` : 'Project data',
        source_types: selectedTypes.length > 0 ? selectedTypes : SOURCE_TYPES,
        filters: compactFilters({
          agent_id: agentFilter.trim(),
          skill_id: skillFilter.trim(),
          workflow_id: workflowFilterKey === 'workflow_id' ? workflowFilterValue : undefined,
          workflow_definition_id: workflowFilterKey === 'workflow_definition_id' ? workflowFilterValue : undefined,
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

  const syncAllRules = async () => {
    if (!canWrite || enabledRules.length === 0) return
    setWorking('sync-all')
    setError(null)
    setFeedback(null)
    try {
      const results = await Promise.all(enabledRules.map((rule) => datasetApi.syncSourceRule(rule.id)))
      const summary = results.reduce(
        (acc, result) => ({
          created: acc.created + result.created,
          skipped: acc.skipped + result.skipped,
          scanned: acc.scanned + result.scanned,
        }),
        { created: 0, skipped: 0, scanned: 0 },
      )
      setFeedback(`全部同步完成：新增 ${summary.created}，跳过 ${summary.skipped}，扫描 ${summary.scanned}。`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步全部来源失败')
    } finally {
      setWorking(null)
    }
  }

  const toggleRuleEnabled = async (rule: DatasetSourceRule, isEnabled: boolean) => {
    if (!canWrite) return
    setWorking(`toggle:${rule.id}`)
    setError(null)
    setFeedback(null)
    try {
      const updated = await datasetApi.updateSourceRule(rule.id, { is_enabled: isEnabled })
      setRules((items) => items.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新来源规则失败')
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
      setSnapshotRecords((items) => items.map((item) => (
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
      setSnapshotRecords((items) => items.map((item) => (
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
      setFeedback(status === 'submitted' ? '已开始导出已提交数据。' : '已开始导出全部数据。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="app-shell data-project-shell">
      <Topbar />
      {feedback && (
        <div className="data-toast" role="status" aria-live="polite">
          {feedback}
        </div>
      )}
      <main className="data-project-main">
        <section className="data-workbench-header">
          <div className="data-workbench-title">
            <span className="data-title-icon" aria-hidden><Database size={18} /></span>
            <div>
              <p>Data Project</p>
              <h1>{dataset?.name ?? project.name}</h1>
            </div>
          </div>
          <div className="data-metrics" aria-label="数据状态统计">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`data-metric ${statusFilter === option.value ? 'is-active' : ''}`}
                onClick={() => setStatusFilter(option.value)}
                aria-pressed={statusFilter === option.value}
              >
                <span>{option.label}</span>
                <strong>{statusCounts[option.value]}</strong>
              </button>
            ))}
          </div>
          <div className="data-header-actions">
            <button className="data-icon-button" onClick={() => void reload()} disabled={loading} title="刷新数据">
              {loading ? <Loader2 className="is-spinning" size={16} /> : <RefreshCw size={16} />}
            </button>
            <button
              className={`data-icon-button ${sourceRulesOpen ? 'is-active' : ''}`}
              onClick={() => setSourceRulesOpen((open) => !open)}
              title={sourceRulesOpen ? '隐藏来源规则' : '来源规则'}
              aria-pressed={sourceRulesOpen}
            >
              <Settings2 size={16} />
            </button>
            <button className="data-secondary-button" onClick={() => void syncAllRules()} disabled={!canWrite || enabledRules.length === 0 || working === 'sync-all'}>
              <RefreshCw size={15} /> 同步全部
            </button>
            <button className="data-secondary-button" onClick={() => void downloadExport('all')} disabled={working === 'export:all'}>
              <Download size={15} /> 全量包
            </button>
            <button className="data-primary-button" onClick={() => void downloadExport('submitted')} disabled={working === 'export:submitted'}>
              <PackageCheck size={15} /> 提交包
            </button>
          </div>
        </section>

        {(error || !canWrite) && (
          <div className="data-workbench-messages" aria-live="polite">
            {error && <div className="data-message is-error">{error}</div>}
            {!canWrite && <div className="data-message">当前项目权限为只读，可以查看与导出，不能修改来源规则或提交标注。</div>}
          </div>
        )}

        <section className="data-workbench-layout">
          <aside className="data-queue-panel" aria-label="数据队列和来源规则">
            <section className="data-panel-section">
              <div className="data-section-heading">
                <div>
                  <span><Filter size={14} /> Record queue</span>
                  <strong>{records.length} / {statusFilter === 'all' && sourceFilter === 'all' ? total : records.length === total ? total : `${records.length}+`}</strong>
                </div>
              </div>
              <div className="data-filter-strip">
                {SOURCE_FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={sourceFilter === item.value ? 'is-active' : ''}
                    title={item.title}
                    onClick={() => setSourceFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="data-record-queue">
                {records.length === 0 ? (
                  <EmptyState title="没有匹配记录" detail="创建来源规则并同步后，新的 record 会出现在这里。" />
                ) : records.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={`data-queue-item ${selectedRecord?.id === record.id ? 'is-active' : ''}`}
                    onClick={() => setSelectedRecordId(record.id)}
                  >
                    <span className={`data-status-chip ${statusClass(record.status)}`}>{statusLabel(record.status)}</span>
                    <strong>{recordTitle(record)}</strong>
                    <p>{recordExcerpt(record)}</p>
                    <small>{sourceTypeLabel(record.source_type)} · {formatDate(record.source_created_at ?? record.created_at)}</small>
                  </button>
                ))}
              </div>
            </section>
          </aside>

          <section className="data-record-panel" aria-label="当前数据样本">
            {selectedRecord ? (
              <>
                <div className="data-record-head">
                  <div>
                    <span className={`data-status-chip ${statusClass(selectedRecord.status)}`}>{statusLabel(selectedRecord.status)}</span>
                    <h2>{recordTitle(selectedRecord)}</h2>
                    <p>{sourceTypeLabel(selectedRecord.source_type)} · {selectedRecord.source_id}</p>
                  </div>
                  <div className="data-record-meta">
                    <span>{selectedRecord.split}</span>
                    <span>{formatDate(selectedRecord.created_at)}</span>
                  </div>
                </div>
                <RecordFields record={selectedRecord} dataset={dataset} />
                <section className="data-record-metadata">
                  <div className="data-section-heading">
                    <div>
                      <span><FileJson size={14} /> Metadata</span>
                      <strong>{selectedRecord.fingerprint.slice(0, 8)}</strong>
                    </div>
                  </div>
                  <RecordMetadata record={selectedRecord} projects={projects} rules={rules} />
                </section>
              </>
            ) : (
              <EmptyState title="选择一条 record" detail="左侧队列会列出已同步的数据。选择后即可查看字段并提交 response。" />
            )}
          </section>

          <aside
            key={sourceRulesOpen ? 'source-rules-panel' : 'labeling-panel'}
            className={`data-label-workbench-panel ${sourceRulesOpen ? 'is-source-rules' : 'is-labeling'}`}
            aria-label={sourceRulesOpen ? '来源规则' : '标注和导出'}
          >
            {sourceRulesOpen ? (
              <section className="data-panel-section data-source-rules-section">
                <div className="data-section-heading">
                  <div>
                    <span><Settings2 size={14} /> Source rules</span>
                    <strong>{rules.length}</strong>
                  </div>
                  <button className="data-icon-button" onClick={() => setSourceRulesOpen(false)} aria-label="关闭来源规则">
                    <X size={16} />
                  </button>
                </div>
                <div className="data-source-inline-body">
                  <div className="data-source-inline-block">
                    <div className="data-section-heading">
                      <div>
                        <span><GitBranch size={14} /> Create rule</span>
                        <strong>{sourceProjects.length}</strong>
                      </div>
                    </div>
                    <div className="data-rule-builder">
                      <label>
                        来源项目
                        <select value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} disabled={!canWrite || sourceProjects.length === 0}>
                          {sourceProjects.length === 0 && <option value="">暂无可选来源项目</option>}
                          {sourceProjects.map((item) => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                      </label>
                      <div className="data-source-checks" aria-label="来源类型">
                        {SOURCE_TYPES.map((type) => (
                          <label key={type}>
                            <input
                              type="checkbox"
                              checked={sourceTypes[type]}
                              disabled={!canWrite}
                              onChange={(event) => setSourceTypes((previous) => ({ ...previous, [type]: event.target.checked }))}
                            />
                            {SOURCE_LABELS[type]}
                          </label>
                        ))}
                      </div>
                      <div className="data-rule-inputs">
                        <FilterSelect
                          label="Agent"
                          value={agentFilter}
                          options={filterOptions.agents}
                          emptyLabel="全部 Agent"
                          loading={filterOptionsLoading}
                          disabled={!canWrite}
                          onChange={setAgentFilter}
                        />
                        <FilterSelect
                          label="Skill"
                          value={skillFilter}
                          options={filterOptions.skills}
                          emptyLabel="全部 Skill"
                          loading={filterOptionsLoading}
                          disabled={!canWrite}
                          onChange={setSkillFilter}
                        />
                        <FilterSelect
                          label="Workflow"
                          value={workflowFilter}
                          options={filterOptions.workflows}
                          emptyLabel="全部 Workflow"
                          loading={filterOptionsLoading}
                          disabled={!canWrite}
                          onChange={setWorkflowFilter}
                        />
                      </div>
                      <label className="data-inline-check">
                        <input
                          type="checkbox"
                          checked={onlyTrainingCandidates}
                          disabled={!canWrite}
                          onChange={(event) => setOnlyTrainingCandidates(event.target.checked)}
                        />
                        只收集 training candidates
                      </label>
                      <button className="data-primary-button" onClick={() => void createRule()} disabled={!canWrite || !sourceProjectId || working === 'create-rule'}>
                        <Plus size={15} /> 创建来源规则
                      </button>
                    </div>
                  </div>
                  <div className="data-source-inline-block">
                    <div className="data-section-heading">
                      <div>
                        <span><Settings2 size={14} /> Existing rules</span>
                        <strong>{rules.length}</strong>
                      </div>
                    </div>
                    <div className="data-rule-list">
                      {rules.length === 0 ? (
                        <EmptyState title="暂无来源规则" detail="Data Project 会根据来源规则持续收集 Agent、Skill、Workflow 数据。" />
                      ) : rules.map((rule) => (
                        <article key={rule.id} className="data-rule-row">
                          <div>
                            <strong>{rule.name}</strong>
                            <span>{sourceName(rule.source_project_id, projects)}</span>
                          </div>
                          <p>{rule.source_types.map((type) => SOURCE_LABELS[type]).join(' / ')}</p>
                          <small>{filterSummary(rule.filters, filterLookups)}</small>
                          <div className="data-rule-actions">
                            <label className="data-switch">
                              <input
                                type="checkbox"
                                checked={rule.is_enabled}
                                disabled={!canWrite || working === `toggle:${rule.id}`}
                                onChange={(event) => void toggleRuleEnabled(rule, event.target.checked)}
                              />
                              <span>{rule.is_enabled ? 'enabled' : 'paused'}</span>
                            </label>
                            <button className="data-secondary-button" onClick={() => void syncRule(rule)} disabled={!canWrite || working === `sync:${rule.id}`}>
                              <RefreshCw size={14} /> 同步
                            </button>
                          </div>
                          {rule.last_synced_at && <time>{formatDate(rule.last_synced_at)}</time>}
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <>
              <section className="data-panel-section">
                <div className="data-section-heading">
                  <div>
                    <span><SlidersHorizontal size={14} /> Label schema</span>
                    <strong>{schemaQuestions.length}</strong>
                  </div>
                </div>
                <div className="data-schema-list">
                  {schemaQuestions.length === 0 ? (
                    <EmptyState title="暂无 schema" detail="当前 dataset 还没有问题配置。" />
                  ) : schemaQuestions.map((question) => (
                    <div key={question.name} className="data-schema-row">
                      <strong>{question.title}</strong>
                      <span>{question.type}</span>
                      {question.options.length > 0 && <p>{question.options.join(' / ')}</p>}
                    </div>
                  ))}
                </div>
              </section>
              <section className="data-panel-section">
                <div className="data-section-heading">
                  <div>
                    <span><CheckCircle2 size={14} /> Response</span>
                    <strong>{selectedRecord?.my_response?.status ?? 'new'}</strong>
                  </div>
                </div>
                <div className="data-label-form">
                  <div className="data-form-group">
                    <label>Task success</label>
                    <div className="data-segmented" role="radiogroup" aria-label="Task success">
                      {['success', 'partial', 'failure', 'unclear'].map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="radio"
                          aria-checked={values.task_success === item}
                          className={values.task_success === item ? 'is-active' : ''}
                          onClick={() => setValues((previous) => ({ ...previous, task_success: item }))}
                          disabled={!canWrite || !selectedRecord}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="data-form-group">
                    <label>Helpfulness</label>
                    <div className="data-rating" role="radiogroup" aria-label="Helpfulness">
                      {[1, 2, 3, 4, 5].map((rating) => (
                        <button
                          key={rating}
                          type="button"
                          role="radio"
                          aria-checked={values.helpfulness === String(rating)}
                          className={values.helpfulness === String(rating) ? 'is-active' : ''}
                          onClick={() => setValues((previous) => ({ ...previous, helpfulness: String(rating) }))}
                          disabled={!canWrite || !selectedRecord}
                        >
                          {rating}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="data-form-group">
                    <label>Issues</label>
                    <div className="data-issue-grid">
                      {ISSUE_OPTIONS.map((issue) => (
                        <label key={issue}>
                          <input
                            type="checkbox"
                            checked={values.issues.includes(issue)}
                            disabled={!canWrite || !selectedRecord}
                            onChange={(event) => setValues((previous) => ({
                              ...previous,
                              issues: event.target.checked
                                ? [...previous.issues, issue]
                                : previous.issues.filter((item) => item !== issue),
                            }))}
                          />
                          {issue}
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="data-inline-check">
                    <input
                      type="checkbox"
                      checked={values.training_candidate === 'yes'}
                      disabled={!canWrite || !selectedRecord}
                      onChange={(event) => setValues((previous) => ({
                        ...previous,
                        training_candidate: event.target.checked ? 'yes' : 'no',
                      }))}
                    />
                    加入优化样本池
                  </label>
                  <label className="data-comments-field">
                    Comments
                    <textarea
                      value={values.comments}
                      onChange={(event) => setValues((previous) => ({ ...previous, comments: event.target.value }))}
                      rows={4}
                      disabled={!canWrite || !selectedRecord}
                    />
                  </label>
                  <div className="data-response-actions">
                    <button className="data-secondary-button" onClick={() => void saveResponse('draft')} disabled={!canWrite || !selectedRecord || working === 'response:draft'}>
                      <Save size={14} /> 保存草稿
                    </button>
                    <button className="data-primary-button" onClick={() => void saveResponse('submitted')} disabled={!canWrite || !selectedRecord || working === 'response:submitted'}>
                      <CheckCircle2 size={14} /> 提交
                    </button>
                    <button className="data-danger-button" onClick={() => void discardRecord()} disabled={!canWrite || !selectedRecord || working === 'discard'}>
                      <Trash2 size={14} /> 丢弃
                    </button>
                  </div>
                </div>
              </section>
              </>
            )}
          </aside>
        </section>
      </main>
    </div>
  )
}

function RecordFields({ record, dataset }: { record: DatasetRecord; dataset: DatasetProject | null }) {
  const chat = Array.isArray(record.fields.chat) ? record.fields.chat : []
  const schemaFields = fieldsFromSchema(dataset?.label_schema)
  const shownKeys = new Set<string>()
  const schemaBlocks = schemaFields
    .filter((field) => field.name !== 'chat' && hasValue(record.fields[field.name]))
    .map((field) => {
      shownKeys.add(field.name)
      return { key: field.name, title: field.title, value: record.fields[field.name] }
    })
  if (chat.length > 0) shownKeys.add('chat')
  const extraBlocks = Object.entries(record.fields)
    .filter(([key, value]) => !shownKeys.has(key) && hasValue(value))
    .map(([key, value]) => ({ key, title: key, value }))

  return (
    <div className="data-record-fields">
      {chat.length > 0 && (
        <section className="data-field-block">
          <div className="data-field-title">Conversation</div>
          <div className="data-chat-thread">
            {chat.map((message, index) => {
              const role = messageRole(message)
              return (
                <div key={`${record.id}-chat-${index}`} className={`data-chat-message role-${chatRoleClass(role)}`}>
                  <span>{roleLabel(role)}</span>
                  <AgentMarkdown source={messageContentText(message)} className="data-chat-markdown" />
                </div>
              )
            })}
          </div>
        </section>
      )}
      {[...schemaBlocks, ...extraBlocks].map((block) => (
        <section key={block.key} className="data-field-block">
          <div className="data-field-title">{block.title}</div>
          <FieldValue fieldKey={block.key} value={block.value} recordFields={record.fields} />
        </section>
      ))}
      {chat.length === 0 && schemaBlocks.length === 0 && extraBlocks.length === 0 && (
        <EmptyState title="没有可展示字段" detail="这条 record 目前只有元数据。" />
      )}
    </div>
  )
}

function FieldValue({
  fieldKey,
  value,
  recordFields = {},
}: {
  fieldKey: string
  value: unknown
  recordFields?: Record<string, unknown>
}) {
  if (fieldKey === 'agent_output') return <AgentOutputValue value={value} />
  if (isWorkflowTraceKey(fieldKey)) return <WorkflowTraceValue value={value} agentOutput={recordFields.agent_output} />
  if (typeof value === 'string') {
    const parsed = parseStructuredString(value)
    if (parsed !== null) return <StructuredValue value={parsed} />
    return (
      <div className={`data-field-markdown ${fieldKey === 'source_text' ? 'is-source-text' : ''}`}>
        <AgentMarkdown source={value} />
      </div>
    )
  }
  return <StructuredValue value={value} />
}

function AgentOutputValue({ value }: { value: unknown }) {
  const output = normalizeAgentOutput(value)
  return (
    <div className="data-agent-output">
      {output.body ? (
        <div className="data-field-markdown is-agent-output">
          <AgentMarkdown source={output.body} />
        </div>
      ) : (
        <div className="data-output-fallback">
          <StructuredValue value={output.fallback} compact />
        </div>
      )}
      {output.metadata && hasValue(output.metadata) && (
        <div className="data-output-metadata">
          <strong>Output metadata</strong>
          <OutputMetadataValue value={output.metadata} />
        </div>
      )}
    </div>
  )
}

function OutputMetadataValue({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value).filter(([, item]) => hasValue(item))
  if (entries.length === 0) return <span className="data-muted-value">empty</span>
  return (
    <dl className="data-output-metadata-rows">
      {entries.map(([key, item]) => {
        const isSkill = isSkillMetadataKey(key)
        const isTrace = isWorkflowTraceKey(key)
        return (
          <div key={key} className={isSkill || isTrace ? 'is-wide' : undefined}>
            <dt>{humanizeKey(key)}</dt>
            <dd>
              {isSkill ? (
                <SkillMetadataValue value={item} />
              ) : isTrace ? (
                <WorkflowTraceValue value={item} compact />
              ) : (
                <StructuredValue value={item} compact />
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function WorkflowTraceValue({
  value,
  compact = false,
  agentOutput,
}: {
  value: unknown
  compact?: boolean
  agentOutput?: unknown
}) {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (!Array.isArray(source)) return <StructuredValue value={source} compact={compact} />
  if (source.length === 0) return <span className="data-muted-value">empty</span>
  const transcript = workflowTraceTranscript(source, agentOutput)
  return (
    <div className={`data-workflow-trace ${compact ? 'is-compact' : ''}`}>
      {transcript.turns.length > 0 && <TraceConversation turns={transcript.turns} className="is-run-transcript" />}
      {source.map((node, index) => (
        <WorkflowTraceNode
          key={index}
          node={node}
          index={index}
          agentOutput={index === source.length - 1 ? agentOutput : undefined}
          conversationOverride={transcript.byIndex.get(index)}
          hideConversation={transcript.turns.length > 0}
        />
      ))}
    </div>
  )
}

function WorkflowTraceNode({
  node,
  index,
  agentOutput,
  conversationOverride,
  hideConversation = false,
}: {
  node: unknown
  index: number
  agentOutput?: unknown
  conversationOverride?: TraceConversationModel
  hideConversation?: boolean
}) {
  const parsed = typeof node === 'string' ? parseStructuredString(node) : null
  const source = parsed ?? node
  if (!isPlainObject(source)) {
    return (
      <article className="data-workflow-trace-node">
        <StructuredValue value={source} compact />
      </article>
    )
  }

  const title = stringFromKeys(source, WORKFLOW_TRACE_TITLE_KEYS) || `Step ${index + 1}`
  const chips = [
    ['type', stringFromKeys(source, WORKFLOW_TRACE_TYPE_KEYS)],
    ['status', stringFromKeys(source, WORKFLOW_TRACE_STATUS_KEYS)],
    ['agent', stringFromKeys(source, WORKFLOW_TRACE_AGENT_KEYS)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  const skillEntries = WORKFLOW_TRACE_SKILL_KEYS
    .filter((key) => hasValue(source[key]))
    .map((key) => [key, source[key]] as const)
  const summaryKey = firstStringKey(source, WORKFLOW_TRACE_SUMMARY_KEYS)
  const summary = summaryKey ? normalizeComparableText(String(source[summaryKey] ?? '')) : ''
  const conversation = conversationOverride ?? workflowTraceConversation(source, agentOutput)
  const detailEntries = workflowTraceDetailEntries(source, summaryKey, conversation.consumedKeys)
  const conversationRenderedElsewhere = hideConversation && conversation.turns.length > 0

  return (
    <article className="data-workflow-trace-node">
      <div className="data-workflow-trace-node-header">
        <strong title={title}>{title}</strong>
        {chips.length > 0 && (
          <span className="data-trace-chip-list">
            {chips.map(([key, item]) => (
              <span key={key} title={item}>{humanizeKey(key)}: {item}</span>
            ))}
          </span>
        )}
      </div>
      {skillEntries.map(([key, item]) => (
        <div key={key} className="data-trace-skill-group">
          <span>{humanizeKey(key)}</span>
          <SkillMetadataValue value={item} />
        </div>
      ))}
      {summary && <p className="data-trace-summary" title={summary}>{summary}</p>}
      {!hideConversation && conversation.turns.length > 0 && <TraceConversation turns={conversation.turns} />}
      {detailEntries.length > 0 && <TraceDetailList entries={detailEntries} />}
      {skillEntries.length === 0 && !summary && chips.length === 0 && detailEntries.length === 0 && !conversationRenderedElsewhere && <StructuredValue value={source} compact />}
    </article>
  )
}

type TraceTurnRole = 'user' | 'agent' | 'system'

type TraceTurn = {
  role: TraceTurnRole
  label: string
  value: unknown
}

type TraceConversationModel = {
  turns: TraceTurn[]
  consumedKeys: Set<string>
}

function TraceConversation({ turns, className }: { turns: TraceTurn[]; className?: string }) {
  return (
    <div className={`data-trace-discussion ${className ?? ''}`.trim()}>
      {turns.map((turn, index) => (
        <TraceTurnBubble key={`${index}:${turn.role}:${turn.label}`} turn={turn} />
      ))}
    </div>
  )
}

function TraceDetailList({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="data-trace-detail-list">
      {entries.map(([key, item]) => (
        <div key={key} className={isConversationalTraceValue(key, item) ? 'is-conversation' : undefined}>
          <dt>{humanizeKey(key)}</dt>
          <dd><TraceDetailValue fieldKey={key} value={item} /></dd>
        </div>
      ))}
    </dl>
  )
}

function TraceTurnBubble({ turn }: { turn: TraceTurn }) {
  return (
    <div className={`data-trace-turn role-${turn.role}`}>
      <div className="data-trace-bubble">
        <div className="data-trace-bubble-label">{turn.label}</div>
        <TraceBubbleValue role={turn.role} value={turn.value} />
      </div>
    </div>
  )
}

function TraceBubbleValue({ role, value }: { role: TraceTurnRole; value: unknown }) {
  const markdown = traceBubbleMarkdown(role, value)
  if (markdown) return <AgentMarkdown source={markdown} className="data-trace-bubble-content" />
  return <StructuredValue value={value} compact />
}

function TraceDetailValue({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (isMessageList(source)) return <TraceMessageList messages={source} />
  if (Array.isArray(source)) {
    return (
      <div className="data-trace-array">
        {source.map((item, index) => (
          <div key={index} className="data-trace-array-item">
            <TraceDetailValue fieldKey={`${fieldKey}_${index}`} value={item} />
          </div>
        ))}
      </div>
    )
  }
  if (isPlainObject(source)) {
    const messageEntries = Object.entries(source).filter(([key, item]) => isTraceMessageKey(key) && isMessageList(item))
    const otherEntries = Object.entries(source).filter(([key, item]) => hasValue(item) && !messageEntries.some(([messageKey]) => messageKey === key))
    return (
      <div className="data-trace-object">
        {messageEntries.map(([key, item]) => (
          <div key={key} className="data-trace-message-group">
            <span>{humanizeKey(key)}</span>
            <TraceMessageList messages={item as Record<string, unknown>[]} />
          </div>
        ))}
        {otherEntries.length > 0 && <StructuredValue value={Object.fromEntries(otherEntries)} compact />}
      </div>
    )
  }
  if (typeof source === 'string') {
    return <AgentMarkdown source={source} className="data-trace-markdown" />
  }
  return <span>{formatInlineValue(source)}</span>
}

function TraceMessageList({ messages }: { messages: Record<string, unknown>[] }) {
  return (
    <TraceConversation
      turns={messages.map((message) => {
        const role = messageRole(message)
        return { role: traceTurnRoleFromMessageRole(role), label: roleLabel(role), value: messageContent(message) }
      })}
    />
  )
}

function SkillMetadataValue({ value }: { value: unknown }) {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (Array.isArray(source)) {
    if (source.length === 0) return <span className="data-muted-value">empty</span>
    const objectItems = source.filter(isPlainObject)
    if (objectItems.length === 0) return <StructuredValue value={source} compact />
    const primitiveItems = source.filter((item) => !isPlainObject(item) && !Array.isArray(item))
    return (
      <div className="data-skill-card-list">
        {objectItems.map((item, index) => (
          <SkillMetadataCard key={index} value={item} index={index} />
        ))}
        {primitiveItems.length > 0 && <StructuredValue value={primitiveItems} compact />}
      </div>
    )
  }
  if (isPlainObject(source)) {
    return (
      <div className="data-skill-card-list">
        <SkillMetadataCard value={source} index={0} />
      </div>
    )
  }
  return <StructuredValue value={source} compact />
}

function SkillMetadataCard({ value, index }: { value: Record<string, unknown>; index: number }) {
  const name = stringFromKeys(value, SKILL_NAME_KEYS) || `Skill ${index + 1}`
  const id = stringFromKeys(value, SKILL_ID_KEYS)
  const description = stringFromKeys(value, SKILL_DESCRIPTION_KEYS)
  const reserved = new Set([...SKILL_NAME_KEYS, ...SKILL_ID_KEYS, ...SKILL_DESCRIPTION_KEYS])
  const chipEntries = SKILL_META_CHIP_KEYS
    .map((key) => [key, value[key]] as const)
    .filter(([key, item]) => !reserved.has(key) && isCompactPrimitive(item))
  const extraEntries = Object.entries(value)
    .filter(([key, item]) => !reserved.has(key) && !SKILL_META_CHIP_KEYS.includes(key) && isCompactPrimitive(item))
    .slice(0, 3)
  const chips = [...chipEntries, ...extraEntries].slice(0, 5)

  return (
    <article className="data-skill-card">
      <div className="data-skill-card-header">
        <strong title={name}>{name}</strong>
        {(id || chips.length > 0) && (
          <span className="data-skill-card-chips">
            {id && <span title={id}>ID: {id}</span>}
            {chips.map(([key, item]) => {
              const label = `${humanizeKey(key)}: ${formatInlineValue(item)}`
              return <span key={key} title={label}>{label}</span>
            })}
          </span>
        )}
      </div>
      {description && <p className="data-skill-card-description" title={description}>{description}</p>}
    </article>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="data-empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  options,
  emptyLabel,
  loading,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: DatasetFilterOption[]
  emptyLabel: string
  loading: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || loading}
        aria-label={label}
      >
        <option value="">{loading ? '加载中...' : emptyLabel}</option>
        {options.map((option) => (
          <option key={`${option.filter_key}:${option.id}`} value={option.id}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  )
}

function RecordMetadata({
  record,
  projects,
  rules,
}: {
  record: DatasetRecord
  projects: ProjectSummary[]
  rules: DatasetSourceRule[]
}) {
  return (
    <div className="data-metadata-stack">
      <MetaRows rows={provenanceRows(record, projects, rules)} />
      <div className="data-metadata-groups">
        <MetadataGroup title="Record metadata" value={record.record_metadata} />
        <MetadataGroup title="Provenance" value={record.provenance} />
      </div>
    </div>
  )
}

function MetadataGroup({ title, value }: { title: string; value: Record<string, unknown> }) {
  if (!hasValue(value)) return null
  return (
    <section className="data-metadata-group">
      <strong>{title}</strong>
      <StructuredValue value={value} compact />
    </section>
  )
}

function MetaRows({ rows }: { rows: MetaRow[] }) {
  return (
    <dl className="data-meta-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><MetaValue value={value} /></dd>
        </div>
      ))}
    </dl>
  )
}

function MetaValue({ value }: { value: unknown }) {
  if (!hasValue(value)) return <span>-</span>
  if (Array.isArray(value)) {
    return (
      <span className="data-chip-list">
        {value.map((item, index) => <span key={`${index}:${formatInlineValue(item)}`}>{formatInlineValue(item)}</span>)}
      </span>
    )
  }
  if (isPlainObject(value)) return <StructuredValue value={value} compact />
  return <span>{formatInlineValue(value)}</span>
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

function hasOption(options: DatasetFilterOption[], id: string): boolean {
  return options.some((option) => option.id === id)
}

function buildFilterLookups(optionSets: DatasetFilterOptions[]): FilterLookups {
  const lookups: FilterLookups = {
    agents: new Map(),
    skills: new Map(),
    workflows: new Map(),
  }
  for (const options of optionSets) {
    for (const option of options.agents) lookups.agents.set(option.id, option)
    for (const option of options.skills) lookups.skills.set(option.id, option)
    for (const option of options.workflows) lookups.workflows.set(option.id, option)
  }
  return lookups
}

function normalizedProjectType(project: ProjectSummary): 'paper' | 'skill' | 'data' {
  if (project.project_type === 'data') return 'data'
  if (project.project_type === 'skill' || project.is_skill_project) return 'skill'
  return 'paper'
}

function countStatuses(records: DatasetRecord[], total: number): Record<DatasetRecordStatus, number> {
  const counts: Record<DatasetRecordStatus, number> = {
    all: total,
    pending: 0,
    in_review: 0,
    labeled: 0,
    discarded: 0,
  }
  for (const record of records) {
    if (isConcreteStatus(record.status)) {
      counts[record.status] += 1
    }
  }
  return counts
}

function isConcreteStatus(status: string): status is Exclude<DatasetRecordStatus, 'all'> {
  return CONCRETE_STATUSES.includes(status as Exclude<DatasetRecordStatus, 'all'>)
}

function fieldsFromSchema(schema: Record<string, unknown> | undefined): SchemaField[] {
  const fields = isPlainObject(schema) && Array.isArray(schema.fields) ? schema.fields : []
  return fields
    .filter(isPlainObject)
    .map((field) => ({
      name: stringValue(field.name, ''),
      type: stringValue(field.type, 'field'),
      title: stringValue(field.title, stringValue(field.name, 'field')),
    }))
    .filter((field) => field.name.length > 0)
}

function questionsFromSchema(schema: Record<string, unknown> | undefined): SchemaQuestion[] {
  const questions = isPlainObject(schema) && Array.isArray(schema.questions) ? schema.questions : []
  return questions
    .filter(isPlainObject)
    .map((question) => ({
      name: stringValue(question.name, ''),
      type: stringValue(question.type, 'question'),
      title: stringValue(question.title, stringValue(question.name, 'question')),
      options: Array.isArray(question.options) ? question.options.map(String) : [],
    }))
    .filter((question) => question.name.length > 0)
}

function provenanceRows(
  record: DatasetRecord,
  projects: ProjectSummary[],
  rules: DatasetSourceRule[],
): MetaRow[] {
  const sourceRule = rules.find((rule) => rule.id === record.source_rule_id)
  const provenance = record.provenance ?? {}
  const metadata = record.record_metadata ?? {}
  const range = rangeLabel(metadata.range ?? {
    from: metadata.range_start,
    to: metadata.range_end,
  })
  const rows: MetaRow[] = [
    ['source project', sourceRule ? sourceName(sourceRule.source_project_id, projects) : stringValue(provenance.project_id, '')],
    ['source rule', sourceRule?.name ?? record.source_rule_id],
    ['source type', sourceTypeLabel(record.source_type)],
    ['source id', record.source_id],
    ['document', metadata.doc_name ?? metadata.document_name ?? metadata.document_id],
    ['range', range],
    ['agent', provenance.agent_name ?? provenance.agent_id ?? provenance.agent_ids ?? metadata.agent_name],
    ['skill', provenance.skill_id ?? provenance.skill_ids ?? metadata.skill_id ?? metadata.skill_ids],
    ['workflow', provenance.workflow_name ?? provenance.workflow_definition_id ?? provenance.workflow_id ?? metadata.workflow_name ?? metadata.workflow_definition_id ?? metadata.workflow_id],
    ['status', metadata.status ?? record.status],
    ['fingerprint', record.fingerprint],
  ]
  return rows.filter(([, value]) => hasValue(value))
}

function sourceName(projectId: string, projects: ProjectSummary[]): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId.slice(0, 8)
}

function sourceTypeLabel(sourceType: string): string {
  if (sourceType === 'annotations' || sourceType === 'conversations' || sourceType === 'workflow_runs') {
    return SOURCE_LABELS[sourceType]
  }
  if (sourceType === 'annotation') return SOURCE_LABELS.annotations
  if (sourceType === 'conversation') return SOURCE_LABELS.conversations
  if (sourceType === 'workflow_run') return SOURCE_LABELS.workflow_runs
  return sourceType
}

function recordTitle(record: DatasetRecord): string {
  const metadata = record.record_metadata ?? {}
  const title = stringValue(metadata.title, '')
  if (title) return title
  const docName = stringValue(metadata.doc_name ?? metadata.document_name, '')
  if (docName) return docName
  return `${sourceTypeLabel(record.source_type)} ${record.source_id.slice(0, 8)}`
}

function recordExcerpt(record: DatasetRecord): string {
  const chat = Array.isArray(record.fields.chat) ? record.fields.chat : []
  if (chat.length > 0) {
    const lastMessage = chat[chat.length - 1]
    return compactText(messageContentText(lastMessage), 128)
  }
  const sourceText = stringValue(record.fields.source_text, '')
  if (sourceText) return compactText(sourceText, 128)
  const output = stringValue(record.fields.agent_output, '')
  if (output) return compactText(output, 128)
  return compactText(formatValue(record.fields), 128)
}

function statusLabel(status: string): string {
  if (status === 'in_review') return 'in review'
  return status || 'pending'
}

function statusClass(status: string): string {
  if (status === 'labeled') return 'is-labeled'
  if (status === 'discarded') return 'is-discarded'
  if (status === 'in_review') return 'is-review'
  return 'is-pending'
}

function filterSummary(filters: Record<string, unknown>, lookups: FilterLookups): string {
  const entries = Object.entries(filters ?? {}).filter(([, value]) => hasValue(value))
  if (entries.length === 0) return 'no filters'
  return entries.map(([key, value]) => `${filterKeyLabel(key)}: ${formatFilterValue(key, value, lookups)}`).join(' · ')
}

function filterKeyLabel(key: string): string {
  if (key === 'agent_id') return 'Agent'
  if (key === 'skill_id') return 'Skill'
  if (key === 'workflow_id' || key === 'workflow_definition_id') return 'Workflow'
  if (key === 'only_training_candidates') return 'Training candidates'
  return key
}

function formatFilterValue(key: string, value: unknown, lookups: FilterLookups): string {
  if (typeof value === 'string') {
    if (key === 'workflow_id' && value.startsWith('native:')) {
      const agent = lookups.agents.get(value.slice('native:'.length))
      if (agent) return `${agent.name || agent.id} · ${value}`
    }
    const option = key === 'agent_id'
      ? lookups.agents.get(value)
      : key === 'skill_id'
        ? lookups.skills.get(value)
        : key === 'workflow_id' || key === 'workflow_definition_id'
          ? lookups.workflows.get(value)
          : undefined
    if (option) return optionLabel(option)
  }
  if (key === 'only_training_candidates' && typeof value === 'boolean') return value ? 'yes' : 'no'
  return formatInlineValue(value)
}

function optionLabel(option: DatasetFilterOption): string {
  const name = option.name || option.id
  return `${name} · ${option.id}`
}

function formatInlineValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? ''
}

const WORKFLOW_TRACE_SKILL_KEYS = [
  'activated_skills',
  'activatedSkills',
  'available_skills',
  'availableSkills',
  'skills',
  'skill_ids',
  'skillIds',
  'skill',
  'skill_id',
  'skillId',
]

const WORKFLOW_TRACE_TITLE_KEYS = [
  'name',
  'title',
  'node_name',
  'nodeName',
  'step_name',
  'stepName',
  'node_id',
  'nodeId',
  'id',
  'type',
  'kind',
]

const WORKFLOW_TRACE_TYPE_KEYS = ['type', 'kind', 'node_type', 'nodeType']

const WORKFLOW_TRACE_STATUS_KEYS = ['status', 'state']

const WORKFLOW_TRACE_AGENT_KEYS = ['agent_name', 'agentName', 'agent_id', 'agentId', 'agent']

const WORKFLOW_TRACE_SUMMARY_KEYS = ['summary', 'description', 'message', 'reason', 'error']

const SKILL_NAME_KEYS = [
  'name',
  'skill_name',
  'skillName',
  'display_name',
  'displayName',
  'public_name',
  'publicName',
  'folder_name',
  'folderName',
  'title',
]

const SKILL_ID_KEYS = ['id', 'skill_id', 'skillId', 'key', 'slug']

const SKILL_DESCRIPTION_KEYS = [
  'description',
  'summary',
  'reason',
  'instructions',
  'instruction',
  'prompt',
  'content',
  'text',
  'details',
  'detail',
]

const SKILL_META_CHIP_KEYS = [
  'version',
  'source',
  'kind',
  'status',
  'path',
  'folder_path',
  'folderPath',
  'entry_url',
  'entryUrl',
  'repo_url',
  'repoUrl',
]

function StructuredValue({ value, compact = false }: { value: unknown; compact?: boolean }) {
  if (typeof value === 'string') {
    const parsed = parseStructuredString(value)
    if (parsed !== null) return <StructuredValue value={parsed} compact={compact} />
    return <AgentMarkdown source={value} className={compact ? 'data-structured-markdown is-compact' : 'data-structured-markdown'} />
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="data-muted-value">empty</span>
    if (value.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
      return (
        <span className="data-chip-list">
          {value.map((item, index) => <span key={`${index}:${formatInlineValue(item)}`}>{formatInlineValue(item)}</span>)}
        </span>
      )
    }
    return (
      <div className={`data-structured-list ${compact ? 'is-compact' : ''}`}>
        {value.map((item, index) => (
          <div key={index} className="data-structured-card">
            <StructuredValue value={item} compact />
          </div>
        ))}
      </div>
    )
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => hasValue(item))
    if (entries.length === 0) return <span className="data-muted-value">empty</span>
    return (
      <dl className={`data-structured-rows ${compact ? 'is-compact' : ''}`}>
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd><StructuredValue value={item} compact /></dd>
          </div>
        ))}
      </dl>
    )
  }
  if (!hasValue(value)) return <span className="data-muted-value">empty</span>
  return <span>{formatInlineValue(value)}</span>
}

function parseStructuredString(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed || !['{', '['].includes(trimmed[0])) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeAgentOutput(value: unknown): {
  body: string
  metadata: Record<string, unknown> | null
  fallback: unknown
} {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (typeof source === 'string') {
    return { body: source, metadata: null, fallback: source }
  }
  if (Array.isArray(source)) {
    const stringItems = source.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (stringItems.length === source.length && stringItems.length > 0) {
      return { body: stringItems.join('\n\n'), metadata: null, fallback: source }
    }
    return { body: '', metadata: null, fallback: source }
  }
  if (isPlainObject(source)) {
    const primary = primaryOutputEntry(source)
    if (primary) {
      const metadata = pruneOutputMetadata(source, primary.value, primary.key)
      return {
        body: primary.value,
        metadata,
        fallback: source,
      }
    }
    return { body: '', metadata: null, fallback: source }
  }
  return { body: formatInlineValue(source), metadata: null, fallback: source }
}

const AGENT_OUTPUT_BODY_KEYS = new Set([
  'text',
  'answer',
  'response',
  'output',
  'result',
  'content',
  'message',
  'markdown',
  'summary',
  'raw',
  'raw_text',
  'completion',
  'generated_text',
  'final',
  'final_answer',
])

const TRACE_CONVERSATION_METADATA_KEYS = new Set([
  'agentoutput',
  'chat',
  'completion',
  'content',
  'conversation',
  'conversationid',
  'history',
  'instruction',
  'message',
  'messages',
  'request',
  'output',
  'outputs',
  'input',
  'inputs',
  'parentrunid',
  'prompt',
  'promptaudit',
  'query',
  'response',
  'result',
  'systemprompt',
  'text',
  'user',
  'userprompt',
  'priormessages',
  'messagecount',
])

const TRACE_REQUEST_HUMAN_INPUT_KEYS = [
  'user_message',
  'userMessage',
  'message',
  'text',
  'content',
  'instruction',
]

const TRACE_REQUEST_PROMPT_KEYS = [
  'user_message',
  'userMessage',
  'message',
  'instruction',
  'query',
  'prompt',
  'user_prompt',
  'userPrompt',
]

const TRACE_REQUEST_CONTEXT_KEYS = [
  'target_text',
  'targetText',
  'selection_text',
  'selectionText',
]

function primaryOutputEntry(value: Record<string, unknown>): { key: string; value: string } | null {
  const keys = Array.from(AGENT_OUTPUT_BODY_KEYS)
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return { key, value: item }
  }
  const stringEntries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
  )
  if (stringEntries.length === 1) return { key: stringEntries[0][0], value: stringEntries[0][1] }
  return null
}

function pruneOutputMetadata(
  value: Record<string, unknown>,
  body: string,
  primaryKey: string,
): Record<string, unknown> | null {
  const entries = Object.entries(value)
    .map(([key, item]) => [key, pruneOutputMetadataValue(item, body, key, key === primaryKey)] as const)
    .filter(([, item]) => hasValue(item))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function pruneOutputMetadataValue(
  value: unknown,
  body: string,
  key: string,
  isPrimary: boolean,
): unknown {
  if (!hasValue(value)) return undefined
  if (isPrimary) return undefined

  const rawKey = key.toLowerCase()
  const metadataKey = normalizeMetadataKey(key)
  if (TRACE_CONVERSATION_METADATA_KEYS.has(metadataKey)) return undefined
  if (typeof value === 'string') {
    const parsed = parseStructuredString(value)
    if (parsed !== null) return pruneOutputMetadataValue(parsed, body, rawKey, false)
    if (AGENT_OUTPUT_BODY_KEYS.has(rawKey) || isDuplicateOutputText(value, body)) return undefined
    return value
  }

  if (Array.isArray(value)) {
    const pruned = value
      .map((item, index) => pruneOutputMetadataValue(item, body, `${rawKey}_${index}`, false))
      .filter(hasValue)
    return pruned.length > 0 ? pruned : undefined
  }

  if (isPlainObject(value)) {
    if (AGENT_OUTPUT_BODY_KEYS.has(rawKey)) {
      const nestedPrimary = primaryOutputEntry(value)
      if (nestedPrimary && isDuplicateOutputText(nestedPrimary.value, body)) return undefined
    }
    const prunedEntries = Object.entries(value)
      .map(([childKey, item]) => [
        childKey,
        pruneOutputMetadataValue(item, body, childKey.toLowerCase(), false),
      ] as const)
      .filter(([, item]) => hasValue(item))
    return prunedEntries.length > 0 ? Object.fromEntries(prunedEntries) : undefined
  }

  return value
}

function isDuplicateOutputText(value: string, body: string): boolean {
  const cleanValue = normalizeComparableText(value)
  const cleanBody = normalizeComparableText(body)
  if (!cleanValue || !cleanBody) return false
  if (cleanValue === cleanBody) return true
  if (cleanBody.length >= 80 && cleanValue.includes(cleanBody)) return true
  if (cleanValue.length >= 80 && cleanBody.includes(cleanValue)) return true
  return false
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeMetadataKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isSkillMetadataKey(value: string): boolean {
  return normalizeMetadataKey(value).includes('skill')
}

function isWorkflowTraceKey(value: string): boolean {
  const normalized = normalizeMetadataKey(value)
  return normalized === 'trace' || normalized === 'workflowtrace' || normalized === 'workflowtraces' || normalized.includes('workflowtrace')
}

function workflowTraceDetailEntries(
  value: Record<string, unknown>,
  summaryKey: string,
  consumedKeys = new Set<string>(),
): [string, unknown][] {
  const represented = new Set([
    ...WORKFLOW_TRACE_TITLE_KEYS,
    ...WORKFLOW_TRACE_TYPE_KEYS,
    ...WORKFLOW_TRACE_STATUS_KEYS,
    ...WORKFLOW_TRACE_AGENT_KEYS,
    ...WORKFLOW_TRACE_SKILL_KEYS,
  ])
  return Object.entries(value).filter(([key, item]) => {
    if (!hasValue(item)) return false
    if (TRACE_CONVERSATION_METADATA_KEYS.has(normalizeMetadataKey(key))) return false
    if (consumedKeys.has(key)) return false
    if (represented.has(key)) return false
    if (key === summaryKey && typeof item === 'string' && normalizeComparableText(item).length <= 220) return false
    return true
  })
}

function workflowTraceTranscript(source: unknown[], fallbackAgentOutput?: unknown): {
  turns: TraceTurn[]
  byIndex: Map<number, TraceConversationModel>
} {
  const turns: TraceTurn[] = []
  const byIndex = new Map<number, TraceConversationModel>()

  source.forEach((node, index) => {
    const parsed = typeof node === 'string' ? parseStructuredString(node) : null
    const item = parsed ?? node
    if (!isPlainObject(item)) return

    const conversation = workflowTraceConversation(item, index === source.length - 1 ? fallbackAgentOutput : undefined)
    byIndex.set(index, conversation)
    turns.push(...conversation.turns)
  })

  return { turns: compactTraceTurns(turns), byIndex }
}

function workflowTraceConversation(value: Record<string, unknown>, fallbackAgentOutput?: unknown): {
  turns: TraceTurn[]
  consumedKeys: Set<string>
} {
  const turns: TraceTurn[] = []
  const consumedKeys = new Set<string>()
  const requestEntry = valueEntryFromKeys(value, ['request'])
  const promptAuditEntry = valueEntryFromKeys(value, ['prompt_audit', 'promptAudit'])
  const inputEntry = valueEntryFromKeys(value, ['input', 'inputs'])
  const directRequestEntry = valueEntryFromKeys(value, TRACE_REQUEST_PROMPT_KEYS)
  const messagesEntry = valueEntryFromKeys(value, ['messages', 'chat', 'conversation', 'history', 'prior_messages', 'priorMessages'])
  const outputEntry = valueEntryFromKeys(value, ['output', 'outputs', 'agent_output', 'agentOutput'])

  if (messagesEntry && isMessageList(messagesEntry[1])) {
    consumedKeys.add(messagesEntry[0])
    appendMessageTurns(turns, messagesEntry[1], '')
  }

  if (requestEntry) {
    consumedKeys.add(requestEntry[0])
    appendRequestTurns(turns, requestEntry[1], 'Request')
  } else if (inputEntry) {
    consumedKeys.add(inputEntry[0])
    appendRequestTurns(turns, inputEntry[1], 'Request')
  } else if (!messagesEntry && directRequestEntry) {
    consumedKeys.add(directRequestEntry[0])
    turns.push({ role: 'user', label: 'Request', value: directRequestEntry[1] })
  }

  if (promptAuditEntry) {
    consumedKeys.add(promptAuditEntry[0])
    appendPromptAuditTurns(turns, promptAuditEntry[1])
  } else if (isPlainObject(outputEntry?.[1])) {
    const nestedPromptAudit = valueEntryFromKeys(outputEntry[1], ['prompt_audit', 'promptAudit'])
    if (nestedPromptAudit) appendPromptAuditTurns(turns, nestedPromptAudit[1])
  }

  if (outputEntry) {
    consumedKeys.add(outputEntry[0])
    appendAgentOutputTurn(turns, outputEntry[1])
  } else {
    const directOutput = valueEntryFromKeys(value, ['text', 'response', 'result'])
    if (directOutput) {
      consumedKeys.add(directOutput[0])
      appendAgentOutputTurn(turns, directOutput[1])
    } else if (hasValue(fallbackAgentOutput)) {
      appendAgentOutputTurn(turns, fallbackAgentOutput)
    }
  }

  return { turns, consumedKeys }
}

function appendRequestTurns(turns: TraceTurn[], value: unknown, label: string): void {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (isPlainObject(source)) {
    appendMessageTurns(turns, source.prior_messages, 'Prior')
    const text = traceRequestText(source)
    turns.push({ role: 'user', label, value: text || source })
    return
  }
  turns.push({ role: 'user', label, value: source })
}

function appendPromptAuditTurns(turns: TraceTurn[], value: unknown): void {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (!isPlainObject(source)) {
    turns.push({ role: 'system', label: 'Prompt audit', value: source })
    return
  }

  const systemPrompt = textFromKeys(source, ['system_prompt', 'systemPrompt'])
  if (systemPrompt) turns.push({ role: 'system', label: 'System prompt', value: systemPrompt })
  const priorMessages = valueEntryFromKeys(source, ['prior_messages', 'priorMessages', 'messages', 'chat', 'conversation', 'history'])
  if (priorMessages) appendMessageTurns(turns, priorMessages[1], 'Prior')
  const userPrompt = textFromKeys(source, ['user_prompt', 'userPrompt'])
  if (userPrompt) turns.push({ role: 'user', label: 'User prompt', value: userPrompt })
  if (!systemPrompt && !userPrompt && !isMessageList(priorMessages?.[1])) {
    turns.push({ role: 'system', label: 'Prompt audit', value: source })
  }
}

function appendAgentOutputTurn(turns: TraceTurn[], value: unknown): void {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (isPlainObject(source)) {
    const nestedRequest = valueEntryFromKeys(source, ['request'])
    const nestedPromptAudit = valueEntryFromKeys(source, ['prompt_audit', 'promptAudit'])
    if (nestedRequest && !turns.some((turn) => turn.label === 'Request')) appendRequestTurns(turns, nestedRequest[1], 'Request')
    if (nestedPromptAudit && !turns.some((turn) => turn.label === 'System prompt' || turn.label === 'Prompt audit')) {
      appendPromptAuditTurns(turns, nestedPromptAudit[1])
    }
  }
  turns.push({ role: 'agent', label: 'Agent output', value: traceAgentOutputValue(source) })
}

function appendMessageTurns(turns: TraceTurn[], value: unknown, labelPrefix: string): void {
  if (!isMessageList(value)) return
  for (const message of value) {
    const role = messageRole(message)
    const content = messageContent(message)
    turns.push({
      role: traceTurnRoleFromMessageRole(role),
      label: labelPrefix ? `${labelPrefix} ${roleLabel(role)}` : roleLabel(role),
      value: hasValue(content) ? content : message,
    })
  }
}

function compactTraceTurns(turns: TraceTurn[]): TraceTurn[] {
  const compacted: TraceTurn[] = []
  for (const turn of turns) {
    const previous = compacted[compacted.length - 1]
    if (
      previous &&
      previous.role === turn.role &&
      previous.label === turn.label &&
      traceTurnComparableValue(previous.value) === traceTurnComparableValue(turn.value)
    ) {
      continue
    }
    compacted.push(turn)
  }
  return compacted
}

function traceTurnComparableValue(value: unknown): string {
  if (typeof value === 'string') return normalizeComparableText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return normalizeComparableText(JSON.stringify(value))
  } catch {
    return ''
  }
}

function traceRequestText(value: Record<string, unknown>): string {
  const inputs = isPlainObject(value.inputs) ? value.inputs : null
  const humanInput = inputs ? textFromKeys(inputs, TRACE_REQUEST_HUMAN_INPUT_KEYS) : ''
  const directHuman = textFromKeys(value, ['user_message', 'userMessage', 'message', 'instruction'])
  if (humanInput || directHuman) return uniqueMarkdownParts([humanInput, directHuman]).join('\n\n')

  const directPrompt = textFromKeys(value, ['query', 'prompt', 'user_prompt', 'userPrompt'])
  const inputPrompt = inputs ? textFromKeys(inputs, ['query', 'prompt']) : ''
  const inputContext = inputs ? textFromKeys(inputs, TRACE_REQUEST_CONTEXT_KEYS) : ''
  return uniqueMarkdownParts([directPrompt, inputPrompt, inputContext]).join('\n\n')
}

function traceBubbleMarkdown(role: TraceTurnRole, value: unknown): string {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (typeof source === 'string') return source

  if (role === 'user' && isPlainObject(source)) {
    const requestText = traceRequestText(source)
    if (requestText) return requestText
    const direct = textFromKeys(source, [
      'content',
      'text',
      'message',
      'query',
      'instruction',
      'prompt',
      'target_text',
      'targetText',
      'selection_text',
      'selectionText',
      'user_prompt',
      'userPrompt',
    ])
    if (direct) return direct
  }

  if (role === 'agent') {
    const output = traceAgentOutputValue(source)
    if (typeof output === 'string') return output
  }

  if (role === 'system' && isPlainObject(source)) {
    const prompt = textFromKeys(source, ['system_prompt', 'systemPrompt', 'content', 'text', 'message'])
    if (prompt) return prompt
  }

  return ''
}

function traceAgentOutputValue(value: unknown): unknown {
  const normalized = normalizeAgentOutput(value)
  if (normalized.body) return normalized.body
  if (isPlainObject(value)) {
    for (const key of ['outputs', 'output', 'result', 'response']) {
      const nested = value[key]
      if (!hasValue(nested)) continue
      const nestedOutput = normalizeAgentOutput(nested)
      if (nestedOutput.body) return nestedOutput.body
    }
  }
  return value
}

function uniqueMarkdownParts(parts: string[]): string[] {
  const seen = new Set<string>()
  return parts
    .map((part) => part.trim())
    .filter((part) => {
      const comparable = normalizeComparableText(part)
      if (!comparable || seen.has(comparable)) return false
      seen.add(comparable)
      return true
    })
}

function valueEntryFromKeys(value: Record<string, unknown>, keys: string[]): [string, unknown] | null {
  for (const key of keys) {
    const item = value[key]
    if (hasValue(item)) return [key, item]
  }
  return null
}

function firstStringKey(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return key
  }
  return ''
}

function stringFromKeys(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key]
    if (!hasValue(item)) continue
    if (typeof item === 'string') return normalizeComparableText(item)
    if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  }
  return ''
}

function textFromKeys(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key]
    if (!hasValue(item)) continue
    if (typeof item === 'string') return item.trim()
    if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  }
  return ''
}

function isCompactPrimitive(value: unknown): value is string | number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (typeof value !== 'string') return false
  const clean = normalizeComparableText(value)
  return clean.length > 0 && clean.length <= 180
}

function isTraceMessageKey(value: string): boolean {
  const normalized = normalizeMetadataKey(value)
  return normalized.includes('message') || normalized.includes('chat')
}

function isConversationalTraceValue(key: string, value: unknown): boolean {
  const parsed = typeof value === 'string' ? parseStructuredString(value) : null
  const source = parsed ?? value
  if (isTraceMessageKey(key) && isMessageList(source)) return true
  if (!isPlainObject(source)) return false
  return Object.entries(source).some(([childKey, item]) => isTraceMessageKey(childKey) && isMessageList(item))
}

function isMessageList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (!isPlainObject(item)) return false
    return hasValue(item.content) || hasValue(item.text) || hasValue(item.message) || hasValue(item.role)
  })
}

function traceTurnRoleFromMessageRole(role: string): TraceTurnRole {
  if (role === 'user') return 'user'
  if (role === 'assistant' || role === 'agent') return 'agent'
  return 'system'
}

function rangeLabel(value: unknown): string {
  if (!isPlainObject(value)) return ''
  const from = Number(value.from)
  const to = Number(value.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return ''
  const length = Math.max(0, to - from)
  return `${from} -> ${to}${length > 0 ? ` (${length} chars)` : ''}`
}

function humanizeKey(value: string): string {
  return value.replace(/_/g, ' ')
}

function compactText(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, maxLength - 1)}…`
}

function formatDate(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function messageRole(value: unknown): string {
  if (!isPlainObject(value)) return 'message'
  return stringValue(value.role, 'message')
}

function roleLabel(role: string): string {
  if (role === 'assistant') return 'assistant'
  if (role === 'agent') return 'agent'
  if (role === 'system') return 'system'
  if (role === 'tool') return 'tool'
  if (role === 'user') return 'user'
  return role || 'message'
}

function chatRoleClass(role: string): string {
  if (role === 'assistant' || role === 'agent') return 'agent'
  if (role === 'user') return 'user'
  if (role === 'system' || role === 'tool') return 'system'
  return 'message'
}

function messageContent(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (!isPlainObject(value)) return ''
  return normalizeMessageContent(value.content ?? value.text ?? value.message)
}

function messageContentText(value: unknown): string {
  const content = messageContent(value)
  if (typeof content === 'string') return content
  if (!hasValue(content)) return ''
  return formatValue(content)
}

function normalizeMessageContent(value: unknown): unknown {
  if (!hasValue(value)) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const textParts = value
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (!isPlainObject(item)) return ''
        return textFromKeys(item, ['text', 'content', 'message'])
      })
      .filter(Boolean)
    return textParts.length > 0 ? uniqueMarkdownParts(textParts).join('\n\n') : value
  }
  if (isPlainObject(value)) {
    const text = textFromKeys(value, ['text', 'content', 'message'])
    return text || value
  }
  return value
}
