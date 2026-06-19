/**
 * Skill Optimization Page — Phoenix-style tab layout for managing
 * data-driven Skill optimization runs.
 */

import React, { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useSkillOptimizationStore } from '../stores/skillOptimizationStore'

// ---------------------------------------------------------------------------
// Tab components (inline for now, can be split later)
// ---------------------------------------------------------------------------

function OptimizationRunsTab() {
  const { runs, runsTotal, loading, fetchRuns } = useSkillOptimizationStore()

  useEffect(() => {
    fetchRuns()
  }, [fetchRuns])

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      collecting: '#6b7280',
      diagnosing: '#3b82f6',
      generating: '#8b5cf6',
      evaluating: '#f59e0b',
      reviewing: '#f97316',
      published: '#10b981',
      discarded: '#ef4444',
    }
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 600,
          color: '#fff',
          backgroundColor: colors[status] || '#6b7280',
        }}
      >
        {status}
      </span>
    )
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Optimization Runs ({runsTotal})</h3>
        <button onClick={() => fetchRuns()} disabled={loading}>
          Refresh
        </button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px' }}>ID</th>
            <th style={{ padding: '8px 12px' }}>Status</th>
            <th style={{ padding: '8px 12px' }}>Review</th>
            <th style={{ padding: '8px 12px' }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
              onClick={() => {
                useSkillOptimizationStore.setState({ currentRun: run, activeTab: 'diagnosis' })
                useSkillOptimizationStore.getState().fetchDiagnosis(run.id)
                useSkillOptimizationStore.getState().fetchArtifacts(run.id)
                useSkillOptimizationStore.getState().fetchDiff(run.id)
              }}
            >
              <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 13 }}>
                {run.id.slice(0, 8)}...
              </td>
              <td style={{ padding: '8px 12px' }}>{statusBadge(run.status)}</td>
              <td style={{ padding: '8px 12px' }}>{run.review_status}</td>
              <td style={{ padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>
                {new Date(run.created_at).toLocaleString()}
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No optimization runs yet. Trigger one from the Skill management panel.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function DiagnosisTab() {
  const { diagnosis, currentRun } = useSkillOptimizationStore()

  if (!diagnosis) {
    return (
      <div style={{ padding: 16, color: '#9ca3af' }}>
        {currentRun ? 'Loading diagnosis...' : 'Select an optimization run to view diagnosis.'}
      </div>
    )
  }

  return (
    <div style={{ padding: 16, display: 'flex', gap: 24 }}>
      {/* Failure Patterns */}
      <div style={{ flex: 1 }}>
        <h4>Failure Patterns ({diagnosis.failure_patterns.length})</h4>
        {diagnosis.failure_patterns.map((fp, i) => (
          <div
            key={i}
            style={{
              padding: '8px 12px',
              marginBottom: 8,
              background: '#fef2f2',
              borderRadius: 6,
              border: '1px solid #fecaca',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>{fp.pattern}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
              Count: {fp.count} | Examples: {fp.example_ids.slice(0, 3).join(', ')}
            </div>
            {fp.suggested_fix && (
              <div style={{ fontSize: 12, color: '#059669', marginTop: 4 }}>
                💡 {fp.suggested_fix}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Golden Examples */}
      <div style={{ flex: 1 }}>
        <h4>Golden Examples ({diagnosis.golden_examples.length})</h4>
        {diagnosis.golden_examples.map((ex, i) => (
          <div
            key={i}
            style={{
              padding: '8px 12px',
              marginBottom: 8,
              background: '#f0fdf4',
              borderRadius: 6,
              border: '1px solid #bbf7d0',
            }}
          >
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>
              {ex.id}
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{ex.reason}</div>
          </div>
        ))}

        <h4 style={{ marginTop: 24 }}>Optimization Suggestions</h4>
        {diagnosis.optimization_suggestions.map((s, i) => (
          <div
            key={i}
            style={{
              padding: '8px 12px',
              marginBottom: 8,
              background: s.priority === 'high' ? '#fef3c7' : '#f3f4f6',
              borderRadius: 6,
              border: `1px solid ${s.priority === 'high' ? '#fcd34d' : '#e5e7eb'}`,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              [{s.priority.toUpperCase()}] {s.target}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{s.suggestion}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function GeneratedPreviewTab() {
  const { artifacts, diff, currentRun } = useSkillOptimizationStore()
  const [showDiff, setShowDiff] = React.useState(false)

  if (!currentRun) {
    return <div style={{ padding: 16, color: '#9ca3af' }}>Select a run to preview.</div>
  }

  return (
    <div style={{ padding: 16 }}>
      <h4>Generated Artifacts ({artifacts.length})</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {artifacts.map((a, i) => (
          <div
            key={i}
            style={{
              padding: '6px 12px',
              background: a.action === 'created' ? '#dbeafe' : '#fef3c7',
              borderRadius: 6,
              fontSize: 13,
              fontFamily: 'monospace',
            }}
          >
            {a.action === 'created' ? '📄' : '✏️'} {a.path}
            <span style={{ color: '#9ca3af', marginLeft: 8 }}>
              {(a.size_bytes / 1024).toFixed(1)}KB
            </span>
          </div>
        ))}
      </div>

      <button onClick={() => setShowDiff(!showDiff)} style={{ marginBottom: 12 }}>
        {showDiff ? 'Hide' : 'Show'} SKILL.md Diff
      </button>
      {showDiff && diff && (
        <pre
          style={{
            padding: 16,
            background: '#1e1e1e',
            color: '#d4d4d4',
            borderRadius: 8,
            fontSize: 13,
            overflow: 'auto',
            maxHeight: 400,
          }}
        >
          {diff.split('\n').map((line, i) => (
            <div
              key={i}
              style={{
                color: line.startsWith('+')
                  ? '#4ade80'
                  : line.startsWith('-')
                    ? '#f87171'
                    : '#d4d4d4',
              }}
            >
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function EvalTab() {
  const { evalResults, currentRun, fetchEvalResults } = useSkillOptimizationStore()

  useEffect(() => {
    if (currentRun?.id) {
      fetchEvalResults(currentRun.id)
    }
  }, [currentRun?.id, fetchEvalResults])

  if (!evalResults) {
    return (
      <div style={{ padding: 16, color: '#9ca3af' }}>
        {currentRun ? 'No eval results yet.' : 'Select a run to view eval results.'}
      </div>
    )
  }

  const { summary, cases, regressions } = evalResults

  return (
    <div style={{ padding: 16 }}>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        <SummaryCard label="Total" value={summary.total} />
        <SummaryCard label="Passed" value={summary.passed} color="#10b981" />
        <SummaryCard label="Failed" value={summary.failed} color="#ef4444" />
        <SummaryCard label="Regressions" value={summary.regressions} color="#f59e0b" />
        <SummaryCard label="Pass Rate" value={`${(summary.pass_rate * 100).toFixed(1)}%`} />
      </div>

      {/* Regressions */}
      {regressions.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ color: '#f59e0b' }}>⚠️ Regressions</h4>
          {regressions.map((r, i) => (
            <div
              key={i}
              style={{
                padding: '8px 12px',
                marginBottom: 4,
                background: '#fef3c7',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <strong>{r.id}</strong>: {r.reason}
            </div>
          ))}
        </div>
      )}

      {/* Case results */}
      <h4>Case Results</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px' }}>Status</th>
            <th style={{ padding: '8px 12px' }}>ID</th>
            <th style={{ padding: '8px 12px' }}>Input</th>
            <th style={{ padding: '8px 12px' }}>Evaluators</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '8px 12px' }}>
                {c.passed ? '✅' : '❌'}{' '}
                {c.is_regression && <span style={{ color: '#f59e0b' }}>⚠️</span>}
              </td>
              <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 13 }}>
                {c.id}
              </td>
              <td style={{ padding: '8px 12px', fontSize: 13, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.input_summary}
              </td>
              <td style={{ padding: '8px 12px' }}>
                {Object.entries(c.evaluators).map(([name, result]) => (
                  <span
                    key={name}
                    style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      margin: '0 4px 4px 0',
                      borderRadius: 4,
                      fontSize: 11,
                      background: result.passed ? '#dcfce7' : '#fee2e2',
                      color: result.passed ? '#166534' : '#991b1b',
                    }}
                  >
                    {result.passed ? '✓' : '✗'} {name}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div
      style={{
        padding: '12px 20px',
        background: '#fff',
        borderRadius: 8,
        border: '1px solid #e5e7eb',
        minWidth: 100,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color: color || '#111827' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{label}</div>
    </div>
  )
}

function ReviewPanel() {
  const { currentRun, reviewRun, loading } = useSkillOptimizationStore()
  const [notes, setNotes] = React.useState('')

  if (!currentRun || currentRun.status !== 'reviewing') return null

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        padding: '12px 16px',
        background: '#fff',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <input
        type="text"
        placeholder="Review notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{
          flex: 1,
          padding: '8px 12px',
          border: '1px solid #d1d5db',
          borderRadius: 6,
          fontSize: 14,
        }}
      />
      <button
        onClick={() => reviewRun(currentRun.id, 'approve', notes)}
        disabled={loading}
        style={{
          padding: '8px 20px',
          background: '#10b981',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        ✅ Approve
      </button>
      <button
        onClick={() => reviewRun(currentRun.id, 'reject', notes)}
        disabled={loading}
        style={{
          padding: '8px 20px',
          background: '#ef4444',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        ❌ Reject
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'runs' as const, label: 'Optimization Runs' },
  { key: 'diagnosis' as const, label: 'Diagnosis' },
  { key: 'preview' as const, label: 'Generated Preview' },
  { key: 'eval' as const, label: 'Eval Results' },
]

export default function SkillOptimizationPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { activeTab, setActiveTab, currentRun, error, clearError } = useSkillOptimizationStore()
  const [skillId, setSkillId] = React.useState<string>('')
  const [projectName, setProjectName] = React.useState<string>('')

  // Resolve skill_id from project
  useEffect(() => {
    if (!projectId) return
    import('../services/projectsApi').then(({ projectsApi }) => {
      projectsApi.get(projectId).then((proj) => {
        const sid = proj.project_skill_id || ''
        if (sid) setSkillId(sid)
        setProjectName(proj.name || '')
      }).catch(() => {})
    })
  }, [projectId])

  useEffect(() => {
    if (skillId) {
      useSkillOptimizationStore.getState().fetchRuns({ skill_id: skillId })
    }
  }, [skillId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>📊 Skill Optimization{projectName ? ` — ${projectName}` : ''}</h2>
        {currentRun && (
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            Run: {currentRun.id.slice(0, 8)}... | Status: {currentRun.status}
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '8px 16px',
            background: '#fee2e2',
            color: '#991b1b',
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          {error}
          <button onClick={clearError} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 20px',
              background: activeTab === tab.key ? '#fff' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.key ? '2px solid #3b82f6' : '2px solid transparent',
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? '#111827' : '#6b7280',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activeTab === 'runs' && <OptimizationRunsTab />}
        {activeTab === 'diagnosis' && <DiagnosisTab />}
        {activeTab === 'preview' && <GeneratedPreviewTab />}
        {activeTab === 'eval' && <EvalTab />}
      </div>

      {/* Review panel */}
      <ReviewPanel />
    </div>
  )
}
