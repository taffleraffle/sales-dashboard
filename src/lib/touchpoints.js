// Touchpoint engine helpers.
//
// Two responsibilities:
//   1. materializeTouchpointsForClient — when a client moves into a stage
//      (onboarding / steady_state / renewal / offboarding), insert the rows
//      defined in src/data/touchpoints.json with computed scheduled_at.
//   2. shouldFireForClient — filter rules: a touchpoint is included only if
//      the client's communication_frequency meets the touchpoint's minimum,
//      and any conditional flag is satisfied.

import touchpointConfig from '../data/touchpoints.json'
import { supabase } from './supabase'

// Frequency ladder — touchpoints with frequency_min=light fire for everyone;
// frequency_min=high only fires for high/white_glove clients.
const FREQ_RANK = { light: 0, standard: 1, high: 2, white_glove: 3 }

export function isFrequencyMet(clientFrequency, touchpointMinimum) {
  if (!touchpointMinimum) return true
  const clientRank = FREQ_RANK[clientFrequency] ?? 1
  const minRank = FREQ_RANK[touchpointMinimum] ?? 0
  return clientRank >= minRank
}

/**
 * Compute scheduled_at for an onboarding touchpoint based on contract_start.
 * For steady_state, uses contract_start + cadence_days offsets.
 * For renewal, uses contract_end + offset_from_renewal_days.
 */
function computeScheduledAt(stage, touchpoint, client) {
  const start = client.contract_start ? new Date(client.contract_start) : new Date()
  if (stage === 'onboarding' && typeof touchpoint.day === 'number') {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + touchpoint.day)
    // jitter for naturalness: 9am client tz with random minute 0-30
    d.setUTCHours(14, Math.floor(Math.random() * 30), 0, 0)
    return d.toISOString()
  }
  if (stage === 'renewal' && typeof touchpoint.offset_from_renewal_days === 'number') {
    const end = client.contract_end ? new Date(client.contract_end) : null
    if (!end) return null
    const d = new Date(end)
    d.setUTCDate(d.getUTCDate() + touchpoint.offset_from_renewal_days)
    return d.toISOString()
  }
  if (stage === 'offboarding' && typeof touchpoint.day === 'number') {
    const today = new Date()
    today.setUTCDate(today.getUTCDate() + touchpoint.day)
    return today.toISOString()
  }
  // steady_state: schedule the first occurrence at start + cadence_days
  if (stage === 'steady_state' && typeof touchpoint.cadence_days === 'number') {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + (touchpoint.offset_days || touchpoint.cadence_days))
    return d.toISOString()
  }
  return null
}

/**
 * Insert touchpoint rows for a client at a given stage.
 *
 * @param {object} client          a row from `clients`
 * @param {string} stage           'onboarding' | 'steady_state' | 'renewal' | 'offboarding'
 * @returns {Promise<{inserted:number, skipped:number}>}
 */
export async function materializeTouchpointsForClient(client, stage = 'onboarding') {
  const stageConfig = touchpointConfig[stage]
  if (!Array.isArray(stageConfig)) return { inserted: 0, skipped: 0 }

  const rows = stageConfig
    .filter(tp => isFrequencyMet(client.communication_frequency, tp.frequency_min))
    .map(tp => ({
      client_id: client.id,
      stage,
      cadence_day: typeof tp.day === 'number' ? tp.day : null,
      touchpoint_key: tp.key,
      channel: tp.channel,
      automated: tp.automated !== false,
      status: 'scheduled',
      scheduled_at: computeScheduledAt(stage, tp, client),
      template_key: tp.template_key || null,
      payload: {
        notes: tp.notes,
        condition: tp.condition,
        to: tp.to,
        subject: tp.subject,
      },
    }))

  if (rows.length === 0) return { inserted: 0, skipped: 0 }

  const { error, count } = await supabase
    .from('client_touchpoints')
    .insert(rows, { count: 'exact' })

  if (error) throw error
  return { inserted: count || rows.length, skipped: stageConfig.length - rows.length }
}

/**
 * Group a list of touchpoint rows by status for the AM queue view.
 * Returns { queued_for_review, scheduled, sent, all }.
 */
export function groupTouchpoints(rows) {
  const out = { queued_for_review: [], scheduled: [], sent: [], all: rows }
  for (const r of rows) {
    if (r.status === 'queued_for_review' || r.status === 'draft') out.queued_for_review.push(r)
    else if (r.status === 'scheduled') out.scheduled.push(r)
    else if (r.status === 'sent' || r.status === 'acknowledged' || r.status === 'completed') out.sent.push(r)
  }
  return out
}

/**
 * Pretty label for a touchpoint key (used in UI).
 */
export function touchpointLabel(key) {
  if (!key) return 'Untitled'
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/Am\b/g, 'AM')
    .replace(/Sms\b/g, 'SMS')
    .replace(/Gbp\b/g, 'GBP')
}
