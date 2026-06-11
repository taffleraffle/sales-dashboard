import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { TrendingUp, FlaskConical, AlertCircle, Archive, MoreHorizontal } from 'lucide-react'

// Messaging hidden 2026-06-11 — Ben wants it rebuilt before it's shown
// again (route still resolves at /sales/ads/messaging for direct access).
const PRIMARY = [
  { to: '/sales/ads/performance', label: 'Performance',      icon: TrendingUp },
  { to: '/sales/ads/creative',    label: 'Creative testing', icon: FlaskConical },
]

// Maintenance surfaces, not daily destinations — tucked behind the ⋯
// menu so the tab bar stays three items (Ben 2026-06-10 de-clutter).
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
  const [moreOpen, setMoreOpen] = useState(false)
  const location = useLocation()
  // Keep the ⋯ trigger visibly active while ON a tucked-away page so the
  // operator can tell where they are even though the tab itself is hidden.
  const onSecondary = SECONDARY.some(s => location.pathname.startsWith(s.to))

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Tab bar — the only chrome the user needs at this layer.
          Per-page SectionHead provides the page identity. */}
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
          <div className="pb-2" style={{ position: 'relative' }}>
            <button type="button" aria-label="More ads pages"
              onClick={() => setMoreOpen(v => !v)}
              style={{ ...secondaryTab(onSecondary), cursor: 'pointer', background: onSecondary ? 'var(--accent-soft)' : 'transparent' }}>
              <MoreHorizontal size={12} />
            </button>
            {moreOpen && (
              <>
                {/* click-outside catcher */}
                <div onClick={() => setMoreOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 55 }} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 60,
                  background: 'white', border: '1px solid var(--rule)',
                  boxShadow: '0 8px 24px rgba(10,10,10,0.12)',
                  display: 'grid', minWidth: 140,
                }}>
                  {SECONDARY.map(({ to, label, icon: Icon }) => (
                    <NavLink key={to} to={to} onClick={() => setMoreOpen(false)}
                      style={({ isActive }) => ({
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '9px 12px',
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        color: isActive ? 'var(--ink)' : 'var(--ink-2)',
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        textDecoration: 'none',
                      })}>
                      <Icon size={11} /> {label}
                    </NavLink>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Outlet />
    </div>
  )
}
