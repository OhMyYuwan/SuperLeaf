/**
 * documentWriter — single write-through point for document content.
 *
 * Extracted from writingStore to break circular dependencies between
 * writingStore, annotationStore, and conversationStore.  All three
 * import from here; this module has no store-level imports.
 */

import { useCollaborationStore } from '../stores/collaborationStore'
import { useDocumentStore } from '../stores/documentStore'

export type ApplyMode = 'replace-doc' | 'append' | 'replace-range'

/** Read the current text at the given range, preferring the live Yjs text
 *  (collab mode) over the Zustand snapshot. */
export function readCurrentText(
  docId: string,
  range: { from: number; to: number },
): string {
  const collab = useCollaborationStore.getState()
  if (collab.provider && collab.currentDocId === docId) {
    const text = collab.provider.yText.toString()
    return text.slice(range.from, Math.min(range.to, text.length))
  }
  const live = useDocumentStore.getState().documents[docId]?.content ?? ''
  return live.slice(range.from, Math.min(range.to, live.length))
}

/**
 * Write ``text`` into the document.
 *
 * Collab-aware: when a Yjs provider is active for the document the write
 * goes through ``ydoc.transact()`` so all peers see it in real time.
 * Otherwise it falls back to ``documentStore.updateContent``.
 *
 * Returns the number of characters written.
 */
export function applyWriteOutput(args: {
  docId: string
  mode: ApplyMode
  range: { from: number; to: number }
  text: string
}): number {
  const collab = useCollaborationStore.getState()
  const yText =
    collab.provider && collab.currentDocId === args.docId
      ? collab.provider.yText
      : null

  if (yText) {
    const ydoc = collab.provider!.doc
    const liveLen = yText.length
    const liveText = yText.toString()
    // eslint-disable-next-line no-console
    console.log('[documentWriter] applyWriteOutput via yText', {
      mode: args.mode,
      docId: args.docId,
      yTextLen: liveLen,
      writeChars: args.text.length,
      range: args.range,
    })
    let written = args.text.length
    ydoc.transact(() => {
      switch (args.mode) {
        case 'replace-doc':
          if (liveLen > 0) yText.delete(0, liveLen)
          if (args.text.length > 0) yText.insert(0, args.text)
          break
        case 'append': {
          const trimmed = liveText.replace(/\s+$/u, '')
          const trailingDropped = liveLen - trimmed.length
          if (trailingDropped > 0) yText.delete(trimmed.length, trailingDropped)
          const sep = trimmed.length > 0 ? '\n\n' : ''
          yText.insert(trimmed.length, sep + args.text)
          written = sep.length + args.text.length
          break
        }
        case 'replace-range': {
          const from = Math.max(0, Math.min(args.range.from, liveLen))
          const to = Math.max(from, Math.min(args.range.to, liveLen))
          if (to > from) yText.delete(from, to - from)
          if (args.text.length > 0) yText.insert(from, args.text)
          break
        }
      }
    })
    return written
  }

  const docStore = useDocumentStore.getState()
  const live = docStore.documents[args.docId]?.content ?? ''
  // eslint-disable-next-line no-console
  console.log('[documentWriter] applyWriteOutput via documentStore', {
    mode: args.mode,
    docId: args.docId,
    liveLen: live.length,
    writeChars: args.text.length,
    range: args.range,
  })
  let next: string
  let written = args.text.length
  switch (args.mode) {
    case 'replace-doc':
      next = args.text
      break
    case 'append': {
      const trimmed = live.replace(/\s+$/u, '')
      const sep = trimmed.length > 0 ? '\n\n' : ''
      next = trimmed + sep + args.text
      written = sep.length + args.text.length
      break
    }
    case 'replace-range': {
      const liveLen = live.length
      const from = Math.max(0, Math.min(args.range.from, liveLen))
      const to = Math.max(from, Math.min(args.range.to, liveLen))
      next = live.slice(0, from) + args.text + live.slice(to)
      break
    }
  }
  docStore.updateContent(args.docId, next)
  return written
}
