/**
 * ProjectSettingsDialog — 项目设置对话框
 *
 * 包含项目成员管理、编译设置等
 */

import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, Loader2, Settings, X } from 'lucide-react'
import { ProjectMembersPanel } from './ProjectMembersPanel'
import { useUserStore } from '../../stores/userStore'
import { useNativeAgentStore } from '../../stores/nativeAgentStore'
import { useProjectStore } from '../../stores/projectStore'
import { projectsApi, type ProjectSummary } from '../../services/projectsApi'
import './settings.css'

interface ProjectSettingsDialogProps {
  open: boolean
  projectId: string
  onOpenChange: (open: boolean) => void
}

export function ProjectSettingsDialog({ open, projectId, onOpenChange }: ProjectSettingsDialogProps) {
  const currentUser = useUserStore((s) => s.currentUser)
  const reloadProjects = useProjectStore((s) => s.load)
  const reloadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillMessage, setSkillMessage] = useState<string | null>(null)
  const [skillError, setSkillError] = useState<string | null>(null)

  const loadProject = useCallback(async () => {
    try {
      setLoading(true)
      const data = await projectsApi.get(projectId)
      setProject(data)
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

  const updateSkillMarker = async (enabled: boolean) => {
    if (!project) return
    setSkillBusy(true)
    setSkillError(null)
    setSkillMessage(null)
    try {
      const updated = await projectsApi.update(project.id, { is_skill_project: enabled })
      setProject(updated)
      await reloadProjects()
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillBusy(false)
    }
  }

  const updateSkillCache = async () => {
    if (!project) return
    setSkillBusy(true)
    setSkillError(null)
    setSkillMessage(null)
    try {
      const result = await projectsApi.updateSkillCache(project.id)
      setProject(result.project)
      setSkillMessage(`已更新 Skill 缓存 v${result.skill.cache_version || result.project.skill_cache_version}`)
      await Promise.all([reloadProjects(), reloadNativeAgents()])
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillBusy(false)
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
              <>
                <section className="settings-section">
                  <div className="settings-section-head">
                    <div>
                      <h3>本地 Skill</h3>
                      <p>把当前项目缓存为 Agent 可装配的开发中 Skill。</p>
                    </div>
                    {project.skill_cache_version > 0 && (
                      <span className="status-chip ok">v{project.skill_cache_version}</span>
                    )}
                  </div>
                  <label className="checkbox-row project-skill-toggle">
                    <input
                      type="checkbox"
                      checked={project.is_skill_project}
                      disabled={skillBusy || project.user_id !== currentUser.id}
                      onChange={(event) => void updateSkillMarker(event.target.checked)}
                    />
                    <span>作为本地 Skill 使用</span>
                  </label>
                  <div className="project-skill-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={skillBusy || project.user_id !== currentUser.id || !project.is_skill_project}
                      onClick={() => void updateSkillCache()}
                    >
                      {skillBusy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                      更新 Skill 缓存
                    </button>
                    <span>
                      {project.skill_cache_updated_at
                        ? `上次缓存 ${new Date(project.skill_cache_updated_at).toLocaleString()}`
                        : '尚未缓存'}
                    </span>
                  </div>
                  {skillMessage && <div className="settings-success">{skillMessage}</div>}
                  {skillError && <div className="form-error">{skillError}</div>}
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
