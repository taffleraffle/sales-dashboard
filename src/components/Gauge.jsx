import { getColor } from '../utils/metricCalculations'

/*
  House gauge tile: uppercase label, serif percentage, 8px pill progress bar.
  The bar colour is status only (green / amber / orange-red), never the accent.
*/

export default function Gauge({ label, value, target, direction = 'above', max = 100, delta, avgLabel }) {
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = getColor(value, target, direction)
  const barColor =
    colorClass === 'text-success' ? 'var(--house-good)' :
    colorClass === 'text-warning' ? 'var(--house-warn)' :
    colorClass === 'text-danger'  ? 'var(--house-bad)' :
    'var(--ink)'

  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--house-radius-tile)',
        boxShadow: 'var(--house-shadow-tile)',
        padding: '18px 20px',
      }}
    >
      <span className="eyebrow" style={{ fontSize: 11, display: 'block' }}>{label}</span>

      <div className="flex items-baseline gap-3 mt-3">
        <span
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 32,
            lineHeight: 1,
            fontWeight: 500,
            color: barColor,
            fontVariantNumeric: 'tabular-nums',
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

      <div className="heatbar mt-4">
        <span style={{ width: `${pct}%`, background: barColor }} />
      </div>

      {(avgLabel != null || target != null) && (
        <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink-4)', margin: '10px 0 0' }}>
          {avgLabel != null ? `Average ${avgLabel}%` : `Target ${target}%`}
        </p>
      )}
    </div>
  )
}
