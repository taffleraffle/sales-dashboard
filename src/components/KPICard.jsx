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
  if (trend.label) return <span className={`pill ${cls}`} title={trend.title} style={{ whiteSpace: 'nowrap' }}>{trend.label}</span>
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
  targetLabel,
  score,
  title,
}) {
  // Numeric value for the target test: strip $, commas, %, x. A dash means
  // "no data" and gets no status at all.
  // `score` is an explicit number to test against the target (e.g. seconds
  // behind a "20h" display); otherwise the display value is parsed.
  const numeric = score != null ? score : typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/[$,%x\s]/g, ''))
  const hasNumber = Number.isFinite(numeric) && String(value ?? '').trim() !== '—'
  const colorClass = target != null && hasNumber ? getColor(numeric, target, direction) : null
  const valueColor =
    colorClass === 'text-success' ? 'var(--house-good)' :
    colorClass === 'text-warning' ? 'var(--house-warn)' :
    colorClass === 'text-danger'  ? 'var(--house-bad)' :
    'var(--ink)'
  const status = colorClass === 'text-success' ? { label: 'On target', color: 'var(--house-good)', border: 'rgba(22,163,74,.35)', bg: 'rgba(22,163,74,.06)' }
    : colorClass === 'text-warning' ? { label: 'Near target', color: 'var(--house-warn)', border: 'rgba(184,134,11,.35)', bg: 'rgba(184,134,11,.06)' }
    : colorClass === 'text-danger' ? { label: 'Below target', color: 'var(--house-bad)', border: 'rgba(224,86,30,.35)', bg: 'rgba(224,86,30,.06)' }
    : null
  const targetText = target != null ? (targetLabel || `Target ${direction === 'below' ? 'under ' : ''}${typeof target === 'number' && String(value ?? '').trim().startsWith('$') ? '$' + target.toLocaleString() : target}${String(value ?? '').trim().endsWith('%') ? '%' : String(value ?? '').trim().endsWith('x') ? 'x' : ''}`) : null

  const interactive = !!onClick

  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }) : undefined}
      className={`relative editorial-kpi-card ${className}`}
      title={title}
      style={{
        background: highlight ? 'rgba(244,225,74,.10)' : '#ffffff',
        border: `1px solid ${highlight ? 'var(--accent)' : 'var(--rule)'}`,
        borderRadius: 'var(--house-radius-tile)',
        boxShadow: highlight ? '0 20px 44px -30px rgba(244,197,24,.55)' : 'var(--house-shadow-tile)',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'visible',
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
          fontFamily: 'var(--sans)',
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum" 1',
          fontSize: 'clamp(22px, 2.2vw, 30px)',
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          padding: '2px 0 1px',
          fontWeight: 600,
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

      {(subtitle || trend || status || targetText) && (
        <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap" style={{ color: 'var(--ink-4)', fontSize: 12.5, fontWeight: 500 }}>
          <span style={{ minWidth: 0 }}>
            {subtitle && <span>{subtitle}</span>}
            {subtitle && targetText && <span> · </span>}
            {targetText && <span>{targetText}</span>}
          </span>
          {status && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, color: status.color, border: `1px solid ${status.border}`, background: status.bg, whiteSpace: 'nowrap' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: status.color }} />{status.label}
            </span>
          )}
          {trendPill(trend)}
        </div>
      )}
    </div>
  )
}
