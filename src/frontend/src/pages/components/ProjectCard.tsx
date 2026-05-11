import { Link } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import type { ProjectSummary } from '../../services/projectsApi'

interface Props {
  project: ProjectSummary
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
}

export function ProjectCard({ project, onRename, onDelete }: Props) {
  return (
    <div className="project-card">
      <Link to={`/projects/${project.id}`} className="project-card-body">
        <div className="project-card-name">{project.name}</div>
        <div className="project-card-meta">
          更新于 {formatDate(project.updated_at)}
        </div>
      </Link>
      <div className="project-card-actions">
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

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}
