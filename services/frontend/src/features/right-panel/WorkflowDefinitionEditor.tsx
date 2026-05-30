/**
 * WorkflowDefinitionEditor — create/edit workflow definitions
 *
 * Three editing modes:
 *   - form:   basic metadata only (for stub workflows, no node config)
 *   - canvas: React Flow visual editor (recommended)
 *   - json:   raw JSON escape hatch, with clipboard import/export so a
 *             workflow can be moved verbatim between projects.
 *
 * Canvas mode holds its graph in local state and serializes on save. Switching
 * modes preserves the in-memory graph, so you can tweak visually then eyeball
 * the JSON if you want. The JSON payload carries name/description/graph/config
 * together — one paste fully reconstructs a workflow.
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  WorkflowDefinition,
  WorkflowDefinitionDraft,
  WorkflowGraph,
  WorkflowConfig,
  WorkflowTestCase,
} from '../../services/backendApi'
import { workflowTestCaseApi } from '../../services/backendApi'
import type { NodeStatus, RunEvent } from '../../stores/workflowStore'
import { AgentMarkdown } from '../shared/AgentMarkdown'
import { WorkflowCanvas } from './workflow-canvas'

type Mode = 'form' | 'canvas' | 'json'

interface WorkflowDefinitionEditorProps {
  definition?: WorkflowDefinition
  /** When set, seeds the editor from a draft (e.g. a template) rather than an
   *  existing definition. Ignored if `definition` is provided. */
  initialDraft?: WorkflowDefinitionDraft
  onSave: (draft: WorkflowDefinitionDraft) => Promise<void>
  onCancel: () => void
  onTestDefinition?: (definitionId: string, prompt: string) => void
  testRunning?: boolean
  testEvents?: RunEvent[]
  testNodeStatuses?: NodeStatus[]
}

interface WorkflowJsonPayload {
  name?: string
  description?: string
  graph?: WorkflowGraph
  config?: WorkflowConfig
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] }

function buildJsonText(
  name: string,
  description: string,
  graph: WorkflowGraph,
  config: WorkflowConfig,
): string {
  return JSON.stringify({ name, description, graph, config }, null, 2)
}

export function WorkflowDefinitionEditor({
  definition,
  initialDraft,
  onSave,
  onCancel,
  onTestDefinition,
  testRunning = false,
  testEvents = [],
  testNodeStatuses = [],
}: WorkflowDefinitionEditorProps) {
  const seed = definition ?? initialDraft
  const [mode, setMode] = useState<Mode>('canvas')
  const [name, setName] = useState(seed?.name ?? '')
  const [description, setDescription] = useState(seed?.description ?? '')
  const executionMode: WorkflowDefinition['execution_mode'] = 'graph'
  const [graph, setGraph] = useState<WorkflowGraph>(seed?.graph ?? EMPTY_GRAPH)
  const [config, setConfig] = useState<WorkflowConfig>(seed?.config ?? {})
  const [jsonText, setJsonText] = useState(
    seed
      ? buildJsonText(
          seed.name ?? '',
          seed.description ?? '',
          seed.graph,
          seed.config ?? {},
        )
      : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testPrompt, setTestPrompt] = useState('现在开始接龙，你需要讲这段完整输出，并在最后添数，以此给后面的 Agent 足够的信息：\n报数开始，每次多报一个数，每个数单独一行：\n1')
  const [notice, setNotice] = useState<string | null>(null)

  const flashNotice = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((curr) => (curr === msg ? null : curr)), 2500)
  }

  const applyJsonToState = (text: string): string | null => {
    // Parse `text` into the editor state. Returns an error message on failure,
    // `null` on success. `name` / `description` are optional; only `graph` is
    // required — missing config defaults to {}.
    let parsed: WorkflowJsonPayload
    try {
      parsed = JSON.parse(text || '{}') as WorkflowJsonPayload
    } catch (e) {
      return `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`
    }
    if (!parsed || typeof parsed !== 'object') {
      return 'JSON 必须是对象'
    }
    const nextGraph = parsed.graph ?? EMPTY_GRAPH
    if (
      !nextGraph ||
      !Array.isArray(nextGraph.nodes) ||
      !Array.isArray(nextGraph.edges)
    ) {
      return 'graph 必须包含 nodes 和 edges 数组'
    }
    setGraph(nextGraph)
    setConfig(parsed.config ?? {})
    if (typeof parsed.name === 'string') setName(parsed.name)
    if (typeof parsed.description === 'string') setDescription(parsed.description)
    return null
  }

  const switchMode = (next: Mode) => {
    if (mode === next) return
    if (mode === 'canvas' && next === 'json') {
      setJsonText(buildJsonText(name, description, graph, config))
    }
    if (mode === 'json' && next === 'canvas') {
      const err = applyJsonToState(jsonText)
      if (err) {
        setError(err)
        return
      }
      setError(null)
    }
    setMode(next)
  }

  const handleCopyJson = async () => {
    const text =
      mode === 'json' ? jsonText : buildJsonText(name, description, graph, config)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for non-secure contexts (webview without clipboard API).
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      flashNotice('已复制到剪贴板')
      // Also update the json pane so the user sees exactly what was copied.
      if (mode === 'json' && text !== jsonText) setJsonText(text)
    } catch (e) {
      setError(`复制失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleImportJson = async () => {
    try {
      let text = ''
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText()
      } else {
        text = window.prompt('粘贴 workflow JSON：') ?? ''
      }
      if (!text.trim()) {
        setError('剪贴板为空或未授权访问')
        return
      }
      const err = applyJsonToState(text)
      if (err) {
        setError(err)
        return
      }
      setJsonText(text)
      setError(null)
      flashNotice('已从剪贴板导入')
    } catch (e) {
      setError(`导入失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      let finalGraph: WorkflowGraph = graph
      let finalConfig: WorkflowConfig = config
      let finalName = name
      let finalDescription = description

      if (mode === 'json') {
        let parsed: WorkflowJsonPayload
        try {
          parsed = JSON.parse(jsonText || '{}') as WorkflowJsonPayload
        } catch (e) {
          throw new Error(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
        }
        finalGraph = parsed.graph ?? EMPTY_GRAPH
        finalConfig = parsed.config ?? {}
        if (typeof parsed.name === 'string' && parsed.name) finalName = parsed.name
        if (typeof parsed.description === 'string') finalDescription = parsed.description
      }

      const draft: WorkflowDefinitionDraft = {
        name: finalName,
        description: finalDescription,
        execution_mode: executionMode,
        graph: finalGraph,
        config: finalConfig,
      }

      await onSave(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="workflow-definition-editor">
      <div className="editor-header">
        <h3>{definition ? '编辑 Workflow' : '创建 Workflow'}</h3>
        <div className="mode-toggle">
          <button
            className={mode === 'canvas' ? 'active' : ''}
            onClick={() => switchMode('canvas')}
          >
            图形模式
          </button>
          {/* 表单模式已隐藏：只保存元数据，无实际编辑能力，统一由图形模式承担。
          <button
            className={mode === 'form' ? 'active' : ''}
            onClick={() => switchMode('form')}
          >
            表单模式
          </button>
          */}
          <button
            className={mode === 'json' ? 'active' : ''}
            onClick={() => switchMode('json')}
          >
            JSON 模式
          </button>
        </div>
      </div>

      {error && <div className="editor-error">{error}</div>}
      {notice && <div className="editor-notice">{notice}</div>}

      <div className="editor-metadata">
        <div className="form-group">
          <label>名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：并行审稿 / 流水线分析"
          />
        </div>

        <div className="form-group">
          <label>描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简要描述这个 workflow 的用途"
            rows={2}
          />
        </div>
      </div>

      {mode === 'canvas' && (
        <div className="editor-canvas">
          <WorkflowCanvas
            initialGraph={graph}
            onGraphChange={setGraph}
            nodeStatuses={testNodeStatuses}
          />
          <div className="form-hint">
            💡 从左侧拖拽节点到画布，拖线连接，点击节点在右侧编辑配置。按 Delete/Backspace 删除选中项。
          </div>
        </div>
      )}

      {mode === 'form' && (
        <div className="editor-form">
          <div className="form-hint">
            💡 表单模式已停用，请使用图形模式或 JSON 模式。
          </div>
        </div>
      )}

      {mode === 'json' && (
        <div className="editor-json">
          <div className="form-group">
            <div className="json-toolbar">
              <label>完整 Workflow JSON（名称 · 描述 · Graph · Config）</label>
              <div className="json-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleCopyJson}
                  title="把当前 JSON 写入剪贴板，可跨项目粘贴"
                >
                  📋 导出到剪贴板
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleImportJson}
                  title="从剪贴板读取 JSON 并替换当前编辑内容"
                >
                  📥 从剪贴板导入
                </button>
              </div>
            </div>
            <textarea
              className="json-editor"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={buildJsonText(
                '示例 Workflow',
                '在此处粘贴从其他项目导出的 JSON，或手动编辑后保存。',
                {
                  nodes: [
                    { id: 'n1', type: 'agent', config: { agent_id: 'agent-1' } },
                    { id: 'n2', type: 'agent', config: { agent_id: 'agent-2' } },
                  ],
                  edges: [{ source: 'n1', target: 'n2' }],
                },
                { max_rounds: 3 },
              )}
              rows={15}
              spellCheck={false}
            />
            <div className="form-hint">
              💡 导出后可直接在另一项目的 JSON 面板里点「导入」完成复制。保存时以此 JSON 为准。
            </div>
          </div>
        </div>
      )}

      <div className="editor-actions">
        <WorkflowTestPanel
          definitionId={definition?.id}
          prompt={testPrompt}
          onPromptChange={setTestPrompt}
          onRun={onTestDefinition}
          running={testRunning}
          events={testEvents}
          nodeStatuses={testNodeStatuses}
        />
        <button className="secondary-btn" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button className="primary-btn" onClick={handleSave} disabled={saving || !name}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function WorkflowTestPanel({
  definitionId,
  prompt,
  onPromptChange,
  onRun,
  running,
  events,
  nodeStatuses,
}: {
  definitionId?: string
  prompt: string
  onPromptChange: (value: string) => void
  onRun?: (definitionId: string, prompt: string) => void
  running: boolean
  events: RunEvent[]
  nodeStatuses: NodeStatus[]
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [fixtures, setFixtures] = useState<WorkflowTestCase[]>([])
  const [fixturesError, setFixturesError] = useState<string | null>(null)
  const failed = nodeStatuses.find((n) => n.status === 'failed')
  const latestEvent = events.at(-1)
  // Build a chronological timeline directly from the event stream so each
  // node execution shows up as its own row — including loop children that
  // run multiple times. The order is preserved from how the backend emitted
  // events (node.completed / node.failed in arrival order).
  const timeline = useMemo(() => buildTimeline(events), [events])
  const selectedTimelineItem =
    timeline.find((t) => t.key === selectedNodeId) ?? timeline[timeline.length - 1] ?? null

  useEffect(() => {
    if (!definitionId) {
      setFixtures([])
      return
    }
    let cancelled = false
    void workflowTestCaseApi
      .list(definitionId)
      .then((rows) => {
        if (!cancelled) setFixtures(rows)
      })
      .catch((e) => {
        if (!cancelled) setFixturesError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [definitionId])

  const handleSaveFixture = async () => {
    if (!definitionId) return
    const name = window.prompt('测试用例名称：', `Fixture ${fixtures.length + 1}`)
    if (!name) return
    try {
      const created = await workflowTestCaseApi.create(definitionId, { name, prompt })
      setFixtures((prev) => [...prev, created])
    } catch (e) {
      setFixturesError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleLoadFixture = (caseId: string) => {
    const fx = fixtures.find((f) => f.id === caseId)
    if (!fx) return
    onPromptChange(fx.prompt)
  }

  const handleDeleteFixture = async (caseId: string) => {
    if (!definitionId) return
    if (!window.confirm('删除这个测试用例？')) return
    try {
      await workflowTestCaseApi.delete(definitionId, caseId)
      setFixtures((prev) => prev.filter((f) => f.id !== caseId))
    } catch (e) {
      setFixturesError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    // Reset selection when the run resets; otherwise keep the user's pick if
    // it still maps to a timeline item, else fall through to "latest".
    if (timeline.length === 0) {
      setSelectedNodeId(null)
      return
    }
    setSelectedNodeId((curr) =>
      curr && timeline.some((t) => t.key === curr) ? curr : timeline[timeline.length - 1].key,
    )
  }, [timeline])

  return (
    <div className="workflow-test-panel">
      <div className="workflow-test-head">
        <span>测试</span>
        <div className="workflow-test-head-actions">
          {definitionId && fixtures.length > 0 && (
            <select
              className="workflow-test-fixture-select"
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (v) handleLoadFixture(v)
              }}
              title="加载已保存的测试用例"
            >
              <option value="">加载用例…</option>
              {fixtures.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {definitionId && (
            <button
              type="button"
              className="secondary-btn"
              onClick={handleSaveFixture}
              disabled={!prompt.trim()}
              title="把当前 Prompt 保存为可重复使用的测试用例"
            >
              💾 保存为用例
            </button>
          )}
          <button
            className="primary-btn"
            type="button"
            disabled={!definitionId || !onRun || running || !prompt.trim()}
            onClick={() => definitionId && onRun?.(definitionId, prompt)}
            title={!definitionId ? '先保存 Workflow 后再测试' : undefined}
          >
            {running ? '运行中…' : '运行测试'}
          </button>
        </div>
      </div>
      {fixturesError && <div className="workflow-test-hint error">{fixturesError}</div>}
      {fixtures.length > 0 && (
        <div className="workflow-test-fixture-chips">
          {fixtures.map((f) => (
            <span key={f.id} className="workflow-test-fixture-chip" title={f.name}>
              <button
                type="button"
                className="workflow-test-fixture-load"
                onClick={() => handleLoadFixture(f.id)}
              >
                {f.name}
              </button>
              <button
                type="button"
                className="workflow-test-fixture-del"
                onClick={() => handleDeleteFixture(f.id)}
                title="删除该用例"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="输入测试 Prompt，例如：请从 1 数到 5"
        rows={2}
      />
      {!definitionId && <div className="workflow-test-hint">新建 Workflow 需要先保存，才能运行测试。</div>}
      <div className="workflow-test-trace">
        {timeline.length === 0 && !latestEvent && (
          <span className="workflow-test-muted">运行后这里会显示每次节点执行的进度和输出。</span>
        )}
        {timeline.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`workflow-test-node ${item.status}${
              selectedTimelineItem?.key === item.key ? ' selected' : ''
            }`}
            onClick={() => setSelectedNodeId(item.key)}
          >
            <span className="workflow-test-node-id">
              {item.nodeId}
              {item.round !== undefined && (
                <span className="workflow-test-node-round">·R{item.round}</span>
              )}
            </span>
            <span className="workflow-test-node-state">{nodeStatusLabel(item.status)}</span>
          </button>
        ))}
      </div>
      {selectedTimelineItem && (
        <div className="workflow-test-io">
          <div className="workflow-test-io-block">
            <div className="workflow-test-io-title">
              Input · {selectedTimelineItem.nodeId}
              {selectedTimelineItem.round !== undefined && (
                <span> · Round {selectedTimelineItem.round}</span>
              )}
            </div>
            <pre className="workflow-test-output">
              {selectedTimelineItem.input?.trim() || '{}'}
            </pre>
          </div>
          <div className="workflow-test-io-block">
            <div className="workflow-test-io-title">
              {selectedTimelineItem.status === 'failed' ? 'Error' : 'Output'} ·{' '}
              {selectedTimelineItem.nodeId}
              {selectedTimelineItem.round !== undefined && (
                <span> · Round {selectedTimelineItem.round}</span>
              )}
            </div>
            <div
              className={`workflow-test-output markdown${selectedTimelineItem.status === 'failed' ? ' error' : ''}`}
            >
              <AgentMarkdown
                source={
                  selectedTimelineItem.status === 'failed'
                    ? selectedTimelineItem.error || failed?.error || '节点执行失败'
                    : selectedTimelineItem.output?.trim() || '{}'
                }
                tone={selectedTimelineItem.status === 'failed' ? 'error' : 'default'}
              />
            </div>
          </div>
        </div>
      )}
      {!selectedTimelineItem && latestEvent && (
        <div className="workflow-test-muted">{eventLabel(latestEvent)}</div>
      )}
    </div>
  )
}

interface TimelineItem {
  key: string
  nodeId: string
  round?: number
  loopId?: string
  status: 'completed' | 'failed'
  input: string
  output: string
  error?: string
  at: number
}

/**
 * Flatten the event stream into one TimelineItem per node execution. Loop
 * children produce one item per round; non-loop nodes produce a single item.
 * Items are returned in event arrival order, which mirrors the actual
 * runtime: input → node1 → node2 → node3 → node1 (round 2) → ...
 *
 * If the same (node_id, round) re-appears (defensive — shouldn't happen but
 * could if backend re-emits), the latest entry wins to keep state coherent.
 */
function buildTimeline(events: RunEvent[]): TimelineItem[] {
  const out: TimelineItem[] = []
  const indexByKey = new Map<string, number>()
  for (const evt of events) {
    if (evt.kind !== 'node.completed' && evt.kind !== 'node.failed') continue
    const p = (evt.payload ?? {}) as Record<string, unknown>
    const nodeId = String(p.nodeId ?? p.node_id ?? '')
    if (!nodeId) continue
    const round = typeof p.round === 'number' ? p.round : undefined
    const loopId = typeof p.loop_id === 'string' ? p.loop_id : undefined
    const status: 'completed' | 'failed' = evt.kind === 'node.failed' ? 'failed' : 'completed'
    const key = round !== undefined ? `${nodeId}#${round}` : nodeId
    const item: TimelineItem = {
      key,
      nodeId,
      round,
      loopId,
      status,
      input: formatNodeJsonInline(p.input),
      output: formatNodeJsonInline(p.output),
      error: typeof p.error === 'string' ? p.error : undefined,
      at: evt.at,
    }
    const existing = indexByKey.get(key)
    if (existing !== undefined) {
      out[existing] = item
    } else {
      indexByKey.set(key, out.length)
      out.push(item)
    }
  }
  return out
}

function formatNodeJsonInline(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function nodeStatusLabel(status: string): string {
  if (status === 'pending') return '等待'
  if (status === 'running') return '运行中'
  if (status === 'completed') return '完成'
  if (status === 'failed') return '失败'
  return status
}

function eventLabel(evt: RunEvent): string {
  if (evt.kind === 'workflow.started') return 'Workflow 已开始'
  if (evt.kind === 'workflow.completed') return 'Workflow 已完成'
  if (evt.kind === 'ylw.run.failed') return '运行失败'
  if (evt.kind === 'node.started') return '节点开始运行'
  if (evt.kind === 'node.completed') return '节点完成'
  if (evt.kind === 'node.failed') return '节点失败'
  return evt.kind
}
