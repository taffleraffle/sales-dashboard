import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Users, UserCheck, ClipboardCheck, Settings, TrendingUp, LogOut, Menu, X, ChevronDown, Megaphone, FileText, TrendingDown } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import SalesChatWidget from './SalesChatWidget'
import ToastStack from './Toast'
import UploadDock from './UploadDock'
import RouteErrorBoundary from './RouteErrorBoundary'
import { ToastProvider } from '../hooks/useToast'
import { UploadProvider } from '../hooks/useUploads'
import { startAutoSync, stopAutoSync } from '../services/autoSync'
import { ICON } from '../utils/constants'

// Archived nav: routes that still work via direct URL but are hidden from
// the sidebar. Pipeline overlaps with Setters / Marketing data; Call Data
// hasn't been used as a primary surface in months. Ben (2026-06-10) also
// cut Commissions, Setter Bot and Email Flows to de-clutter, and moved
// Settings to the avatar/profile dropdown only (it was already linked
// there). Keeping the routes registered in App.jsx so deep links survive.
const navItems = [
  { to: '/sales', icon: BarChart3, label: 'Overview', end: true },
  { to: '/sales/closers', icon: UserCheck, label: 'Closers' },
  { to: '/sales/setters', icon: Users, label: 'Setters' },
  { to: '/sales/marketing', icon: TrendingUp, label: 'Marketing' },
  { to: '/sales/ads', icon: Megaphone, label: 'Ads' },
  { to: '/sales/eod', icon: ClipboardCheck, label: 'EOD' },
  { to: '/sales/contracts', icon: FileText, label: 'Contracts' },
  { to: '/sales/downsells', icon: TrendingDown, label: 'Downsells' },
]

function initialsOf(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef(null)

  const roleLabel = isAdmin ? 'Admin' : profile?.role === 'closer' ? 'Closer' : profile?.role === 'setter' ? 'Setter' : 'Viewer'

  useEffect(() => {
    if (!profileOpen) return
    const handler = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [profileOpen])

  useEffect(() => {
    if (!drawerOpen) return
    const handler = (e) => { if (e.key === 'Escape') setDrawerOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [drawerOpen])

  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [drawerOpen])

  useEffect(() => {
    const timer = setTimeout(() => startAutoSync(), 3000)
    return () => {
      clearTimeout(timer)
      stopAutoSync()
    }
  }, [])

  // Pre-warm caches for slow pages. Trimmed 2026-06-12 (perf audit):
  // - Email Flows prewarm DELETED — the page is hidden from nav, and its
  //   loadEmailStats() pulled every inbound email ever recorded (no date
  //   bound) on every session, for every user. If the page returns to
  //   nav, prewarm on first visit instead.
  // - Closer/Setter EOD prewarm DELETED — SalesOverview's own
  //   useCloserEODs/useSetterEODs fill the same module cache at T+0,
  //   so the T+12s timer re-fetched data the landing page already had.
  // Kept: pipeline summaries + WAVV aggregates (no other warm path).
  useEffect(() => {
    const timers = []
    timers.push(setTimeout(async () => {
      try {
        const { fetchAllPipelineSummaries } = await import('../services/ghlPipeline')
        fetchAllPipelineSummaries().catch(() => {})
      } catch (_e) { void _e }
    }, 7000))
    timers.push(setTimeout(async () => {
      try {
        const { fetchWavvAggregates } = await import('../services/wavvService')
        fetchWavvAggregates(30).catch(() => {})
      } catch (_e) { void _e }
    }, 17000))
    return () => { for (const t of timers) clearTimeout(t) }
  }, [])

  return (
    <ToastProvider>
      <UploadProvider>
      <div className="min-h-screen flex" style={{ background: 'var(--paper)' }}>
        <UploadDock />
        {/* ── Left Sidebar (desktop) ── editorial paper, hairline border, ink icons */}
        <aside
          className="hidden md:flex w-16 flex-col items-center py-5 fixed top-0 left-0 h-screen z-50"
          style={{
            background: 'var(--paper)',
            borderRight: '1px solid var(--rule)',
          }}
        >
          {/* Logo — accent yellow disc, ink mark */}
          <div
            className="w-9 h-9 flex items-center justify-center mb-8"
            style={{
              background: 'var(--accent)',
              borderRadius: '999px',
            }}
          >
            <BarChart3 size={ICON.xl} style={{ color: 'var(--ink)' }} />
          </div>

          {/* Nav icons */}
          <nav className="flex flex-col items-center gap-1 flex-1">
            {navItems.map(({ to, icon: Icon, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  `editorial-nav-item ${isActive ? 'is-active' : ''}`
                }
              >
                <Icon size={ICON.xl} />
                <span className="editorial-nav-tip">{label}</span>
              </NavLink>
            ))}
          </nav>

          {/* Sign out */}
          <button
            onClick={signOut}
            className="editorial-nav-item"
            title="Sign out"
            style={{ marginTop: 8 }}
          >
            <LogOut size={ICON.lg} />
            <span className="editorial-nav-tip">Sign out</span>
          </button>
        </aside>

        {/* ── Mobile Drawer ── */}
        {drawerOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 z-[99]"
              style={{ background: 'rgba(10,10,10,0.45)', backdropFilter: 'blur(4px)' }}
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside
              className="md:hidden fixed top-0 left-0 h-full z-[100] w-72 max-w-[82vw] flex flex-col slide-in-right"
              role="dialog"
              aria-label="Navigation menu"
              style={{
                background: 'var(--paper)',
                borderRight: '1px solid var(--rule)',
                boxShadow: '0 0 60px rgba(10,10,10,0.18)',
              }}
            >
              {/* Drawer header */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--rule)' }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-8 h-8 flex items-center justify-center"
                    style={{ background: 'var(--accent)', borderRadius: '999px' }}
                  >
                    <BarChart3 size={15} style={{ color: 'var(--ink)' }} />
                  </div>
                  <div className="leading-tight">
                    <span className="eyebrow eyebrow-bare" style={{ fontSize: 9 }}>OPT Digital</span>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', marginTop: 2 }}>
                      Sales <em style={{ fontStyle: 'italic' }}>Dashboard</em>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="w-10 h-10 flex items-center justify-center"
                  aria-label="Close menu"
                  style={{ color: 'var(--ink-3)', borderRadius: 3 }}
                >
                  <X size={ICON.lg} />
                </button>
              </div>

              {/* Nav items */}
              <nav className="flex-1 overflow-y-auto px-2 py-3">
                {navItems.map(({ to, icon: Icon, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={() => setDrawerOpen(false)}
                    className={({ isActive }) =>
                      `editorial-nav-row ${isActive ? 'is-active' : ''}`
                    }
                  >
                    <Icon size={ICON.lg} className="shrink-0" />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </nav>

              {/* Sign out */}
              <div style={{ borderTop: '1px solid var(--rule)', padding: 8 }}>
                <button
                  onClick={() => { setDrawerOpen(false); signOut() }}
                  className="editorial-nav-row"
                  style={{ color: 'var(--down)' }}
                >
                  <LogOut size={ICON.lg} />
                  <span>Sign out</span>
                </button>
              </div>
            </aside>
          </>
        )}

        {/* ── Main column ── */}
        <div className="flex-1 md:ml-16 min-w-0">
          {/* Top bar — paper, hairline bottom, sticky */}
          <header
            className="h-14 md:h-16 flex items-center justify-between px-3 sm:px-4 md:px-8 sticky top-0 z-40"
            style={{
              background: 'rgba(251,250,246,0.92)',
              backdropFilter: 'blur(10px)',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            <div className="flex items-center gap-3">
              {/* Mobile hamburger */}
              <button
                onClick={() => setDrawerOpen(true)}
                aria-expanded={drawerOpen}
                aria-label="Open navigation menu"
                className="md:hidden w-11 h-11 flex items-center justify-center"
                style={{ color: 'var(--ink)', borderRadius: 3 }}
              >
                <Menu size={ICON.xl} />
              </button>
              <div
                className="md:hidden w-8 h-8 flex items-center justify-center shrink-0"
                style={{ background: 'var(--accent)', borderRadius: 999 }}
              >
                <BarChart3 size={15} style={{ color: 'var(--ink)' }} />
              </div>

              {/* Wordmark — desktop */}
              <div className="hidden md:flex items-center gap-3">
                <span className="eyebrow eyebrow-accent">OPT Digital · Sales</span>
              </div>
            </div>

            {/* Profile */}
            <div className="flex items-center gap-3 md:gap-4">
              {profile && (
                <div className="relative" ref={profileRef}>
                  <button
                    onClick={() => setProfileOpen(v => !v)}
                    aria-expanded={profileOpen}
                    aria-haspopup="menu"
                    aria-label="Open profile menu"
                    className="flex items-center gap-2 md:gap-3 min-h-[44px] px-1.5 md:pl-1.5 md:pr-3"
                    style={{ borderRadius: 3 }}
                  >
                    <div
                      className="w-10 h-10 flex items-center justify-center text-[12px] font-semibold"
                      style={{
                        background: 'var(--paper-2)',
                        border: '1px solid var(--rule)',
                        color: 'var(--ink)',
                        borderRadius: 999,
                        fontFamily: 'var(--mono)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {initialsOf(profile.name)}
                    </div>
                    <div className="hidden md:block text-left leading-tight">
                      <p style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500, margin: 0 }}>{profile.name}</p>
                      <p
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                          color: 'var(--ink-3)',
                          margin: 0,
                        }}
                      >
                        {roleLabel}
                      </p>
                    </div>
                    <ChevronDown
                      size={ICON.sm}
                      className={`hidden md:block transition-transform ${profileOpen ? 'rotate-180' : ''}`}
                      style={{ color: 'var(--ink-3)' }}
                    />
                  </button>
                  {profileOpen && (
                    <div className="absolute top-full right-0 mt-2 dropdown-panel min-w-[260px]">
                      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--rule)' }}>
                        <p style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500, margin: 0 }}>{profile.name}</p>
                        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '2px 0 0' }}>{profile.email}</p>
                        <span className="eyebrow eyebrow-accent" style={{ marginTop: 8, fontSize: 9 }}>{roleLabel}</span>
                      </div>
                      {isAdmin && (
                        <NavLink
                          to="/sales/settings"
                          onClick={() => setProfileOpen(false)}
                          className="editorial-menu-row"
                        >
                          <Settings size={ICON.md} />
                          <span>Settings</span>
                        </NavLink>
                      )}
                      <button
                        onClick={() => { setProfileOpen(false); signOut() }}
                        className="editorial-menu-row"
                        style={{ color: 'var(--down)', borderTop: '1px solid var(--rule)', width: '100%', textAlign: 'left' }}
                      >
                        <LogOut size={ICON.md} />
                        <span>Sign out</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </header>

          {/* Page content */}
          <main className="w-full px-3 sm:px-4 md:px-8 py-4 md:py-6 pb-10">
            {/* Route-scoped boundary: a page crash keeps the shell + nav
                alive (resets automatically on navigation). */}
            <RouteErrorBoundary>
              <Outlet />
            </RouteErrorBoundary>
          </main>
        </div>

        {/* Toast stack */}
        <ToastStack />

        {/* Sales chat */}
        <SalesChatWidget />
      </div>
      </UploadProvider>
    </ToastProvider>
  )
}
