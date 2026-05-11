/**
 * DeleteProjectDialog — destructive confirm; user must type the project name.
 *
 * Mirrors the GitHub-style "type the repo name to delete" pattern. Backend
 * blocks deleting the last project (409); we surface that error inline.
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  projectName: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void | Promise<void>
  onOpenChange: (open: boolean) => void
}

export function DeleteProjectDialog({
  open, projectName, busy, error, onConfirm, onOpenChange,
}: Props) {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const matches = typed.trim() === projectName

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="project-dialog-overlay" />
        <Dialog.Content className="project-dialog-content">
          <div className="project-dialog-header">
            <Dialog.Title className="project-dialog-title">删除项目</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭"><X size={18} /></button>
            </Dialog.Close>
          </div>
          <p className="project-form-desc">
            将永久删除 <strong>{projectName}</strong> 的全部文件、对话和工作流运行记录。此操作不可恢复。
          </p>
          <p className="project-form-desc">请输入项目名称以确认：</p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={projectName}
            className="project-form-input"
          />
          {error && <div className="project-form-error">{error}</div>}
          <div className="project-form-actions">
            <button type="button" className="ghost-btn" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="danger-btn"
              disabled={!matches || busy}
              onClick={() => onConfirm()}
            >
              {busy ? '删除中…' : '删除项目'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
