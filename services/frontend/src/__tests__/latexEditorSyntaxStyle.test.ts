import { describe, expect, it } from 'vitest'
import { __test__ as latexLanguageTest } from '../features/latex-editor/latex-language'
import {
  DEFAULT_LATEX_EDITOR_THEME_ID,
  LATEX_EDITOR_COLORS,
  LATEX_EDITOR_THEME_PRESETS,
} from '../features/latex-editor/theme'

describe('LaTeX editor syntax styling', () => {
  it('uses the requested light editor palette', () => {
    expect(LATEX_EDITOR_COLORS.background).toBe('#ffffff')
    expect(LATEX_EDITOR_COLORS.command).toBe('#2563eb')
    expect(LATEX_EDITOR_COLORS.comment).toBe('#22c55e')
    expect(LATEX_EDITOR_COLORS.referenceKey).toBe('#22c55e')
  })

  it('keeps both personal editor style templates available', () => {
    expect(DEFAULT_LATEX_EDITOR_THEME_ID).toBe('light')
    expect(Object.keys(LATEX_EDITOR_THEME_PRESETS)).toEqual(['light', 'overleaf-dark'])
    expect(LATEX_EDITOR_THEME_PRESETS.light.colors.background).toBe('#ffffff')
    expect(LATEX_EDITOR_THEME_PRESETS.light.label).toBe('Light')
    expect(LATEX_EDITOR_THEME_PRESETS['overleaf-dark'].colors.background).toBe('#1b222c')
    expect(LATEX_EDITOR_THEME_PRESETS['overleaf-dark'].label).toBe('Overleaf Dark')
  })

  it('does not fill invalid formula tokens with a red background', () => {
    for (const preset of Object.values(LATEX_EDITOR_THEME_PRESETS)) {
      expect(preset.colors.invalidBackground).toBe('transparent')
      expect(preset.colors.invalidForeground).toBe(preset.colors.foreground)
    }
  })

  it('keeps selected text visible over current-line reminders', () => {
    expect(LATEX_EDITOR_COLORS.selection).toBe('rgba(37, 99, 235, 0.34)')
    expect(LATEX_EDITOR_COLORS.activeLine).toBe('rgba(239, 246, 255, 0.58)')
    expect(LATEX_EDITOR_COLORS.sourceJumpFlash).toBe('rgba(191, 219, 254, 0.54)')
    expect(LATEX_EDITOR_COLORS.selection).not.toBe(LATEX_EDITOR_COLORS.activeLine)
  })

  it('marks citation and label keys without marking command names', () => {
    const source = [
      '\\section{Ablation}',
      '\\label{sec:ablation}',
      'We follow \\cite{yang2024sneakyprompt} and \\ref{sec:ablation}.',
      '% keep comments green',
    ].join('\n')

    const ranges = latexLanguageTest.findLatexReferenceKeyRanges(source)
    const highlighted = ranges.map((range) => source.slice(range.from, range.to))

    expect(highlighted).toEqual([
      'sec:ablation',
      'yang2024sneakyprompt',
      'sec:ablation',
    ])
    expect(ranges.some((range) => source.slice(range.from, range.to).includes('\\cite'))).toBe(false)
    expect(ranges.some((range) => source.slice(range.from, range.to).includes('\\label'))).toBe(false)
  })
})
