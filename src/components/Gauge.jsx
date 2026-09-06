import { getColor } from '../utils/metricCalculations'

/*
  House gauge tile: uppercase label, serif percentage, 8px pill progress bar.
  The bar colour is status only (green / amber / orange-red), never the accent.
*/

export default function Gauge({ label, value, target, direction = 'above', max = 100, delta, avgLabel, onClick, hint, suffix = '%' }) {
  const interactive = !!onClick
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = getColor(value, target, direction)
  const barColor =
    colorClass === 'text-success' ? 'var(--house-good)' :
    colorClass === 'text-warning' ? 'var(--house-warn)' :
    colorClass === 'text-danger'  ? 'var(--house-bad)' :
    'var(--ink)'

  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }) : undefined}
      title={hint}
      style={{
        background: '#ffffff',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--house-radius-tile)',
        boxShadow: 'var(--house-shadow-tile)',
        padding: '18px 20px',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color 160ms ease, transform 160ms ease',
      }}
      onMouseEnter={interactive ? (e) => { e.currentTarget.style.borderColor = 'var(--house-line-hover)'; e.currentTarget.style.transform = 'translateY(-1px)' } : undefined}
      onMouseLeave={interactive ? (e) => { e.currentTarget.style.borderColor = 'var(--rule)'; e.currentTarget.style.transform = 'none' } : undefined}
    >
      <span className="eyebrow" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {label}
        {interactive && <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: 'var(--ink-4)' }}>View calls</span>}
      </span>

      <div className="flex items-baseline gap-3 mt-3">
        <span
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 28,
            lineHeight: 1.1,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            fontFeatureSettings: '"tnum" 1',
            color: barColor,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value != null ? `${value}${suffix}` : '—'}
        </span>
        {delta != null && delta !== 0 && (
          <span className={`pill ${delta > 0 ? 'pill-up' : 'pill-down'}`}>
            <span className="arrow">{delta > 0 ? '↑' : '↓'}</span>
            {Math.abs(delta)}%
          </span>
        )}
      </div>

      <div className="heatbar mt-4">
        <span style={{ width: `${pct}%`, background: barColor }} />
      </div>

      {(avgLabel != null || target != null) && (
        <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink-4)', margin: '10px 0 0' }}>
          {avgLabel != null ? `Average ${avgLabel}${suffix}` : `Target ${target}${suffix}`}
        </p>
      )}
    </div>
  )
}
