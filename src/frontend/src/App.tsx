import { useMemo, useState } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  BookOpen,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  Plus,
  Save,
  Settings2,
  SplitSquareVertical,
  Wand2,
} from 'lucide-react'
import * as Tabs from '@radix-ui/react-tabs'
import * as ScrollArea from '@radix-ui/react-scroll-area'
import { LatexEditor, type EditorFormat } from './features/latex-editor'
import './App.css'

const fileTree = [
  { id: 'root', name: 'project', type: 'folder', level: 0, open: true },
  { id: 'paper', name: 'main.tex', type: 'file', level: 1 },
  { id: 'intro', name: 'introduction.tex', type: 'file', level: 1 },
  { id: 'method', name: 'method.tex', type: 'file', level: 1 },
  { id: 'notes', name: 'review_notes.txt', type: 'file', level: 1 },
]

const outline = [
  '摘要',
  '1. 引言',
  '2. 系统架构',
  '3. Agent 设计',
  '4. Workflow 设计',
  '5. 风险与计划',
]

const initialAgents = [
  { id: 'a1', name: 'Reviewer', role: '学术评审', color: '#2563eb' },
  { id: 'a2', name: 'Polisher', role: '语言润色', color: '#7c3aed' },
  { id: 'a3', name: 'Synthesizer', role: '结果汇总', color: '#059669' },
]

const initialWorkflow = [
  { id: 'n1', type: 'input', label: '输入文档块' },
  { id: 'n2', type: 'agent', label: '学术评审 Agent' },
  { id: 'n3', type: 'agent', label: '语言润色 Agent' },
  { id: 'n4', type: 'merge', label: '结果汇总' },
  { id: 'n5', type: 'output', label: '批注输出' },
]

function App() {
  const [selectedFile, setSelectedFile] = useState('paper')
  const [selectedTab, setSelectedTab] = useState('discussion')
  const [agents, setAgents] = useState(initialAgents)
  const [workflow, setWorkflow] = useState(initialWorkflow)
  const [docFormat, setDocFormat] = useState<EditorFormat>('tex')
  const [editorValue, setEditorValue] = useState(`\\documentclass{article}
\\usepackage{ctex}
\\begin{document}
\\section{引言}
这是一个以 LaTeX 为核心的论文写作面板。
\\subsection{目标}
支持写作、review 和润色。
\\end{document}`)
  const [messages, setMessages] = useState([
    { id: 1, author: 'System', content: 'Workflow 已加载，等待用户选择文档块。' },
    { id: 2, author: 'Reviewer', content: '当前章节逻辑完整，但需要更清晰的分层。' },
  ])
  const [newMessage, setNewMessage] = useState('')
  const annotations = [
    {
      id: 1,
      agent: 'Reviewer',
      text: '建议补充本节与上一节的衔接句。',
      quote: '这是一个以 LaTeX 为核心的论文写作面板。',
      time: '09:42',
    },
    {
      id: 2,
      agent: 'Polisher',
      text: '“review 和润色”建议改为“评审与润色”。',
      quote: '支持写作、review 和润色。',
      time: '09:43',
    },
  ]

  const selectedFileName = useMemo(
    () => fileTree.find((file) => file.id === selectedFile)?.name ?? 'main.tex',
    [selectedFile],
  )

  const addAgent = () => {
    const next = agents.length + 1
    setAgents([
      ...agents,
      {
        id: `a${next}`,
        name: `Agent ${next}`,
        role: '自定义角色',
        color: ['#2563eb', '#7c3aed', '#059669', '#ea580c'][next % 4],
      },
    ])
  }

  const addWorkflowNode = (type: string) => {
    const next = workflow.length + 1
    setWorkflow([
      ...workflow,
      { id: `n${next}`, type, label: `${type.toUpperCase()} Node ${next}` },
    ])
  }

  const sendMessage = () => {
    if (!newMessage.trim()) return
    setMessages([
      ...messages,
      { id: Date.now(), author: 'You', content: newMessage.trim() },
    ])
    setNewMessage('')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand">YuwanLabWriter</div>
          <div className="subtitle">LaTeX-first 本地科研写作工作台</div>
        </div>
        <div className="topbar-actions">
          <button className="ghost-btn"><Save size={16} /> 保存</button>
          <button className="ghost-btn"><Settings2 size={16} /> 设置</button>
        </div>
      </header>

      <main className="workspace">
        <PanelGroup orientation="horizontal" style={{ height: '100%' }}>
          <Panel defaultSize={20} minSize={16}>
            <div className="panel left-panel">
              <div className="panel-section">
                <div className="section-title"><Folder size={16} /> 文件管理</div>
                <div className="file-list">
                  {fileTree.map((file) => (
                    <button
                      key={file.id}
                      className={`file-item ${selectedFile === file.id ? 'active' : ''}`}
                      onClick={() => setSelectedFile(file.id)}
                    >
                      {file.type === 'folder' ? (
                        file.open ? <FolderOpen size={16} /> : <Folder size={16} />
                      ) : (
                        <FileText size={16} />
                      )}
                      <span style={{ marginLeft: file.level * 12 }}>{file.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel-section">
                <div className="section-title"><BookOpen size={16} /> 文档大纲</div>
                <div className="outline-list">
                  {outline.map((item, index) => (
                    <button key={item} className="outline-item">
                      <ChevronRight size={14} />
                      <span>{index + 1}. {item}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={50} minSize={36}>
            <div className="panel editor-panel">
              <div className="editor-toolbar">
                <div className="toolbar-left">
                  <div className="doc-name">{selectedFileName}</div>
                  <span className="badge">{docFormat.toUpperCase()}</span>
                </div>
                <div className="toolbar-right">
                  <button className={`format-btn ${docFormat === 'tex' ? 'active' : ''}`} onClick={() => setDocFormat('tex')}>LaTeX</button>
                  <button className={`format-btn ${docFormat === 'md' ? 'active' : ''}`} onClick={() => setDocFormat('md')}>Markdown</button>
                  <button className={`format-btn ${docFormat === 'txt' ? 'active' : ''}`} onClick={() => setDocFormat('txt')}>TXT</button>
                </div>
              </div>

              <div className="editor-split">
                <div className="editor-column">
                  <div className="column-header"><SplitSquareVertical size={16} /> 编辑器</div>
                  <div className="latex-editor-host">
                    <LatexEditor
                      value={editorValue}
                      format={docFormat}
                      onChange={setEditorValue}
                    />
                  </div>
                </div>

                <div className="editor-column preview-column">
                  <div className="column-header"><Wand2 size={16} /> 预览</div>
                  <div className="preview-box">
                    <ScrollArea.Root className="scroll-root">
                      <ScrollArea.Viewport className="scroll-viewport">
                        <div className="preview-paper">
                          <h1>论文预览</h1>
                          <p>当前格式：{docFormat.toUpperCase()}</p>
                          <pre>{editorValue}</pre>
                        </div>
                      </ScrollArea.Viewport>
                      <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
                        <ScrollArea.Thumb className="thumb" />
                      </ScrollArea.Scrollbar>
                    </ScrollArea.Root>
                  </div>
                </div>

                <div className="editor-column note-column">
                  <div className="column-header"><MessageSquare size={16} /> 批注</div>
                  <div className="annotation-list">
                    {annotations.map((note) => (
                      <div key={note.id} className="annotation-card">
                        <div className="annotation-head">
                          <strong>{note.agent}</strong>
                          <span>{note.time}</span>
                        </div>
                        <p>{note.text}</p>
                        <blockquote>{note.quote}</blockquote>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={30} minSize={24}>
            <div className="panel right-panel">
              <Tabs.Root value={selectedTab} onValueChange={setSelectedTab} className="tabs-root">
                <Tabs.List className="tabs-list">
                  <Tabs.Trigger className="tab-trigger" value="discussion">讨论区</Tabs.Trigger>
                  <Tabs.Trigger className="tab-trigger" value="agents">团队管理</Tabs.Trigger>
                  <Tabs.Trigger className="tab-trigger" value="workflow">工作流</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="discussion" className="tab-content">
                  <div className="chat-list">
                    {messages.map((msg) => (
                      <div key={msg.id} className={`chat-item ${msg.author === 'You' ? 'me' : ''}`}>
                        <div className="chat-author">{msg.author}</div>
                        <div className="chat-text">{msg.content}</div>
                      </div>
                    ))}
                  </div>
                  <div className="chat-input-row">
                    <input
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      placeholder="输入消息，发送给 Agent team"
                    />
                    <button onClick={sendMessage}>发送</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="agents" className="tab-content">
                  <div className="tab-header-row">
                    <span>当前团队：{agents.length} 个 Agent</span>
                    <button onClick={addAgent}><Plus size={14} /> 添加</button>
                  </div>
                  <div className="agent-grid">
                    {agents.map((agent) => (
                      <div key={agent.id} className="agent-card">
                        <div className="agent-avatar" style={{ background: agent.color }}>{agent.name.slice(0, 1)}</div>
                        <div className="agent-info">
                          <strong>{agent.name}</strong>
                          <span>{agent.role}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Tabs.Content>

                <Tabs.Content value="workflow" className="tab-content">
                  <div className="tab-header-row">
                    <span>Workflow：论文评审模板</span>
                    <button className="small-btn">保存</button>
                  </div>
                  <div className="workflow-palette">
                    <button onClick={() => addWorkflowNode('input')}>输入节点</button>
                    <button onClick={() => addWorkflowNode('agent')}>Agent 节点</button>
                    <button onClick={() => addWorkflowNode('condition')}>条件节点</button>
                    <button onClick={() => addWorkflowNode('merge')}>合并节点</button>
                    <button onClick={() => addWorkflowNode('output')}>输出节点</button>
                  </div>
                  <div className="workflow-canvas">
                    {workflow.map((node, index) => (
                      <div key={node.id} className="workflow-node">
                        <div className="workflow-node-type">{node.type}</div>
                        <div className="workflow-node-label">{node.label}</div>
                        {index < workflow.length - 1 && <div className="workflow-arrow">↓</div>}
                      </div>
                    ))}
                  </div>
                </Tabs.Content>
              </Tabs.Root>
            </div>
          </Panel>
        </PanelGroup>
      </main>
    </div>
  )
}

export default App
