/**
 * GHL Pipeline Analytics — consumed from existing Flask app.
 * This proxies through dashboard.optdigital.io, NOT direct GHL API calls.
 * The Flask app handles the PIT key auth and background processing.
 */
const GHL_ANALYTICS_URL = import.meta.env.VITE_GHL_ANALYTICS_URL

/**
 * Fetch pipeline analytics from the Flask app.
 * First call returns {status: 'processing'}, poll until data arrives.
 */
export async function fetchPipelineAnalytics(days = 30) {
  // Start the background job
  await fetch(`${GHL_ANALYTICS_URL}?days=${days}`, { method: 'POST' }).catch(() => {})

  // Poll for results
  const maxAttempts = 60  // 3 minutes max
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${GHL_ANALYTICS_URL}?days=${days}`)
    if (!res.ok) continue
    const data = await res.json()
    if (data.status === 'processing') continue
    if (data.status === 'error') throw new Error(data.error)
    return data
  }
  throw new Error('Pipeline analytics timed out')
}

/**
 * Extract funnel data from pipeline analytics response
 */
export function extractFunnel(analytics) {
  return {
    totalOpportunities: analytics.total_opportunities || 0,
    newLeads: analytics.new_leads || 0,
    triageCount: analytics.triage_count || 0,
    setCallsTotal: analytics.set_calls_total || 0,
    closedCount: analytics.closed_count || 0,
    ascendedCount: analytics.ascended_count || 0,
    noShowCount: analytics.no_show_count || 0,
    autoBooked: analytics.auto_booked || 0,
    manualSet: analytics.manual_set || 0,
    showRate: analytics.show_rate || 0,
    closeRate: analytics.close_rate_shown || 0,
    noShowRate: analytics.no_show_rate || 0,
    showRateAuto: analytics.show_rate_auto || 0,
    showRateManual: analytics.show_rate_manual || 0,
    closeRateAuto: analytics.close_rate_auto || 0,
    closeRateManual: analytics.close_rate_manual || 0,
    noShowRateAuto: analytics.no_show_rate_auto || 0,
    noShowRateManual: analytics.no_show_rate_manual || 0,
  }
}

/**
 * Extract Wavv dialer metrics from pipeline analytics
 */
export function extractDialerMetrics(analytics) {
  return {
    totalDials: analytics.total_dials || 0,
    totalPickups: analytics.total_pickups || 0,
    totalMCs: analytics.total_mcs || 0,
    totalLeadsDialed: analytics.total_leads_dialed || 0,
    totalSets: analytics.total_sets_from_dials || 0,
    avgDialsPerLead: analytics.avg_dials_per_lead || 0,
    pickupRate: analytics.overall_pickup_rate || 0,
    callToSet: analytics.overall_call_to_set || 0,
    mcToSet: analytics.overall_mc_to_set || 0,
    dialsByOrigin: analytics.dials_by_origin || [],
  }
}

/**
 * Extract speed to lead from pipeline analytics
 */
export function extractSpeedToLead(analytics) {
  return analytics.speed_to_lead || {
    total_new_leads: 0,
    worked: 0,
    unworked: 0,
    avg_display: '—',
    median_display: '—',
    fastest_display: '—',
    slowest_display: '—',
    pct_under_5m: 0,
    pct_under_1h: 0,
    daily: [],
    unworked_leads: [],
  }
}

/**
 * Extract source outcomes (auto vs manual) from pipeline analytics
 */
export function extractSourceOutcomes(analytics) {
  return analytics.source_outcomes || {
    auto: { total: 0, shown: 0, closed: 0, no_show: 0, show_rate: 0, close_rate: 0 },
    manual: { total: 0, shown: 0, closed: 0, no_show: 0, show_rate: 0, close_rate: 0 },
  }
}
