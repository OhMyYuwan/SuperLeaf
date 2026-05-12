/**
 * 初始种子文档，用于 W1 的文件树/编辑器/大纲联动演示。
 * W10 起改为从后端 /api/documents 加载。
 */

import type { DocumentFormat } from '../types/document'

export interface SeedFile {
  id: string
  name: string
  format: DocumentFormat
  content: string
}

export const seedDocuments: SeedFile[] = [
  {
    id: 'paper',
    name: 'main.tex',
    format: 'tex',
    content: `\\documentclass{article}
\\usepackage{ctex}
\\begin{document}

\\section{引言}
这是一个以 LaTeX 为核心的论文写作面板。研究目标是构建一个 Agent
驱动的科研写作环境。

\\subsection{研究目标}
支持写作、review 和润色，并允许用户在其中和 Agent 协作。

\\subsection{系统边界}
V1 只处理单文档编辑与单 Agent 评审。

\\section{系统架构}
系统由八层数据流构成：文档模型、编辑器状态、Agent、工作流、协作、
历史、UI、用户动作。

\\subsection{Agent 层}
每个 Agent 有输入契约、输出契约与权限模型。

\\section{实验与结论}
我们以论文评审作为示范场景 \\cite{knuth1984}。

\\end{document}
`,
  },
  {
    id: 'intro',
    name: 'introduction.tex',
    format: 'tex',
    content: `\\section{Introduction}
This chapter outlines the motivation and scope of the project.

\\subsection{Motivation}
Academic writing demands iterative review. Traditional editors lack
first-class Agent collaboration.

\\subsection{Contributions}
We contribute a layered architecture that decouples document content
from agent execution.
`,
  },
  {
    id: 'method',
    name: 'method.md',
    format: 'md',
    content: `# Method

## Document Model
Content is the single source of truth.

## Agent Model
Each agent has input/output contracts[^contract].

[^contract]: Defined in types/agent.ts
`,
  },
  {
    id: 'notes',
    name: 'review_notes.txt',
    format: 'txt',
    content: `Raw review notes.

Things to double-check:
- citation formatting
- tense consistency in Section 3
- figure ordering
`,
  },
]
