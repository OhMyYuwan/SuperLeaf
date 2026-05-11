/**
 * NodePalette — the draggable palette of node types.
 *
 * Minimal: just agent (atom) + loop (container). Parallel vs sequential is
 * expressed by topology (two disconnected agents = parallel; connected = serial).
 */

import type { DragEvent } from 'react'

type PaletteType = 'agent' | 'loop'

const PALETTE: Array<{ type: PaletteType; icon: string; label: string; hint: string }> = [
  { type: 'agent', icon: '🤖', label: 'Agent', hint: '最小执行单元' },
  { type: 'loop', icon: '🔁', label: 'Loop 容器', hint: '框住一组节点，循环 N 次' },
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
        <div className="wf-footnote-line">💡 拓扑即模式：</div>
        <div className="wf-footnote-line">· 两个 agent 不连线 → 平行</div>
        <div className="wf-footnote-line">· A → B 连线 → 顺序</div>
        <div className="wf-footnote-line">· agent 有多输入 → 下游天然合并</div>
      </div>
    </aside>
  )
}
