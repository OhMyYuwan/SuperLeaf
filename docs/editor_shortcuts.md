# Editor Shortcuts

This list documents the Overleaf-style formatting shortcuts implemented for the
YuwanLabWriter source editor.

Reference inspected:
`/Volumes/DevLayer/Reference/overleaf/services/web/frontend/js/features/source-editor/languages/latex/shortcuts.ts`
and
`/Volumes/DevLayer/Reference/overleaf/services/web/frontend/js/features/source-editor/languages/markdown/shortcuts.ts`.

## Formatting

| Shortcut | macOS | LaTeX behavior | Markdown behavior |
| --- | --- | --- | --- |
| `Ctrl+B` | `Cmd+B` | Wraps the selection with `\textbf{...}`. With no selection, inserts `\textbf{}` and places the cursor inside. If the selected text is already wrapped, removes the wrapper. | Wraps the selection with `**...**`. With no selection, inserts `****` and places the cursor between the marks. If the selected text is already wrapped, removes the wrapper. |
| `Ctrl+I` | `Cmd+I` | Wraps the selection with `\textit{...}`. With no selection, inserts `\textit{}` and places the cursor inside. If the selected text is already wrapped, removes the wrapper. | Wraps the selection with `_..._`. With no selection, inserts `__` and places the cursor between the marks. If the selected text is already wrapped, removes the wrapper. |

## Notes

- Shortcuts are active only in source editor documents whose format is `tex` or `md`.
- Plain text documents keep CodeMirror's default behavior and do not receive these formatting commands.
- The Markdown italic shortcut follows Overleaf's Markdown reference and uses `_..._`.
- The implementation is local to YuwanLabWriter; the Overleaf code was used only as read-only behavioral reference.
