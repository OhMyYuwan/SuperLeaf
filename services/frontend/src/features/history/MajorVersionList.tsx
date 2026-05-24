/**
 * MajorVersionList — list of project-level git commits.
 *
 * Each row shows:
 *   - short SHA + commit message (truncated)
 *   - author name + relative timestamp
 *   - +N / -N stats
 *   - actions: 对比 (diff with parent) / 恢复 (restore via append-only commit)
 */

import { useEffect, useState } from 'react'
import { GitCommit, GitCompare, RefreshCw, Loader2, RotateCcw } from 'lucide-react'

import { useMajorVersionStore } from '../../stores/majorVersionStore'
import type { CommitMeta } from '../../services/majorVersionApi'

interface MajorVersionListProps {
  projectId: string
  onDiffClick: (sha: string, against?: string) => void
  onRestore: (sha: string, message: string) => Promise<void>
}

export function MajorVersionList({ projectId, onDiffClick, onRestore }: MajorVersionListProps) {
  const commitsMap = useMajorVersionStore((s) => s.commits)
  const loadingMap = useMajorVersionStore((s) => s.loading)
  const errorMap = useMajorVersionStore((s) => s.error)
  const loadCommits = useMajorVersionStore((s) => s.loadCommits)

  const commits = commitsMap[projectId] ?? []
  const loading = loadingMap[projectId] ?? false
  const error = errorMap[projectId] ?? null

  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) loadCommits(projectId)
  }, [projectId, loadCommits])

  const handleRefresh = () => {
    if (projectId) loadCommits(projectId)
  }

  const handleRestore = async (commit: CommitMeta) => {
    const defaultMsg = `Restore from ${commit.short_sha}: ${commit.message}`
    const msg = prompt('恢复提交记录信息（可修改）：', defaultMsg)
    if (msg === null) return  // cancelled
    if (!confirm(`确认恢复到 ${commit.short_sha}？\n\n会创建一个新的提交记录覆盖当前内容，不会破坏历史。`)) return
    setRestoring(commit.sha)
    try {
      await onRestore(commit.sha, msg.trim() || defaultMsg)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '恢复失败'
      alert(errMsg)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <>
      <div className="tab-header-row">
        <span>大版本：{commits.length} 个 commit</span>
        <button className="small-btn" onClick={handleRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      {error && <div className="tab-error">{error}</div>}

      {!loading && commits.length === 0 && (
        <div className="tab-empty">还没有大版本 commit。点击「新建大版本」开始记录。</div>
      )}

      <ul className="major-version-list">
        {commits.map((commit) => (
          <li key={commit.sha} className="major-version-item">
            <div className="major-version-head">
              <GitCommit size={14} className="major-version-icon" />
              <span className="major-version-sha">{commit.short_sha}</span>
              <span className="major-version-message" title={commit.message}>
                {commit.message}
              </span>
            </div>
            <div className="major-version-meta">
              <span className="major-version-author">{commit.author_name}</span>
              <span className="major-version-time">{formatTime(commit.date)}</span>
              {commit.files_changed > 0 && (
                <span className="major-version-stats">
                  {commit.files_changed} 个文件
                  {commit.insertions > 0 && (
                    <span className="major-version-ins"> +{commit.insertions}</span>
                  )}
                  {commit.deletions > 0 && (
                    <span className="major-version-del"> -{commit.deletions}</span>
                  )}
                </span>
              )}
            </div>
            <div className="major-version-actions">
              <button
                className="small-btn"
                onClick={() => onDiffClick(commit.sha)}
                title="与父提交对比"
              >
                <GitCompare size={12} /> 对比
              </button>
              <button
                className="small-btn"
                onClick={() => handleRestore(commit)}
                disabled={restoring === commit.sha}
              >
                {restoring === commit.sha ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <RotateCcw size={12} />
                )}{' '}
                恢复
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
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
