import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last line of defence: if a screen crashes while rendering, show a way out instead of a blank
 * page. Also covers a lazy screen that fails to download (e.g. right after a new deploy).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const outdated = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(this.state.error.message)
    return (
      <div className="crash-screen" role="alert">
        <div className="card glass">
          <h1 className="auth-title">{outdated ? 'A new version is ready' : 'Something went wrong'}</h1>
          <p className="list-sub" style={{ margin: 0 }}>
            {outdated ? 'Reload to get the latest version of the app.' : 'Your tasks are safe. Reloading usually fixes this.'}
          </p>
          <button type="button" className="primary-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
