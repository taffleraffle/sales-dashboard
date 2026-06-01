/*
  Theory-of-constraints engine.

  Encodes the Acquisition.com "money model" KPIs that ROM runs the business on
  (see project_ceo_dashboard memory + the four source docs). Each metric has a
  hard KPI threshold. The engine scores every metric against its KPI, marks it
  healthy / warning / critical, and surfaces the single biggest constraint —
  the one lever to pull this month ("why can't we double adspend tomorrow?").

  Phase A wires only the metrics the app already computes from marketing_tracker
  via computeMarketingStats(). Churn, NOI, and the P&L mix join the registry in
  Phase B/C once those engines feed data.

  direction: 'above' = healthy when value >= target (higher is better)
             'below' = healthy when value <= target (lower is better)
  stage: funnel order, used as a tiebreaker — an upstream constraint is higher
         leverage than an equally-severe downstream one.
*/

export const KPI_REGISTRY = [
  {
    key: 'cpqbc', label: 'Cost per qualified booking',
    target: 300, direction: 'below', unit: '$', stage: 1,
    lever: 'Cheaper traffic or better-qualified bookings to get CPQBC under $300.',
    read: (s) => s.cpb,
    valid: (s) => s.adspend > 0 && s.qualified_bookings > 0,
  },
  {
    key: 'show_rate', label: 'Show rate',
    target: 50, direction: 'above', unit: '%', stage: 2,
    lever: 'Tighten booking-to-call confirmation and reminder sequence to lift show rate above 50%.',
    read: (s) => s.show_rate,
    valid: (s) => s.nc_booked > 0,
  },
  {
    key: 'offer_rate', label: 'Offer rate',
    target: 80, direction: 'above', unit: '%', stage: 3,
    lever: 'Closers must make an offer on every qualified live call — push offer rate to 80%+.',
    read: (s) => s.offer_rate,
    valid: (s) => s.live_calls > 0,
  },
  {
    key: 'close_rate', label: 'Close rate',
    target: 25, direction: 'above', unit: '%', stage: 4,
    lever: 'Objection handling and offer strength on calls — a 20%→30% close rate grows the front end 50%.',
    read: (s) => s.close_rate,
    valid: (s) => s.new_live_calls > 0,
  },
  {
    key: 'cash_pct', label: 'Cash collected %',
    target: 40, direction: 'above', unit: '%', stage: 5,
    lever: 'Collect more upfront at close — target 40%+ of contract value as day-1 cash.',
    read: (s) => s.trial_cash_pct,
    valid: (s) => s.trial_revenue > 0,
  },
  {
    key: 'cash_roas', label: 'Cash ROAS (day 1)',
    target: 2, direction: 'above', unit: 'x', stage: 6,
    lever: 'Raise price or lower CAC until new cash is 2x ad spend on day one.',
    read: (s) => s.trial_fe_roas,
    valid: (s) => s.adspend > 0,
  },
  {
    key: 'revenue_roas', label: 'Revenue ROAS',
    target: 5, direction: 'above', unit: 'x', stage: 7,
    lever: 'Raise contract value or lower acquisition cost — contracted revenue should be 5x ad spend.',
    read: (s) => s.revenue_roas,
    valid: (s) => s.adspend > 0,
  },
  {
    key: 'ar_success', label: 'AR success rate',
    target: 90, direction: 'above', unit: '%', stage: 8,
    lever: 'Tighten AR collection and reduce defaults to keep AR success above 90%.',
    read: (s) => s.ar_success_rate,
    valid: (s) => (s.ar_collected + s.ar_defaulted) > 0,
  },
]

/* Relative gap below KPI. 0 = at/above target, positive = short of target. */
function severity(value, target, direction) {
  if (target === 0) return 0
  if (direction === 'above') return Math.max(0, (target - value) / target)
  return Math.max(0, (value - target) / target)
}

/* Mirror getColor's bands: healthy at target, warning within 20%, else critical. */
function statusFor(sev) {
  if (sev <= 0) return 'healthy'
  if (sev <= 0.2) return 'warning'
  return 'critical'
}

export function formatKpi(value, unit) {
  if (value == null || Number.isNaN(value)) return '—'
  if (unit === '$') return `$${Math.round(value).toLocaleString()}`
  if (unit === '%') return `${value.toFixed(1)}%`
  if (unit === 'x') return `${value.toFixed(2)}x`
  return String(value)
}

/*
  Evaluate every KPI against `stats` (a computeMarketingStats() result).
  Returns { readings, constraint } where readings is the full scorecard and
  constraint is the single biggest lever (null if everything is healthy or
  there isn't enough volume to judge).
*/
export function evaluateConstraints(stats) {
  const readings = KPI_REGISTRY.map((kpi) => {
    const value = kpi.read(stats)
    const hasData = kpi.valid(stats)
    const sev = hasData ? severity(value, kpi.target, kpi.direction) : 0
    return {
      ...kpi,
      value,
      hasData,
      severity: sev,
      status: hasData ? statusFor(sev) : 'nodata',
      display: formatKpi(value, kpi.unit),
      targetDisplay: formatKpi(kpi.target, kpi.unit),
    }
  })

  const offenders = readings
    .filter((r) => r.hasData && r.status !== 'healthy')
    // Biggest gap first; upstream funnel stage breaks ties (higher leverage).
    .sort((a, b) => (b.severity - a.severity) || (a.stage - b.stage))

  return { readings, constraint: offenders[0] || null }
}
