/**
 * HistoryTab — version timeline for the active document.
 *
 * Layout (top → bottom):
 *   - Header: doc name, refresh, "对比" hint (need 2 selected to compare)
 *   - List: 倒序 versions, labels chip + origin chip + actor + relative time;
 *           inline actions: 标签 / 对比 / 恢复
 *   - Footer: 选中 base/compare 提示
 *
 * One selected version compares against the current document. Two selected
 * versions can still be compared explicitly.
 */

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, Loader2, Tag, GitCompare, RotateCcw, X } from 'lucide-react'

import { useHistoryStore } from '../../stores/historyStore'
import { useDocumentStore } from '../../stores/documentStore'
import type { VersionMeta } from '../../services/versionApi'
import type { EditorFormat } from '../latex-editor/extensions'
import { DiffModal } from './DiffModal'
import { OperationsView } from './OperationsView'

interface HistoryTabProps {
  documentId: string | null
  embedded?: boolean
}

const ORIGIN_LABEL: Record<VersionMeta['origin'], string> = {
  auto_save: '自动保存',
  accept_suggestion: '接受建议',
  manual: '手动保存',
  restore: '回滚',
  ai_edit: 'AI 编辑',
}

const ORIGIN_CLASS: Record<VersionMeta['origin'], string> = {
  auto_save: 'origin-auto',
  accept_suggestion: 'origin-accept',
  manual: 'origin-manual',
  restore: 'origin-restore',
  ai_edit: 'origin-ai',
}

export function HistoryTab({ documentId, embedded = false }: HistoryTabProps) {
  const versionsMap = useHistoryStore((s) => s.versions)
  const loadingMap = useHistoryStore((s) => s.loading)
  const errorMap = useHistoryStore((s) => s.error)
  const loadVersions = useHistoryStore((s) => s.loadVersions)
  const restore = useHistoryStore((s) => s.restore)
  const addLabel = useHistoryStore((s) => s.addLabel)
  const removeLabel = useHistoryStore((s) => s.removeLabel)
  const upsertFromBackendDoc = useDocumentStore((s) => s.upsertFromBackendDoc)

  const docFormat: EditorFormat = useDocumentStore((s) => {
    const d = documentId ? s.documents[documentId] : null
    return (d?.format as EditorFormat) ?? 'tex'
  })

  const versions = documentId ? versionsMap[documentId] ?? [] : []
  const loading = documentId ? loadingMap[documentId] ?? false : false
  const error = documentId ? errorMap[documentId] ?? null : null

  const [selected, setSelected] = useState<number[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffPair, setDiffPair] = useState<{ from: number; to: number | 'current' } | null>(null)
  const [subView, setSubView] = useState<'versions' | 'operations'>('versions')

  useEffect(() => {
    if (!documentId) return
    loadVersions(documentId)
    setSelected([])
  }, [documentId, loadVersions])

  const handleRefresh = () => {
    if (documentId) loadVersions(documentId)
  }

  const toggleSelect = (version: number) => {
    setSelected((prev) => {
      if (prev.includes(version)) return prev.filter((v) => v !== version)
      const next = [...prev, version]
      // Keep at most 2 selected; drop the oldest.
      return next.length > 2 ? next.slice(-2) : next
    })
  }

  const openDiffForRow = (version: number) => {
    setDiffPair({ from: version, to: 'current' })
    setDiffOpen(true)
  }

  const openDiffForSelected = () => {
    if (selected.length === 1) {
      setDiffPair({ from: selected[0], to: 'current' })
      setDiffOpen(true)
      return
    }
    if (selected.length !== 2) return
    const [a, b] = [...selected].sort((x, y) => x - y)
    setDiffPair({ from: a, to: b })
    setDiffOpen(true)
  }

  const handleRestore = async (version: number) => {
    if (!documentId) return
    if (!confirm(`回滚到版本 v${version}？当前内容会作为新版本快照。`)) return
    try {
      const doc = await restore(documentId, version)
      upsertFromBackendDoc(doc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回滚失败'
      alert(msg)
    }
  }

  const handleAddLabel = async (version: number) => {
    if (!documentId) return
    const text = prompt('为这个版本添加标签（最多 256 字）：')
    if (!text) return
    const trimmed = text.trim()
    if (!trimmed) return
    try {
      await addLabel(documentId, version, trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '添加标签失败'
      alert(msg)
    }
  }

  const handleRemoveLabel = async (version: number, labelId: string) => {
    if (!documentId) return
    try {
      await removeLabel(documentId, version, labelId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除标签失败'
      alert(msg)
    }
  }

  const selectedLabel = useMemo(() => {
    if (selected.length === 0) return '勾选一个版本以对比当前，或勾选两个版本互相对比'
    if (selected.length === 1) return `已选 v${selected[0]}（将与当前版本对比）`
    const [a, b] = [...selected].sort((x, y) => x - y)
    return `已选 v${a} 与 v${b}`
  }, [selected])

  if (!documentId) {
    return (
      <div className={embedded ? "history-embedded" : "tab-content-wrapper"}>
        <div className="tab-empty">请先打开一个文档。</div>
      </div>
    )
  }

  return (
    <div className={embedded ? "history-embedded" : "tab-content-wrapper"}>
      <div className="history-subnav">
        <button
          className={`history-subnav-btn ${subView === 'versions' ? 'is-active' : ''}`}
          onClick={() => setSubView('versions')}
        >
          版本
        </button>
        <button
          className={`history-subnav-btn ${subView === 'operations' ? 'is-active' : ''}`}
          onClick={() => setSubView('operations')}
        >
          操作日志
        </button>
      </div>

      {subView === 'operations' ? (
        <OperationsView documentId={documentId} />
      ) : (
        <>
      <div className="tab-header-row">
        <span>版本时间线：{versions.length} 条（最多保留 100 条，带标签的不会被淘汰）</span>
        <button className="small-btn" onClick={handleRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      <div className="history-compare-bar">
        <span className="history-compare-hint">{selectedLabel}</span>
        <button
          className="small-btn"
          onClick={openDiffForSelected}
          disabled={selected.length === 0}
        >
          <GitCompare size={12} /> {selected.length === 1 ? '对比当前' : '对比所选'}
        </button>
        {selected.length > 0 && (
          <button className="small-btn" onClick={() => setSelected([])}>
            清空选择
          </button>
        )}
      </div>

      {error && <div className="tab-error">{error}</div>}

      {!loading && versions.length === 0 && (
        <div className="tab-empty">还没有版本快照。编辑文档并保存后会自动产生快照。</div>
      )}

      <ul className="history-list">
        {versions.map((v) => {
          const isSelected = selected.includes(v.version)
          return (
            <li
              key={v.id}
              className={`history-item ${isSelected ? 'is-selected' : ''} ${
                v.labels.length > 0 ? 'is-labeled' : ''
              }`}
            >
              <label className="history-item-checkbox">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(v.version)}
                />
              </label>
              <div className="history-item-body">
                <div className="history-item-head">
                  <span className="history-version">v{v.version}</span>
                  <span className={`history-origin ${ORIGIN_CLASS[v.origin]}`}>
                    {ORIGIN_LABEL[v.origin] ?? v.origin}
                  </span>
                  <span className="history-time">{formatTime(v.created_at)}</span>
                  {v.actor && <span className="history-actor">{v.actor.slice(0, 8)}</span>}
                  <span className="history-size">
                    {v.binary ? '二进制' : `${v.byte_length} B`}
                  </span>
                </div>
                {v.labels.length > 0 && (
                  <div className="history-labels">
                    {v.labels.map((l) => (
                      <span key={l.id} className="history-label-chip">
                        <Tag size={10} /> {l.text}
                        <button
                          className="history-label-remove"
                          onClick={() => handleRemoveLabel(v.version, l.id)}
                          title="删除标签"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="history-item-actions">
                  <button
                    className="small-btn"
                    onClick={() => handleAddLabel(v.version)}
                  >
                    <Tag size={12} /> 标签
                  </button>
                  <button
                    className="small-btn"
                    onClick={() => openDiffForRow(v.version)}
                  >
                    <GitCompare size={12} /> 对比当前
                  </button>
                  <button
                    className="small-btn"
                    onClick={() => handleRestore(v.version)}
                  >
                    <RotateCcw size={12} /> 恢复
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
        </>
      )}

      {diffPair && (
        <DiffModal
          open={diffOpen}
          onOpenChange={(open) => {
            setDiffOpen(open)
            if (!open) setDiffPair(null)
          }}
          docId={documentId}
          format={docFormat}
          fromVersion={diffPair.from}
          toVersion={diffPair.to}
        />
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = Date.now()
  const delta = now - d.getTime()
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (delta < min) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / min)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
