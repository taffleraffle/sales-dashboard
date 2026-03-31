/**
 * Traffic light color based on value vs target.
 * direction: 'above' = green when value >= target, 'below' = green when value <= target
 */
export function getColor(value, target, direction = 'above') {
  if (value == null || target == null) return 'text-text-400'
  if (direction === 'above') {
    if (value >= target) return 'text-success'
    if (value >= target * 0.8) return 'text-warning'
    return 'text-danger'
  } else {
    if (value <= target) return 'text-success'
    if (value <= target * 1.2) return 'text-warning'
    return 'text-danger'
  }
}

export function getColorBg(value, target, direction = 'above') {
  if (value == null || target == null) return 'bg-bg-card'
  if (direction === 'above') {
    if (value >= target) return 'bg-success/10 border-success/30'
    if (value >= target * 0.8) return 'bg-warning/10 border-warning/30'
    return 'bg-danger/10 border-danger/30'
  } else {
    if (value <= target) return 'bg-success/10 border-success/30'
    if (value <= target * 1.2) return 'bg-warning/10 border-warning/30'
    return 'bg-danger/10 border-danger/30'
  }
}

export function pct(numerator, denominator, decimals = 1) {
  if (!denominator) return 0
  return Number(((numerator / denominator) * 100).toFixed(decimals))
}

export function currency(value, decimals = 0) {
  if (value == null) return '$0'
  return '$' + Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function ratio(numerator, denominator, decimals = 1) {
  if (!denominator) return '0'
  return (numerator / denominator).toFixed(decimals)
}

export function trend(current, previous) {
  if (!previous) return { direction: 'flat', pct: 0 }
  const change = ((current - previous) / previous) * 100
  return {
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    pct: Math.abs(Number(change.toFixed(1))),
  }
}

/**
 * Compute show rate for setter leads using closer EOD daily aggregates.
 *
 * For each setter_lead with an appointment_date, looks up the closer EOD stats
 * for that date and uses the daily show rate (live_calls / booked) to weight
 * whether that lead likely showed. This matches the SalesOverview methodology.
 *
 * @param {Array} leads - setter_leads with { appointment_date }
 * @param {Object} dateStats - { [date]: { booked, live, noShows } } from closer EODs
 * @returns {{ showRate, showedCount, noShowCount, resolved }}
 */
export function computeShowRate(leads, dateStats = {}) {
  let weightedShows = 0
  let weightedTotal = 0

  // Group leads by appointment_date
  const byDate = {}
  for (const lead of leads) {
    if (!lead.appointment_date) continue
    byDate[lead.appointment_date] = (byDate[lead.appointment_date] || 0) + 1
  }

  for (const [date, count] of Object.entries(byDate)) {
    const ds = dateStats[date]
    if (!ds || ds.booked === 0) continue
    // Cap show rate at 100% (some dates have live > booked due to walk-ins/data quirks)
    const dateShowRate = Math.min(ds.live / ds.booked, 1)
    weightedShows += count * dateShowRate
    weightedTotal += count
  }

  const showedCount = Math.round(weightedShows)
  const noShowCount = Math.max(0, weightedTotal - showedCount)
  return {
    showRate: weightedTotal > 0 ? Number(((weightedShows / weightedTotal) * 100).toFixed(1)) : 0,
    showedCount,
    noShowCount,
    resolved: weightedTotal,
  }
}
