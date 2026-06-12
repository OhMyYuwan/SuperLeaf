/**
 * MathJax v3 lazy loader with SVG output.
 *
 * Single-instance promise: the first call loads MathJax, subsequent calls reuse it.
 *
 * Uses the `tex-svg-full` combined bundle which ships every standard TeX package
 * but does NOT include the loader/safe/menu UI modules. Since we render math
 * straight from the user's own document, safe mode adds no real protection and
 * costs us a runtime failure when the bundle has no `safe` filter to attach to.
 *
 * The bundle initialises `window.MathJax` as a side effect of import. We then
 * await `MathJax.startup.promise` before exposing the instance — `tex2svgPromise`
 * is not available until startup has finished.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mathJaxPromise: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadMathJax(): Promise<any> {
  if (mathJaxPromise) return mathJaxPromise

  mathJaxPromise = (async () => {
    // Configure MathJax globally BEFORE importing the bundle.
    window.MathJax = {
      tex: {
        macros: {
          bm: ['\\boldsymbol{#1}', 1],
          coloneq: '\\coloneqq',
        },
        inlineMath: [['\\(', '\\)'], ['$', '$']],
        displayMath: [['\\[', '\\]'], ['$$', '$$']],
        processEscapes: true,
        processEnvironments: true,
        useLabelIds: false,
      },
      options: {
        enableMenu: false,
        // Don't emit the parallel accessibility MathML node. Its visual-hiding
        // CSS lives in MathJax's own stylesheet (not loaded for the SVG bundle),
        // so leaving it on makes every formula render twice.
        enableAssistiveMml: false,
      },
      startup: {
        typeset: false, // we drive typesetting manually per-formula
      },
    }

    // Dynamic import — bundle attaches the full instance to window.MathJax.
    await import('mathjax/es5/tex-svg-full.js')

    // tex2svgPromise is only available after startup finishes.
    if (window.MathJax.startup?.promise) {
      await window.MathJax.startup.promise
    }

    return window.MathJax
  })()

  return mathJaxPromise
}
