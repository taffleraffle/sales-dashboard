import { ArrowUpRight } from 'lucide-react'
import { getColor } from '../utils/metricCalculations'
import { ICON } from '../utils/constants'

/*
  Editorial scorecard cell.
  Convention: mono small-caps label (with dash) → big serif tabular number
  → optional subtitle and trend pill at the foot.
*/

function trendPill(trend) {
  if (!trend) return null
  const dir = trend.direction
  const cls = dir === 'up' ? 'pill-up' : dir === 'down' ? 'pill-down' : 'pill-flat'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '—'
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
    colorClass === 'text-success' ? 'var(--up)' :
    colorClass === 'text-warning' ? 'var(--warning, #b88200)' :
    colorClass === 'text-danger'  ? 'var(--down)' :
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
        background: highlight ? 'var(--accent-soft)' : 'var(--paper)',
        border: `1px solid ${highlight ? 'var(--accent)' : 'var(--rule)'}`,
        borderRadius: 4,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color 200ms ease, background 200ms ease',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        if (interactive) e.currentTarget.style.borderColor = 'var(--ink-3)'
      }}
      onMouseLeave={(e) => {
        if (interactive) e.currentTarget.style.borderColor = highlight ? 'var(--accent)' : 'var(--rule)'
      }}
    >
      {/* Top: eyebrow + arrow */}
      <div className="flex items-start justify-between gap-1.5">
        <span
          className="eyebrow"
          style={{
            fontSize: 9,
            letterSpacing: '0.12em',
            minWidth: 0,
            flex: '1 1 0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={label}
        >
          {label}
        </span>
        {interactive && (
          <ArrowUpRight
            size={ICON.sm}
            style={{ color: highlight ? 'var(--ink)' : 'var(--ink-4)', flexShrink: 0 }}
          />
        )}
      </div>

      {/* Big editorial number — clamped + truncated to never spill */}
      <div
        className="mt-2"
        style={{
          fontFamily: 'var(--serif)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 'clamp(20px, 2.8vw, 28px)',
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          color: valueColor,
          fontWeight: 400,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
        title={String(value ?? '')}
      >
        {value ?? '—'}
      </div>

      {/* Foot: subtitle + trend */}
      {(subtitle || trend) && (
        <div
          className="mt-auto pt-3 flex items-center gap-2 flex-wrap"
          style={{ color: 'var(--ink-3)', fontSize: 11 }}
        >
          {subtitle && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {subtitle}
            </span>
          )}
          {trendPill(trend)}
        </div>
      )}
    </div>
  )
}
