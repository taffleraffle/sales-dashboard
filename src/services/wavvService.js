import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

/**
 * Classify a call by duration:
 * - Any call = 1 dial
 * - duration > 45s = pickup (someone answered — filters out voicemails/short rings)
 * - duration >= 60s = meaningful conversation (matches WAVV "Outbound Conversations" = calls > 1 min)
 * Note: "sets" are NOT derived from call duration — they come from setter_leads or EOD reports only.
 */
function classifyCall(duration) {
  const d = duration || 0
  return {
    pickup: d > 45,
    mc: d >= 60,
  }
}

// Module-level cache for WAVV aggregates. Keyed by `days`, 5-minute TTL.
// WAVV aggregates are called from SalesOverview + SetterOverview + PipelinePerformance,
// each page burning a Supabase aggregation on mount. With cache + inflight dedupe,
// a user hopping between these pages within 5 min sees the third visit in <10ms.
const aggregateCache = new Map() // days → { data, expiresAt }
const aggregateInflight = new Map() // days → promise
const AGG_TTL = 5 * 60 * 1000

/**
 * Fetch per-user WAVV aggregates directly from Supabase.
 * Returns: { totals: {dials,pickups,mcs}, byUser: {[userId]: {dials,pickups,mcs,uniqueContacts,avgDuration}}, uniqueContacts }
 */
export async function fetchWavvAggregates(days = 30) {
  const key = String(days)
  const cached = aggregateCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.data
  if (aggregateInflight.has(key)) return aggregateInflight.get(key)

  const promise = (async () => {
    const result = await fetchWavvAggregatesUncached(days)
    aggregateCache.set(key, { data: result, expiresAt: Date.now() + AGG_TTL })
    aggregateInflight.delete(key)
    return result
  })()
  aggregateInflight.set(key, promise)
  return promise
}

export function clearWavvAggregatesCache() {
  aggregateCache.clear()
  aggregateInflight.clear()
}

async function fetchWavvAggregatesUncached(days = 30) {
  const since = sinceDate(days)

  const rows = []
  const pageSize = 1000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('wavv_calls')
      .select('user_id, phone_number, call_duration')
      .gte('started_at', `${since}T00:00:00`)
      .range(offset, offset + pageSize - 1)

    if (error) {
      console.error('Failed to fetch wavv_calls:', error)
      return { totals: { dials: 0, pickups: 0, mcs: 0 }, byUser: {}, uniqueContacts: 0 }
    }

    const batch = data || []
    rows.push(...batch)
    hasMore = batch.length === pageSize
    offset += pageSize
  }

  const byUser = {}
  const allPhones = new Set()

  for (const r of rows) {
    const uid = r.user_id || 'unknown'
    if (!byUser[uid]) byUser[uid] = { dials: 0, pickups: 0, mcs: 0, totalDuration: 0, phones: new Set() }
    const u = byUser[uid]
    const cls = classifyCall(r.call_duration)
    u.dials++
    if (cls.pickup) u.pickups++
    if (cls.mc) u.mcs++
    u.totalDuration += r.call_duration || 0
    if (r.phone_number) {
      u.phones.add(r.phone_number)
      allPhones.add(r.phone_number)
    }
  }

  let totals = { dials: 0, pickups: 0, mcs: 0 }
  for (const uid of Object.keys(byUser)) {
    const u = byUser[uid]
    u.uniqueContacts = u.phones.size
    u.avgDuration = u.pickups > 0 ? Math.round(u.totalDuration / u.pickups) : 0
    u.avgCallsPerContact = u.uniqueContacts > 0 ? parseFloat((u.dials / u.uniqueContacts).toFixed(1)) : 0
    delete u.phones
    totals.dials += u.dials
    totals.pickups += u.pickups
    totals.mcs += u.mcs
  }

  return { totals, byUser, uniqueContacts: allPhones.size }
}

/**
 * Fetch WAVV calls with phone numbers for Speed to Lead matching.
 */
export async function fetchWavvCallsForSTL(days = 30) {
  const since = sinceDate(days)
  const allCalls = []
  const pageSize = 1000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('wavv_calls')
      .select('phone_number, started_at, user_id')
      .gte('started_at', `${since}T00:00:00`)
      .order('started_at', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (error) {
      console.error('Failed to fetch wavv_calls for STL:', error)
      break
    }

    const rows = data || []
    allCalls.push(...rows)
    hasMore = rows.length === pageSize
    offset += pageSize
  }

  return allCalls
}

/**
 * Legacy: Fetch all WAVV call data (full rows). Use fetchWavvAggregates for overview pages.
 */
export async function fetchWavvCalls(days = 30) {
  const since = sinceDate(days)
  const allCalls = []
  const pageSize = 1000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('wavv_calls')
      .select('call_id, contact_name, phone_number, started_at, call_duration, user_id, team_id')
      .gte('started_at', `${since}T00:00:00`)
      .order('started_at', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (error) {
      console.error('Failed to fetch wavv_calls:', error)
      break
    }

    const rows = data || []
    allCalls.push(...rows)
    hasMore = rows.length === pageSize
    offset += pageSize
  }

  return allCalls
}

export function aggregateByAgent(calls) {
  const byAgent = {}
  for (const c of calls) {
    const key = c.user_id || 'unknown'
    if (!byAgent[key]) byAgent[key] = { dials: 0, pickups: 0, mcs: 0, totalDuration: 0 }
    const a = byAgent[key]
    const cls = classifyCall(c.call_duration)
    a.dials++
    if (cls.pickup) a.pickups++
    if (cls.mc) a.mcs++
    a.totalDuration += c.call_duration || 0
  }
  return byAgent
}

export function aggregateByPhone(calls) {
  const byPhone = {}
  for (const c of calls) {
    const key = c.phone_number
    if (!key) continue
    if (!byPhone[key]) byPhone[key] = { dials: 0, pickups: 0, mcs: 0 }
    const a = byPhone[key]
    const cls = classifyCall(c.call_duration)
    a.dials++
    if (cls.pickup) a.pickups++
    if (cls.mc) a.mcs++
  }
  return byPhone
}

export function aggregateTotals(calls) {
  let dials = 0, pickups = 0, mcs = 0
  for (const c of calls) {
    const cls = classifyCall(c.call_duration)
    dials++
    if (cls.pickup) pickups++
    if (cls.mc) mcs++
  }
  return { dials, pickups, mcs }
}
