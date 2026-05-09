import { NavLink, Outlet } from 'react-router-dom'
import { Megaphone, Sparkles, MessageSquare, Camera, Users, AlertCircle, Archive, GitBranch } from 'lucide-react'

const PRIMARY = [
  { to: '/sales/ads/list',     label: 'Ads',      icon: Megaphone },
  { to: '/sales/ads/hooks',    label: 'Hooks',    icon: Sparkles },
  { to: '/sales/ads/bodies',   label: 'Bodies',   icon: MessageSquare },
  { to: '/sales/ads/scenes',   label: 'Scenes',   icon: Camera },
  { to: '/sales/ads/creators', label: 'Creators', icon: Users },
]

const SECONDARY = [
  { to: '/sales/ads/variants', label: 'Variants', icon: GitBranch },
  { to: '/sales/ads/orphans',  label: 'Orphans',  icon: AlertCircle },
  { to: '/sales/ads/legacy',   label: 'Legacy',   icon: Archive },
]

function tabClass(isActive, primary = true) {
  if (primary) {
    return `flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
      isActive
        ? 'border-opt-yellow text-opt-yellow'
        : 'border-transparent text-text-secondary hover:text-text-primary'
    }`
  }
  return `flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg transition-colors whitespace-nowrap ${
    isActive
      ? 'bg-opt-yellow/15 text-opt-yellow'
      : 'text-text-400 hover:text-text-secondary hover:bg-bg-card-hover'
  }`
}

export default function AdsLayout() {
  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="mb-4">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Creative Library</h1>
        <p className="text-xs text-text-400">Meta ads · components · variants · attribution</p>
      </div>

      {/* Tab bar */}
      <div className="border-b border-border-default mb-4 sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex overflow-x-auto -mx-1 px-1">
            {PRIMARY.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={({ isActive }) => tabClass(isActive, true)}>
                <Icon size={13} /> {label}
              </NavLink>
            ))}
          </div>
          <div className="flex gap-1 pb-1.5">
            {SECONDARY.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={({ isActive }) => tabClass(isActive, false)}>
                <Icon size={11} /> {label}
              </NavLink>
            ))}
          </div>
        </div>
      </div>

      <Outlet />
    </div>
  )
}
