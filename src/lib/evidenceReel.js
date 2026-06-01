// Evidence reel generator — produces the weekly "here's what we did" Slack post.
//
// Reads from client_touchpoints, client_leads, client_rankings_history,
// client_citations, client_reviews and assembles a single message in ROM
// voice (no em-dashes, direct, specific, dollar-anchored).
//
// Output is a single string ready to send to a client Slack channel.

import { supabase } from './supabase'
import { buildValueReceipt, formatValueReceiptForSlack } from './roi'

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString()
}

function fmtDelta(curr, prev) {
  if (prev == null || curr == null) return ''
  const d = curr - prev
  if (d === 0) return ''
  const sign = d > 0 ? '↑' : '↓'
  return ` (${sign}${Math.abs(d)} vs last wk)`
}

/**
 * Build the weekly evidence reel for a client.
 *
 * @param {string} clientId        uuid
 * @param {object} [opts]
 * @param {Date}   [opts.weekEnd]  defaults to now
 * @returns {Promise<{ text:string, summary:object }>}
 */
export async function generateWeeklyEvidenceReel(clientId, opts = {}) {
  const weekEnd = opts.weekEnd ? new Date(opts.weekEnd) : new Date()
  const weekStart = new Date(weekEnd); weekStart.setUTCDate(weekStart.getUTCDate() - 7)
  const prevWeekStart = new Date(weekStart); prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7)

  // ── fetch the data ────────────────────────────────────────
  const [
    clientRes,
    touchpointsRes,
    leadsRes,
    leadsPrevRes,
    citationsRes,
    reviewsRes,
    rankingsRes,
  ] = await Promise.all([
    supabase.from('clients').select('business_name, monthly_fee, vertical, primary_city, ga4_measurement_id').eq('id', clientId).single(),
    supabase.from('client_touchpoints')
      .select('touchpoint_key, status, channel, completed_at, sent_at, payload')
      .eq('client_id', clientId)
      .gte('sent_at', weekStart.toISOString())
      .in('status', ['sent','acknowledged','completed']),
    supabase.from('client_leads')
      .select('id, qualified, converted, deal_value, source, created_at')
      .eq('client_id', clientId)
      .gte('created_at', weekStart.toISOString()),
    supabase.from('client_leads')
      .select('id, qualified, converted', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .gte('created_at', prevWeekStart.toISOString())
      .lt('created_at', weekStart.toISOString()),
    supabase.from('client_citations')
      .select('directory_name, status, submitted_at, verified_at')
      .eq('client_id', clientId)
      .gte('submitted_at', weekStart.toISOString()),
    supabase.from('client_reviews')
      .select('platform, rating, reviewed_at')
      .eq('client_id', clientId)
      .gte('reviewed_at', weekStart.toISOString()),
    supabase.from('client_rankings_history')
      .select('keyword, position, position_type, tracked_at')
      .eq('client_id', clientId)
      .gte('tracked_at', weekStart.toISOString())
      .order('tracked_at', { ascending: false }),
  ])

  if (clientRes.error) throw clientRes.error
  const client = clientRes.data
  const touchpoints = touchpointsRes.data || []
  const leads = leadsRes.data || []
  const leadsPrevCount = leadsPrevRes.count || 0
  const citations = citationsRes.data || []
  const reviews = reviewsRes.data || []
  const rankings = rankingsRes.data || []

  // ── compute headline metrics ──────────────────────────────
  const calls = leads.filter(l => l.source === 'organic').length
  const qualified = leads.filter(l => l.qualified === true).length
  const converted = leads.filter(l => l.converted === true).length
  const reportedRevenue = leads
    .filter(l => l.converted && l.deal_value)
    .reduce((a, b) => a + Number(b.deal_value), 0)

  const newReviews = reviews.length
  const newCitations = citations.length

  // ── build the "we did" bullets from touchpoints ──────────
  const didBullets = []
  if (newCitations > 0) didBullets.push(`Submitted ${newCitations} new citation${newCitations === 1 ? '' : 's'}`)
  const gbpPosts = touchpoints.filter(t => t.touchpoint_key?.startsWith('gbp_') || t.touchpoint_key === 'gbp_post').length
  if (gbpPosts > 0) didBullets.push(`Posted ${gbpPosts}x to your Google Business Profile`)
  if (newReviews > 0) didBullets.push(`${newReviews} new review${newReviews === 1 ? '' : 's'} live`)
  const contentPosts = touchpoints.filter(t => t.touchpoint_key?.includes('blog') || t.touchpoint_key?.includes('content')).length
  if (contentPosts > 0) didBullets.push(`Published ${contentPosts} blog post${contentPosts === 1 ? '' : 's'}`)
  const schemaWork = touchpoints.filter(t => t.touchpoint_key?.includes('schema')).length
  if (schemaWork > 0) didBullets.push(`Tightened structured data on ${schemaWork} page${schemaWork === 1 ? '' : 's'}`)
  const profileWork = touchpoints.filter(t => t.touchpoint_key?.includes('profile') || t.touchpoint_key?.includes('directory')).length
  if (profileWork > 0) didBullets.push(`Built ${profileWork} new entity profile${profileWork === 1 ? '' : 's'}`)

  if (didBullets.length === 0) {
    didBullets.push('Worked through the optimisation backlog (granular updates in the next pass)')
  }

  // ── build "your numbers" block ────────────────────────────
  const numbersBlock = [
    `Calls: ${fmtNum(calls)}${fmtDelta(calls, leadsPrevCount)}`,
    `Qualified: ${fmtNum(qualified)}`,
    converted > 0 ? `Closed jobs (reported): ${fmtNum(converted)}` : null,
    reportedRevenue > 0 ? `Revenue (reported): $${fmtNum(reportedRevenue)}` : null,
  ].filter(Boolean)

  // ── ROI receipt ───────────────────────────────────────────
  const receipt = buildValueReceipt({
    period_label: 'this week',
    monthly_fee: client.monthly_fee,
    qualified_leads: qualified,
    closed_jobs_reported: converted,
    avg_value_reported: converted > 0 ? reportedRevenue / converted : 0,
  })

  // ── compose the message ───────────────────────────────────
  const lines = [
    `🟢 ${client.business_name} · Week ending ${weekEnd.toISOString().slice(0,10)}`,
    '',
    'THIS WEEK WE…',
    ...didBullets.map(b => `  • ${b}`),
    '',
    'YOUR NUMBERS',
    ...numbersBlock.map(b => `  • ${b}`),
    '',
  ]

  if (receipt.tier) {
    lines.push(receipt.headline)
    if (receipt.fee > 0) lines.push(`You paid us $${receipt.fee.toLocaleString()} this week.`)
    if (receipt.roi_multiplier != null) {
      lines.push(`ROI: ${receipt.roi_multiplier >= 10 ? `${receipt.roi_multiplier.toFixed(1)}x` : `${receipt.roi_pct}%`}`)
    }
    lines.push('')
  }

  lines.push('Anything you want to dig into? Reply here.')

  return {
    text: lines.join('\n'),
    summary: {
      calls, qualified, converted, reportedRevenue,
      newReviews, newCitations,
      receipt,
    },
  }
}
