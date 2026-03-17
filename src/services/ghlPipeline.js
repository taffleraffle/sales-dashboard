const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID
const BASE_URL = 'https://services.leadconnectorhq.com'

const ghlHeaders = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
}

// Wavv dialer tag classification
const WAVV_DIAL_TAGS = new Set([
  'wavv-no-answer', 'wavv-left-voicemail', 'wavv-bad-number',
  'wavv-interested', 'wavv-appointment-set', 'wavv-not-interested',
  'wavv-callback', 'wavv-do-not-contact', 'wavv-none',
])
const WAVV_PICKUP_TAGS = new Set([
  'wavv-interested', 'wavv-appointment-set', 'wavv-not-interested',
  'wavv-callback', 'wavv-do-not-contact',
])
const WAVV_MC_TAGS = new Set([
  'wavv-interested', 'wavv-appointment-set', 'wavv-not-interested',
  'wavv-callback',
])
const WAVV_SET_TAGS = new Set(['wavv-appointment-set'])

function classifyWavvTags(tags) {
  const wavv = (tags || []).filter(t => WAVV_DIAL_TAGS.has(t))
  return {
    dials: wavv.length,
    pickups: wavv.filter(t => WAVV_PICKUP_TAGS.has(t)).length,
    mcs: wavv.filter(t => WAVV_MC_TAGS.has(t)).length,
    sets: wavv.filter(t => WAVV_SET_TAGS.has(t)).length,
  }
}

// Stage name patterns → bucket categories
const STAGE_BUCKETS = [
  { key: 'new_leads', label: 'New Leads', pattern: /^new.lead/i, color: 'text-blue-400' },
  { key: 'contacting', label: 'Contacting', pattern: /^contact(ed)?\s*\d|^lead.contact/i, color: 'text-opt-yellow' },
  { key: 'triage', label: 'Triage', pattern: /triage|auto.booked/i, color: 'text-purple-400' },
  { key: 'set_calls', label: 'Set Calls', pattern: /set.call|proposal/i, color: 'text-cyan-400' },
  { key: 'no_shows', label: 'No Shows', pattern: /no.show/i, color: 'text-danger' },
  { key: 'follow_ups', label: 'Follow Ups', pattern: /follow.up|nurture/i, color: 'text-orange-400' },
  { key: 'closed', label: 'Closed / Won', pattern: /closed|ascend|won/i, color: 'text-success' },
  { key: 'lost', label: 'Lost / Dead', pattern: /not.interested|unqualified|not.responsive|dead|dud/i, color: 'text-text-400' },
]

function classifyStage(stageName) {
  const clean = stageName.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim()
  for (const bucket of STAGE_BUCKETS) {
    if (bucket.pattern.test(clean)) return bucket.key
  }
  return 'other'
}

/**
 * Fetch all pipelines and their stages for this location.
 */
export async function fetchPipelines() {
  const res = await fetch(
    `${BASE_URL}/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`,
    { headers: ghlHeaders }
  )
  const data = await res.json()
  return (data.pipelines || []).map(p => ({
    id: p.id,
    name: p.name,
    stages: (p.stages || [])
      .sort((a, b) => a.position - b.position)
      .map(s => ({ id: s.id, name: s.name, position: s.position })),
  }))
}

/**
 * Fetch all opportunities for a given pipeline, paginating through results.
 */
export async function fetchOpportunities(pipelineId, onProgress) {
  const all = []
  let url = `${BASE_URL}/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipelineId}&limit=100`

  while (url && all.length < 5000) {
    const res = await fetch(url, { headers: ghlHeaders })
    const data = await res.json()
    const opps = data.opportunities || []
    all.push(...opps)
    if (onProgress) onProgress(all.length, data.meta?.total || all.length)
    url = data.meta?.nextPageUrl || null
  }

  return all
}

/**
 * Build a full pipeline summary with stage counts, buckets, and metrics.
 */
export async function fetchPipelineSummary(pipelineId, stages, onProgress) {
  const opps = await fetchOpportunities(pipelineId, onProgress)

  // Build stage map for quick lookup
  const stageMap = {}
  stages.forEach(s => { stageMap[s.id] = s.name })

  // Count by stage
  const stageCounts = {}
  stages.forEach(s => { stageCounts[s.name] = 0 })
  opps.forEach(o => {
    const name = stageMap[o.pipelineStageId] || 'Unknown'
    stageCounts[name] = (stageCounts[name] || 0) + 1
  })

  // Group into buckets
  const buckets = {}
  STAGE_BUCKETS.forEach(b => { buckets[b.key] = { ...b, count: 0, stages: [] } })
  buckets.other = { key: 'other', label: 'Other', color: 'text-text-400', count: 0, stages: [] }

  stages.forEach(s => {
    const bucketKey = classifyStage(s.name)
    const count = stageCounts[s.name] || 0
    if (buckets[bucketKey]) {
      buckets[bucketKey].count += count
      buckets[bucketKey].stages.push({ name: s.name.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim(), count })
    }
  })

  // Count by assigned user
  const assignedCounts = {}
  opps.forEach(o => {
    const uid = o.assignedTo || 'unassigned'
    assignedCounts[uid] = (assignedCounts[uid] || 0) + 1
  })

  // Total monetary value
  const totalValue = opps.reduce((s, o) => s + (o.monetaryValue || 0), 0)

  // Status breakdown
  const statusCounts = {}
  opps.forEach(o => {
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1
  })

  // Wavv metrics per stage — classify tags on each opportunity's contact
  const stageWavv = {}
  stages.forEach(s => { stageWavv[s.id] = { dials: 0, pickups: 0, mcs: 0, sets: 0 } })
  const totalWavv = { dials: 0, pickups: 0, mcs: 0, sets: 0 }
  opps.forEach(o => {
    const tags = o.contact?.tags || []
    const w = classifyWavvTags(tags)
    const sw = stageWavv[o.pipelineStageId]
    if (sw) {
      sw.dials += w.dials; sw.pickups += w.pickups; sw.mcs += w.mcs; sw.sets += w.sets
    }
    totalWavv.dials += w.dials; totalWavv.pickups += w.pickups; totalWavv.mcs += w.mcs; totalWavv.sets += w.sets
  })

  // Per-stage funnel: for each stage compute how many reached it and conversion to next
  // "Reached this stage" = everyone currently AT this stage or any stage AFTER it
  const stageFlow = []
  let cumulativeAfter = 0
  // Walk stages in reverse to compute cumulative
  const stageList = [...stages].reverse()
  const reachedMap = {}
  for (const s of stageList) {
    const count = stageCounts[s.name] || 0
    cumulativeAfter += count
    reachedMap[s.name] = cumulativeAfter
  }
  // Now walk forward to build flow data
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]
    const count = stageCounts[s.name] || 0
    const reached = reachedMap[s.name] || 0
    const nextReached = i < stages.length - 1 ? (reachedMap[stages[i + 1].name] || 0) : 0
    const conversionToNext = reached > 0 ? ((nextReached / reached) * 100) : 0
    const reachedFromTotal = opps.length > 0 ? ((reached / opps.length) * 100) : 0
    const w = stageWavv[s.id] || { dials: 0, pickups: 0, mcs: 0, sets: 0 }
    stageFlow.push({
      name: s.name.replace(/[🔵🟡🟢🔴🟣🟠]/g, '').trim(),
      id: s.id,
      position: s.position,
      count,
      reached,
      reachedPct: parseFloat(reachedFromTotal.toFixed(1)),
      conversionToNext: parseFloat(conversionToNext.toFixed(1)),
      bucket: classifyStage(s.name),
      wavv: w,
    })
  }

  return {
    total: opps.length,
    stageCounts,
    stageFlow,
    buckets: Object.values(buckets).filter(b => b.count > 0),
    assignedCounts,
    totalValue,
    statusCounts,
    totalWavv,
    opportunities: opps,
  }
}

/**
 * Fetch all pipelines with their summaries in parallel.
 */
export async function fetchAllPipelineSummaries(onProgress) {
  const pipelines = await fetchPipelines()
  const results = await Promise.all(
    pipelines.map(async (p) => {
      const summary = await fetchPipelineSummary(p.id, p.stages, (loaded, total) => {
        if (onProgress) onProgress(p.name, loaded, total)
      })
      return { ...p, summary }
    })
  )
  return results.filter(p => p.summary.total > 0)
}

/**
 * Compute speed-to-lead metrics by matching GHL opportunity phones to WAVV calls.
 * @param {Array} opportunities - GHL opportunities (with contact.phone, createdAt)
 * @param {Array} wavvCalls - WAVV call rows from Supabase (with phone_number, started_at)
 * @returns {Object} Speed to lead stats
 */
export function computeSpeedToLead(opportunities, wavvCalls, appointments = []) {
  // Build map of contact phone/id → appointment info
  const appointmentByPhone = {}
  const appointmentByContactId = {}
  for (const a of appointments) {
    if (a.contact_phone) {
      const phone = normalizePhone(a.contact_phone)
      if (phone) appointmentByPhone[phone] = a
    }
    if (a.ghl_contact_id) appointmentByContactId[a.ghl_contact_id] = a
  }

  // Build map of phone → earliest wavv call
  const firstCallByPhone = {}
  for (const c of wavvCalls) {
    const phone = normalizePhone(c.phone_number)
    if (!phone) continue
    const ts = new Date(c.started_at).getTime()
    if (!firstCallByPhone[phone] || ts < firstCallByPhone[phone]) {
      firstCallByPhone[phone] = ts
    }
  }

  const times = []       // response times in seconds
  const leads = []       // per-lead detail for table display
  const perSetter = {}   // user_id → [seconds]
  const daily = {}       // date → [seconds]

  // Also build phone → user_id from wavv calls for per-setter attribution
  const phoneToUser = {}
  for (const c of wavvCalls) {
    const phone = normalizePhone(c.phone_number)
    if (phone && c.user_id) phoneToUser[phone] = c.user_id
  }

  const uncalledLeads = []

  // Helper to get booking info for a lead
  const getBooking = (phone, contactId) => {
    const appt = (phone && appointmentByPhone[phone]) || (contactId && appointmentByContactId[contactId]) || null
    if (!appt) return { hasBooking: false, bookingCalendar: null, bookingDate: null, bookingCloserId: null }
    return {
      hasBooking: true,
      bookingCalendar: appt.calendar_name || 'Booked',
      bookingDate: appt.appointment_date || appt.start_time?.split('T')[0] || null,
      bookingCloserId: appt.closer_id || appt.ghl_user_id || null,
    }
  }

  for (const opp of opportunities) {
    const phone = normalizePhone(opp.contact?.phone)
    const createdAt = opp.createdAt ? new Date(opp.createdAt).getTime() : null
    if (!createdAt) continue

    const firstCall = phone ? firstCallByPhone[phone] : null
    const booking = getBooking(phone, opp.contact?.id)

    if (!firstCall || !phone) {
      uncalledLeads.push({
        name: opp.contact?.name || 'Unknown',
        phone: phone || '',
        created: opp.createdAt,
        calledAt: null,
        responseSecs: null,
        responseDisplay: 'Not Called',
        setterId: null,
        uncalled: true,
        ...booking,
      })
      continue
    }

    const diffSecs = (firstCall - createdAt) / 1000
    if (diffSecs < -3600) {
      uncalledLeads.push({
        name: opp.contact?.name || 'Unknown',
        phone,
        created: opp.createdAt,
        calledAt: null,
        responseSecs: null,
        responseDisplay: 'Not Called',
        setterId: null,
        uncalled: true,
        ...booking,
      })
      continue
    }

    const secs = Math.max(0, diffSecs)
    times.push(secs)
    const userId = phoneToUser[phone]
    leads.push({
      name: opp.contact?.name || 'Unknown',
      phone,
      created: opp.createdAt,
      calledAt: new Date(firstCall).toISOString(),
      responseSecs: Math.round(secs),
      responseDisplay: fmtDuration(secs),
      setterId: userId || null,
      uncalled: false,
      ...booking,
    })

    // Per-setter
    if (userId) {
      if (!perSetter[userId]) perSetter[userId] = []
      perSetter[userId].push(secs)
    }

    // Daily
    const day = new Date(createdAt).toISOString().split('T')[0]
    if (!daily[day]) daily[day] = []
    daily[day].push(secs)
  }

  times.sort((a, b) => a - b)
  leads.sort((a, b) => new Date(b.created) - new Date(a.created))
  uncalledLeads.sort((a, b) => new Date(b.created) - new Date(a.created))
  // All leads: called first (sorted by newest), then uncalled (sorted by newest)
  const allLeads = [...leads, ...uncalledLeads].sort((a, b) => new Date(b.created) - new Date(a.created))

  const avg = times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0
  const median = times.length > 0 ? times[Math.floor(times.length / 2)] : 0
  const fastest = times.length > 0 ? times[0] : 0
  const slowest = times.length > 0 ? times[times.length - 1] : 0

  return {
    totalLeads: opportunities.length,
    worked: times.length,
    notCalled: uncalledLeads.length,
    leads,
    allLeads,
    avgSecs: Math.round(avg),
    avgDisplay: fmtDuration(avg),
    medianSecs: Math.round(median),
    medianDisplay: fmtDuration(median),
    fastestSecs: Math.round(fastest),
    fastestDisplay: fmtDuration(fastest),
    slowestSecs: Math.round(slowest),
    slowestDisplay: fmtDuration(slowest),
    under5m: times.filter(t => t < 300).length,
    under30m: times.filter(t => t < 1800).length,
    under1h: times.filter(t => t < 3600).length,
    over24h: times.filter(t => t >= 86400).length,
    pctUnder5m: times.length > 0 ? parseFloat(((times.filter(t => t < 300).length / times.length) * 100).toFixed(1)) : 0,
    pctUnder1h: times.length > 0 ? parseFloat(((times.filter(t => t < 3600).length / times.length) * 100).toFixed(1)) : 0,
    perSetter,
    daily: Object.entries(daily)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, arr]) => ({
        date,
        count: arr.length,
        avgSecs: Math.round(arr.reduce((s, t) => s + t, 0) / arr.length),
        avgDisplay: fmtDuration(arr.reduce((s, t) => s + t, 0) / arr.length),
      })),
  }
}

function normalizePhone(phone) {
  if (!phone) return null
  return phone.replace(/\D/g, '').slice(-10) // last 10 digits
}

function fmtDuration(secs) {
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  if (secs < 86400) return `${h}h ${m}m`
  const d = Math.floor(secs / 86400)
  const hr = Math.round((secs % 86400) / 3600)
  return `${d}d ${hr}h`
}

export { STAGE_BUCKETS }
