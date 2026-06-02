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
import { SettingsDialog } from '../features/settings/SettingsDialog'
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

  const [personalPanelOpen, setPersonalPanelOpen] = useState(false)
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
      <Topbar onOpenPersonalPanel={() => setPersonalPanelOpen(true)} />
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
                <details className="data-json-details">
                  <summary><FileJson size={14} /> Raw record</summary>
                  <pre>{formatValue({
                    fields: selectedRecord.fields,
                    metadata: selectedRecord.record_metadata,
                    provenance: selectedRecord.provenance,
                  })}</pre>
                </details>
                <section className="data-record-metadata">
                  <div className="data-section-heading">
                    <div>
                      <span><FileJson size={14} /> Metadata</span>
                      <strong>{selectedRecord.fingerprint.slice(0, 8)}</strong>
                    </div>
                  </div>
                  <MetaRows rows={provenanceRows(selectedRecord, projects, rules)} />
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
      <SettingsDialog open={personalPanelOpen} onOpenChange={setPersonalPanelOpen} />
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
                  <p>{messageContent(message)}</p>
                </div>
              )
            })}
          </div>
        </section>
      )}
      {[...schemaBlocks, ...extraBlocks].map((block) => (
        <section key={block.key} className="data-field-block">
          <div className="data-field-title">{block.title}</div>
          <pre>{formatValue(block.value)}</pre>
        </section>
      ))}
      {chat.length === 0 && schemaBlocks.length === 0 && extraBlocks.length === 0 && (
        <EmptyState title="没有可展示字段" detail="这条 record 只有元数据，可以在 Raw record 中查看完整 JSON。" />
      )}
    </div>
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

function MetaRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="data-meta-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || '-'}</dd>
        </div>
      ))}
    </dl>
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
): Array<[string, string]> {
  const sourceRule = rules.find((rule) => rule.id === record.source_rule_id)
  const provenance = record.provenance ?? {}
  const metadata = record.record_metadata ?? {}
  return [
    ['source project', sourceRule ? sourceName(sourceRule.source_project_id, projects) : stringValue(provenance.project_id, '')],
    ['source rule', sourceRule?.name ?? record.source_rule_id],
    ['source type', sourceTypeLabel(record.source_type)],
    ['source id', record.source_id],
    ['agent', stringValue(provenance.agent_name ?? provenance.agent_id ?? metadata.agent_name, '')],
    ['skill', stringValue(provenance.skill_id ?? metadata.skill_id, '')],
    ['workflow', stringValue(provenance.workflow_name ?? provenance.workflow_id ?? metadata.workflow_name, '')],
    ['fingerprint', record.fingerprint],
  ]
}

function sourceName(projectId: string, projects: ProjectSummary[]): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId.slice(0, 8)
}

function sourceTypeLabel(sourceType: string): string {
  if (sourceType === 'annotations' || sourceType === 'conversations' || sourceType === 'workflow_runs') {
    return SOURCE_LABELS[sourceType]
  }
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
    return compactText(messageContent(lastMessage), 128)
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

function messageContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isPlainObject(value)) return ''
  return stringValue(value.content ?? value.text ?? value.message, '')
}
