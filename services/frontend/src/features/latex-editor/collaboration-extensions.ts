import * as Y from 'yjs'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { Awareness } from 'y-protocols/awareness'

export function collaborationExtensions(
  yText: Y.Text,
  awareness: Awareness,
): Extension[] {
  const undoManager = new Y.UndoManager(yText)
  return [
    yCollab(yText, awareness, { undoManager }),
    keymap.of(yUndoManagerKeymap),
  ]
}
