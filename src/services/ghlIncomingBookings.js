import { supabase } from '../lib/supabase'
import { gradeApplication, GRADE_LABELS } from '../lib/gradeApplication'

const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID
const BASE_URL = 'https://services.leadconnectorhq.com'

const ghlHeaders = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
}

// Field-name patterns we'll match against custom field names (case-insensitive).
// Daniel's GHL has multiple price_point versions (_OLD/_NEW/_Updated); we try the
// freshest first and fall back. Same idea for revenue / monthly call volume.
const FIELD_PATTERNS = {
  revenue: [/monthly[ _]?revenue.*updated/i, /monthly[ _]?revenue.*new/i, /monthly[ _]?revenue/i, /revenue/i],
  pricePoint: [/price[ _]?point.*updated/i, /price[ _]?point.*new/i, /price[ _]?point/i, /average[ _]?ticket/i],
  monthlyCalls: [/monthly[ _]?calls/i, /calls[ _]?per[ _]?month/i, /call[ _]?volume/i, /inbound[ _]?calls/i],
}

let _cachedFieldMap = null

async function getCustomFieldMap() {
  if (_cachedFieldMap) return _cachedFieldMap
  const res = await fetch(`${BASE_URL}/locations/${GHL_LOCATION_ID}/customFields`, { headers: ghlHeaders })
  if (!res.ok) throw new Error(`GHL custom fields fetch failed: ${res.status}`)
  const json = await res.json()
  const fields = json.customFields || []

  const map = { revenue: null, pricePoint: null, monthlyCalls: null }
  for (const key of Object.keys(FIELD_PATTERNS)) {
    for (const pattern of FIELD_PATTERNS[key]) {
      const match = fields.find(f => pattern.test(f.name || ''))
      if (match) { map[key] = match.id; break }
    }
  }
  _cachedFieldMap = map
  return map
}

function readNumeric(contact, fieldId) {
  if (!fieldId) return null
  const cf = (contact.customFields || []).find(c => c.id === fieldId)
  if (!cf) return null
  const raw = cf.value ?? cf.fieldValue ?? cf.fieldValueString
  if (raw == null || raw === '') return null
  // Strip $ , k suffix
  let s = String(raw).trim().toLowerCase().replace(/[$,]/g, '')
  let mult = 1
  if (s.endsWith('k')) { mult = 1000; s = s.slice(0, -1) }
  if (s.endsWith('m')) { mult = 1_000_000; s = s.slice(0, -1) }
  const n = parseFloat(s)
  return isNaN(n) ? null : n * mult
}

/**
 * Sync upcoming GHL appointments into incoming_bookings, applying the grade rubric.
 * Pulls a 7-day forward window by default.
 */
export async function syncIncomingBookings({ daysAhead = 7, onProgress = () => {} } = {}) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) throw new Error('GHL not configured')

  const fieldMap = await getCustomFieldMap()
  onProgress(`Fields: rev=${!!fieldMap.revenue} price=${!!fieldMap.pricePoint} calls=${!!fieldMap.monthlyCalls}`)

  const today = new Date()
  const start = today.toISOString().split('T')[0]
  const endDate = new Date(today.getTime() + daysAhead * 86400000)
  const end = endDate.toISOString().split('T')[0]

  // Pull cached ghl_appointments rows in the window (kept fresh by ghlCalendar.js)
  const { data: appts, error } = await supabase
    .from('ghl_appointments')
    .select('*')
    .gte('appointment_date', start)
    .lte('appointment_date', end)
    .neq('appointment_status', 'cancelled')
    .order('start_time', { ascending: true })

  if (error) throw error
  onProgress(`Found ${appts?.length || 0} bookings in window`)

  // Build closer map (ghl_user_id → team member uuid)
  const { data: members } = await supabase
    .from('team_members')
    .select('id, ghl_user_id')
    .not('ghl_user_id', 'is', null)
  const userIdToCloser = {}
  for (const m of members || []) userIdToCloser[m.ghl_user_id] = m.id

  const rows = []
  // Fetch each contact's custom fields in batches of 10
  for (let i = 0; i < (appts || []).length; i += 10) {
    const batch = appts.slice(i, i + 10)
    const enriched = await Promise.all(batch.map(async (a) => {
      let contact = null
      if (a.ghl_contact_id) {
        try {
          const r = await fetch(`${BASE_URL}/contacts/${a.ghl_contact_id}`, { headers: ghlHeaders })
          if (r.ok) {
            const j = await r.json()
            contact = j.contact || j
          }
        } catch { /* ignore */ }
      }
      const monthlyRevenue = contact ? readNumeric(contact, fieldMap.revenue) : null
      const pricePoint     = contact ? readNumeric(contact, fieldMap.pricePoint) : null
      const monthlyCalls   = contact ? readNumeric(contact, fieldMap.monthlyCalls) : null
      const { grade, reason } = gradeApplication({ monthlyRevenue, pricePoint, monthlyCalls })

      return {
        ghl_event_id:   a.ghl_event_id,
        ghl_contact_id: a.ghl_contact_id || null,
        contact_name:   a.contact_name,
        contact_email:  a.contact_email || null,
        contact_phone:  a.contact_phone || null,
        appointment_date: a.appointment_date,
        start_time:     a.start_time,
        calendar_name:  a.calendar_name || null,
        closer_id:      a.closer_id || userIdToCloser[a.ghl_user_id] || null,
        monthly_revenue: monthlyRevenue,
        price_point:    pricePoint,
        monthly_calls:  monthlyCalls,
        grade,
        grade_reason:   reason,
        recommended_action: GRADE_LABELS[grade].action,
        graded_at:      new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }
    }))
    rows.push(...enriched)
    onProgress(`Graded ${rows.length}/${appts.length}`)
  }

  if (rows.length > 0) {
    const { error: upErr } = await supabase
      .from('incoming_bookings')
      .upsert(rows, { onConflict: 'ghl_event_id' })
    if (upErr) throw upErr
  }

  return { graded: rows.length, fieldMap }
}

/** Read graded bookings from the cache table for the next N days. */
export async function fetchIncomingBookings({ daysAhead = 7 } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const endDate = new Date(Date.now() + daysAhead * 86400000).toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('incoming_bookings')
    .select('*, closer:team_members!incoming_bookings_closer_id_fkey(name)')
    .gte('appointment_date', today)
    .lte('appointment_date', endDate)
    .order('grade', { ascending: false })
    .order('start_time', { ascending: true })

  if (error) throw error
  return data || []
}
