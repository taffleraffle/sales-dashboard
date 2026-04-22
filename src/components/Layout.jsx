import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Users, UserCheck, ClipboardCheck, Settings, TrendingUp, LogOut, Menu, X, Headphones, DollarSign, Bot, Mail, ChevronDown, Workflow } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import SalesChatWidget from './SalesChatWidget'
import ToastStack from './Toast'
import { ToastProvider } from '../hooks/useToast'
import { startAutoSync, stopAutoSync } from '../services/autoSync'
import { ICON } from '../utils/constants'

const navItems = [
  { to: '/sales', icon: BarChart3, label: 'Overview', end: true },
  { to: '/sales/closers', icon: UserCheck, label: 'Closers' },
  { to: '/sales/setters', icon: Users, label: 'Setters' },
  { to: '/sales/pipeline', icon: Workflow, label: 'Pipeline' },
  { to: '/sales/marketing', icon: TrendingUp, label: 'Marketing' },
  { to: '/sales/eod', icon: ClipboardCheck, label: 'EOD' },
  { to: '/sales/call-data', icon: Headphones, label: 'Call Data' },
  { to: '/sales/commissions', icon: DollarSign, label: 'Commissions' },
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

  // Outside-click dismiss for the profile dropdown. The drawer has its own
  // backdrop layer, so clicking outside of it already closes it via backdrop onClick.
  useEffect(() => {
    if (!profileOpen) return
    const handler = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [profileOpen])

  // Escape closes the drawer (accessibility)
  useEffect(() => {
    if (!drawerOpen) return
    const handler = (e) => { if (e.key === 'Escape') setDrawerOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [drawerOpen])

  // Lock body scroll while the drawer is open so the page underneath
  // doesn't scroll when the user swipes inside the drawer.
  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [drawerOpen])

  // Background auto-sync. Deferred 3s after mount so the first paint / first
  // page render isn't competing with 6 sync network calls (the previous
  // contention was the biggest trigger of GHL 429 rate-limit errors).
  useEffect(() => {
    const timer = setTimeout(() => startAutoSync(), 3000)
    return () => {
      clearTimeout(timer)
      stopAutoSync()
    }
  }, [])

  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg-primary flex">
        {/* ── Left Sidebar (desktop only) ── */}
        <aside className="hidden md:flex w-16 bg-bg-sidebar border-r border-border-default flex-col items-center py-5 fixed top-0 left-0 h-screen z-50">
          {/* Logo */}
          <div className="w-9 h-9 rounded-full bg-opt-yellow flex items-center justify-center mb-8">
            <BarChart3 size={ICON.xl} className="text-bg-primary" />
          </div>

          {/* Nav Icons */}
          <nav className="flex flex-col items-center gap-2 flex-1">
            {navItems.map(({ to, icon: Icon, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  `group relative w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-200 ${
                    isActive
                      ? 'bg-opt-yellow text-bg-primary shadow-[0_0_20px_rgba(212,245,12,0.15)]'
                      : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
                  }`
                }
              >
                <Icon size={ICON.xl} />
                <span className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-bg-card border border-border-default text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-lg">
                  {label}
                </span>
              </NavLink>
            ))}
          </nav>

          {/* Bottom: Sign out */}
          <button
            onClick={signOut}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-400 hover:text-danger hover:bg-danger/10 transition-all"
            title="Sign out"
          >
            <LogOut size={ICON.lg} />
          </button>
        </aside>

        {/* ── Mobile Drawer (hamburger menu) ── */}
        {drawerOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 z-[99] bg-black/50 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside
              className="md:hidden fixed top-0 left-0 h-full z-[100] w-72 max-w-[82vw] bg-bg-sidebar border-r border-border-default shadow-2xl flex flex-col slide-in-right"
              role="dialog"
              aria-label="Navigation menu"
            >
              {/* Drawer header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-opt-yellow flex items-center justify-center">
                    <BarChart3 size={15} className="text-bg-primary" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Sales Dashboard</span>
                </div>
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all"
                  aria-label="Close menu"
                >
                  <X size={ICON.lg} />
                </button>
              </div>

              {/* Nav items — all of them */}
              <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
                {navItems.map(({ to, icon: Icon, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={() => setDrawerOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-3 rounded-xl transition-all min-h-[48px] ${
                        isActive
                          ? 'bg-opt-yellow-subtle text-opt-yellow'
                          : 'text-text-secondary hover:bg-bg-card-hover'
                      }`
                    }
                  >
                    <Icon size={ICON.xl} className="shrink-0" />
                    <span className="text-sm font-medium">{label}</span>
                  </NavLink>
                ))}
              </nav>

              {/* Drawer footer — sign out */}
              <div className="border-t border-border-default p-2">
                <button
                  onClick={() => { setDrawerOpen(false); signOut() }}
                  className="flex items-center gap-3 px-3 py-3 w-full text-left rounded-xl text-danger hover:bg-danger/5 transition-all min-h-[48px]"
                >
                  <LogOut size={ICON.xl} />
                  <span className="text-sm font-medium">Sign Out</span>
                </button>
              </div>
            </aside>
          </>
        )}

        {/* ── Main Content ── */}
        <div className="flex-1 md:ml-16 min-w-0">
          {/* Top bar */}
          <header className="h-14 md:h-16 border-b border-border-default flex items-center justify-between px-3 sm:px-4 md:px-8 sticky top-0 bg-bg-primary/80 backdrop-blur-xl z-40">
            {/* Left slot */}
            <div className="flex items-center gap-2">
              {/* Mobile hamburger */}
              <button
                onClick={() => setDrawerOpen(true)}
                aria-expanded={drawerOpen}
                aria-label="Open navigation menu"
                className="md:hidden w-11 h-11 rounded-xl flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-colors"
              >
                <Menu size={ICON.xl} />
              </button>
              {/* Mobile logo (next to hamburger) */}
              <div className="md:hidden w-8 h-8 rounded-full bg-opt-yellow flex items-center justify-center shrink-0">
                <BarChart3 size={15} className="text-bg-primary" />
              </div>
            </div>

            {/* Right side — profile only */}
            <div className="flex items-center gap-3 md:gap-4">
              {profile && (
                <div className="relative" ref={profileRef}>
                  <button
                    onClick={() => setProfileOpen(v => !v)}
                    aria-expanded={profileOpen}
                    aria-haspopup="menu"
                    aria-label="Open profile menu"
                    className="flex items-center gap-2 md:gap-3 min-h-[44px] px-1.5 md:pl-1.5 md:pr-3 rounded-xl hover:bg-bg-card-hover transition-colors"
                  >
                    <div className="w-11 h-11 rounded-full bg-opt-yellow/15 border border-opt-yellow/30 flex items-center justify-center text-[13px] font-semibold text-opt-yellow">
                      {initialsOf(profile.name)}
                    </div>
                    <div className="hidden md:block text-left">
                      <p className="text-sm font-medium text-text-primary leading-tight">{profile.name}</p>
                      <p className="text-[11px] text-text-400">{roleLabel}</p>
                    </div>
                    <ChevronDown size={ICON.sm} className={`hidden md:block text-text-400 transition-transform ${profileOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {profileOpen && (
                    <div className="absolute top-full right-0 mt-2 dropdown-panel min-w-[240px]">
                      <div className="px-4 py-3 border-b border-border-default">
                        <p className="text-sm font-semibold text-text-primary">{profile.name}</p>
                        <p className="text-[11px] text-text-400">{profile.email}</p>
                        <p className="text-[11px] text-opt-yellow mt-0.5">{roleLabel}</p>
                      </div>
                      {isAdmin && (
                        <NavLink
                          to="/sales/settings"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-4 py-3 text-sm text-text-secondary hover:bg-bg-card-hover transition-all min-h-[48px]"
                        >
                          <Settings size={ICON.md} />
                          <span>Settings</span>
                        </NavLink>
                      )}
                      <button
                        onClick={() => { setProfileOpen(false); signOut() }}
                        className="flex items-center gap-3 px-4 py-3 w-full text-left text-sm text-danger hover:bg-danger/5 transition-all min-h-[48px] border-t border-border-default"
                      >
                        <LogOut size={ICON.md} />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </header>

          {/* Page content — full-width, no bottom-nav reservation anymore */}
          <main className="w-full px-3 sm:px-4 md:px-8 py-4 md:py-6 pb-6">
            <Outlet />
          </main>
        </div>

        {/* Toast stack — globally mounted */}
        <ToastStack />

        {/* Sales Intelligence Chat */}
        <SalesChatWidget />
      </div>
    </ToastProvider>
  )
}
