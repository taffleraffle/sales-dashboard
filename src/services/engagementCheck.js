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

async function checkContactEngagement(ghlContactId) {
  if (!ghlContactId) return { hasInbound: false, lastOutboundDate: null }

  try {
    // Step 1: Get conversation for this contact
    const convRes = await fetch(
      `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${ghlContactId}`,
      { headers: ghlHeaders }
    )
    if (!convRes.ok) return { hasInbound: false, lastOutboundDate: null }

    const convData = await convRes.json()
    const conv = convData.conversations?.[0]
    if (!conv) return { hasInbound: false, lastOutboundDate: null }

    const lastOutboundDate = conv.lastMessageDate ? new Date(conv.lastMessageDate) : null

    // Step 2: Get messages and check for any inbound
    const msgRes = await fetch(
      `${GHL_BASE}/conversations/${conv.id}/messages`,
      { headers: ghlHeaders }
    )
    if (!msgRes.ok) return { hasInbound: false, lastOutboundDate }

    const msgData = await msgRes.json()
    const messages = msgData.messages?.messages || []
    const hasInbound = messages.some(m => m.direction === 'inbound')

    return { hasInbound, lastOutboundDate }
  } catch {
    return { hasInbound: false, lastOutboundDate: null }
  }
}

/**
 * Check upcoming appointments for engagement signals.
 * Returns only UNENGAGED leads sorted by urgency.
 *
 * @param {Array} appointments - ghl_appointments with ghl_contact_id, contact_phone, appointment_date, start_time, contact_name
 * @param {Array} wavvCalls - wavv_calls rows with phone_number, call_duration
 * @returns {Array} endangered leads with engagement details
 */
export async function checkEndangeredLeads(appointments, wavvCalls = []) {
  // Build WAVV lookup: normalized phone → longest call duration
  const wavvByPhone = {}
  for (const c of wavvCalls) {
    const phone = normalizePhone(c.phone_number)
    if (!phone) continue
    if (!wavvByPhone[phone] || c.call_duration > wavvByPhone[phone]) {
      wavvByPhone[phone] = c.call_duration
    }
  }

  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 3600000)
  const in48h = new Date(now.getTime() + 48 * 3600000)

  // Filter to next 48h, no outcome yet
  const upcoming = appointments.filter(a => {
    const apptTime = new Date(a.appointment_date + 'T' + (a.start_time || '12:00:00'))
    return apptTime > now && apptTime <= in48h && !a.outcome
  })

  if (!upcoming.length) return []

  // Check engagement for each appointment in parallel
  const results = await Promise.allSettled(
    upcoming.map(async (appt) => {
      const phone = normalizePhone(appt.contact_phone)
      const longestCall = phone ? (wavvByPhone[phone] || 0) : 0
      const hasCall = longestCall > 30

      const { hasInbound, lastOutboundDate } = await checkContactEngagement(appt.ghl_contact_id)

      const apptTime = new Date(appt.appointment_date + 'T' + (appt.start_time || '12:00:00'))
      const hoursUntil = (apptTime - now) / 3600000
      const tier = hoursUntil <= 24 ? 'critical' : 'warning'

      const engaged = hasInbound || hasCall

      return {
        ...appt,
        hasInbound,
        hasCall,
        longestCall,
        lastOutboundDate,
        engaged,
        tier,
        hoursUntil: Math.round(hoursUntil),
        apptTime,
      }
    })
  )

  return results
    .filter(r => r.status === 'fulfilled' && !r.value.engaged)
    .map(r => r.value)
    .sort((a, b) => a.apptTime - b.apptTime)
}
