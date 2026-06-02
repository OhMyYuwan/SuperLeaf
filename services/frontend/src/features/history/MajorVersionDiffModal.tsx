/**
 * MajorVersionDiffModal — multi-file diff viewer for a project-level commit.
 *
 * Layout: left side is a file list (added/modified/deleted), right side
 * shows the unified diff for the selected file. Mirrors GitHub's PR diff UI
 * but scoped to a selected archive commit versus the current project tree.
 */

import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FilePlus, FileMinus, FileEdit, X, Loader2 } from 'lucide-react'

import { useMajorVersionStore } from '../../stores/majorVersionStore'

interface MajorVersionDiffModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  sha: string
  against?: string
}

export function MajorVersionDiffModal({
  open,
  onOpenChange,
  projectId,
  sha,
  against,
}: MajorVersionDiffModalProps) {
  const loadDiff = useMajorVersionStore((s) => s.loadDiff)
  const diffs = useMajorVersionStore((s) => s.diffs)
  const diffLoading = useMajorVersionStore((s) => s.diffLoading)
  const diffError = useMajorVersionStore((s) => s.diffError)

  const key = `${projectId}|${sha}|${against ?? 'current'}`
  const diff = diffs[key]
  const loading = diffLoading[key] ?? false
  const error = diffError[key] ?? null

  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (diff) return
    loadDiff(projectId, sha, against).catch(() => {})
  }, [open, projectId, sha, against, diff, loadDiff])

  // Auto-select first file when diff loads
  useEffect(() => {
    if (diff && diff.files.length > 0 && selectedFile === null) {
      setSelectedFile(diff.files[0].path)
    }
  }, [diff, selectedFile])

  const selected = useMemo(() => {
    if (!diff || !selectedFile) return null
    return diff.files.find((f) => f.path === selectedFile) ?? null
  }, [diff, selectedFile])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="diff-overlay" />
        <Dialog.Content className="diff-dialog major-diff-dialog">
          <div className="diff-header">
            <div>
              <Dialog.Title className="diff-title">大版本对比</Dialog.Title>
              <div className="diff-subtitle">
                {sha.slice(0, 7)} → {against ? against.slice(0, 7) : '当前版本'}
              </div>
            </div>
            <Dialog.Close asChild>
              <button className="small-btn" aria-label="关闭">
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          {loading && (
            <div className="diff-loading">
              <Loader2 size={16} className="spin" /> 加载 diff…
            </div>
          )}

          {error && <div className="tab-error">{error}</div>}

          {diff && diff.files.length === 0 && (
            <div className="tab-empty">这个大版本与当前版本没有文件变化。</div>
          )}

          {diff && diff.files.length > 0 && (
            <>
              <div className="major-diff-summary">
                {diff.files_changed} 个文件变更
                {diff.total_insertions > 0 && (
                  <span className="major-version-ins"> +{diff.total_insertions}</span>
                )}
                {diff.total_deletions > 0 && (
                  <span className="major-version-del"> -{diff.total_deletions}</span>
                )}
              </div>
              <div className="major-diff-body">
                <div className="major-diff-filelist">
                  {diff.files.map((f) => (
                    <button
                      key={f.path}
                      className={`major-diff-fileitem ${
                        selectedFile === f.path ? 'is-selected' : ''
                      }`}
                      onClick={() => setSelectedFile(f.path)}
                      title={f.path}
                    >
                      <FileStatusIcon status={f.status} />
                      <span className="major-diff-filename">{f.path}</span>
                      <span className="major-diff-fileeach">
                        {f.insertions > 0 && (
                          <span className="major-version-ins">+{f.insertions}</span>
                        )}
                        {f.deletions > 0 && (
                          <span className="major-version-del">-{f.deletions}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="major-diff-patch">
                  {selected ? (
                    selected.patch ? (
                      <pre className="major-diff-patch-content">
                        {renderPatch(selected.patch)}
                      </pre>
                    ) : (
                      <div className="tab-empty">
                        二进制文件或无可显示的文本差异。
                      </div>
                    )
                  ) : (
                    <div className="tab-empty">请从左侧选择文件查看 diff。</div>
                  )}
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function FileStatusIcon({ status }: { status: string }) {
  if (status === 'A') return <FilePlus size={12} className="status-added" />
  if (status === 'D') return <FileMinus size={12} className="status-deleted" />
  return <FileEdit size={12} className="status-modified" />
}

function renderPatch(patch: string): React.ReactNode[] {
  const lines = patch.split('\n')
  return lines.map((line, idx) => {
    let className = 'patch-line'
    if (line.startsWith('+++') || line.startsWith('---')) {
      className += ' patch-header'
    } else if (line.startsWith('@@')) {
      className += ' patch-hunk'
    } else if (line.startsWith('+')) {
      className += ' patch-add'
    } else if (line.startsWith('-')) {
      className += ' patch-del'
    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
      className += ' patch-meta'
    }
    return (
      <div key={idx} className={className}>
        {line || ' '}
      </div>
    )
  })
}
