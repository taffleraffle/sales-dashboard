import { NavLink, Outlet } from 'react-router-dom'
import { Scissors, GitBranch, Megaphone, BarChart3, Sparkles } from 'lucide-react'

/*
  Creative testing wrapper. Hosts the three production-related views as
  sub-tabs under one primary tab: Clips · Variants · Ads.

  Previously these were 7 separate PRIMARY tabs (Clips + Variants + Ads +
  Hooks + Bodies + Scenes + Creators) which crowded the nav and split the
  workflow across pages. The canonical-type pages (Hooks/Bodies/Scenes/
  Creators) are retired — Clips covers that granular tracking now.
*/

const SUBNAV = [
  { to: '/sales/ads/creative/clips',    label: 'Clips',    icon: Scissors,   sub: 'Atomic clip files + production stages' },
  { to: '/sales/ads/creative/variants', label: 'Variants', icon: GitBranch,  sub: 'Spliced combinations + matrix splicer' },
  { to: '/sales/ads/creative/ads',      label: 'Ads',      icon: Megaphone,  sub: 'Live Meta ads + variant linkage' },
  { to: '/sales/ads/creative/insights', label: 'Insights', icon: BarChart3,  sub: 'Performance pivots by test variable' },
  { to: '/sales/ads/creative/generate', label: 'Generate', icon: Sparkles,   sub: 'LLM-generated scripts for any offer' },
]

export default function AdsCreativeTestingLayout() {
  return (
    <div>
      {/* Sub-nav */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 24,
          borderBottom: '1px solid var(--rule)',
        }}
      >
        {SUBNAV.map(t => {
          const Icon = t.icon
          return (
            <NavLink
              key={t.to}
              to={t.to}
              style={({ isActive }) => ({
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 18px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                fontWeight: 500,
                color: isActive ? 'var(--ink)' : 'var(--ink-3)',
                background: 'transparent',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
                textDecoration: 'none',
                transition: 'color 160ms ease, border-color 160ms ease',
              })}
            >
              <Icon size={13} />
              <span>{t.label}</span>
              <span
                style={{
                  fontFamily: 'var(--serif)',
                  fontSize: 11,
                  fontStyle: 'italic',
                  letterSpacing: 0,
                  textTransform: 'none',
                  color: 'var(--ink-4)',
                  fontWeight: 400,
                  marginLeft: 6,
                }}
              >
                {t.sub}
              </span>
            </NavLink>
          )
        })}
      </div>

      <Outlet />
    </div>
  )
}
