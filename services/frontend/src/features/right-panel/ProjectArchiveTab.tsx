import { useEffect, useState } from 'react'
import { Archive, GitBranch, Loader2, RefreshCw, Save, Upload } from 'lucide-react'
import {
  projectArchiveApi,
  type ProjectArchiveStatus,
} from '../../services/backendApi'
import { useProjectStore } from '../../stores/projectStore'
import './project-archive.css'

export function ProjectArchiveTab() {
  const projectId = useProjectStore((s) => s.currentProjectId)
  const role = useProjectStore((s) => s.currentProjectRole)
  const loadProjects = useProjectStore((s) => s.load)
  const [status, setStatus] = useState<ProjectArchiveStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('yuwanlab-archive')

  const isOwner = role === 'owner'
  const roleKnown = role !== null

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
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    if (projectId && role === null) {
      void loadProjects()
    }
  }, [loadProjects, projectId, role])

  const createSnapshot = async () => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    try {
      await projectArchiveApi.createSnapshot(projectId, message.trim() || undefined)
      setMessage('')
      setFeedback('本地大版本已保存。')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目大版本失败')
    } finally {
      setSaving(false)
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
      <div className="archive-section">
        <div className="archive-section-head">
          <div>
            <h3><Archive size={14} /> 项目大版本</h3>
            <p>本地编辑内容是 ground truth；这里把整个项目树保存为本地 Git 快照。</p>
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
            title={isOwner ? '保存当前项目树为本地 Git commit' : '只有项目 Owner 可以创建大版本'}
          >
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
            保存大版本
          </button>
        </div>

        {!roleKnown && <div className="tab-empty">正在确认项目权限，确认后才能编辑项目大版本。</div>}

        {status?.binding.local_repo_path && (
          <div className="archive-meta">
            <span>本地仓库</span>
            <code>{status.binding.local_repo_path}</code>
          </div>
        )}
      </div>

      <div className="archive-section">
        <div className="archive-section-head">
          <div>
            <h3><GitBranch size={14} /> GitHub 大版本仓库</h3>
            <p>只保存用户提供的仓库链接；上传时直接把本地 archive branch 推送过去。</p>
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
            <h3>本地大版本历史</h3>
            <p>{status?.snapshots.length ?? 0} 个项目级快照</p>
          </div>
        </div>
        {!status || status.snapshots.length === 0 ? (
          <div className="tab-empty">还没有项目大版本。点击“保存大版本”创建第一版。</div>
        ) : (
          <ul className="archive-snapshot-list">
            {status.snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <div>
                  <strong>{snapshot.message}</strong>
                  <span>{formatTime(snapshot.created_at)}</span>
                </div>
                <code>{snapshot.commit_sha.slice(0, 10)}</code>
                <span>{snapshot.doc_count} docs · {snapshot.file_count} files · {formatBytes(snapshot.byte_count)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function formatGithubUrl(owner: string, repo: string): string {
  return owner && repo ? `https://github.com/${owner}/${repo}` : ''
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
