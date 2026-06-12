/**
 * MathJax v3 ambient type declarations (minimal, only what we use).
 *
 * MathJax v3 ships without official npm TypeScript types. We declare the
 * minimum surface needed by the math-preview extension. The bundle import is
 * declared as a wildcard module since the bundle exports a fully-initialised
 * window.MathJax object as a side effect.
 *
 * No top-level import/export here so the file stays an ambient declaration.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MathJaxInstance = any

interface Window {
  MathJax: MathJaxInstance
}

declare module 'mathjax/es5/tex-svg-full.js' {
  const MathJax: MathJaxInstance
  export default MathJax
}
