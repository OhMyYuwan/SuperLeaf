/**
 * ErrorBoundary — feature-level crash isolation.
 *
 * Wrap panels in this so a bug in one panel doesn't blank the entire app.
 * Logs the error to console (so the bug is still visible in dev), renders
 * a compact fallback card, and offers a reset button that remounts the
 * children.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import './error-boundary.css'

interface Props {
  /** Short label shown in the fallback card (e.g. "批注面板", "讨论区"). */
  label?: string
  /** Optional custom renderer; receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the original stack visible in dev; production builds can hook a
    // remote logger here if we add one later.
    console.error(`[ErrorBoundary:${this.props.label ?? 'unknown'}]`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div className="err-boundary-card" role="alert">
        <div className="err-boundary-title">
          {this.props.label ? `${this.props.label}出错了` : '组件出错了'}
        </div>
        <div className="err-boundary-message">{error.message || String(error)}</div>
        <button className="err-boundary-reset" onClick={this.reset}>
          重试
        </button>
      </div>
    )
  }
}
