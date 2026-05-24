/**
 * MajorVersionCreateDialog — modal for creating a new major version (git commit).
 *
 * The user must enter a commit message; the entire project tree is exported
 * into the working repo and committed as a single atomic snapshot.
 */

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { GitCommit, Loader2, X } from 'lucide-react'

interface MajorVersionCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (message: string) => Promise<void>
}

export function MajorVersionCreateDialog({
  open,
  onOpenChange,
  onSubmit,
}: MajorVersionCreateDialogProps) {
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const trimmed = message.trim()
    if (!trimmed) {
      setError('请填写 commit 信息')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed)
      setMessage('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建大版本失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    if (!next) {
      setError(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="major-dialog-overlay" />
        <Dialog.Content className="major-dialog-content">
          <div className="major-dialog-header">
            <Dialog.Title className="major-dialog-title">
              <GitCommit size={16} /> 新建大版本
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="small-btn" disabled={submitting}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="major-dialog-desc">
            把当前项目的所有文档和文件作为一个原子快照提交到本地 git 仓库。
          </Dialog.Description>

          <div className="major-dialog-body">
            <label className="major-dialog-field">
              <span>提交信息</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="例如：完成第一稿 / 整理第三章引用 / 调整图表布局…"
                rows={4}
                disabled={submitting}
                autoFocus
              />
              <small className="major-dialog-hint">
                第一行作为 commit 标题（建议 50 字以内），可选附带正文说明。
              </small>
            </label>

            {error && <div className="tab-error">{error}</div>}
          </div>

          <div className="major-dialog-footer">
            <button
              className="small-btn"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              取消
            </button>
            <button
              className="primary-btn"
              onClick={handleSubmit}
              disabled={submitting || !message.trim()}
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="spin" /> 提交中…
                </>
              ) : (
                <>
                  <GitCommit size={14} /> 创建大版本
                </>
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
