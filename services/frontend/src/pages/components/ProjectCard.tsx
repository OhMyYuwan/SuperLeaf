import { Link } from 'react-router-dom'
import { Pencil, Settings, Trash2 } from 'lucide-react'
import type { ProjectSummary } from '../../services/projectsApi'

interface Props {
  project: ProjectSummary
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
  onSettings?: (p: ProjectSummary) => void
}

export function ProjectCard({ project, onRename, onDelete, onSettings }: Props) {
  const typeBadge = projectTypeBadge(project)
  return (
    <div className="project-card">
      <Link to={`/projects/${project.id}`} className="project-card-body">
        <div className="project-card-name-row">
          <span className="project-card-name">{project.name}</span>
          {typeBadge && (
            <span className={`project-type-badge project-type-badge-${typeBadge.toLowerCase()}`}>
              {typeBadge}
            </span>
          )}
        </div>
        <div className="project-card-meta">
          更新于 {formatDate(project.updated_at)}
        </div>
      </Link>
      <div className="project-card-actions">
        {onSettings && (
          <button
            className="icon-btn"
            aria-label="设置"
            title="项目设置"
            onClick={(e) => { e.stopPropagation(); onSettings(project) }}
          >
            <Settings size={14} />
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="重命名"
          title="重命名"
          onClick={(e) => { e.stopPropagation(); onRename(project) }}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-btn danger"
          aria-label="删除"
          title="删除"
          onClick={(e) => { e.stopPropagation(); onDelete(project) }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

function projectTypeBadge(project: ProjectSummary): 'Skill' | 'Data' | null {
  if (project.project_type === 'data') return 'Data'
  if (project.project_type === 'skill' || project.is_skill_project) return 'Skill'
  return null
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}
