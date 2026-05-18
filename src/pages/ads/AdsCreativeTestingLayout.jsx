import { NavLink, Outlet } from 'react-router-dom'

/*
  Creative testing sub-nav. Restructured per the dj282R9iMtYwNPnoqDHDRw
  design handoff: Insights / Creatives / Attributes / Explorations are now
  their own pages instead of in-page tabs, so each gets a top-level entry.

  Order: Clips · Variants · Ads · Insights · Creatives · Attributes ·
  Explorations · Generate
*/

const SUBNAV = [
  { to: '/sales/ads/creative/clips',        label: 'Clips' },
  { to: '/sales/ads/creative/variants',     label: 'Variants' },
  { to: '/sales/ads/creative/ads',          label: 'Ads' },
  { to: '/sales/ads/creative/insights',     label: 'Insights' },
  { to: '/sales/ads/creative/creatives',    label: 'Creatives' },
  { to: '/sales/ads/creative/attributes',   label: 'Attributes' },
  { to: '/sales/ads/creative/explorations', label: 'Explorations' },
  { to: '/sales/ads/creative/generate',     label: 'Generate' },
]

export default function AdsCreativeTestingLayout() {
  return (
    <div>
      {/* Sub-nav — sans-serif, numbered, accent underline on active (per design) */}
      <div style={{
        display: 'flex', gap: 0, marginBottom: 28,
        borderBottom: '1px solid var(--rule)',
      }}>
        {SUBNAV.map((t, i) => (
          <NavLink
            key={t.to}
            to={t.to}
            style={({ isActive }) => ({
              padding: '10px 14px 11px',
              fontFamily: 'var(--sans)',
              fontSize: 13, fontWeight: 500, letterSpacing: '-0.005em',
              color: isActive ? 'var(--ink)' : 'var(--ink-4)',
              background: 'transparent',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              textTransform: 'capitalize',
              transition: 'color 160ms ease, border-color 160ms ease',
            })}
          >
            <span style={{
              fontFamily: 'var(--mono)', opacity: 0.5,
              fontSize: 10, fontWeight: 400,
            }}>{String(i + 1).padStart(2, '0')}</span>
            <span>{t.label}</span>
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  )
}
