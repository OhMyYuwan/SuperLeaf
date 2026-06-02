import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  CheckCircle2,
  Database,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  projectArchiveApi,
  type ProjectArchiveStatus,
} from '../../services/backendApi'
import { projectsApi, type ProjectSkillDataStatus } from '../../services/projectsApi'
import { useProjectStore } from '../../stores/projectStore'
import { useMajorVersionStore } from '../../stores/majorVersionStore'
import { useNativeAgentStore } from '../../stores/nativeAgentStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { MajorVersionList } from '../history/MajorVersionList'
import { MajorVersionDiffModal } from '../history/MajorVersionDiffModal'
import './project-archive.css'

export function ProjectArchiveTab() {
  const projectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const role = useProjectStore((s) => s.currentProjectRole)
  const loadProjects = useProjectStore((s) => s.load)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const tree = useFilesystemStore((s) => s.tree)
  const loadTree = useFilesystemStore((s) => s.loadTree)
  const loadCommits = useMajorVersionStore((s) => s.loadCommits)
  const restoreCommit = useMajorVersionStore((s) => s.restore)
  const [status, setStatus] = useState<ProjectArchiveStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillDataSaving, setSkillDataSaving] = useState(false)
  const [skillDataDeleting, setSkillDataDeleting] = useState(false)
  const [skillDataProjectId, setSkillDataProjectId] = useState('')
  const [skillDataStatus, setSkillDataStatus] = useState<ProjectSkillDataStatus>('submitted')
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('yuwanlab-archive')
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffPair, setDiffPair] = useState<{ sha: string; against?: string } | null>(null)
  const [pathCopied, setPathCopied] = useState(false)

  const isOwner = role === 'owner'
  const roleKnown = role !== null
  const currentProject = projects.find((project) => project.id === projectId)
  const isSkillProject = currentProject?.is_skill_project === true
  const dataProjects = useMemo(
    () => projects.filter((project) => project.project_type === 'data'),
    [projects],
  )
  const selectedSkillDataProjectId = dataProjects.some((project) => project.id === skillDataProjectId)
    ? skillDataProjectId
    : dataProjects[0]?.id ?? ''
  const selectedSkillDataProject = dataProjects.find((project) => project.id === selectedSkillDataProjectId)
  const currentTree = tree?.project_id === projectId ? tree : null
  const skillDataRoot = currentTree?.root.folders.find((folder) => folder.name === '_skill_data') ?? null
  const importedSkillDataFolders = skillDataRoot?.folders ?? []
  const selectedSkillDataFolderName = selectedSkillDataProject
    ? safeSkillDataFolderName(selectedSkillDataProject.name)
    : ''
  const selectedSkillDataFolder = importedSkillDataFolders.find((folder) => (
    folder.name === selectedSkillDataFolderName
    || (selectedSkillDataFolderName && folder.name.startsWith(`${selectedSkillDataFolderName}-`))
  ))
  const hasSkillDataFolder = importedSkillDataFolders.length > 0

  const load = async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const next = await projectArchiveApi.status(projectId)
      setStatus(next)
      setRepoUrl(next.binding.github_repo_url || formatGithubUrl(next.binding.github_owner, next.binding.github_repo))
      setOwner(next.binding.github_owner)
      setRepo(next.binding.github_repo)
      setBranch(next.binding.github_branch || 'yuwanlab-archive')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载项目归档失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    if (projectId && role === null) {
      void loadProjects()
    }
  }, [loadProjects, projectId, role])

  useEffect(() => {
    if (projectId && !currentProject) {
      void loadProjects()
    }
  }, [currentProject, loadProjects, projectId])

  useEffect(() => {
    if (projectId && isSkillProject && tree?.project_id !== projectId) {
      void loadTree()
    }
  }, [isSkillProject, loadTree, projectId, tree?.project_id])

  const createSnapshot = async () => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    try {
      await projectArchiveApi.createSnapshot(projectId, message.trim() || undefined)
      setMessage('')
      setFeedback('大版本已保存到服务器归档。')
      await load()
      // Refresh archive commit list as well.
      await loadCommits(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目大版本失败')
    } finally {
      setSaving(false)
    }
  }

  const updateSkillCache = async () => {
    if (!projectId) return
    setSkillSaving(true)
    setError(null)
    try {
      const result = await projectsApi.updateSkillCache(projectId)
      setFeedback(`Skill 缓存已更新到 v${result.skill.cache_version || result.project.skill_cache_version}。`)
      await Promise.all([loadProjects(), loadNativeAgents(), load()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新 Skill 缓存失败')
    } finally {
      setSkillSaving(false)
    }
  }

  const attachSkillDataPackage = async () => {
    if (!projectId || !selectedSkillDataProjectId) return
    setSkillDataSaving(true)
    setError(null)
    try {
      const result = await projectsApi.attachSkillDataPackage(projectId, {
        data_project_id: selectedSkillDataProjectId,
        status: skillDataStatus,
      })
      setFeedback(
        `已接入 ${result.dataset_name}：${result.record_count} 条记录写入 ${result.folder}。`,
      )
      await loadTree()
    } catch (err) {
      setError(err instanceof Error ? err.message : '接入 Data Project 失败')
    } finally {
      setSkillDataSaving(false)
    }
  }

  const clearSkillDataPackage = async () => {
    if (!projectId || !selectedSkillDataProjectId) return
    setSkillDataDeleting(true)
    setError(null)
    try {
      const result = await projectsApi.clearSkillDataPackage(projectId, selectedSkillDataProjectId)
      setFeedback(
        result.deleted_count > 0
          ? `已删除 ${result.folder} 中的导入数据。`
          : '当前选中的 Data Project 没有已导入数据。',
      )
      await loadTree()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除导入数据失败')
    } finally {
      setSkillDataDeleting(false)
    }
  }

  const handleRestore = async (sha: string, restoreMessage: string) => {
    if (!projectId) return
    await restoreCommit(projectId, sha, restoreMessage)
    setFeedback(`已恢复到 ${sha.slice(0, 7)}（创建了新的恢复提交）。`)
    await load()
  }

  const handleDiff = (sha: string, against?: string) => {
    setDiffPair({ sha, against })
    setDiffOpen(true)
  }

  const copyRepoPath = async () => {
    if (!status?.binding.local_repo_path) return
    try {
      await navigator.clipboard.writeText(status.binding.local_repo_path)
      setPathCopied(true)
      setTimeout(() => setPathCopied(false), 1500)
    } catch {
      // ignore clipboard failure
    }
  }

  const saveGithubBinding = async () => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    try {
      await projectArchiveApi.configureGithub(projectId, {
        github_repo_url: repoUrl.trim(),
        github_owner: owner.trim(),
        github_repo: repo.trim(),
        github_branch: branch.trim() || 'yuwanlab-archive',
        github_path: '',
        github_private_required: false,
      })
      setFeedback('GitHub 仓库链接已保存。')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 GitHub 绑定失败')
    } finally {
      setSaving(false)
    }
  }

  const pushGithub = async () => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    try {
      const result = await projectArchiveApi.pushGithub(projectId, message.trim() || undefined)
      setMessage('')
      setFeedback(`已上传到 ${result.repo_url}#${result.branch}，commit ${result.commit_sha.slice(0, 10)}。`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传到 GitHub 失败')
    } finally {
      setSaving(false)
    }
  }

  if (!projectId) {
    return <div className="tab-empty">请先打开一个项目。</div>
  }

  if (roleKnown && !isOwner) {
    return <div className="tab-empty">只有项目 Owner 可以查看和管理项目大版本。</div>
  }

  return (
    <div className="project-archive-panel">
      {currentProject && isSkillProject && (
        <div className="archive-section skill-cache-section">
          <div className="archive-section-head">
            <div>
              <h3><CheckCircle2 size={14} /> Skill 缓存</h3>
              <p>把当前 Skill 项目的文件写入本地缓存，已装载这个 Skill 的 Agent 会使用最新版缓存。</p>
            </div>
            {currentProject.skill_cache_version > 0 && (
              <span className="archive-version-chip">v{currentProject.skill_cache_version}</span>
            )}
          </div>
          <div className="skill-cache-row">
            <span>
              {currentProject.skill_cache_updated_at
                ? `上次缓存 ${new Date(currentProject.skill_cache_updated_at).toLocaleString()}`
                : '尚未缓存'}
            </span>
            <button
              className="primary-btn"
              onClick={() => void updateSkillCache()}
              disabled={!isOwner || skillSaving}
              title={isOwner ? '更新这个 Skill 项目的本地缓存' : '只有项目 Owner 可以更新 Skill 缓存'}
            >
              {skillSaving ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              更新 Skill 缓存
            </button>
          </div>
        </div>
      )}

      {currentProject && isSkillProject && (
        <div className="archive-section skill-data-section">
          <div className="archive-section-head">
            <div>
              <h3><Database size={14} /> Skill 数据输入</h3>
              <p>选择 Data Project 作为优化输入，写入隔离目录，不参与 Skill 缓存和发布。</p>
            </div>
            <span className={hasSkillDataFolder ? 'archive-state-chip active' : 'archive-state-chip'}>
              {hasSkillDataFolder ? `已接入 ${importedSkillDataFolders.length} 个` : '未接入'}
            </span>
          </div>
          <div className="skill-data-handoff">
            <div className="skill-data-selectors">
              <label>
                <span>Data Project</span>
                <select
                  value={selectedSkillDataProjectId}
                  onChange={(event) => setSkillDataProjectId(event.target.value)}
                  disabled={dataProjects.length === 0 || skillDataSaving || skillDataDeleting}
                >
                  {dataProjects.length === 0 ? (
                    <option value="">暂无 Data Project</option>
                  ) : (
                    dataProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} · {project.id.slice(0, 8)}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label>
                <span>数据范围</span>
                <select
                  value={skillDataStatus}
                  onChange={(event) => {
                    setSkillDataStatus(event.target.value as ProjectSkillDataStatus)
                  }}
                  disabled={skillDataSaving || skillDataDeleting}
                >
                  <option value="submitted">提交包</option>
                  <option value="labeled">已标注记录</option>
                  <option value="all">全链包</option>
                  <option value="pending">待处理</option>
                  <option value="in_review">标注中</option>
                  <option value="discarded">已丢弃</option>
                </select>
              </label>
            </div>
            <button
              className="secondary-btn"
              onClick={() => void attachSkillDataPackage()}
              disabled={!isOwner || skillDataSaving || skillDataDeleting || !selectedSkillDataProjectId}
              title={
                isOwner
                  ? '把选择的数据包接入这个 Skill Project 的隔离数据区'
                  : '只有项目 Owner 可以接入数据包'
              }
            >
              {skillDataSaving ? <Loader2 size={13} className="spin" /> : <Database size={13} />}
              接入数据包
            </button>
          </div>
          <div className="skill-data-actions">
            <span>
              当前目录：
              <code>
                {selectedSkillDataProject
                  ? `_skill_data/${selectedSkillDataFolder?.name ?? selectedSkillDataFolderName}/latest/`
                  : '_skill_data/<Data Project>/latest/'}
              </code>
            </span>
            <button
              className="secondary-btn danger-lite"
              onClick={() => void clearSkillDataPackage()}
              disabled={
                !isOwner
                || skillDataSaving
                || skillDataDeleting
                || !selectedSkillDataProjectId
                || !selectedSkillDataFolder
              }
              title={selectedSkillDataFolder ? '删除选中 Data Project 的导入包' : '选中的 Data Project 尚未导入'}
            >
              {skillDataDeleting ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
              删除选中数据
            </button>
          </div>
          {importedSkillDataFolders.length > 0 && (
            <div className="skill-data-imported-list" aria-label="已接入的数据项目">
              {importedSkillDataFolders.map((folder) => (
                <span key={folder.id}>{folder.name}</span>
              ))}
            </div>
          )}
          <p className="skill-data-note">
            数据会显示在 <code>{'_skill_data/<Data Project>/latest/'}</code>，
            不会进入 Skill 缓存、公开包或项目导出包。
          </p>
        </div>
      )}

      <div className="archive-section">
        <div className="archive-section-head">
          <div>
            <h3><Archive size={14} /> 项目大版本</h3>
            <p>编辑数据库是工作源；这里把整个项目树保存为服务器端归档快照。</p>
          </div>
          <button className="small-btn" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>

        {error && <div className="tab-error">{error}</div>}
        {feedback && <div className="archive-feedback">{feedback}</div>}

        <div className="archive-create-row">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="大版本说明，例如：完成实验章节初稿"
            disabled={!isOwner || saving}
          />
          <button
            className="primary-btn"
            onClick={() => void createSnapshot()}
            disabled={!isOwner || saving}
            title={isOwner ? '保存当前项目树为服务器端归档 commit' : '只有项目 Owner 可以创建大版本'}
          >
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
            保存大版本
          </button>
        </div>

        {!roleKnown && <div className="tab-empty">正在确认项目权限，确认后才能编辑项目大版本。</div>}

        {status?.binding.local_repo_path && (
          <div className="archive-meta">
            <span>服务器归档路径</span>
            <code>{status.binding.local_repo_path}</code>
          </div>
        )}
      </div>

      <div className="archive-section">
        <div className="archive-section-head">
          <div>
            <h3><GitBranch size={14} /> GitHub 大版本仓库</h3>
            <p>只保存用户提供的仓库链接；上传时把服务器端归档 branch 推送过去。</p>
          </div>
        </div>
        <div className="archive-github-grid">
          <label className="archive-field-wide">
            GitHub Link
            <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} disabled={!isOwner} placeholder="https://github.com/owner/repo" />
          </label>
          <label>
            Owner
            <input value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!isOwner} />
          </label>
          <label>
            Repo
            <input value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!isOwner} />
          </label>
          <label>
            Branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!isOwner} />
          </label>
        </div>
        <div className="archive-github-actions">
          <span>不创建仓库、不改可见性、不创建 PR。</span>
          <button className="small-btn" onClick={() => void saveGithubBinding()} disabled={!isOwner || saving}>
            保存绑定
          </button>
          <button className="primary-btn" onClick={() => void pushGithub()} disabled={!isOwner || saving || !status?.remote_configured}>
            {saving ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
            上传大版本
          </button>
        </div>
      </div>

      <div className="archive-section archive-history">
        <div className="archive-section-head">
          <div>
            <h3>大版本历史（服务器归档）</h3>
            <p>每个 commit 都是整个项目的原子快照。可下载、可对比、可恢复（恢复 = 新增 commit，不破坏历史）。</p>
          </div>
        </div>

        {status?.binding.local_repo_path && (
          <div className="major-version-hint">
            <div className="major-version-hint-row">
              <Terminal size={12} />
              <span className="major-version-hint-path">{status.binding.local_repo_path}</span>
              <button className="small-btn" onClick={() => void copyRepoPath()}>
                {pathCopied ? '已复制' : '复制路径'}
              </button>
            </div>
            <span className="major-version-hint-note">
              该路径位于运行后端服务的机器上，仅用于排查；普通导出请使用每个大版本里的下载按钮。
            </span>
          </div>
        )}

        {projectId && (
          <MajorVersionList
            projectId={projectId}
            onDiffClick={handleDiff}
            onRestore={handleRestore}
          />
        )}
      </div>

      {projectId && diffPair && (
        <MajorVersionDiffModal
          open={diffOpen}
          onOpenChange={(open) => {
            setDiffOpen(open)
            if (!open) setDiffPair(null)
          }}
          projectId={projectId}
          sha={diffPair.sha}
          against={diffPair.against}
        />
      )}
    </div>
  )
}

function formatGithubUrl(owner: string, repo: string): string {
  return owner && repo ? `https://github.com/${owner}/${repo}` : ''
}

function safeSkillDataFolderName(name: string): string {
  const cleaned = name.replace(/[/\\:\0]/g, '_').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'dataset'
}
