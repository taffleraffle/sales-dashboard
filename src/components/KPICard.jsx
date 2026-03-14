import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { getColor } from '../utils/metricCalculations'

export default function KPICard({ label, value, subtitle, target, direction, trend, className = '' }) {
  const colorClass = target != null ? getColor(parseFloat(value), target, direction) : 'text-text-primary'

  return (
    <div className={`bg-bg-card border border-border-default rounded-lg p-4 ${className}`}>
      <p className="text-[11px] uppercase tracking-wider text-text-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorClass}`}>{value ?? '—'}</p>
      <div className="flex items-center gap-2 mt-1">
        {subtitle && <p className="text-xs text-text-secondary">{subtitle}</p>}
        {trend && (
          <span className={`flex items-center gap-0.5 text-xs ${
            trend.direction === 'up' ? 'text-success' : trend.direction === 'down' ? 'text-danger' : 'text-text-400'
          }`}>
            {trend.direction === 'up' && <TrendingUp size={12} />}
            {trend.direction === 'down' && <TrendingDown size={12} />}
            {trend.direction === 'flat' && <Minus size={12} />}
            {trend.pct}%
          </span>
        )}
      </div>
    </div>
  )
}
