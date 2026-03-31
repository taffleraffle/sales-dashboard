const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID
const GHL_BASE = 'https://services.leadconnectorhq.com'
const ghlHeaders = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
}

function normalizePhone(phone) {
  if (!phone) return null
  return phone.replace(/\D/g, '').slice(-10)
}

/**
 * Fetch upcoming appointments live from GHL calendars (next 7 days).
 * Returns events with contactId, title, startTime, calendarName.
 */
export async function fetchUpcomingAppointments() {
  const now = Date.now()
  const in7d = now + 7 * 24 * 3600000

  // Get all calendars
  const calRes = await fetch(`${GHL_BASE}/calendars/?locationId=${GHL_LOCATION_ID}`, { headers: ghlHeaders })
  if (!calRes.ok) return []
  const { calendars } = await calRes.json()

  // Only check strategy call calendars (not intro/auto-booked calls)
  const strategyCals = calendars.filter(c => /strategy/i.test(c.name))

  // Fetch events from strategy calendars in parallel
  const results = await Promise.allSettled(
    strategyCals.map(async (cal) => {
      const r = await fetch(
        `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${cal.id}&startTime=${now}&endTime=${in7d}`,
        { headers: ghlHeaders }
      )
      if (!r.ok) return []
      const d = await r.json()
      return (d.events || [])
        .filter(e => e.appointmentStatus !== 'cancelled' && !e.deleted)
        .map(e => ({
          ghl_event_id: e.id,
          ghl_contact_id: e.contactId,
          contact_name: e.title || '(Unknown)',
          startTime: e.startTime,
          appointment_date: e.startTime?.split('T')[0],
          calendarName: cal.name,
          appointmentStatus: e.appointmentStatus,
        }))
    })
  )

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
}

/**
 * Fetch contact phone from GHL by contactId.
 */
async function fetchContactPhone(contactId) {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders })
    if (!r.ok) return null
    const d = await r.json()
    return d.contact?.phone || null
  } catch {
    return null
  }
}

/**
 * Check a single contact's GHL conversation for inbound replies within 24h of appointment.
 * Returns which channels they replied on (SMS, email, call).
 */
async function checkContactEngagement(ghlContactId, apptTime) {
  const empty = { hasInbound: false, lastOutboundDate: null, channels: [] }
  if (!ghlContactId) return empty

  try {
    const convRes = await fetch(
      `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${ghlContactId}`,
      { headers: ghlHeaders }
    )
    if (!convRes.ok) return empty

    const convData = await convRes.json()
    const conv = convData.conversations?.[0]
    if (!conv) return empty

    const lastOutboundDate = conv.lastMessageDate ? new Date(conv.lastMessageDate) : null

    const msgRes = await fetch(
      `${GHL_BASE}/conversations/${conv.id}/messages`,
      { headers: ghlHeaders }
    )
    if (!msgRes.ok) return { hasInbound: false, lastOutboundDate, channels: [] }

    const msgData = await msgRes.json()
    const messages = msgData.messages?.messages || []

    // Only count inbound messages within 24h before the appointment
    const cutoff = new Date(apptTime.getTime() - 24 * 3600000)
    const recentInbound = messages.filter(m =>
      m.direction === 'inbound' && new Date(m.dateAdded) >= cutoff
    )

    // Classify channels
    const channels = new Set()
    for (const m of recentInbound) {
      const t = (m.messageType || '').toUpperCase()
      if (t.includes('SMS') || t.includes('TYPE_SMS')) channels.add('SMS')
      else if (t.includes('EMAIL') || t.includes('TYPE_EMAIL')) channels.add('Email')
      else if (t.includes('CALL') || t.includes('TYPE_CALL') || t.includes('CUSTOM_CALL')) channels.add('Call')
      else if (t.includes('FB') || t.includes('FACEBOOK') || t.includes('IG')) channels.add('Social')
      else channels.add('SMS') // default to SMS for unknown text-based
    }

    return {
      hasInbound: recentInbound.length > 0,
      lastOutboundDate,
      channels: [...channels],
    }
  } catch {
    return empty
  }
}

/**
 * Fetch live upcoming appointments from GHL, check engagement signals,
 * and return only UNENGAGED leads sorted by urgency.
 *
 * @param {Array} wavvCalls - wavv_calls rows with phone_number, call_duration (pre-fetched)
 * @param {function} onProgress - optional callback(message) for loading state
 * @returns {Array} endangered leads
 */
export async function checkEndangeredLeads(wavvCalls = [], onProgress = () => {}) {
  // Build WAVV lookup: normalized phone → longest call duration
  const wavvByPhone = {}
  for (const c of wavvCalls) {
    const phone = normalizePhone(c.phone_number)
    if (!phone) continue
    if (!wavvByPhone[phone] || c.call_duration > wavvByPhone[phone]) {
      wavvByPhone[phone] = c.call_duration
    }
  }

  onProgress('Fetching upcoming appointments from GHL...')
  const appointments = await fetchUpcomingAppointments()
  if (!appointments.length) return []

  onProgress(`Checking engagement for ${appointments.length} upcoming leads...`)
  const now = new Date()

  // Check engagement for each appointment in parallel
  const results = await Promise.allSettled(
    appointments.map(async (appt) => {
      // Fetch contact phone from GHL
      const phone = await fetchContactPhone(appt.ghl_contact_id)
      const normalizedPhone = normalizePhone(phone)
      const longestCall = normalizedPhone ? (wavvByPhone[normalizedPhone] || 0) : 0
      const hasCall = longestCall > 30

      const apptTime = new Date(appt.startTime)
      const { hasInbound, lastOutboundDate, channels } = await checkContactEngagement(appt.ghl_contact_id, apptTime)

      // Add 'Call' channel if they had a 30s+ WAVV call
      const allChannels = [...channels]
      if (hasCall && !allChannels.includes('Call')) allChannels.push('Call')

      const hoursUntil = (apptTime - now) / 3600000
      const tier = hoursUntil <= 24 ? 'critical' : hoursUntil <= 48 ? 'warning' : 'monitor'

      const engaged = hasInbound || hasCall

      return {
        ...appt,
        contact_phone: phone,
        hasInbound,
        hasCall,
        longestCall,
        lastOutboundDate,
        engaged,
        channels: allChannels,
        tier: engaged ? 'confirmed' : tier,
        hoursUntil: Math.round(hoursUntil),
        apptTime,
      }
    })
  )

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => {
      // Endangered first, then by appointment time
      if (a.engaged !== b.engaged) return a.engaged ? 1 : -1
      return a.apptTime - b.apptTime
    })
}
