import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Users, UserCheck, Target, TrendingUp, Settings } from 'lucide-react'

const navItems = [
  { to: '/sales', icon: BarChart3, label: 'Overview', end: true },
  { to: '/sales/marketing', icon: TrendingUp, label: 'Marketing' },
  { to: '/sales/closers', icon: UserCheck, label: 'Closers' },
  { to: '/sales/setters', icon: Users, label: 'Setters' },
  { to: '/sales/attribution', icon: Target, label: 'Attribution' },
  { to: '/sales/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Top nav bar */}
      <nav className="border-b border-border-default bg-bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-4 flex items-center h-14 gap-1">
          <span className="text-opt-yellow font-bold text-lg mr-6 tracking-tight">OPT SALES</span>
          {navItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                  isActive
                    ? 'bg-opt-yellow-muted text-opt-yellow'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-card-hover'
                }`
              }
            >
              <Icon size={16} />
              <span className="hidden sm:inline">{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Page content */}
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
