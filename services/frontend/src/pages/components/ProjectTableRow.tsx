import { Link } from 'react-router-dom'
import { Pencil, Settings, Trash2 } from 'lucide-react'
import type { ProjectSummary } from '../../services/projectsApi'
import { normalizeProjectTags } from '../projectListUtils'

interface Props {
  project: ProjectSummary
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
  onSettings?: (p: ProjectSummary) => void
  onTagClick?: (project: ProjectSummary, tag: string) => void
}

export function ProjectTableRow({ project, onRename, onDelete, onSettings, onTagClick }: Props) {
  const typeBadge = projectTypeBadge(project)
  const tags = normalizeProjectTags(project.tags)
  return (
    <tr className="project-row">
      <td className="project-row-name-cell">
        <Link to={`/projects/${project.id}`} className="project-row-name">
          {project.name}
        </Link>
        {typeBadge && (
          <span className={`project-type-badge project-row-badge project-type-badge-${typeBadge.toLowerCase()}`}>
            {typeBadge}
          </span>
        )}
      </td>
      <td className="project-row-tags-cell">
        {tags.length > 0 && (
          <div className="project-row-tags" aria-label="项目标签">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="project-tag-pill"
                onClick={() => onTagClick?.(project, tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </td>
      <td className="project-row-meta">{formatDate(project.updated_at)}</td>
      <td className="project-row-meta">{formatDate(project.created_at)}</td>
      <td className="project-row-actions">
        {onSettings && (
          <button className="icon-btn" aria-label="设置" title="项目设置" onClick={() => onSettings(project)}>
            <Settings size={14} />
          </button>
        )}
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

function projectTypeBadge(project: ProjectSummary): 'Skill' | 'Data' | null {
  if (project.project_type === 'data') return 'Data'
  if (project.project_type === 'skill' || project.is_skill_project) return 'Skill'
  return null
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
