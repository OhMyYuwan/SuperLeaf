import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import type { TreeFolder } from '../../services/filesystemApi'
import { useDocumentStore } from '../../stores/documentStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useProjectStore } from '../../stores/projectStore'

const APP_TITLE = 'SuperLeaf'
const TITLE_SEPARATOR = ' · '

export function AppDocumentTitle() {
  const location = useLocation()
  const projects = useProjectStore((s) => s.projects)
  const tree = useFilesystemStore((s) => s.tree)
  const activePreviewFile = useFilesystemStore((s) => s.activePreviewFile)
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId)
  const activeDocument = useDocumentStore((s) =>
    s.activeDocumentId ? s.documents[s.activeDocumentId] ?? null : null,
  )

  const title = useMemo(() => {
    const routeProjectId = workspaceProjectIdFromPath(location.pathname)
    if (!routeProjectId) return APP_TITLE

    const projectName = normalizeTitlePart(
      tree?.project_id === routeProjectId
        ? tree.project_name
        : projects.find((project) => project.id === routeProjectId)?.name,
    )
    const fileName = normalizeTitlePart(
      activePreviewFile
        ? findFileName(tree?.root ?? null, activePreviewFile.id) ?? activePreviewFile.name
        : activeDocumentId
          ? findDocName(tree?.root ?? null, activeDocumentId) ?? activeDocument?.metadata.title
          : '',
    )

    return [APP_TITLE, projectName, fileName].filter(Boolean).join(TITLE_SEPARATOR)
  }, [
    activeDocument?.metadata.title,
    activeDocumentId,
    activePreviewFile,
    location.pathname,
    projects,
    tree,
  ])

  useEffect(() => {
    document.title = title
  }, [title])

  return null
}

function workspaceProjectIdFromPath(pathname: string): string {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function normalizeTitlePart(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function findDocName(folder: TreeFolder | null, docId: string): string | null {
  if (!folder) return null
  const doc = folder.docs.find((item) => item.id === docId)
  if (doc) return doc.name
  for (const child of folder.folders) {
    const found = findDocName(child, docId)
    if (found) return found
  }
  return null
}

function findFileName(folder: TreeFolder | null, fileId: string): string | null {
  if (!folder) return null
  const file = folder.files.find((item) => item.id === fileId)
  if (file) return file.name
  for (const child of folder.folders) {
    const found = findFileName(child, fileId)
    if (found) return found
  }
  return null
}
