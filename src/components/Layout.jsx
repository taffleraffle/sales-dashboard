import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Users, UserCheck, ClipboardCheck, Settings, TrendingUp, LogOut, Menu, X, Headphones, DollarSign, Bot, Mail, ChevronDown, Workflow, Megaphone, FileText, TrendingDown, Building2, LayoutDashboard, Home, BookOpen, Trophy, Link2, Inbox, History, Sparkles, Target, PenSquare } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import SalesChatWidget from './SalesChatWidget'
import ToastStack from './Toast'
import UploadDock from './UploadDock'
import { ToastProvider } from '../hooks/useToast'
import { UploadProvider } from '../hooks/useUploads'
import { startAutoSync, stopAutoSync } from '../services/autoSync'
import { ICON } from '../utils/constants'

// Archived nav: Pipeline + Call Data are routes that still work via direct
// URL but are hidden from the sidebar. Pipeline overlaps with Setters /
// Marketing data; Call Data hasn't been used as a primary surface in months.
// Keeping the routes registered in App.jsx so any deep links survive.
const navItems = [
  // ROM-first surfaces
  { to: '/hq', icon: Home, label: 'HQ' },
  { to: '/hq/wins', icon: Sparkles, label: 'Wins' },
  { to: '/hq/content', icon: PenSquare, label: 'Content' },
  { to: '/hq/strategy', icon: Target, label: 'Strategy' },
  { to: '/clients', icon: Building2, label: 'Clients' },
  { to: '/ceo', icon: LayoutDashboard, label: 'CEO' },

  // Sales-team surfaces (ROM admin-dashboard + OPT-era legacy)
  { to: '/sales', icon: BarChart3, label: 'Sales overview', end: true },
  { to: '/sales/closers', icon: UserCheck, label: 'Closers' },
  { to: '/sales/setters', icon: Users, label: 'Setters' },
  { to: '/sales/leaderboard', icon: Trophy, label: 'Leaderboard' },
  { to: '/sales/incoming', icon: Inbox, label: 'Incoming' },
  { to: '/sales/eod', icon: ClipboardCheck, label: 'EOD' },
  { to: '/sales/eod/backfill', icon: History, label: 'Backfill' },
  { to: '/sales/marketing', icon: TrendingUp, label: 'Marketing' },
  { to: '/sales/payment-links', icon: Link2, label: 'Payment links' },
  { to: '/sales/handbook', icon: BookOpen, label: 'Handbook' },
  { to: '/sales/commissions', icon: DollarSign, label: 'Commissions' },
  { to: '/sales/ads', icon: Megaphone, label: 'Ads' },
  { to: '/sales/contracts', icon: FileText, label: 'Contracts' },
  { to: '/sales/downsells', icon: TrendingDown, label: 'Downsells' },
  { to: '/sales/setter-bot', icon: Bot, label: 'Setter Bot' },
  { to: '/sales/email-flows', icon: Mail, label: 'Email Flows' },
  { to: '/sales/settings', icon: Settings, label: 'Settings' },
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

  // Pre-warm caches for slow pages (preserved verbatim)
  useEffect(() => {
    const timers = []
    timers.push(setTimeout(async () => {
      try {
        const { prewarmRecipientNameCache, loadEmailStats, loadFlowGroups, loadSubjectMeta } =
          await import('../services/ghlEmailFlows')
        const since = new Date(); since.setDate(since.getDate() - 30)
        const fromDate = since.toISOString().split('T')[0]
        const toDate = new Date().toISOString().split('T')[0]
        Promise.all([
          loadEmailStats(fromDate, toDate),
          loadFlowGroups(),
          loadSubjectMeta(),
        ]).catch(() => {})
        prewarmRecipientNameCache(30).catch(() => {})
      } catch (_e) { void _e }
    }, 5000))
    timers.push(setTimeout(async () => {
      try {
        const { fetchAllPipelineSummaries } = await import('../services/ghlPipeline')
        fetchAllPipelineSummaries().catch(() => {})
      } catch (_e) { void _e }
    }, 7000))
    timers.push(setTimeout(async () => {
      try {
        const [{ prewarmCloserEODs }, { prewarmSetterEODs }] = await Promise.all([
          import('../hooks/useCloserData'),
          import('../hooks/useSetterData'),
        ])
        Promise.all([
          prewarmCloserEODs(null, 30),
          prewarmSetterEODs(null, 30),
        ]).catch(() => {})
      } catch (_e) { void _e }
    }, 12000))
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
                  <div className="w-8 h-8 flex items-center justify-center">
                    <svg viewBox="0 0 512 512" width="28" height="28">
                      <path fill="#1F4D3C" d="M256 56c-66.3 0-120 53.7-120 120 0 24 7 46.4 19.2 65.2L256 388l100.8-146.8C369 222.4 376 200 376 176c0-66.3-53.7-120-120-120zm0 162c-23.2 0-42-18.8-42-42s18.8-42 42-42 42 18.8 42 42-18.8 42-42 42z"/>
                    </svg>
                  </div>
                  <div className="leading-tight">
                    <span className="eyebrow eyebrow-bare" style={{ fontSize: 9, color: '#1F4D3C' }}>Rank On Maps</span>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', marginTop: 2 }}>
                      HQ <em style={{ fontStyle: 'italic' }}>Dashboard</em>
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
                <span className="eyebrow" style={{ color: '#1F4D3C', fontWeight: 600 }}>Rank On Maps · HQ</span>
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
            <Outlet />
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
