import { supabase } from '../lib/supabase'
import { BASE_URL, GHL_LOCATION_ID, ghlFetch } from './ghlClient'

// Raw key ref kept local so the "is GHL configured?" guards below can
// short-circuit before any network call. Auth headers live in ghlClient.
const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY

/**
 * Sync all GHL appointments for a date range to Supabase.
 * Scans ALL contacts in the location and checks each for appointments.
 * Slow (~30-60s) but comprehensive. Run from Settings page.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {function} onProgress - callback(message)
 * @returns {{ synced: number, scanned: number }}
 */
export async function syncGHLAppointments(startDate, endDate, onProgress = () => {}) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error('GHL API key or Location ID not configured')
  }

  // Get team members with GHL user IDs for mapping
  const { data: teamMembers } = await supabase
    .from('team_members')
    .select('id, ghl_user_id')
    .not('ghl_user_id', 'is', null)

  const userIdToCloser = {}
  for (const m of teamMembers || []) {
    if (m.ghl_user_id) userIdToCloser[m.ghl_user_id] = m.id
  }

  // Paginate through ALL contacts in the location
  let allContacts = []
  let startAfterId = null
  let startAfter = null
  let page = 0

  onProgress('Fetching contacts...')

  while (page < 20) { // Max 2000 contacts
    const params = new URLSearchParams({
      locationId: GHL_LOCATION_ID,
      limit: '100',
    })
    if (startAfterId) {
      params.set('startAfterId', startAfterId)
      params.set('startAfter', String(startAfter))
    }

    const res = await ghlFetch(`${BASE_URL}/contacts/?${params}`)
    if (!res.ok) break

    const json = await res.json()
    const contacts = json.contacts || []
    allContacts = allContacts.concat(contacts)

    onProgress(`Fetched ${allContacts.length} contacts...`)

    if (!json.meta?.nextPageUrl || contacts.length === 0) break
    startAfterId = json.meta.startAfterId
    startAfter = json.meta.startAfter
    page++
  }

  onProgress(`Scanning ${allContacts.length} contacts for appointments...`)

  // Check each contact for appointments in the date range
  // Extend end date 30 days forward to catch future bookings made today
  const allAppointments = []
  const dateStartFilter = `${startDate} 00:00:00`
  const futureEnd = new Date(endDate + 'T00:00:00')
  futureEnd.setDate(futureEnd.getDate() + 30)
  const dateEndFilter = `${futureEnd.toISOString().split('T')[0]} 23:59:59`

  for (let i = 0; i < allContacts.length; i += 10) {
    if (i > 0 && i % 100 === 0) await new Promise(r => setTimeout(r, 1000))
    const batch = allContacts.slice(i, i + 10)
    const results = await Promise.all(
      batch.map(async (contact) => {
        try {
          const res = await ghlFetch(
            `${BASE_URL}/contacts/${contact.id}/appointments`
          )
          if (!res.ok) return []
          const json = await res.json()
          return (json.events || [])
            .filter(e => {
              const st = e.startTime || ''
              return st >= dateStartFilter && st <= dateEndFilter
                && e.appointmentStatus !== 'cancelled'
            })
            .map(e => ({
              ...e,
              _contact: contact,
            }))
        } catch {
          return []
        }
      })
    )
    results.forEach(events => allAppointments.push(...events))
    onProgress(`Scanned ${Math.min(i + 10, allContacts.length)}/${allContacts.length} contacts (${allAppointments.length} appointments found)`)
  }

  // Upsert to Supabase
  if (allAppointments.length > 0) {
    const rows = allAppointments.map(e => {
      const apptDate = (e.startTime || '').split(' ')[0]
      const closerId = userIdToCloser[e.assignedUserId] || null

      return {
        ghl_event_id: e.id,
        closer_id: closerId,
        ghl_user_id: e.assignedUserId || '',
        contact_name: e.title || `${e._contact.firstName || ''} ${e._contact.lastName || ''}`.trim() || 'Unknown',
        contact_email: e._contact.email || '',
        contact_phone: e._contact.phone || '',
        // GHL returns times in location timezone (America/Indiana/Indianapolis)
        // Store as-is without Z suffix so they're interpreted as local time
        start_time: e.startTime || null,
        end_time: e.endTime || null,
        calendar_name: e.calendarId || '',
        appointment_status: e.appointmentStatus || 'confirmed',
        appointment_date: apptDate,
        ghl_contact_id: e.contactId || e._contact.id || '',
        booked_at: e.dateAdded || null,
      }
    })

    const { error } = await supabase
      .from('ghl_appointments')
      .upsert(rows, { onConflict: 'ghl_event_id' })

    if (error) {
      console.error('Failed to sync GHL appointments:', error)
      throw error
    }

    onProgress(`Synced ${rows.length} appointments to database`)
  }

  return { synced: allAppointments.length, scanned: allContacts.length }
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
