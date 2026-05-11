/**
 * NodePalette — the draggable palette of node types.
 *
 * Minimum set:
 *   - input:  workflow entry (selection + instruction + referenced files)
 *   - agent:  atomic execution unit
 *   - loop:   container that iterates a sub-graph N times
 *             Loop input connects to internal agent inputs
 *             Internal agent outputs connect to Loop output
 *             Loop output feeds back to Loop input (feedback loop)
 *   - output: workflow exit (text | json | annotations)
 *
 * Parallel vs sequential is expressed by topology — two disconnected agents
 * = parallel, connected = serial.
 */

import type { DragEvent } from 'react'

type PaletteType = 'input' | 'agent' | 'loop' | 'output'

const PALETTE: Array<{ type: PaletteType; icon: string; label: string; hint: string }> = [
  { type: 'input', icon: '📥', label: 'Input', hint: '工作流入口' },
  { type: 'agent', icon: '🤖', label: 'Agent', hint: '最小执行单元' },
  { type: 'loop', icon: '🔁', label: 'Loop 容器', hint: '框住一组节点，循环 N 次' },
  { type: 'output', icon: '📤', label: 'Output', hint: '工作流出口' },
]

export function NodePalette() {
  const handleDragStart = (event: DragEvent, nodeType: PaletteType) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <aside className="wf-palette">
      <div className="wf-palette-header">节点</div>
      <div className="wf-palette-hint">拖到画布添加</div>
      {PALETTE.map((item) => (
        <div
          key={item.type}
          className={`wf-palette-item wf-palette-${item.type}`}
          draggable
          onDragStart={(e) => handleDragStart(e, item.type)}
          title={item.hint}
        >
          <span className="wf-palette-icon">{item.icon}</span>
          <div className="wf-palette-labels">
            <div className="wf-palette-label">{item.label}</div>
            <div className="wf-palette-hint-sm">{item.hint}</div>
          </div>
        </div>
      ))}

      <div className="wf-palette-footnote">
        <div className="wf-footnote-line">💡 工作流结构：</div>
        <div className="wf-footnote-line">· Input → Agent(s) → Output</div>
        <div className="wf-footnote-line">· Loop 输入输出可直接连线</div>
        <div className="wf-footnote-line">· Agent 不连线 → 平行</div>
        <div className="wf-footnote-line">· A → B 连线 → 顺序</div>
      </div>
    </aside>
  )
}
