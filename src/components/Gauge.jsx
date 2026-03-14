import { getColor } from '../utils/metricCalculations'

export default function Gauge({ label, value, target, direction = 'above', max = 100 }) {
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = getColor(value, target, direction)
  const barColor = colorClass.includes('success') ? '#22c55e' : colorClass.includes('warning') ? '#f59e0b' : colorClass.includes('danger') ? '#ef4444' : '#64748b'

  return (
    <div className="bg-bg-card border border-border-default rounded-lg p-4">
      <p className="text-[11px] uppercase tracking-wider text-text-400 mb-2">{label}</p>
      <p className={`text-xl font-bold mb-2 ${colorClass}`}>{value != null ? `${value}%` : '—'}</p>
      <div className="w-full h-2 bg-bg-primary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      {target != null && (
        <p className="text-[10px] text-text-400 mt-1">Target: {target}%</p>
      )}
    </div>
  )
}
