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

export function computeShowRate(leads, closerCalls = []) {
  // Build a lookup of closer_call outcomes keyed by setter_lead_id
  const callOutcomes = {}
  for (const c of closerCalls) {
    if (c.setter_lead_id) callOutcomes[c.setter_lead_id] = c
  }

  let showed = 0
  let noShows = 0
  let rescheduled = 0

  for (const lead of leads) {
    // Use closer_call outcome if linked, otherwise fall back to setter_leads.status
    const call = callOutcomes[lead.id]
    const outcome = call ? call.outcome : lead.status

    if (['showed', 'closed', 'not_closed'].includes(outcome)) showed++
    else if (outcome === 'no_show') noShows++
    else if (outcome === 'rescheduled') rescheduled++
    // 'set' / null / other = unresolved, skip
  }

  const resolved = showed + noShows
  return {
    showRate: resolved > 0 ? Number(((showed / resolved) * 100).toFixed(1)) : 0,
    showedCount: showed,
    noShowCount: noShows,
    resolved,
  }
}
