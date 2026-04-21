import { TrendingUp, TrendingDown, Minus, ArrowUpRight } from 'lucide-react'
import { getColor } from '../utils/metricCalculations'
import { ICON } from '../utils/constants'

export default function KPICard({ label, value, subtitle, target, direction, trend, className = '', highlight = false, onClick }) {
  const colorClass = target != null ? getColor(parseFloat(value), target, direction) : 'text-text-primary'
  const hoverClass = onClick ? 'tile-hover' : 'tile-feedback'

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }) : undefined}
      className={`tile ${hoverClass} relative p-3 sm:p-5 ${highlight ? 'border-opt-yellow/40 bg-opt-yellow-subtle' : ''} ${className}`}
    >
      {/* Arrow link icon */}
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4">
        <ArrowUpRight size={ICON.md} className={highlight ? 'text-opt-yellow' : 'text-text-400/50'} />
      </div>

      <p className="text-[10px] sm:text-[11px] uppercase tracking-wider text-text-400 mb-1 sm:mb-2 font-medium pr-5">{label}</p>
      <p className={`text-lg sm:text-2xl font-bold tracking-tight ${colorClass}`}>{value ?? '—'}</p>
      <div className="flex items-center gap-2 mt-1.5">
        {subtitle && <p className="text-xs text-text-secondary">{subtitle}</p>}
        {trend && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${
            trend.direction === 'up' ? 'text-success' : trend.direction === 'down' ? 'text-danger' : 'text-text-400'
          }`}>
            {trend.direction === 'up' && <TrendingUp size={ICON.sm} />}
            {trend.direction === 'down' && <TrendingDown size={ICON.sm} />}
            {trend.direction === 'flat' && <Minus size={ICON.sm} />}
            {trend.pct}%
          </span>
        )}
      </div>
    </div>
  )
}
