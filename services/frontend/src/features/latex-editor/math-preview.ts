/**
 * CodeMirror 6 extension: Math Preview Tooltip
 *
 * Shows a floating tooltip above the cursor when it enters a math environment.
 * Renders the formula using MathJax v3 with document-wide macro context.
 *
 * Inspired by Overleaf's math-preview.ts extension.
 */

import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { showTooltip, keymap, EditorView } from '@codemirror/view'
import type { Tooltip } from '@codemirror/view'
import { findMathAtCursor, extractMacroDefinitions } from './math-detection'
import type { MathRange } from './math-detection'
import { loadMathJax } from './mathjax-loader'

export const hideTooltipEffect = StateEffect.define<void>()

interface MathPreviewState {
  tooltip: Tooltip | null
  hide: boolean // User pressed Esc to temporarily hide
}

const mathPreviewStateField = StateField.define<MathPreviewState>({
  create: () => ({ tooltip: null, hide: false }),

  update(state, tr) {
    // User pressed Esc → hide tooltip
    for (const effect of tr.effects) {
      if (effect.is(hideTooltipEffect)) {
        return { tooltip: null, hide: true }
      }
    }

    // Document changed or selection moved → re-detect
    if (tr.docChanged || tr.selection) {
      const pos = tr.state.selection.main.head
      const doc = tr.state.doc.toString()
      const mathRange = findMathAtCursor(doc, pos)

      if (mathRange) {
        const macros = extractMacroDefinitions(doc)
        const tooltip = buildTooltip(mathRange, macros)
        return { tooltip, hide: false }
      }

      return { tooltip: null, hide: false }
    }

    return state
  },

  provide: (field) => [
    showTooltip.compute([field], (state) => state.field(field).tooltip),
  ],
})

function buildTooltip(mathRange: MathRange, macros: string): Tooltip {
  return {
    pos: mathRange.from,
    above: true,
    strictSide: true,
    arrow: false,
    create(view: EditorView) {
      const dom = document.createElement('div')
      dom.className = 'ylw-cm-math-tooltip-container'

      const inner = document.createElement('div')
      inner.className = 'ylw-cm-math-tooltip'
      inner.textContent = '渲染中...'
      inner.style.opacity = '0'
      inner.style.transition = 'opacity 0.15s ease'

      // Async render
      renderMath(mathRange.content, mathRange.displayMode, inner, macros, view)
        .then(() => {
          inner.style.opacity = '1'
          // Reposition all tooltips after content changes size
          view.requestMeasure()
        })
        .catch((err) => {
          console.error('[math-preview] render error:', err)
          const message = err instanceof Error ? err.message : String(err)
          inner.textContent = `渲染失败: ${message}`
          inner.style.opacity = '1'
          inner.style.color = 'var(--color-error, #ef4444)'
          inner.style.fontSize = '12px'
          inner.style.fontFamily = 'monospace'
        })

      dom.appendChild(inner)
      return { dom, overlap: true, offset: { x: 0, y: 8 } }
    },
  }
}

async function renderMath(
  content: string,
  displayMode: boolean,
  element: HTMLElement,
  macros: string,
  _view: EditorView,
): Promise<void> {
  const MathJax = await loadMathJax()

  MathJax.texReset([0]) // Reset equation numbering

  // Feed macro definitions first (swallow errors)
  try {
    if (macros.trim()) {
      await MathJax.tex2svgPromise(macros, { display: false })
    }
  } catch (err) {
    // Bad macro shouldn't block formula rendering
    console.warn('[math-preview] macro error:', err)
  }

  // Render the formula
  const math = await MathJax.tex2svgPromise(content, {
    ...MathJax.getMetricsFor(element),
    display: displayMode,
  })

  element.textContent = ''
  element.appendChild(math)
}

// Esc keymap to hide tooltip
const mathPreviewKeymap = keymap.of([
  {
    key: 'Escape',
    run: (view) => {
      const state = view.state.field(mathPreviewStateField, false)
      if (state?.tooltip) {
        view.dispatch({ effects: hideTooltipEffect.of() })
        return true
      }
      return false
    },
  },
])

/**
 * Public API: CodeMirror 6 extension for math preview.
 * Install this in the editor's extensions array.
 */
export function mathPreview(): Extension {
  return [mathPreviewStateField, mathPreviewKeymap]
}
