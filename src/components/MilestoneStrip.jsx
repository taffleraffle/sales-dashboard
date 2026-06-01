import { ink, ink2, ink3, accent, pos, hair, fmt$, fmtPct } from './ui'

// Cash collected → commission progress strip. Shows TWO things:
//  1. Cash collected this month (denominator $100K, the production target)
//  2. Commission earned at current pace (10% for closer / 5% for setter — capped at full goal payout)
//
// Milestones at 25 / 50 / 75 / 100% of $100K = commission of $2.5K/$5K/$7.5K/$10K (closer) or $1.25K/$2.5K/$3.75K/$5K (setter).
//
// Usage:
//   <MilestoneStrip role="closer" cashThisMonth={42000} />
//   <MilestoneStrip role="setter" cashThisMonth={42000} />
export default function MilestoneStrip({ role, cashThisMonth = 0, productionTarget = 100000 }) {
  const commissionRate = role === 'closer' ? 0.10 : 0.05
  const fullCommission = productionTarget * commissionRate     // $10K closer / $5K setter
  const stops = [0.25, 0.50, 0.75, 1.00]

  const pct = productionTarget > 0 ? Math.min(cashThisMonth / productionTarget, 1.5) : 0
  const progressWidthPct = Math.min(pct * 100, 100)
  const overshoot = pct > 1
  const hitMilestones = stops.filter(s => pct >= s).length
  const commissionEarned = Math.min(cashThisMonth * commissionRate, fullCommission)
                          + (overshoot ? (cashThisMonth - productionTarget) * commissionRate : 0)
  // Note: the cap is at $100K production for guaranteed commission. Whether overage pays more
  // depends on Daniel's actual structure — assuming continued % is conservative; he can tell me to cap.

  const headline = (() => {
    if (cashThisMonth === 0) return 'No cash collected this month yet.'
    if (pct >= 1)             return `${fmt$(cashThisMonth)} produced · ${fmt$(commissionEarned)} earned${overshoot ? ' (over goal)' : ''}.`
    const next = stops.find(s => pct < s) ?? 1
    const cashToNext = (productionTarget * next) - cashThisMonth
    return `${fmt$(cashThisMonth)} of ${fmt$(productionTarget)} · ${fmt$(cashToNext)} to next milestone.`
  })()

  return (
    <div style={{ borderTop: hair, borderBottom: hair, padding: '24px 0', margin: '0 0 32px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <h3 className="font-display" style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-0.018em', color: ink }}>
          Commission progress
        </h3>
        <span style={{ fontSize: 11, color: ink2, letterSpacing: '-0.005em' }}>
          {hitMilestones}/{stops.length} milestones · {Math.round(commissionRate * 100)}% of {fmt$(productionTarget)} = {fmt$(fullCommission)}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ position: 'relative', height: 6, background: 'var(--color-bg-alt, rgba(0,0,0,0.04))', borderRadius: 3, overflow: 'visible' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${progressWidthPct}%`,
          background: overshoot ? pos : accent,
          borderRadius: 3,
          transition: 'width 600ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        }} />
        {stops.map(s => {
          const reached = pct >= s
          return (
            <div key={s} style={{
              position: 'absolute',
              left: `${s * 100}%`,
              top: -4, bottom: -4,
              width: 1,
              background: reached ? ink : ink3,
              transform: 'translateX(-0.5px)',
            }} />
          )
        })}
      </div>

      {/* Milestone labels — show cash AND commission earned at each stop */}
      <div style={{ position: 'relative', height: 28, marginTop: 8, fontSize: 10, color: ink3, letterSpacing: '-0.005em' }}>
        {stops.map(s => {
          const reached = pct >= s
          const cashAt = productionTarget * s
          const commAt = fullCommission * s
          return (
            <span key={s} style={{
              position: 'absolute',
              left: `${s * 100}%`,
              transform: 'translateX(-50%)',
              textAlign: 'center',
              color: reached ? ink2 : ink3,
              fontWeight: reached ? 500 : 400,
              lineHeight: 1.3,
            }}>
              <div>{fmt$(cashAt)}</div>
              <div style={{ color: reached ? ink2 : ink3, fontSize: 10 }}>{fmt$(commAt)} earned</div>
            </span>
          )
        })}
      </div>

      <div style={{ marginTop: 22, fontSize: 12, color: ink2, letterSpacing: '-0.005em' }}>
        {headline}
      </div>
    </div>
  )
}
