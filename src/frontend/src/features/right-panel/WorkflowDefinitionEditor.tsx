/**
 * WorkflowDefinitionEditor — create/edit workflow definitions
 * Supports both form mode (for simple workflows) and JSON mode (for advanced users)
 */

import { useState } from 'react'
import type {
  WorkflowDefinition,
  WorkflowDefinitionDraft,
  WorkflowGraph,
  WorkflowConfig,
} from '../../services/backendApi'

interface WorkflowDefinitionEditorProps {
  definition?: WorkflowDefinition
  onSave: (draft: WorkflowDefinitionDraft) => Promise<void>
  onCancel: () => void
}

export function WorkflowDefinitionEditor({
  definition,
  onSave,
  onCancel,
}: WorkflowDefinitionEditorProps) {
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [name, setName] = useState(definition?.name ?? '')
  const [description, setDescription] = useState(definition?.description ?? '')
  const [executionMode, setExecutionMode] = useState<WorkflowDefinition['execution_mode']>(
    definition?.execution_mode ?? 'pipeline',
  )
  const [jsonText, setJsonText] = useState(
    definition ? JSON.stringify({ graph: definition.graph, config: definition.config }, null, 2) : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      let graph: WorkflowGraph
      let config: WorkflowConfig

      if (mode === 'json') {
        const parsed = JSON.parse(jsonText)
        graph = parsed.graph ?? { nodes: [], edges: [] }
        config = parsed.config ?? {}
      } else {
        graph = { nodes: [], edges: [] }
        config = {}
      }

      const draft: WorkflowDefinitionDraft = {
        name,
        description,
        execution_mode: executionMode,
        graph,
        config,
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
            className={mode === 'form' ? 'active' : ''}
            onClick={() => setMode('form')}
          >
            表单模式
          </button>
          <button
            className={mode === 'json' ? 'active' : ''}
            onClick={() => setMode('json')}
          >
            JSON 模式
          </button>
        </div>
      </div>

      {error && <div className="editor-error">{error}</div>}

      {mode === 'form' && (
        <div className="editor-form">
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

          <div className="form-hint">
            💡 提示：表单模式适合快速创建简单 workflow。如需配置节点和边，请切换到 JSON 模式。
          </div>
        </div>
      )}

      {mode === 'json' && (
        <div className="editor-json">
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
              <option value="parallel">Parallel</option>
              <option value="pipeline">Pipeline</option>
              <option value="roundtable">Roundtable</option>
              <option value="graph">Graph</option>
            </select>
          </div>

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
