import { Component } from 'react'
import { useLocation } from 'react-router-dom'

/*
  Route-scoped error boundary — wraps Layout's <Outlet/> so a render crash
  in ONE page keeps the sidebar/topbar alive and the user can navigate
  away. Before this, the only boundary was at the App root: any page
  crash replaced the entire shell (nav included) with the monospace
  "Runtime Error" screen, leaving no way out but a reload.

  Keyed by location.pathname (see the wrapper below): navigating to a
  different page automatically discards the error state and tries a
  fresh render — the classic reset-on-route-change pattern, done with a
  key instead of lifecycle bookkeeping.

  The root App boundary stays as the last line of defense for crashes in
  the shell itself.
*/
class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  hardReload = () => {
    const u = new URL(window.location.href)
    u.searchParams.set('_r', Date.now())
    window.location.replace(u.toString())
  }
  render() {
    if (this.state.error) return (
      <div style={{
        margin: '40px auto', maxWidth: 720, padding: '28px 32px',
        background: 'white', border: '1px solid var(--rule)',
        borderTop: '3px solid var(--down)',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--down)',
          marginBottom: 8,
        }}>This page hit an error</div>
        <p style={{ fontFamily: 'var(--sans)', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 0 16px' }}>
          The rest of the dashboard is fine — use the sidebar to keep working,
          or reload this page. If it keeps happening it's often a stale
          browser cache after a deploy.
        </p>
        <button onClick={this.hardReload} style={{
          padding: '9px 16px', fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
          background: 'var(--ink)', color: 'var(--paper)', border: 'none', cursor: 'pointer',
        }}>Reload this page</button>
        <pre style={{
          whiteSpace: 'pre-wrap', color: 'var(--down)', fontSize: 12,
          marginTop: 18, fontFamily: 'var(--mono)',
        }}>{this.state.error.message}</pre>
      </div>
    )
    return this.props.children
  }
}

export default function RouteErrorBoundary({ children }) {
  const location = useLocation()
  return <Boundary key={location.pathname}>{children}</Boundary>
}
