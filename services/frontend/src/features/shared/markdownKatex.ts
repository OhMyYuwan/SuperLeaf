import mdKatexModule from '@vscode/markdown-it-katex'

export const mdKatex = ((mdKatexModule as unknown as { default?: typeof mdKatexModule }).default ?? mdKatexModule)
