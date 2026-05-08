import { useEffect, useMemo, useState } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  BookOpen,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  Save,
  Settings2,
  SplitSquareVertical,
  Wand2,
} from 'lucide-react'
import * as Tabs from '@radix-ui/react-tabs'
import * as ScrollArea from '@radix-ui/react-scroll-area'
import { LatexEditor, type EditorFormat, type DecorationSpec, type DocChangeInfo } from './features/latex-editor'
import { SettingsDialog } from './features/settings'
import { AnnotationPanel } from './features/annotation-panel'
import { useDocumentStore } from './stores/documentStore'
import { useEditorStore } from './stores/editorStore'
import { useSettingsStore } from './stores/settingsStore'
import { useWorkflowStore } from './stores/workflowStore'
import { useAnnotationStore } from './stores/annotationStore'
import { seedDocuments } from './stores/seedData'
import './App.css'

function App() {
  const documents = useDocumentStore((s) => s.documents)
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId)
  const setActive = useDocumentStore((s) => s.setActive)
  const updateContent = useDocumentStore((s) => s.updateContent)
  const seed = useDocumentStore((s) => s.seed)

  const updateSelection = useEditorStore((s) => s.updateSelection)
  const activeSelection = useEditorStore((s) =>
    activeDocumentId ? s.states[activeDocumentId]?.selection ?? null : null,
  )

  const loadProviders = useSettingsStore((s) => s.load)
  const activeProvider = useSettingsStore((s) => s.providers.find((p) => p.is_active) ?? null)
  const backendReachable = useSettingsStore((s) => s.backendReachable)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const workflows = useWorkflowStore((s) => s.workflows)
  const workflowsLoaded = useWorkflowStore((s) => s.loaded)
  const workflowError = useWorkflowStore((s) => s.error)
  const loadWorkflows = useWorkflowStore((s) => s.load)
  const runningMap = useWorkflowStore((s) => s.running)
  const eventsMap = useWorkflowStore((s) => s.lastRunEvents)
  const runWorkflow = useWorkflowStore((s) => s.run)

  useEffect(() => {
    if (Object.keys(useDocumentStore.getState().documents).length === 0) {
      seed(seedDocuments)
    }
    loadProviders()
    loadWorkflows()
  }, [seed, loadProviders, loadWorkflows])

  const activeDoc = activeDocumentId ? documents[activeDocumentId] : null
  const fileList = useMemo(() => Object.values(documents), [documents])

  const [selectedTab, setSelectedTab] = useState('discussion')
  const [messages, setMessages] = useState([
    { id: 1, author: 'System', content: 'Workflow 已加载，等待用户选择文档块。' },
    { id: 2, author: 'Reviewer', content: '当前章节逻辑完整，但需要更清晰的分层。' },
  ])
  const [newMessage, setNewMessage] = useState('')
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')

  const annotationItemsById = useAnnotationStore((s) => s.items)
  const annotationItems = useMemo(() => {
    if (!activeDocumentId) return []
    return Object.values(annotationItemsById)
      .filter((it) => it.documentId === activeDocumentId && it.status !== 'deleted')
      .sort((a, b) => a.range.from - b.range.from)
  }, [annotationItemsById, activeDocumentId])
  const decorationSpecs: DecorationSpec[] = useMemo(
    () =>
      annotationItems
        .filter((it) => it.status === 'pending')
        .map((it) => ({
          id: it.id,
          from: it.range.from,
          to: it.range.to,
          kind: it.kind,
          severity: it.severity,
        })),
    [annotationItems],
  )

  const sendMessage = () => {
    if (!newMessage.trim()) return
    setMessages([
      ...messages,
      { id: Date.now(), author: 'You', content: newMessage.trim() },
    ])
    setNewMessage('')
  }

  const handleRunWorkflow = (workflowId: string, instruction: string) => {
    if (!activeDocumentId) {
      alert('请先选择一个文件')
      return
    }
    if (!activeSelection) {
      alert('请先在编辑器中选中一段文字，再运行。')
      return
    }
    const selectionText = activeSelection.text
    const userPrompt = instruction.trim() || '请针对以下文本给出评审意见。'
    runWorkflow(workflowId, {
      document_id: activeDocumentId,
      range_start: activeSelection.from,
      range_end: activeSelection.to,
      inputs: {
        target_text: selectionText,
        section_title: activeSelection.context.sectionTitle ?? '',
        before: activeSelection.context.before,
        after: activeSelection.context.after,
        instruction: userPrompt,
      },
      // chat-mode needs `query`; workflow-mode ignores it. We put the user's
      // instruction here with the selected text appended so a plain Dify LLM
      // node has everything it needs in a single prompt.
      query: `${userPrompt}\n\n---\n${selectionText}`,
    })
  }

  const handleEditorChange = (next: string) => {
    if (!activeDocumentId) return
    updateContent(activeDocumentId, next)
  }

  const handleDocChange = (changes: DocChangeInfo[]) => {
    if (!activeDocumentId) return
    useAnnotationStore.getState().applyDocumentChange(activeDocumentId, changes)
  }

  const handleSelectionChange = (info: { from: number; to: number; text: string }) => {
    if (!activeDocumentId) return
    const sel = updateSelection(activeDocumentId, { from: info.from, to: info.to })
    if (sel) {
      // W1 demo acceptance: selection context is derived and logged.
      console.log('[selection]', {
        text: sel.text,
        section: sel.context.sectionTitle,
        before: sel.context.before.slice(-60),
        after: sel.context.after.slice(0, 60),
        paragraphIds: sel.paragraphIds,
      })
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand">YuwanLabWriter</div>
          <div className="subtitle">LaTeX-first 本地科研写作工作台</div>
        </div>
        <div className="topbar-actions">
          <ProviderBadge
            reachable={backendReachable}
            providerName={activeProvider?.name ?? null}
            providerStatus={activeProvider?.status ?? null}
            onOpen={() => setSettingsOpen(true)}
          />
          <button className="ghost-btn"><Save size={16} /> 保存</button>
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} /> 设置
          </button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <main className="workspace">
        <PanelGroup orientation="horizontal" style={{ height: '100%' }}>
          <Panel defaultSize={20} minSize={16}>
            <div className="panel left-panel">
              <div className="panel-section">
                <div className="section-title"><Folder size={16} /> 文件管理</div>
                <div className="file-list">
                  <button className="file-item">
                    <FolderOpen size={16} />
                    <span>project</span>
                  </button>
                  {fileList.map((file) => (
                    <button
                      key={file.id}
                      className={`file-item ${activeDocumentId === file.id ? 'active' : ''}`}
                      onClick={() => setActive(file.id)}
                    >
                      <FileText size={16} />
                      <span style={{ marginLeft: 12 }}>{file.metadata.title}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel-section">
                <div className="section-title"><BookOpen size={16} /> 文档大纲</div>
                <div className="outline-list">
                  {activeDoc && activeDoc.structure.sections.length === 0 && (
                    <div className="outline-empty">此文档无章节标题</div>
                  )}
                  {activeDoc?.structure.sections.map((sec) => (
                    <button
                      key={sec.id}
                      className="outline-item"
                      style={{ paddingLeft: 8 + sec.level * 14 }}
                      title={sec.title}
                    >
                      <ChevronRight size={14} />
                      <span>{sec.title}</span>
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
                  <div className="doc-name">{activeDoc?.metadata.title ?? '未打开文件'}</div>
                  <span className="badge">{(activeDoc?.format ?? '').toUpperCase()}</span>
                </div>
                <div className="toolbar-right">
                  {activeSelection && (
                    <span className="selection-info">
                      选中 {activeSelection.context.selectionLength} 字
                      {activeSelection.context.sectionTitle &&
                        ` · ${activeSelection.context.sectionTitle}`}
                    </span>
                  )}
                </div>
              </div>

              <div className="editor-split">
                <div className="editor-column">
                  <div className="column-header"><SplitSquareVertical size={16} /> 编辑器</div>
                  <div className="latex-editor-host">
                    {activeDoc ? (
                      <LatexEditor
                        key={activeDoc.id}
                        value={activeDoc.content}
                        format={activeDoc.format as EditorFormat}
                        onChange={handleEditorChange}
                        onSelectionChange={handleSelectionChange}
                        onDocChange={handleDocChange}
                        decorations={decorationSpecs}
                        activeDecorationId={activeAnnotationId}
                        onDecorationClick={(id) =>
                          setActiveAnnotationId((prev) => (prev === id ? null : id))
                        }
                      />
                    ) : (
                      <div className="editor-empty">请选择一个文件</div>
                    )}
                  </div>
                </div>

                <div className="editor-column preview-column">
                  <div className="column-header"><Wand2 size={16} /> 预览</div>
                  <div className="preview-box">
                    <ScrollArea.Root className="scroll-root">
                      <ScrollArea.Viewport className="scroll-viewport">
                        <div className="preview-paper">
                          <h1>文档预览</h1>
                          <p>格式：{(activeDoc?.format ?? '').toUpperCase()}（W10 起接入真实渲染器）</p>
                          <pre>{activeDoc?.content ?? ''}</pre>
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
                  <AnnotationPanel
                    documentId={activeDocumentId}
                    activeId={activeAnnotationId}
                    onFocus={setActiveAnnotationId}
                  />
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
                    <span>Dify Agent / Workflow：{workflows.length} 个已同步</span>
                    <button className="small-btn" onClick={() => loadWorkflows()}>刷新</button>
                  </div>
                  {!activeProvider && (
                    <div className="tab-empty">
                      还未配置或激活 provider。先去"设置"里添加 Dify provider，并点击"测连"完成首次同步。
                    </div>
                  )}
                  {activeProvider && workflowsLoaded && workflows.length === 0 && (
                    <div className="tab-empty">
                      没有同步到任何 app。确保已在 Dify 里创建应用并生成 API key，然后回到"设置"点击"测连"。
                    </div>
                  )}
                  {workflowError && <div className="tab-error">{workflowError}</div>}
                  <div className="agent-grid">
                    {workflows.map((wf) => (
                      <div key={wf.id} className="agent-card" title={wf.description || wf.kind}>
                        <div className="agent-avatar" style={{ background: agentColor(wf.kind) }}>
                          {wf.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="agent-info">
                          <strong>{wf.name}</strong>
                          <span>{wf.kind}{wf.description ? ` · ${wf.description}` : ''}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Tabs.Content>

                <Tabs.Content value="workflow" className="tab-content">
                  <div className="tab-header-row">
                    <span>选中文字、写下指令，再选择 workflow 运行</span>
                  </div>
                  {!activeSelection && (
                    <div className="tab-empty">先在编辑器里选中一段文字。</div>
                  )}
                  {activeSelection && (
                    <div className="run-instruction-block">
                      <label className="run-instruction-label">
                        给 Agent 的指令（可选）
                      </label>
                      <textarea
                        className="run-instruction-input"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder="例如：请润色 / 压缩到 50 字 / 检查逻辑 / 调整段落结构…"
                        rows={2}
                      />
                      <div className="run-instruction-presets">
                        {presetInstructions.map((p) => (
                          <button
                            key={p}
                            className="preset-chip"
                            type="button"
                            onClick={() => setInstruction(p)}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="workflow-runs">
                    {workflows.map((wf) => {
                      const running = !!runningMap[wf.id]
                      const events = eventsMap[wf.id] ?? []
                      return (
                        <div key={wf.id} className="workflow-run-card">
                          <div className="workflow-run-head">
                            <div>
                              <strong>{wf.name}</strong>
                              <span className="workflow-run-kind"> · {wf.kind}</span>
                            </div>
                            <button
                              className="primary-btn run-btn"
                              onClick={() => handleRunWorkflow(wf.id, instruction)}
                              disabled={running}
                            >
                              {running ? '运行中…' : '▶ 运行'}
                            </button>
                          </div>
                          {events.length > 0 && (
                            <ul className="run-events">
                              {events.slice(-6).map((evt, i) => (
                                <li key={i} className={`run-event ${evt.kind.replaceAll('.', '-')}`}>
                                  <span className="event-kind">{eventLabel(evt)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
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

function ProviderBadge({
  reachable,
  providerName,
  providerStatus,
  onOpen,
}: {
  reachable: boolean | null
  providerName: string | null
  providerStatus: string | null
  onOpen: () => void
}) {
  let label: string
  let tone: 'idle' | 'ok' | 'warn' | 'err'
  if (reachable === false) {
    label = '后端离线'
    tone = 'err'
  } else if (!providerName) {
    label = '未配置 Provider'
    tone = 'warn'
  } else if (providerStatus === 'error') {
    label = `${providerName} · 连接失败`
    tone = 'err'
  } else if (providerStatus === 'ok') {
    label = providerName
    tone = 'ok'
  } else {
    label = `${providerName} · 未验证`
    tone = 'idle'
  }
  return (
    <button className={`provider-badge ${tone}`} onClick={onOpen} title="打开设置">
      <span className="dot" />
      {label}
    </button>
  )
}

function agentColor(kind: string): string {
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}

interface EventLike {
  kind: string
  payload: unknown
}

function eventLabel(evt: EventLike): string {
  if (evt.kind === 'ylw.run.started') return '已提交到 Dify'
  if (evt.kind === 'ylw.run.finished') return '完成 ✓'
  if (evt.kind === 'ylw.run.failed') {
    const p = evt.payload as { error?: string } | undefined
    return `失败: ${p?.error ?? ''}`
  }
  const p = evt.payload as { event?: string } | undefined
  return p?.event ?? 'dify 事件'
}

const presetInstructions = [
  '润色这段文字',
  '压缩到 50 字以内',
  '检查论证逻辑',
  '调整段落结构',
  '改写得更学术',
  '检查引用与事实',
]
