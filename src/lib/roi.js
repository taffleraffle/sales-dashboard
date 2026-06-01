// ROM ROI calculator — 3-tier value engine.
//
// Tier ladder, lowest claim to highest:
//   1. TRAFFIC_VALUE       organic sessions valued at avg CPC (defensible, conservative)
//   2. QUOTABLE_JOBS       qualified leads × close rate × avg job value (mid; uses benchmarks)
//   3. ACTUAL_SALES        client-reported closed jobs × actual avg value (highest, requires client input)
//
// The display layer picks the HIGHEST tier we have full data for. Never inflate
// past what the data supports. The "what would we be claiming" rule: if any input
// is a fallback benchmark, we anchor at the tier above (e.g. if close_rate is
// benchmark, we display QUOTABLE_JOBS not ACTUAL_SALES).

export const ROI_TIER = {
  TRAFFIC: 'traffic_value',
  QUOTABLE: 'quotable_jobs',
  ACTUAL: 'actual_sales',
}

const SAFE_NUM = (v, fallback = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : fallback

/**
 * Compute the conservative TIER 1 — "what this much organic traffic is worth".
 *
 * @param {object} args
 * @param {number} args.organic_sessions   sessions from organic source over the period
 * @param {number} args.organic_cpc_avg    avg CPC for that client's keyword set (USD)
 * @param {number} [args.session_to_lead_rate]  decimal 0-1; default 0.025 (industry avg local services)
 * @returns {{value:number, basis:string[]}}
 */
export function computeTrafficValue({ organic_sessions, organic_cpc_avg, session_to_lead_rate = 0.025 }) {
  const sessions = SAFE_NUM(organic_sessions)
  const cpc = SAFE_NUM(organic_cpc_avg)
  const value = sessions * cpc
  return {
    value,
    basis: [
      `${sessions.toLocaleString()} organic sessions`,
      `× $${cpc.toFixed(2)} avg CPC`,
      `= $${value.toLocaleString()} of equivalent paid-traffic value`,
    ],
  }
}

/**
 * Compute TIER 2 — "qualified leads × close rate × avg job".
 *
 * @param {object} args
 * @param {number} args.qualified_leads        count of qualified leads in the period
 * @param {number} args.close_rate             decimal 0-1 (e.g. 0.22)
 * @param {number} args.avg_job_value          USD per closed job
 * @param {boolean} [args.close_rate_is_benchmark]  true if we're using vertical benchmark
 * @param {boolean} [args.avg_job_is_benchmark]     true if we're using vertical benchmark
 * @returns {{value:number, basis:string[], usingBenchmark:boolean}}
 */
export function computeQuotableJobs({ qualified_leads, close_rate, avg_job_value, close_rate_is_benchmark, avg_job_is_benchmark }) {
  const leads = SAFE_NUM(qualified_leads)
  const close = SAFE_NUM(close_rate)
  const job = SAFE_NUM(avg_job_value)
  const closedJobs = leads * close
  const value = closedJobs * job
  const usingBenchmark = Boolean(close_rate_is_benchmark || avg_job_is_benchmark)
  const benchmarkNote = usingBenchmark ? ' (industry benchmark — share your numbers for accuracy)' : ''
  return {
    value,
    usingBenchmark,
    basis: [
      `${leads} qualified leads`,
      `× ${(close * 100).toFixed(0)}% close rate${close_rate_is_benchmark ? ' (benchmark)' : ''}`,
      `× $${job.toLocaleString()} avg job${avg_job_is_benchmark ? ' (benchmark)' : ''}`,
      `= $${value.toLocaleString()} estimated quote-stage value${benchmarkNote}`,
    ],
  }
}

/**
 * Compute TIER 3 — actual reported closed sales.
 *
 * @param {object} args
 * @param {number} args.closed_jobs            count client reported
 * @param {number} args.reported_avg_value     avg job value client reported
 * @returns {{value:number, basis:string[]}}
 */
export function computeActualSales({ closed_jobs, reported_avg_value }) {
  const jobs = SAFE_NUM(closed_jobs)
  const avg = SAFE_NUM(reported_avg_value)
  const value = jobs * avg
  return {
    value,
    basis: [
      `${jobs} closed jobs (client reported)`,
      `× $${avg.toLocaleString()} avg job value`,
      `= $${value.toLocaleString()} of revenue you've earned`,
    ],
  }
}

/**
 * Pick the display tier — the highest tier with non-benchmark data.
 *
 * Returns the value-receipt-ready summary for the client portal + Slack reel.
 *
 * @param {object} inputs    everything we know about this client this period
 * @returns {object}         { tier, value, basis, roi_pct, roi_multiplier, headline }
 */
export function buildValueReceipt(inputs) {
  const {
    period_label,
    monthly_fee,
    organic_sessions,
    organic_cpc_avg,
    qualified_leads,
    close_rate,
    avg_job_value,
    closed_jobs_reported,
    avg_value_reported,
    close_rate_is_benchmark,
    avg_job_is_benchmark,
  } = inputs

  const fee = SAFE_NUM(monthly_fee, 0)

  // Prefer the highest tier with real (non-benchmark) data
  let receipt
  if (Number.isFinite(Number(closed_jobs_reported)) && Number.isFinite(Number(avg_value_reported)) && Number(closed_jobs_reported) > 0) {
    const calc = computeActualSales({
      closed_jobs: closed_jobs_reported,
      reported_avg_value: avg_value_reported,
    })
    receipt = { tier: ROI_TIER.ACTUAL, ...calc }
  } else if (Number.isFinite(Number(qualified_leads)) && Number(qualified_leads) > 0 && !avg_job_is_benchmark) {
    const calc = computeQuotableJobs({
      qualified_leads,
      close_rate,
      avg_job_value,
      close_rate_is_benchmark,
      avg_job_is_benchmark,
    })
    receipt = { tier: ROI_TIER.QUOTABLE, ...calc }
  } else if (Number.isFinite(Number(organic_sessions)) && Number(organic_sessions) > 0) {
    const calc = computeTrafficValue({ organic_sessions, organic_cpc_avg })
    receipt = { tier: ROI_TIER.TRAFFIC, ...calc }
  } else {
    return {
      tier: null,
      value: 0,
      basis: ['No data yet for this period'],
      roi_pct: null,
      roi_multiplier: null,
      headline: 'Tracking activated — first numbers in 7 days.',
      period_label,
    }
  }

  const roi_pct = fee > 0 ? Math.round((receipt.value / fee) * 100) : null
  const roi_multiplier = fee > 0 ? receipt.value / fee : null

  const tierLabel = {
    [ROI_TIER.TRAFFIC]: 'traffic value',
    [ROI_TIER.QUOTABLE]: 'estimated quotable value',
    [ROI_TIER.ACTUAL]: 'closed-revenue',
  }[receipt.tier]

  const headline = receipt.tier === ROI_TIER.ACTUAL
    ? `You earned ~$${receipt.value.toLocaleString()} ${period_label} from organic search.`
    : receipt.tier === ROI_TIER.QUOTABLE
      ? `Estimated $${receipt.value.toLocaleString()} in quotable value ${period_label} from organic leads.`
      : `Your organic traffic ${period_label} is worth ~$${receipt.value.toLocaleString()} at equivalent paid CPC.`

  return {
    tier: receipt.tier,
    tier_label: tierLabel,
    value: receipt.value,
    basis: receipt.basis,
    fee,
    roi_pct,
    roi_multiplier,
    headline,
    period_label,
  }
}

/**
 * Format the value receipt as a ready-to-send Slack message block.
 * Uses ROM brand voice: no em-dashes, no AI slop, direct.
 */
export function formatValueReceiptForSlack(receipt) {
  if (!receipt.tier) return receipt.headline
  const lines = [
    receipt.headline,
    receipt.fee > 0 ? `You paid us $${receipt.fee.toLocaleString()} ${receipt.period_label}.` : null,
    receipt.roi_multiplier != null
      ? `ROI: ${receipt.roi_multiplier >= 10 ? `${receipt.roi_multiplier.toFixed(1)}x` : `${receipt.roi_pct}%`}`
      : null,
    '',
    'How we got there:',
    ...receipt.basis.map(b => `  • ${b}`),
  ].filter(Boolean)
  return lines.join('\n')
}
