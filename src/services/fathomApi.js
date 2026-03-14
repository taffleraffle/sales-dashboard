const FATHOM_API_KEY = import.meta.env.VITE_FATHOM_API_KEY
const BASE_URL = 'https://api.fathom.ai/external/v1'

async function fathomFetch(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const res = await fetch(url, {
    headers: { 'X-Api-Key': FATHOM_API_KEY },
  })
  if (!res.ok) throw new Error(`Fathom API ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function fetchMeetings(limit = 50) {
  const data = await fathomFetch('/meetings', {
    include_summary: 'true',
    include_action_items: 'true',
    limit: String(limit),
  })
  return data.items || []
}

/**
 * Match Fathom meetings to closers by comparing invitee emails
 * against GHL calendar booking emails.
 */
export function matchMeetingToCloser(meeting, closerGhlMap, calendarEvents) {
  const inviteeEmails = (meeting.calendar_invitees || [])
    .filter(i => i.is_external)
    .map(i => i.email?.toLowerCase())
    .filter(Boolean)

  // Find a GHL calendar event with a matching contact email
  for (const event of calendarEvents) {
    const contactEmail = (event.contact?.email || '').toLowerCase()
    if (!contactEmail) continue
    if (inviteeEmails.includes(contactEmail)) {
      // Match the GHL event's assignedTo to a closer
      const assignedTo = event.assignedTo || event.assignedUserId || ''
      const closer = closerGhlMap[assignedTo]
      return {
        closerId: closer?.id || null,
        closerName: closer?.name || 'Unknown',
        prospectEmail: contactEmail,
        prospectName: event.contact?.name || meeting.title || 'Unknown',
        calendarEventId: event.id,
      }
    }
  }

  // Fallback: try matching by meeting title containing prospect name
  return {
    closerId: null,
    closerName: 'Unmatched',
    prospectEmail: inviteeEmails[0] || '',
    prospectName: meeting.title || 'Unknown',
    calendarEventId: null,
  }
}

export function formatDuration(seconds) {
  if (!seconds) return '0 min'
  const mins = Math.round(seconds / 60)
  return `${mins} min`
}
