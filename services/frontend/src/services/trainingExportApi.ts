import { BACKEND_BASE } from './backendApi'

export interface TrainingExportOptions {
  onlyTrainingCandidates?: boolean
}

export const trainingExportApi = {
  downloadUrl(projectId: string, options: TrainingExportOptions = {}): string {
    const params = new URLSearchParams()
    if (options.onlyTrainingCandidates) {
      params.set('only_training_candidates', 'true')
    }
    const query = params.toString()
    return `${BACKEND_BASE}/api/projects/${encodeURIComponent(projectId)}/annotation-training-export${query ? `?${query}` : ''}`
  },

  async download(projectId: string, options: TrainingExportOptions = {}): Promise<void> {
    const response = await fetch(this.downloadUrl(projectId, options), {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(detail || `导出失败：HTTP ${response.status}`)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const filename = filenameFromDisposition(disposition) ?? 'annotation-training-export.zip'
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}

function filenameFromDisposition(disposition: string): string | null {
  const match = disposition.match(/filename="?([^"]+)"?/i)
  return match?.[1] ?? null
}
