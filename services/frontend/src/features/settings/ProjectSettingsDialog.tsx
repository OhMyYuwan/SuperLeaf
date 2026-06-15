/**
 * ProjectSettingsDialog — 项目设置对话框
 *
 * 包含项目成员管理、编译设置等
 */

import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Settings, X } from 'lucide-react'
import { ProjectMembersPanel } from './ProjectMembersPanel'
import { useUserStore } from '../../stores/userStore'
import { useProjectStore } from '../../stores/projectStore'
import { projectsApi, type ProjectSummary } from '../../services/projectsApi'
import { normalizeProjectTags } from '../../pages/projectListUtils'
import './settings.css'

interface ProjectSettingsDialogProps {
  open: boolean
  projectId: string
  onOpenChange: (open: boolean) => void
}

export function ProjectSettingsDialog({ open, projectId, onOpenChange }: ProjectSettingsDialogProps) {
  const currentUser = useUserStore((s) => s.currentUser)
  const updateProject = useProjectStore((s) => s.update)
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [tagText, setTagText] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingTags, setSavingTags] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)

  const loadProject = useCallback(async () => {
    try {
      setLoading(true)
      const data = await projectsApi.get(projectId)
      setProject(data)
      setTagText(normalizeProjectTags(data.tags).join(', '))
    } catch (err) {
      console.error('Failed to load project:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && projectId) {
      const timer = window.setTimeout(() => {
        void loadProject()
      }, 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [loadProject, open, projectId])

  if (!currentUser) return null

  const saveTags = async () => {
    if (!project || savingTags) return
    setSavingTags(true)
    setTagError(null)
    try {
      const tags = normalizeProjectTags(tagText.split(','))
      const updated = await updateProject(project.id, { tags })
      setProject(updated)
      setTagText(normalizeProjectTags(updated.tags).join(', '))
    } catch (err) {
      setTagError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingTags(false)
    }
  }

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
              <>
                <section className="project-settings-section">
                  <div>
                    <h3>项目标签</h3>
                    <p>用逗号分隔，标签会显示在 Projects 页面并可点击筛选。</p>
                  </div>
                  <div className="project-tags-editor">
                    <input
                      value={tagText}
                      onChange={(event) => setTagText(event.target.value)}
                      placeholder="例如：NLP, draft, rebuttal"
                      className="settings-input"
                    />
                    <button
                      type="button"
                      className="settings-primary-btn"
                      onClick={saveTags}
                      disabled={savingTags}
                    >
                      {savingTags ? '保存中...' : '保存标签'}
                    </button>
                  </div>
                  {tagError && <div className="settings-error-text">{tagError}</div>}
                </section>
                <ProjectMembersPanel
                  projectId={projectId}
                  projectOwnerId={project.user_id || ''}
                  currentUserId={currentUser.id}
                />
              </>
            ) : (
              <div className="empty-state">无法加载项目信息</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
