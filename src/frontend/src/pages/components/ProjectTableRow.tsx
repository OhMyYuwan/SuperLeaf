import { Link } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import type { ProjectSummary } from '../../services/projectsApi'

interface Props {
  project: ProjectSummary
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
}

export function ProjectTableRow({ project, onRename, onDelete }: Props) {
  return (
    <tr className="project-row">
      <td>
        <Link to={`/projects/${project.id}`} className="project-row-name">
          {project.name}
        </Link>
      </td>
      <td className="project-row-meta">{formatDate(project.updated_at)}</td>
      <td className="project-row-meta">{formatDate(project.created_at)}</td>
      <td className="project-row-actions">
        <button className="icon-btn" aria-label="重命名" title="重命名" onClick={() => onRename(project)}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn danger" aria-label="删除" title="删除" onClick={() => onDelete(project)}>
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
