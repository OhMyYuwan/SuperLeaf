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
  onSave,
  onCancel,
}: WorkflowDefinitionEditorProps) {
  const [mode, setMode] = useState<Mode>('canvas')
  const [name, setName] = useState(definition?.name ?? '')
  const [description, setDescription] = useState(definition?.description ?? '')
  const executionMode: WorkflowDefinition['execution_mode'] = 'graph'
  const [graph, setGraph] = useState<WorkflowGraph>(definition?.graph ?? EMPTY_GRAPH)
  const [config, setConfig] = useState<WorkflowConfig>(definition?.config ?? {})
  const [jsonText, setJsonText] = useState(
    definition
      ? buildJsonText(
          definition.name,
          definition.description ?? '',
          definition.graph,
          definition.config ?? {},
        )
      : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
          <WorkflowCanvas initialGraph={graph} onGraphChange={setGraph} />
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
