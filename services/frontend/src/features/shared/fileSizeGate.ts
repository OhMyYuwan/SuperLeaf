/**
 * fileSizeGate — confirmation flow for attaching large files.
 *
 * Used by mention-enabled inputs (DiscussionTab, CommentComposer) before
 * accepting a file candidate. Three outcomes:
 *
 *   - size  < 1 MB  → silently accept
 *   - 1 MB ≤ size < 50 MB → confirm() dialog, user can cancel
 *   - size ≥ 50 MB → reject with a friendly message, never attached
 *
 * Kept as a tiny pure utility so MentionInput stays generic (it just calls a
 * caller-supplied `onCandidatePicked`).
 */

import {
  HARD_REJECT_BYTES,
  PER_FILE_CAP_BYTES,
  SOFT_WARN_BYTES,
  type FileCandidate,
} from '../../services/mentions'

export function confirmLargeFileAttachment(candidate: FileCandidate): boolean {
  if (candidate.size_bytes >= HARD_REJECT_BYTES) {
    alert(
      `文件 ${candidate.name} 太大了（${formatSize(candidate.size_bytes)}），无法作为上下文附加给 Agent。请拆分或先精简内容。`,
    )
    return false
  }
  if (candidate.format === 'doc' && candidate.size_bytes >= SOFT_WARN_BYTES) {
    return confirm(
      `${candidate.name} 共 ${formatSize(candidate.size_bytes)}，仅会附带前 ${
        PER_FILE_CAP_BYTES / 1024
      } KB 给 Agent。继续？`,
    )
  }
  if (candidate.format === 'binary' && candidate.size_bytes >= 10 * 1024 * 1024) {
    return confirm(
      `${candidate.name}（${formatSize(candidate.size_bytes)}）超过 10 MB，多模态传输可能失败或耗时较长。仍要附带？`,
    )
  }
  if (candidate.format === 'binary' && candidate.size_bytes >= 5 * 1024 * 1024) {
    return confirm(
      `${candidate.name}（${formatSize(candidate.size_bytes)}）较大，Agent 可能拒绝处理或耗时较长。仍要附带？`,
    )
  }
  return true
}

export function confirmMultimodalBudget(candidates: readonly FileCandidate[]): boolean {
  const binaryFiles = candidates.filter((c) => c.format === 'binary')
  if (binaryFiles.length === 0) return true

  const totalBytes = binaryFiles.reduce((sum, c) => sum + c.size_bytes, 0)
  const MULTIMODAL_BUDGET = 25 * 1024 * 1024 // 25 MB total

  if (totalBytes > MULTIMODAL_BUDGET) {
    return confirm(
      `多模态附件总计 ${formatSize(totalBytes)}（超过 ${formatSize(MULTIMODAL_BUDGET)} 建议值），可能导致请求超时或被拒绝。继续？`,
    )
  }
  return true
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}
