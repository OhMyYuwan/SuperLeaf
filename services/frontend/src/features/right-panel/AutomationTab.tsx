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
          aria-label="自动批注"
          title="自动批注"
        >
          <Bot size={14} aria-hidden="true" />
          <span className="automation-switch-label" aria-hidden="true">自动批注</span>
        </button>
        <button
          type="button"
          className={mode === 'write' ? 'active' : ''}
          onClick={() => setMode('write')}
          aria-label="自动写入"
          title="自动写入"
        >
          <Pen size={14} aria-hidden="true" />
          <span className="automation-switch-label" aria-hidden="true">自动写入</span>
        </button>
        <button
          type="button"
          className={mode === 'reply' ? 'active' : ''}
          onClick={() => setMode('reply')}
          aria-label="自动回复"
          title="自动回复"
        >
          <MessageCircle size={14} aria-hidden="true" />
          <span className="automation-switch-label" aria-hidden="true">自动回复</span>
        </button>
      </div>

      {mode === 'annotate' && <AnnotationAutomationPanel />}
      {mode === 'write' && <WritingAutomationPanel />}
      {mode === 'reply' && <AnnotationAutoReplyPanel />}
    </div>
  )
}
