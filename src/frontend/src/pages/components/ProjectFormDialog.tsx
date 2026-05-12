/**
 * ProjectFormDialog — create or rename a project.
 *
 * One Radix Dialog reused for both flows: pass `mode='create'` for the empty
 * initial state, or `mode='rename'` plus `initialName` to seed.
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  mode: 'create' | 'rename'
  initialName?: string
  busy?: boolean
  error?: string | null
  onSubmit: (name: string) => void | Promise<void>
  onOpenChange: (open: boolean) => void
}

export function ProjectFormDialog({
  open, mode, initialName = '', busy, error, onSubmit, onOpenChange,
}: Props) {
  const [name, setName] = useState(initialName)

  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])

  const title = mode === 'create' ? '新建项目' : '重命名项目'
  const cta = mode === 'create' ? '创建' : '保存'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onSubmit(trimmed)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="project-dialog-overlay" />
        <Dialog.Content className="project-dialog-content">
          <div className="project-dialog-header">
            <Dialog.Title className="project-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭"><X size={18} /></button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleSubmit} className="project-form">
            <label className="project-form-label">
              项目名称
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：博士论文"
                className="project-form-input"
              />
            </label>
            {error && <div className="project-form-error">{error}</div>}
            <div className="project-form-actions">
              <button type="button" className="ghost-btn" onClick={() => onOpenChange(false)} disabled={busy}>
                取消
              </button>
              <button type="submit" className="primary-btn" disabled={busy || !name.trim()}>
                {busy ? '处理中…' : cta}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
