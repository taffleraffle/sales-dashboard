import { NavLink, Outlet } from 'react-router-dom'
import { TrendingUp, Type, FlaskConical, AlertCircle, Archive } from 'lucide-react'

const PRIMARY = [
  { to: '/sales/ads/performance', label: 'Performance',      icon: TrendingUp },
  { to: '/sales/ads/messaging',   label: 'Messaging',        icon: Type },
  { to: '/sales/ads/creative',    label: 'Creative testing', icon: FlaskConical },
]

const SECONDARY = [
  { to: '/sales/ads/orphans',  label: 'Orphans',  icon: AlertCircle },
  { to: '/sales/ads/legacy',   label: 'Legacy',   icon: Archive },
]

const primaryTab = (isActive) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
  color: isActive ? 'var(--ink)' : 'var(--ink-3)',
  transition: 'color 160ms ease, border-color 160ms ease',
})

const secondaryTab = (isActive) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 8px',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 2,
  background: isActive ? 'var(--accent-soft)' : 'transparent',
  color: isActive ? 'var(--ink)' : 'var(--ink-3)',
  border: `1px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
})

export default function AdsLayout() {
  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Header — editorial */}
      <div className="mb-6 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Sales · Creative library</span>
        <h1 className="h2 mt-2">The <em>creative</em> shelf.</h1>
        <p
          className="mt-2"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}
        >
          Meta ads · components · variants · attribution
        </p>
      </div>

      {/* Tab bar */}
      <div
        className="mb-6 sticky top-14 md:top-16 z-10"
        style={{
          background: 'rgba(251,250,246,0.94)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex overflow-x-auto">
            {PRIMARY.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} style={({ isActive }) => primaryTab(isActive)}>
                <Icon size={12} /> {label}
              </NavLink>
            ))}
          </div>
          <div className="flex gap-1 pb-2">
            {SECONDARY.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} style={({ isActive }) => secondaryTab(isActive)}>
                <Icon size={10} /> {label}
              </NavLink>
            ))}
          </div>
        </div>
      </div>

      <Outlet />
    </div>
  )
}
