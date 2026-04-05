import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Users, UserCheck, ClipboardCheck, Settings, TrendingUp, LogOut, User, Search, Bell, MoreHorizontal, X, Headphones, DollarSign, Bot, History } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import SalesChatWidget from './SalesChatWidget'

const navItems = [
  { to: '/sales', icon: BarChart3, label: 'Overview', end: true },
  { to: '/sales/closers', icon: UserCheck, label: 'Closers' },
  { to: '/sales/setters', icon: Users, label: 'Setters' },
  { to: '/sales/marketing', icon: TrendingUp, label: 'Marketing' },
  { to: '/sales/eod', icon: ClipboardCheck, label: 'EOD' },
  { to: '/sales/eod-history', icon: History, label: 'EOD History' },
  { to: '/sales/call-data', icon: Headphones, label: 'Call Data' },
  { to: '/sales/commissions', icon: DollarSign, label: 'Commissions' },
  { to: '/sales/setter-bot', icon: Bot, label: 'Setter Bot' },
  { to: '/sales/settings', icon: Settings, label: 'Settings' },
]

// Mobile: show these 4 in bottom bar, rest go under "More"
const mobileMainItems = navItems.slice(0, 4) // Overview, Closers, Setters, Marketing
const mobileMoreItems = navItems.slice(4)     // EOD, Settings

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)

  const roleLabel = isAdmin ? 'Admin' : profile?.role === 'closer' ? 'Closer' : profile?.role === 'setter' ? 'Setter' : 'Viewer'

  // Close "More" menu on outside tap
  useEffect(() => {
    if (!moreOpen) return
    const handler = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [moreOpen])

  return (
    <div className="min-h-screen bg-bg-primary flex">
      {/* ── Left Sidebar (desktop only) ── */}
      <aside className="hidden md:flex w-16 bg-bg-sidebar border-r border-border-default flex-col items-center py-5 fixed top-0 left-0 h-screen z-50">
        {/* Logo */}
        <div className="w-9 h-9 rounded-full bg-opt-yellow flex items-center justify-center mb-8">
          <BarChart3 size={18} className="text-bg-primary" />
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
                `group relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
                  isActive
                    ? 'bg-opt-yellow text-bg-primary shadow-[0_0_20px_rgba(212,245,12,0.15)]'
                    : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
                }`
              }
            >
              <Icon size={20} />
              {/* Tooltip */}
              <span className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-bg-card border border-border-default text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-lg">
                {label}
              </span>
            </NavLink>
          ))}
        </nav>

        {/* Bottom: Sign out */}
        <button
          onClick={signOut}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-text-400 hover:text-danger hover:bg-danger/10 transition-all"
          title="Sign out"
        >
          <LogOut size={18} />
        </button>
      </aside>

      {/* ── Mobile Bottom Nav ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-bg-sidebar/95 backdrop-blur-xl border-t border-border-default safe-bottom">
        <div className="flex items-center justify-around px-3 py-2">
          {mobileMainItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl transition-all min-w-[56px] ${
                  isActive
                    ? 'text-opt-yellow'
                    : 'text-text-400'
                }`
              }
            >
              <Icon size={22} />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </NavLink>
          ))}
          {/* More button */}
          <div className="relative" ref={moreRef}>
            <button
              onClick={() => setMoreOpen(v => !v)}
              className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl transition-all min-w-[56px] ${moreOpen ? 'text-opt-yellow' : 'text-text-400'}`}
            >
              {moreOpen ? <X size={22} /> : <MoreHorizontal size={22} />}
              <span className="text-[10px] font-medium leading-none">More</span>
            </button>
            {moreOpen && (
              <div className="absolute bottom-full mb-2 right-0 bg-bg-card border border-border-default rounded-2xl shadow-xl overflow-hidden min-w-[180px]">
                {mobileMoreItems.map(({ to, icon: Icon, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-4 py-3 transition-all min-h-[48px] ${
                        isActive
                          ? 'text-opt-yellow bg-opt-yellow-subtle'
                          : 'text-text-secondary hover:bg-bg-card-hover'
                      }`
                    }
                  >
                    <Icon size={20} />
                    <span className="text-sm font-medium">{label}</span>
                  </NavLink>
                ))}
                <button
                  onClick={() => { setMoreOpen(false); signOut() }}
                  className="flex items-center gap-3 px-4 py-3 w-full text-left text-danger hover:bg-danger/5 transition-all min-h-[48px] border-t border-border-default"
                >
                  <LogOut size={20} />
                  <span className="text-sm font-medium">Sign Out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ── Main Content ── */}
      <div className="flex-1 md:ml-16">
        {/* Top bar */}
        <header className="h-14 md:h-16 border-b border-border-default flex items-center justify-between px-4 md:px-8 sticky top-0 bg-bg-primary/80 backdrop-blur-xl z-40">
          {/* Logo (mobile only) */}
          <div className="md:hidden w-8 h-8 rounded-full bg-opt-yellow flex items-center justify-center shrink-0">
            <BarChart3 size={15} className="text-bg-primary" />
          </div>

          {/* Search — hidden on mobile (non-functional) */}
          <div className="hidden md:flex items-center gap-2 bg-bg-card border border-border-default rounded-xl px-4 py-2 w-48 md:w-72">
            <Search size={15} className="text-text-400" />
            <input
              type="text"
              placeholder="Search..."
              className="bg-transparent text-sm text-text-primary placeholder-text-400 outline-none w-full"
            />
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3 md:gap-4">
            {/* Notification bell */}
            <button className="w-9 h-9 rounded-xl bg-bg-card border border-border-default flex items-center justify-center text-text-400 hover:text-text-primary transition-colors">
              <Bell size={16} />
            </button>

            {/* User profile */}
            {profile && (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-opt-yellow/15 border border-opt-yellow/30 flex items-center justify-center">
                  <User size={15} className="text-opt-yellow" />
                </div>
                <div className="hidden md:block">
                  <p className="text-sm font-medium text-text-primary leading-tight">{profile.name}</p>
                  <p className="text-[11px] text-text-400">{roleLabel}</p>
                </div>
              </div>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="max-w-[1440px] mx-auto px-3 sm:px-4 md:px-8 py-4 md:py-6 pb-24 md:pb-6">
          <Outlet />
        </main>
      </div>

      {/* Sales Intelligence Chat */}
      <SalesChatWidget />
    </div>
  )
}
