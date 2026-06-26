import { getColor } from '../utils/metricCalculations'

/*
  Editorial gauge: eyebrow label + serif percentage + heatbar strip.
  Bar fill colour follows the metric's directional health (up/warning/down).
*/

export default function Gauge({ label, value, target, direction = 'above', max = 100, delta, avgLabel }) {
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = getColor(value, target, direction)
  const barColor =
    colorClass === 'text-success' ? 'var(--up)' :
    colorClass === 'text-warning' ? '#b88200' :
    colorClass === 'text-danger'  ? 'var(--down)' :
    'var(--ink)'
  const valueColor = barColor

  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 10,
        padding: '16px 18px',
      }}
    >
      <span className="eyebrow" style={{ fontSize: 9, marginBottom: 12, display: 'inline-flex' }}>{label}</span>

      <div className="flex items-baseline gap-3 mt-3">
        <span
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 28,
            lineHeight: 1,
            color: valueColor,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
          }}
        >
          {value != null ? `${value}%` : '—'}
        </span>
        {delta != null && delta !== 0 && (
          <span className={`pill ${delta > 0 ? 'pill-up' : 'pill-down'}`}>
            <span className="arrow">{delta > 0 ? '↑' : '↓'}</span>
            {Math.abs(delta)}%
          </span>
        )}
      </div>

      <div className="heatbar mt-3">
        <span style={{ width: `${pct}%`, background: barColor }} />
      </div>

      {(avgLabel != null || target != null) && (
        <p
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            margin: '10px 0 0',
          }}
        >
          {avgLabel != null ? `Avg · ${avgLabel}%` : `Target · ${target}%`}
        </p>
      )}
    </div>
  )
}
