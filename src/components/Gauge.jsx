import { getColor } from '../utils/metricCalculations'

export default function Gauge({ label, value, target, direction = 'above', max = 100, delta, avgLabel }) {
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = getColor(value, target, direction)
  const barColor = colorClass.includes('success') ? '#d4f50c' : colorClass.includes('warning') ? '#f59e0b' : colorClass.includes('danger') ? '#ef4444' : '#606060'

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl p-3 sm:p-5">
      <p className="text-[10px] sm:text-[11px] uppercase tracking-wider text-text-400 mb-2 sm:mb-3 font-medium">{label}</p>
      <div className="flex items-end gap-2 mb-2 sm:mb-3">
        <p className={`text-base sm:text-xl font-bold ${colorClass}`}>{value != null ? `${value}%` : '—'}</p>
        {delta != null && delta !== 0 && (
          <span className={`text-xs font-medium ${delta > 0 ? 'text-success' : 'text-danger'}`}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="w-full h-1.5 bg-bg-primary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      {avgLabel != null ? (
        <p className="text-[10px] text-text-400 mt-2">Avg: {avgLabel}%</p>
      ) : target != null ? (
        <p className="text-[10px] text-text-400 mt-2">Target: {target}%</p>
      ) : null}
    </div>
  )
}
