import { supabase } from '../lib/supabase'
import { BASE_URL, GHL_LOCATION_ID, ghlFetch } from './ghlClient'
import { INTRO_CALENDARS, STRATEGY_CALL_CALENDARS } from '../utils/constants'

// Raw key ref kept local so the "is GHL configured?" guards below can
// short-circuit before any network call. Auth headers live in ghlClient.
const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY

/**
 * Parse a GHL `startTime` / `endTime` string into a normalized
 * `{ appointmentDate: 'YYYY-MM-DD', startTime: 'YYYY-MM-DD HH:MM:SS' }` pair
 * in America/Indiana/Indianapolis (the GHL location timezone).
 *
 * GHL returns two formats depending on the endpoint:
 *   - `/calendars/events` → ISO 8601 with offset, e.g. `2026-05-04T13:00:00-04:00`
 *   - legacy `/contacts/{id}/appointments` → `2026-05-04 13:00:00` (location-local)
 *
 * The legacy code did `(startTime||'').split(' ')[0]` which silently mangled
 * ISO inputs (the whole string ended up in `appointment_date`). This helper
 * normalizes both into the legacy storage format expected by readers.
 */
function parseEventDateTime(s) {
  if (!s) return null
  if (s.includes('T')) {
    const d = new Date(s)
    if (isNaN(d.getTime())) return null
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Indiana/Indianapolis',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]))
    let hour = parts.hour
    if (hour === '24') hour = '00' // en-CA midnight quirk
    const datePart = `${parts.year}-${parts.month}-${parts.day}`
    return { appointmentDate: datePart, startTime: `${datePart} ${hour}:${parts.minute}:${parts.second}` }
  }
  if (s.includes(' ')) {
    return { appointmentDate: s.split(' ')[0], startTime: s }
  }
  return null
}

/**
 * Sync GHL appointments for a date range into the `ghl_appointments` cache.
 *
 * Strategy: query `/calendars/events` two ways and dedupe by `ghl_event_id`.
 *
 *   1. Per `userId` (every team_member with a `ghl_user_id`). Critical because
 *      GHL's `/calendars/?locationId=` endpoint omits round-robin Calendly
 *      mirrors (e.g. `T5Zif5GjDwulya6novU0` "Opt Digital | Strategy Call
 *      (Calendly)"). The user-scoped events endpoint returns events from
 *      those hidden calendars, so a closer's full booked schedule is visible.
 *
 *   2. Per `calendarId` for every known intro + strategy calendar. Catches
 *      events with no `assignedUserId` (rare but happens for self-bookings).
 *
 * The previous implementation paged through up to 2000 contacts and queried
 * `/contacts/{id}/appointments` per contact — slow, capped, and missed any
 * Calendly bookings whose contact landed beyond the 2000-contact ceiling.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD (extended +30d internally to capture
 *   future bookings created during the window)
 * @param {function} onProgress
 * @returns {{ synced: number, scanned: number }}
 */
export async function syncGHLAppointments(startDate, endDate, onProgress = () => {}) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error('GHL API key or Location ID not configured')
  }

  // 1. Team-member roster — used for both user-scoped queries and assignedUserId → closer_id mapping.
  const { data: teamMembers } = await supabase
    .from('team_members')
    .select('id, ghl_user_id, role')
    .not('ghl_user_id', 'is', null)

  const userIdToCloser = {}
  for (const m of teamMembers || []) {
    // Only closers map to closer_id. Setters' GHL IDs are still queried (so we
    // surface their assigned calls into ghl_appointments) but stored with closer_id=null.
    if (m.role === 'closer') userIdToCloser[m.ghl_user_id] = m.id
  }

  // Date range as ms-since-epoch (what /calendars/events expects). Use ET
  // boundaries since the location lives in ET; the +30d future window catches
  // bookings made today for next month.
  const startMs = new Date(`${startDate}T00:00:00-04:00`).getTime()
  const endBase = new Date(`${endDate}T00:00:00-04:00`)
  endBase.setDate(endBase.getDate() + 30)
  const endMs = endBase.getTime()

  // Calendars to scan directly. Set ensures we don't double-fetch a calendar
  // that lives in both lists.
  const calendarsToScan = [...new Set([...INTRO_CALENDARS, ...STRATEGY_CALL_CALENDARS])]

  const eventsByEventId = new Map()

  // 2. Per-user fetches. Sequential to respect GHL's 100 req / 10s limit;
  // ghlFetch handles 429 backoff if we ever burst.
  onProgress(`Fetching events for ${teamMembers?.length || 0} team members...`)
  for (const m of teamMembers || []) {
    const url = `${BASE_URL}/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${encodeURIComponent(m.ghl_user_id)}&startTime=${startMs}&endTime=${endMs}`
    try {
      const r = await ghlFetch(url)
      if (!r.ok) continue
      const json = await r.json()
      for (const e of (json.events || [])) {
        if (e.id) eventsByEventId.set(e.id, e)
      }
    } catch (err) {
      console.warn(`User-events fetch failed for ${m.ghl_user_id}: ${err.message}`)
    }
  }

  // 3. Per-calendar fetches. Only sets if the event isn't already known —
  // user-scoped responses already include assignedUserId, which we want preserved.
  onProgress(`Fetching events for ${calendarsToScan.length} known calendars...`)
  for (const calId of calendarsToScan) {
    const url = `${BASE_URL}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${calId}&startTime=${startMs}&endTime=${endMs}`
    try {
      const r = await ghlFetch(url)
      if (!r.ok) continue
      const json = await r.json()
      for (const e of (json.events || [])) {
        if (e.id && !eventsByEventId.has(e.id)) eventsByEventId.set(e.id, e)
      }
    } catch (err) {
      console.warn(`Calendar-events fetch failed for ${calId}: ${err.message}`)
    }
  }

  onProgress(`Building ${eventsByEventId.size} appointment rows...`)

  // Resolve a closer from an event. Round-robin Calendly calendars set
  // `assignedUserId` to the agency admin (Ben) and put the real participant
  // closers in the `users` array (e.g. ["<adminId>","<closerGhlId>"]). If the
  // direct assignedUserId doesn't map to a closer we know about, scan `users`
  // for one that does. The resolved GHL ID is also returned so it can be
  // stored as `ghl_user_id` — that's what the per-closer OR filter
  // (`closer_id.eq.X OR ghl_user_id.eq.Y`) compares against.
  const resolveCloser = (e) => {
    const direct = userIdToCloser[e.assignedUserId]
    if (direct) return { closerId: direct, ghlUserId: e.assignedUserId }
    if (Array.isArray(e.users)) {
      for (const uid of e.users) {
        if (userIdToCloser[uid]) return { closerId: userIdToCloser[uid], ghlUserId: uid }
      }
    }
    return { closerId: null, ghlUserId: e.assignedUserId || '' }
  }

  // 4. Build upsert rows. Skip cancelled (matches prior sync behavior — cancelled
  // events would inflate booked counts on the marketing tracker).
  const rows = []
  for (const e of eventsByEventId.values()) {
    if (e.appointmentStatus === 'cancelled') continue
    const startParsed = parseEventDateTime(e.startTime)
    if (!startParsed) continue
    const endParsed = parseEventDateTime(e.endTime)
    const { closerId, ghlUserId } = resolveCloser(e)

    rows.push({
      ghl_event_id: e.id,
      closer_id: closerId,
      ghl_user_id: ghlUserId,
      contact_name: e.title || 'Unknown',
      // /calendars/events doesn't include contact email/phone. The form falls
      // back gracefully when these are empty; if we need them we can do a
      // second-pass /contacts/{id} fetch on a per-row basis.
      contact_email: '',
      contact_phone: '',
      start_time: startParsed.startTime,
      end_time: endParsed?.startTime || null,
      // The column is named `calendar_name` for legacy reasons but stores the
      // calendar ID, which is what the strategy/intro filters compare against.
      calendar_name: e.calendarId || '',
      appointment_status: e.appointmentStatus || 'confirmed',
      appointment_date: startParsed.appointmentDate,
      ghl_contact_id: e.contactId || '',
      booked_at: e.dateAdded || null,
    })
  }

  // 5. Tag each appointment with the prospect's monthly-revenue tier (read
  // from GHL contact custom field `Tb6fklGYdWcgl9vUS2q9`). The Marketing page
  // uses this to split bookings into qualified (>$30k) vs DQ ($0-$30k) — a
  // calendar-ID split is unreliable because the same calendar can hold both.
  //
  // Per-contact fetch is sequential to respect GHL's 100req/10s ceiling.
  // Only fetches contacts we don't already have a tier for in this batch
  // (de-duped by contactId). One miss per contact, then memoized.
  await enrichRowsWithRevenueTier(rows, onProgress)

  if (rows.length > 0) {
    const { error } = await supabase
      .from('ghl_appointments')
      .upsert(rows, { onConflict: 'ghl_event_id' })

    if (error) {
      console.error('Failed to sync GHL appointments:', error)
      throw error
    }

    onProgress(`Synced ${rows.length} appointments to database`)
  }

  return { synced: rows.length, scanned: (teamMembers?.length || 0) + calendarsToScan.length }
}

// GHL contact custom field that holds the monthly revenue tier captured by
// the Typeform during qualification. The form mirrors it to a sibling field
// (`eiTsafUsji5ZQHJpcGDk`) — same value, either works. We read the first.
const REVENUE_TIER_FIELD_ID = 'Tb6fklGYdWcgl9vUS2q9'

/**
 * For each row in `rows`, look up the contact's monthly revenue tier from
 * the GHL contact record and write it onto `row.revenue_tier`. Mutates
 * `rows` in place. De-duped by ghl_contact_id so we don't double-fetch.
 *
 * Failures are silent — a row without a revenue tier just classifies as
 * "unknown" downstream (treated as qualified by default to avoid false DQs).
 */
async function enrichRowsWithRevenueTier(rows, onProgress = () => {}) {
  if (!rows || rows.length === 0) return
  const uniqueContactIds = [...new Set(rows.map(r => r.ghl_contact_id).filter(Boolean))]
  if (uniqueContactIds.length === 0) return

  onProgress(`Fetching revenue tiers for ${uniqueContactIds.length} contacts...`)
  const tierByContactId = {}
  for (const id of uniqueContactIds) {
    try {
      const r = await ghlFetch(`${BASE_URL}/contacts/${id}`)
      if (!r.ok) continue
      const j = await r.json()
      const c = j.contact || j
      const field = (c.customFields || []).find(f => f.id === REVENUE_TIER_FIELD_ID)
      if (field?.value) tierByContactId[id] = field.value
    } catch (err) {
      console.warn(`Revenue tier fetch failed for contact ${id}: ${err.message}`)
    }
  }

  for (const row of rows) {
    if (row.ghl_contact_id && tierByContactId[row.ghl_contact_id]) {
      row.revenue_tier = tierByContactId[row.ghl_contact_id]
    }
  }
}

/**
 * Classify a revenue tier value as DQ (≤$30k) or not. The form's tier values
 * include "$0-$30,000", "$30-$50,000", "$50k-$75k/m", "$75k-$100k/m",
 * "$100-250k/m", "$250,000/m+". Only the first one is DQ.
 */
export function isDQRevenueTier(tier) {
  if (!tier) return false
  return /^\$\s*0\s*[-–]/.test(String(tier).trim())
}

// Track sync state to avoid duplicate syncs
const syncInProgress = new Set()
const STALE_MINUTES = 60

/**
 * Check if cached appointments are stale (older than 1 hour).
 */
function isCacheStale(cached) {
  if (!cached || cached.length === 0) return true
  const newest = cached.reduce((latest, row) => {
    const t = new Date(row.updated_at || row.created_at || 0).getTime()
    return t > latest ? t : latest
  }, 0)
  return (Date.now() - newest) > STALE_MINUTES * 60 * 1000
}

/**
 * Fetch calendar events for a closer on a specific date.
 * Auto-syncs from GHL if no cached data or cache is stale (>1 hour).
 * Falls back to setter_leads if GHL is not configured.
 */
export async function fetchCloserCalendar(closerId, dateStr) {
  // Look up the closer's GHL user ID
  const { data: member } = await supabase
    .from('team_members')
    .select('ghl_user_id')
    .eq('id', closerId)
    .single()

  const ghlUserId = member?.ghl_user_id

  // Try cached GHL appointments from Supabase
  if (ghlUserId) {
    const { data: cached, error } = await supabase
      .from('ghl_appointments')
      .select('*')
      .eq('appointment_date', dateStr)
      .or(`closer_id.eq.${closerId},ghl_user_id.eq.${ghlUserId}`)
      .order('start_time', { ascending: true })

    if (!error && cached && cached.length > 0) {
      // If cache is stale, trigger background re-sync
      if (isCacheStale(cached) && GHL_API_KEY && GHL_LOCATION_ID) {
        const syncKey = `${dateStr}`
        if (!syncInProgress.has(syncKey)) {
          syncInProgress.add(syncKey)
          syncGHLAppointments(dateStr, dateStr)
            .catch(err => console.warn('Background GHL re-sync failed:', err.message))
            .finally(() => syncInProgress.delete(syncKey))
        }
      }

      const events = cached.map(row => ({
        ghl_event_id: row.ghl_event_id,
        contact_name: row.contact_name,
        contact_email: row.contact_email || '',
        contact_phone: row.contact_phone || '',
        start_time: row.start_time,
        end_time: row.end_time,
        calendar_name: row.calendar_name || '',
        status: row.appointment_status || 'confirmed',
        notes: row.notes || '',
        ghl_contact_id: row.ghl_contact_id || '',
        existing_status: row.outcome || null,
        revenue_attributed: parseFloat(row.revenue || 0),
      }))
      return { source: 'ghl', events }
    }

    // No cache — auto-sync from GHL if configured
    if (GHL_API_KEY && GHL_LOCATION_ID) {
      const syncKey = `${dateStr}`
      if (!syncInProgress.has(syncKey)) {
        syncInProgress.add(syncKey)
        try {
          const result = await syncGHLAppointments(dateStr, dateStr)
          if (result.synced > 0) {
            // Re-fetch from cache after sync
            const { data: fresh } = await supabase
              .from('ghl_appointments')
              .select('*')
              .eq('appointment_date', dateStr)
              .or(`closer_id.eq.${closerId},ghl_user_id.eq.${ghlUserId}`)
              .order('start_time', { ascending: true })

            if (fresh && fresh.length > 0) {
              const events = fresh.map(row => ({
                ghl_event_id: row.ghl_event_id,
                contact_name: row.contact_name,
                contact_email: row.contact_email || '',
                contact_phone: row.contact_phone || '',
                start_time: row.start_time,
                end_time: row.end_time,
                calendar_name: row.calendar_name || '',
                status: row.appointment_status || 'confirmed',
                notes: row.notes || '',
                ghl_contact_id: row.ghl_contact_id || '',
                existing_status: row.outcome || null,
                revenue_attributed: parseFloat(row.revenue || 0),
              }))
              return { source: 'ghl', events }
            }
          }
        } catch (err) {
          console.warn('Auto GHL sync failed:', err.message)
        } finally {
          syncInProgress.delete(syncKey)
        }
      }
    }
  }

  // Fallback: pull from setter_leads
  const { data: leads } = await supabase
    .from('setter_leads')
    .select('id, lead_name, setter_id, status, appointment_date, date_set, lead_source, revenue_attributed, setter:team_members!setter_leads_setter_id_fkey(name)')
    .eq('closer_id', closerId)
    .eq('appointment_date', dateStr)
    .order('lead_name', { ascending: true })

  const events = (leads || []).map(lead => ({
    ghl_event_id: null,
    lead_id: lead.id,
    contact_name: lead.lead_name,
    contact_email: '',
    contact_phone: '',
    start_time: null,
    end_time: null,
    calendar_name: '',
    status: lead.status,
    notes: '',
    setter_name: lead.setter?.name || '—',
    lead_source: lead.lead_source || 'manual',
    existing_status: lead.status,
    revenue_attributed: parseFloat(lead.revenue_attributed || 0),
  }))

  return { source: 'setter_leads', events }
}
