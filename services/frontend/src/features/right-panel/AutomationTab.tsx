import { useState } from 'react'
import { Bot, Pen } from 'lucide-react'
import { AnnotationAutomationPanel } from './AnnotationAutomationPanel'
import { WritingAutomationPanel } from './WritingAutomationPanel'

type AutomationMode = 'annotate' | 'write'

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
      </div>

      {mode === 'annotate' ? <AnnotationAutomationPanel /> : <WritingAutomationPanel />}
    </div>
  )
}
