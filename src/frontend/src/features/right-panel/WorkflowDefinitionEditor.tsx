/**
 * WorkflowDefinitionEditor — create/edit workflow definitions
 *
 * Three editing modes:
 *   - form:   basic metadata only (for stub workflows, no node config)
 *   - canvas: React Flow visual editor (recommended)
 *   - json:   raw JSON escape hatch
 *
 * Canvas mode holds its graph in local state and serializes on save. Switching
 * modes preserves the in-memory graph, so you can tweak visually then eyeball
 * the JSON if you want.
 */

import { useState } from 'react'
import type {
  WorkflowDefinition,
  WorkflowDefinitionDraft,
  WorkflowGraph,
  WorkflowConfig,
} from '../../services/backendApi'
import { WorkflowCanvas } from './workflow-canvas'

type Mode = 'form' | 'canvas' | 'json'

interface WorkflowDefinitionEditorProps {
  definition?: WorkflowDefinition
  onSave: (draft: WorkflowDefinitionDraft) => Promise<void>
  onCancel: () => void
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] }

export function WorkflowDefinitionEditor({
  definition,
  onSave,
  onCancel,
}: WorkflowDefinitionEditorProps) {
  const [mode, setMode] = useState<Mode>(definition ? 'canvas' : 'canvas')
  const [name, setName] = useState(definition?.name ?? '')
  const [description, setDescription] = useState(definition?.description ?? '')
  const [executionMode, setExecutionMode] = useState<WorkflowDefinition['execution_mode']>(
    definition?.execution_mode ?? 'graph',
  )
  const [graph, setGraph] = useState<WorkflowGraph>(definition?.graph ?? EMPTY_GRAPH)
  const [config, setConfig] = useState<WorkflowConfig>(definition?.config ?? {})
  const [jsonText, setJsonText] = useState(
    definition ? JSON.stringify({ graph: definition.graph, config: definition.config }, null, 2) : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const switchMode = (next: Mode) => {
    // Sync JSON pane with current graph/config when leaving canvas mode.
    if (mode === 'canvas' && next === 'json') {
      setJsonText(JSON.stringify({ graph, config }, null, 2))
    }
    // Parse JSON back into graph state when leaving json mode.
    if (mode === 'json' && next === 'canvas') {
      try {
        const parsed = JSON.parse(jsonText || '{}')
        setGraph(parsed.graph ?? EMPTY_GRAPH)
        setConfig(parsed.config ?? {})
        setError(null)
      } catch (e) {
        setError(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    setMode(next)
  }

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      let finalGraph: WorkflowGraph = graph
      let finalConfig: WorkflowConfig = config

      if (mode === 'json') {
        const parsed = JSON.parse(jsonText || '{}')
        finalGraph = parsed.graph ?? EMPTY_GRAPH
        finalConfig = parsed.config ?? {}
      }

      const draft: WorkflowDefinitionDraft = {
        name,
        description,
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
          <button
            className={mode === 'form' ? 'active' : ''}
            onClick={() => switchMode('form')}
          >
            表单模式
          </button>
          <button
            className={mode === 'json' ? 'active' : ''}
            onClick={() => switchMode('json')}
          >
            JSON 模式
          </button>
        </div>
      </div>

      {error && <div className="editor-error">{error}</div>}

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

        <div className="form-group">
          <label>执行模式</label>
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as WorkflowDefinition['execution_mode'])}
          >
            <option value="parallel">Parallel - 多个 Agent 并行执行</option>
            <option value="pipeline">Pipeline - 顺序执行 A → B → C</option>
            <option value="roundtable">Roundtable - 循环讨论直到收敛</option>
            <option value="graph">Graph - 自定义 DAG 结构</option>
          </select>
        </div>
      </div>

      {mode === 'canvas' && (
        <div className="editor-canvas">
          <WorkflowCanvas initialGraph={graph} onGraphChange={setGraph} />
          <div className="form-hint">
            💡 从左侧拖拽节点到画布，拖线连接，点击节点在右侧编辑配置。按 Delete/Backspace 删除选中项。
          </div>
        </div>
      )}

      {mode === 'form' && (
        <div className="editor-form">
          <div className="form-hint">
            💡 表单模式仅保存元数据。需要可视化配置节点请切到图形模式；需要批量导入请切到 JSON 模式。
          </div>
        </div>
      )}

      {mode === 'json' && (
        <div className="editor-json">
          <div className="form-group">
            <label>Graph 和 Config (JSON)</label>
            <textarea
              className="json-editor"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={JSON.stringify(
                {
                  graph: {
                    nodes: [
                      { id: 'n1', type: 'agent', config: { agent_id: 'agent-1' } },
                      { id: 'n2', type: 'agent', config: { agent_id: 'agent-2' } },
                    ],
                    edges: [{ source: 'n1', target: 'n2' }],
                  },
                  config: { max_rounds: 3 },
                },
                null,
                2,
              )}
              rows={15}
            />
          </div>
        </div>
      )}

      <div className="editor-actions">
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
