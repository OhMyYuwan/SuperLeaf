/**
 * ProjectListPage — landing view at /projects.
 *
 * Shows all projects in either a card grid or a table. The view mode toggle
 * persists to localStorage via projectStore.setViewMode. New project / rename /
 * delete go through the three dialogs in ./components.
 *
 * After create() we navigate the user straight into the new project — that
 * matches the Overleaf flow where "New Project" jumps you into the workspace.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Download, LayoutGrid, List, Plus, UserRound, X } from 'lucide-react'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { ProjectSummary } from '../services/projectsApi'
import { BackendError, githubApi, type GitHubAccountStatus } from '../services/backendApi'
import { ProjectCard } from './components/ProjectCard'
import { ProjectTableRow } from './components/ProjectTableRow'
import { ProjectFormDialog } from './components/ProjectFormDialog'
import { DeleteProjectDialog } from './components/DeleteProjectDialog'
import { ProjectSettingsDialog } from '../features/settings/ProjectSettingsDialog'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { NotificationBell } from '../features/topbar/NotificationBell'
import { UserMenu } from '../features/topbar/UserMenu'
import './project-list.css'

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'import-github' }
  | { kind: 'rename'; target: ProjectSummary }
  | { kind: 'delete'; target: ProjectSummary }
  | { kind: 'settings'; target: ProjectSummary }

export function ProjectListPage() {
  const navigate = useNavigate()
  const projects = useProjectStore((s) => s.projects)
  const loading = useProjectStore((s) => s.loading)
  const loaded = useProjectStore((s) => s.loaded)
  const error = useProjectStore((s) => s.error)
  const load = useProjectStore((s) => s.load)
  const create = useProjectStore((s) => s.create)
  const importGithub = useProjectStore((s) => s.importGithub)
  const rename = useProjectStore((s) => s.rename)
  const remove = useProjectStore((s) => s.remove)
  const viewMode = useProjectStore((s) => s.viewMode)
  const setViewMode = useProjectStore((s) => s.setViewMode)
  const projectListGrouping = useSettingsStore((s) => s.projectListGrouping)

  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [github, setGithub] = useState<GitHubAccountStatus | null>(null)
  const [personalPanelOpen, setPersonalPanelOpen] = useState(false)
  const sortedProjects = useMemo(() => sortProjectsByUpdated(projects), [projects])
  const paperProjects = useMemo(
    () => sortedProjects.filter((project) => !project.is_skill_project),
    [sortedProjects],
  )
  const skillProjects = useMemo(
    () => sortedProjects.filter((project) => project.is_skill_project),
    [sortedProjects],
  )

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    githubApi.account().then(setGithub).catch(() => setGithub(null))
  }, [])

  const refreshGithubAccount = () => {
    githubApi.account().then(setGithub).catch(() => setGithub(null))
  }

  const closeDialog = () => {
    setDialog({ kind: 'closed' })
    setDialogError(null)
    setDialogBusy(false)
  }

  const handleCreate = async (name: string, projectType: 'paper' | 'skill' = 'paper') => {
    setDialogBusy(true)
    setDialogError(null)
    try {
      const created = await create(name, projectType)
      closeDialog()
      navigate(`/projects/${created.id}`)
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  const handleGithubImport = async (body: { repoUrl: string; branch?: string; name?: string }) => {
    setDialogBusy(true)
    setDialogError(null)
    try {
      const created = await importGithub({
        repo_url: body.repoUrl,
        branch: body.branch,
        name: body.name,
      })
      closeDialog()
      navigate(`/projects/${created.id}`)
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  const handleRename = async (name: string) => {
    if (dialog.kind !== 'rename') return
    setDialogBusy(true)
    setDialogError(null)
    try {
      await rename(dialog.target.id, name)
      closeDialog()
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  const handleDelete = async () => {
    if (dialog.kind !== 'delete') return
    setDialogBusy(true)
    setDialogError(null)
    try {
      await remove(dialog.target.id)
      closeDialog()
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  return (
    <div className="project-list-page">
      <header className="project-list-header">
        <div>
          <div className="brand">SuperLeaf</div>
          <div className="subtitle">选择或创建一个项目</div>
        </div>
        <div className="project-list-header-actions">
          <div className="view-toggle" role="tablist" aria-label="切换视图">
            <button
              role="tab"
              aria-selected={viewMode === 'grid'}
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="卡片视图"
            >
              <LayoutGrid size={14} /> 卡片
            </button>
            <button
              role="tab"
              aria-selected={viewMode === 'table'}
              className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="表格视图"
            >
              <List size={14} /> 表格
            </button>
          </div>
          <button className="primary-btn" onClick={() => setDialog({ kind: 'create' })}>
            <Plus size={14} /> 新建项目
          </button>
          <button
            className="secondary-btn"
            onClick={() => setDialog({ kind: 'import-github' })}
            disabled={!github?.connected}
            title={github?.connected ? '从 GitHub 仓库导入为新项目' : '请先在个人设置连接 GitHub 账户'}
          >
            <Download size={14} /> GitHub 导入
          </button>
          <button
            className="secondary-btn"
            onClick={() => setPersonalPanelOpen(true)}
            title="打开个人面板，连接 GitHub 账户"
          >
            <UserRound size={14} /> 个人面板
          </button>
          <NotificationBell />
          <UserMenu onOpenPersonalPanel={() => setPersonalPanelOpen(true)} />
        </div>
      </header>

      <main className="project-list-main">
        {!loaded && loading && <div className="project-list-empty">加载中…</div>}
        {loaded && error && <div className="project-list-error">{error}</div>}
        {loaded && !error && projects.length === 0 && (
          <div className="project-list-empty">
            还没有项目。点击右上角「新建项目」开始你的第一个写作工作台。
          </div>
        )}

        {projects.length > 0 && projectListGrouping === 'grouped' && (
          <div className="project-sections">
            <ProjectSection
              title="Papers"
              description="论文、笔记和普通写作项目"
              projects={paperProjects}
              viewMode={viewMode}
              emptyText="还没有 Paper 项目。"
              onRename={(target) => setDialog({ kind: 'rename', target })}
              onDelete={(target) => setDialog({ kind: 'delete', target })}
              onSettings={(target) => setDialog({ kind: 'settings', target })}
            />
            <ProjectSection
              title="Skills"
              description="可编辑、可缓存给 Agent 使用的 Skill 项目"
              projects={skillProjects}
              viewMode={viewMode}
              emptyText="还没有 Skill 项目。"
              onRename={(target) => setDialog({ kind: 'rename', target })}
              onDelete={(target) => setDialog({ kind: 'delete', target })}
              onSettings={(target) => setDialog({ kind: 'settings', target })}
            />
          </div>
        )}

        {projects.length > 0 && projectListGrouping === 'mixed' && (
          <ProjectCollection
            projects={sortedProjects}
            viewMode={viewMode}
            onRename={(target) => setDialog({ kind: 'rename', target })}
            onDelete={(target) => setDialog({ kind: 'delete', target })}
            onSettings={(target) => setDialog({ kind: 'settings', target })}
          />
        )}
      </main>

      <ProjectFormDialog
        open={dialog.kind === 'create'}
        mode="create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={handleCreate}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <GitHubImportDialog
        open={dialog.kind === 'import-github'}
        busy={dialogBusy}
        error={dialogError}
        onSubmit={handleGithubImport}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <ProjectFormDialog
        open={dialog.kind === 'rename'}
        mode="rename"
        initialName={dialog.kind === 'rename' ? dialog.target.name : ''}
        busy={dialogBusy}
        error={dialogError}
        onSubmit={handleRename}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <DeleteProjectDialog
        open={dialog.kind === 'delete'}
        projectName={dialog.kind === 'delete' ? dialog.target.name : ''}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={handleDelete}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <ProjectSettingsDialog
        open={dialog.kind === 'settings'}
        projectId={dialog.kind === 'settings' ? dialog.target.id : ''}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <SettingsDialog
        open={personalPanelOpen}
        onOpenChange={(open) => {
          setPersonalPanelOpen(open)
          if (!open) refreshGithubAccount()
        }}
      />
    </div>
  )
}

function ProjectSection({
  title,
  description,
  projects,
  viewMode,
  emptyText,
  onRename,
  onDelete,
  onSettings,
}: {
  title: string
  description: string
  projects: ProjectSummary[]
  viewMode: 'table' | 'grid'
  emptyText: string
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
  onSettings: (p: ProjectSummary) => void
}) {
  return (
    <section className="project-section">
      <div className="project-section-header">
        <div>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
        <strong>{projects.length}</strong>
      </div>
      {projects.length === 0 ? (
        <div className="project-section-empty">{emptyText}</div>
      ) : (
        <ProjectCollection
          projects={projects}
          viewMode={viewMode}
          onRename={onRename}
          onDelete={onDelete}
          onSettings={onSettings}
        />
      )}
    </section>
  )
}

function ProjectCollection({
  projects,
  viewMode,
  onRename,
  onDelete,
  onSettings,
}: {
  projects: ProjectSummary[]
  viewMode: 'table' | 'grid'
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
  onSettings: (p: ProjectSummary) => void
}) {
  if (viewMode === 'grid') {
    return (
      <div className="project-grid">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onRename={onRename}
            onDelete={onDelete}
            onSettings={onSettings}
          />
        ))}
      </div>
    )
  }

  return (
    <table className="project-table">
      <thead>
        <tr>
          <th>项目名称</th>
          <th>最后更新</th>
          <th>创建时间</th>
          <th aria-label="操作"></th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <ProjectTableRow
            key={p.id}
            project={p}
            onRename={onRename}
            onDelete={onDelete}
            onSettings={onSettings}
          />
        ))}
      </tbody>
    </table>
  )
}

function sortProjectsByUpdated(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => {
    const updated = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    if (updated !== 0) return updated
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

function GitHubImportDialog({
  open,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  busy?: boolean
  error?: string | null
  onSubmit: (body: { repoUrl: string; branch?: string; name?: string }) => void | Promise<void>
  onOpenChange: (open: boolean) => void
}) {
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) {
      setRepoUrl('')
      setBranch('')
      setName('')
    }
  }, [open])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!repoUrl.trim() || busy) return
    void onSubmit({
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || undefined,
      name: name.trim() || undefined,
    })
  }

  return (
    <ProjectFormDialogShell
      open={open}
      title="从 GitHub 导入"
      onOpenChange={onOpenChange}
    >
      <form onSubmit={handleSubmit} className="project-form">
        <label className="project-form-label">
          GitHub 仓库链接
          <input
            autoFocus
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="project-form-input"
          />
        </label>
        <div className="project-form-grid">
          <label className="project-form-label">
            Branch
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="留空使用默认分支"
              className="project-form-input"
            />
          </label>
          <label className="project-form-label">
            项目名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空使用仓库名"
              className="project-form-input"
            />
          </label>
        </div>
        {error && <div className="project-form-error">{error}</div>}
        <div className="project-form-actions">
          <button type="button" className="ghost-btn" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary-btn" disabled={busy || !repoUrl.trim()}>
            {busy ? '导入中…' : '导入为新项目'}
          </button>
        </div>
      </form>
    </ProjectFormDialogShell>
  )
}

function ProjectFormDialogShell({
  open,
  title,
  children,
  onOpenChange,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  onOpenChange: (open: boolean) => void
}) {
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
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function extractMessage(e: unknown): string {
  if (e instanceof BackendError) return e.detail || e.message
  if (e instanceof Error) return e.message
  return String(e)
}
