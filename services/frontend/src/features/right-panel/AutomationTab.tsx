import { useState } from 'react'
import { Bot, MessageCircle, Pen } from 'lucide-react'
import { AnnotationAutoReplyPanel } from './AnnotationAutoReplyPanel'
import { AnnotationAutomationPanel } from './AnnotationAutomationPanel'
import { WritingAutomationPanel } from './WritingAutomationPanel'

type AutomationMode = 'annotate' | 'write' | 'reply'

export function AutomationTab() {
  const [mode, setMode] = useState<AutomationMode>('annotate')

  return (
    <div className="tab-content-wrapper automation-tab">
      <div className="automation-top-switch">
        <button
          type="button"
          className={mode === 'annotate' ? 'active' : ''}
          onClick={() => setMode('annotate')}
        >
          <Bot size={14} /> 自动批注
        </button>
        <button
          type="button"
          className={mode === 'write' ? 'active' : ''}
          onClick={() => setMode('write')}
        >
          <Pen size={14} /> 自动写入
        </button>
        <button
          type="button"
          className={mode === 'reply' ? 'active' : ''}
          onClick={() => setMode('reply')}
        >
          <MessageCircle size={14} /> 自动回复
        </button>
      </div>

      {mode === 'annotate' && <AnnotationAutomationPanel />}
      {mode === 'write' && <WritingAutomationPanel />}
      {mode === 'reply' && <AnnotationAutoReplyPanel />}
    </div>
  )
}
