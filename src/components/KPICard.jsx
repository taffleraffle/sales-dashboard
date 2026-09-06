import { ArrowUpRight } from 'lucide-react'
import { getColor } from '../utils/metricCalculations'
import { ICON } from '../utils/constants'

/*
  House KPI tile (OPT-UI-STYLE-GUIDE .kpi): 18px radius white tile, uppercase
  letter-spaced label, big serif tabular number, one muted note underneath.
  `highlight` is the .kpi.hi variant: yellow border + soft yellow wash.
*/

function trendPill(trend) {
  if (!trend) return null
  const dir = trend.direction
  const cls = dir === 'up' ? 'pill-up' : dir === 'down' ? 'pill-down' : 'pill-flat'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·'
  return (
    <span className={`pill ${cls}`}>
      <span className="arrow">{arrow}</span>
      {trend.pct}%
    </span>
  )
}

export default function KPICard({
  label,
  value,
  subtitle,
  target,
  direction,
  trend,
  className = '',
  highlight = false,
  onClick,
}) {
  const colorClass = target != null ? getColor(parseFloat(value), target, direction) : null
  const valueColor =
    colorClass === 'text-success' ? 'var(--house-good)' :
    colorClass === 'text-warning' ? 'var(--house-warn)' :
    colorClass === 'text-danger'  ? 'var(--house-bad)' :
    'var(--ink)'

  const interactive = !!onClick

  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }) : undefined}
      className={`relative editorial-kpi-card ${className}`}
      style={{
        background: highlight ? 'rgba(244,225,74,.10)' : '#ffffff',
        border: `1px solid ${highlight ? 'var(--accent)' : 'var(--rule)'}`,
        borderRadius: 'var(--house-radius-tile)',
        boxShadow: highlight ? '0 20px 44px -30px rgba(244,197,24,.55)' : 'var(--house-shadow-tile)',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        if (interactive) { e.currentTarget.style.borderColor = 'var(--house-line-hover)'; e.currentTarget.style.transform = 'translateY(-1px)' }
      }}
      onMouseLeave={(e) => {
        if (interactive) { e.currentTarget.style.borderColor = highlight ? 'var(--accent)' : 'var(--rule)'; e.currentTarget.style.transform = 'none' }
      }}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span
          className="eyebrow"
          style={{ fontSize: 11, minWidth: 0, flex: '1 1 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
          title={label}
        >
          {label}
        </span>
        {interactive && (
          <ArrowUpRight size={ICON.sm} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
        )}
      </div>

      <div
        className="mt-2"
        style={{
          fontFamily: 'var(--serif)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 'clamp(24px, 2.8vw, 34px)',
          lineHeight: 1,
          fontWeight: 500,
          color: valueColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
        title={String(value ?? '')}
      >
        {value ?? '—'}
      </div>

      {(subtitle || trend) && (
        <div className="mt-auto pt-3 flex items-center gap-2 flex-wrap" style={{ color: 'var(--ink-4)', fontSize: 12.5, fontWeight: 500 }}>
          {subtitle && <span>{subtitle}</span>}
          {trendPill(trend)}
        </div>
      )}
    </div>
  )
}
