/**
 * ProjectSettingsDialog — 项目设置对话框
 *
 * 包含项目成员管理、编译设置等
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Settings, X } from 'lucide-react'
import { ProjectMembersPanel } from './ProjectMembersPanel'
import { useUserStore } from '../../stores/userStore'
import { projectsApi, type ProjectSummary } from '../../services/projectsApi'
import './settings.css'

interface ProjectSettingsDialogProps {
  open: boolean
  projectId: string
  onOpenChange: (open: boolean) => void
}

export function ProjectSettingsDialog({ open, projectId, onOpenChange }: ProjectSettingsDialogProps) {
  const currentUser = useUserStore((s) => s.currentUser)
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (open && projectId) {
      loadProject()
    }
  }, [open, projectId])

  const loadProject = async () => {
    try {
      setLoading(true)
      const data = await projectsApi.get(projectId)
      setProject(data)
    } catch (err) {
      console.error('Failed to load project:', err)
    } finally {
      setLoading(false)
    }
  }

  if (!currentUser) return null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content className="settings-dialog">
          <div className="settings-header">
            <div>
              <Dialog.Title className="settings-title">
                <Settings size={16} style={{ display: 'inline', marginRight: '8px' }} />
                项目设置
              </Dialog.Title>
              <Dialog.Description className="settings-subtitle">
                {project?.name || '加载中...'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <div className="settings-body">
            {loading ? (
              <div className="loading-state">加载中...</div>
            ) : project ? (
              <ProjectMembersPanel
                projectId={projectId}
                projectOwnerId={project.user_id || ''}
                currentUserId={currentUser.id}
              />
            ) : (
              <div className="empty-state">无法加载项目信息</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
