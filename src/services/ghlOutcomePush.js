// One-way push of EOD outcomes from the dashboard to GoHighLevel.
// The dashboard is the canonical source of truth — failures here log but don't block the EOD save.
//
// GHL appointment statuses: confirmed | showed | noshow | cancelled | invalid
// (per https://highlevel.stoplight.io/docs/integrations)

const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const BASE_URL = 'https://services.leadconnectorhq.com'

const headers = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
}

// Map our outcome enum → GHL appointmentStatus.
// Returns null if the outcome shouldn't change anything in GHL (e.g. no_show on an already-cancelled).
function outcomeToGHLStatus(outcome) {
  switch (outcome) {
    case 'closed':
    case 'not_closed':
    case 'follow_up_booked':
    case 'ascended':
    case 'not_ascended':
      return 'showed'
    case 'no_show':
      return 'noshow'
    case 'rescheduled':
    case 'cancelled':
      return 'cancelled'
    default:
      return null
  }
}

// Push a single appointment's status. Returns { ok: bool, error?: string }.
export async function pushOutcomeToGHL(ghlEventId, outcome) {
  if (!GHL_API_KEY) return { ok: false, error: 'no_api_key' }
  if (!ghlEventId)  return { ok: false, error: 'no_event_id' }
  const status = outcomeToGHLStatus(outcome)
  if (!status)      return { ok: false, error: 'no_mapping' }

  try {
    const res = await fetch(`${BASE_URL}/calendars/events/appointments/${ghlEventId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ appointmentStatus: status }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ============================================================================
// GRANULAR TRACKING: tag + custom field writes per call (Phase 1B)
// ============================================================================

import { supabase } from '../lib/supabase'

// Lean tag taxonomy — only tags that drive GHL workflow triggers go here.
// Detail (objection, follow-up reason, etc) lives in custom fields, not tags.
const WORKFLOW_TAGS = {
  outcomes: {
    closed:           'outcome:closed',
    follow_up_booked: 'outcome:follow-up',
    not_closed:       'outcome:no-close',
    no_show:          'outcome:no-show',
  },
  nextStates: {
    'follow-up':          'next-state:follow-up',
    'long-term-nurture':  'next-state:nurture',
    'dead':               'next-state:dead',
  },
  decisionMaker: {
    false: 'decision-maker:no',
  },
  confirmIssues: {
    'noshow-after-call': 'noshow:after-call-confirm',
  },
}

async function getCustomFieldId(name) {
  const { data } = await supabase
    .from('rom_ghl_custom_field_cache')
    .select('field_id')
    .eq('name', name)
    .maybeSingle()
  return data?.field_id || null
}

async function getAllFieldIds() {
  const { data } = await supabase.from('rom_ghl_custom_field_cache').select('name, field_id')
  const map = {}
  for (const r of data || []) map[r.name] = r.field_id
  return map
}

// Write tags to a GHL contact (additive — does not remove tags).
export async function addContactTags(contactId, tags) {
  if (!GHL_API_KEY || !contactId || !tags?.length) return { ok: false, error: 'missing_args' }
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, error: `${res.status} ${txt.slice(0, 160)}` }
  }
  return { ok: true }
}

// Write custom field values to a GHL contact in one call.
// Pass { fieldName: value, ... } using our rom_* names — we resolve to GHL ids.
export async function writeCustomFields(contactId, fieldsByName) {
  if (!GHL_API_KEY || !contactId || !fieldsByName) return { ok: false, error: 'missing_args' }
  const fieldIdMap = await getAllFieldIds()
  const customFields = []
  for (const [name, value] of Object.entries(fieldsByName)) {
    const id = fieldIdMap[name]
    if (!id || value == null || value === '') continue
    customFields.push({ id, value })
  }
  if (customFields.length === 0) return { ok: true, written: 0 }

  const res = await fetch(`${BASE_URL}/contacts/${contactId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ customFields }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, error: `${res.status} ${txt.slice(0, 160)}` }
  }
  return { ok: true, written: customFields.length }
}

// Master push for a single call row — handles status + tags + custom fields.
// Pass a hydrated call object with all the granular fields populated.
export async function pushCallToGHL(call) {
  if (!call.ghl_event_id) return { ok: false, error: 'no_event_id' }

  const errors = []
  // 1) Appointment status
  if (call.outcome) {
    const r1 = await pushOutcomeToGHL(call.ghl_event_id, call.outcome)
    if (!r1.ok && r1.error !== 'no_mapping') errors.push({ step: 'status', error: r1.error })
  }

  // 2) Tags + custom fields (need ghl_contact_id from the appointment)
  let ghlContactId = call.ghl_contact_id
  if (!ghlContactId) {
    const { data } = await supabase
      .from('ghl_appointments')
      .select('ghl_contact_id')
      .eq('ghl_event_id', call.ghl_event_id)
      .maybeSingle()
    ghlContactId = data?.ghl_contact_id
  }
  if (!ghlContactId) return { ok: errors.length === 0, errors }

  // Build tag list
  const tags = []
  if (WORKFLOW_TAGS.outcomes[call.outcome]) tags.push(WORKFLOW_TAGS.outcomes[call.outcome])
  if (WORKFLOW_TAGS.nextStates[call.next_state]) tags.push(WORKFLOW_TAGS.nextStates[call.next_state])
  if (call.decision_maker_present === false) tags.push(WORKFLOW_TAGS.decisionMaker.false)
  if (call.outcome === 'no_show' && call.confirm_method === 'call') tags.push(WORKFLOW_TAGS.confirmIssues['noshow-after-call'])
  if (tags.length > 0) {
    const r = await addContactTags(ghlContactId, tags)
    if (!r.ok) errors.push({ step: 'tags', error: r.error })
  }

  // Build custom field writes (full granular snapshot of this call)
  const now = new Date().toISOString()
  const fields = {
    rom_last_call_date: now,
    rom_last_outcome: outcomeToReadable(call.outcome),
    rom_last_objection: call.objection_category || null,
    rom_last_objection_date: call.objection_category ? now : null,
    rom_last_followup_reason: call.follow_up_reason || null,
    rom_last_followup_date: call.follow_up_reason ? now : null,
    rom_last_followup_timeframe_days: call.follow_up_timeframe_days ?? null,
    rom_last_followup_timeframe_reason: call.follow_up_timeframe_reason || null,
    rom_next_state: call.next_state || null,
    rom_offers_pitched_last: Array.isArray(call.offers_pitched) ? call.offers_pitched.join(',') : null,
    rom_confirm_method_last: call.confirm_method || null,
    rom_decision_maker_last: call.decision_maker_present == null ? 'unknown' : (call.decision_maker_present ? 'yes' : 'no'),
    rom_pre_call_video_pct_last: call.pre_call_video_watched_pct ?? null,
    rom_reason_alignment_last: call.reason_alignment || null,
    rom_closer_assigned_last: call.closer_name || null,
    rom_setter_assigned_last: call.setter_name || null,
    rom_fathom_recording_url_last: call.fathom_recording_url || null,
    rom_ai_prefill_confirmed_last: call.ai_prefill_status === 'confirmed' ? 'confirmed'
                                  : call.ai_prefill_status === 'overridden' ? 'overridden'
                                  : 'skipped',
  }
  // History appends — pull existing, append new entry, write back
  if (call.objection_category) {
    const existing = await fetchCustomFieldValue(ghlContactId, 'rom_objection_history') || ''
    const line = `${now.slice(0, 10)} · ${call.objection_category}`
    fields.rom_objection_history = existing ? `${existing}\n${line}` : line
  }
  if (Array.isArray(call.offers_pitched) && call.offers_pitched.length > 0) {
    const existing = await fetchCustomFieldValue(ghlContactId, 'rom_offers_pitched_history') || ''
    const line = `${now.slice(0, 10)} · ${call.offers_pitched.join(', ')}${call.offer_downsell_occurred ? ' (downsell)' : ''}`
    fields.rom_offers_pitched_history = existing ? `${existing}\n${line}` : line
  }

  const r2 = await writeCustomFields(ghlContactId, fields)
  if (!r2.ok) errors.push({ step: 'customFields', error: r2.error })

  return { ok: errors.length === 0, errors, ghl_contact_id: ghlContactId, tags_written: tags.length, fields_written: r2.written || 0 }
}

async function fetchCustomFieldValue(contactId, fieldName) {
  const id = await getCustomFieldId(fieldName)
  if (!id) return null
  try {
    const res = await fetch(`${BASE_URL}/contacts/${contactId}`, { headers })
    if (!res.ok) return null
    const json = await res.json()
    const cf = (json.contact?.customFields || []).find(f => f.id === id)
    return cf?.value ?? null
  } catch { return null }
}

function outcomeToReadable(o) {
  return { closed: 'closed', follow_up_booked: 'follow-up', not_closed: 'no-close', no_show: 'no-close', rescheduled: 'follow-up', cancelled: 'no-close' }[o] || null
}

// Bulk push — call for every call_row that has a ghl_event_id. Concurrency capped at 5.
// Returns { successes, failures, errors[] }.
export async function pushOutcomesBulk(callRows) {
  const targets = callRows.filter(c => c.ghl_event_id && outcomeToGHLStatus(c.outcome))
  if (targets.length === 0) return { successes: 0, failures: 0, errors: [] }

  const errors = []
  let successes = 0
  let failures  = 0
  const CONCURRENCY = 5

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(c => pushOutcomeToGHL(c.ghl_event_id, c.outcome)))
    results.forEach((r, idx) => {
      if (r.ok) successes++
      else {
        failures++
        errors.push({ ghl_event_id: batch[idx].ghl_event_id, outcome: batch[idx].outcome, error: r.error })
      }
    })
  }

  return { successes, failures, errors }
}
