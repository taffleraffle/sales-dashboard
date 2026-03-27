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

/**
 * Normalize a single Fathom meeting record to consistent field names.
 */
function normalizeMeeting(m) {
    const startTime = m.recording_start_time || m.scheduled_start_time || m.created_at
    const endTime = m.recording_end_time || m.scheduled_end_time
    const durationSecs = startTime && endTime
      ? Math.round((new Date(endTime) - new Date(startTime)) / 1000)
      : null

  return {
    id: String(m.recording_id || m.id || ''),
    meeting_id: String(m.recording_id || m.id || ''),
    title: m.title || m.meeting_title || '',
    start_time: startTime,
    summary: m.default_summary?.markdown_formatted || m.summary || null,
    duration_seconds: durationSecs,
    share_url: m.share_url || m.url || null,
    recording_url: m.url || m.share_url || null,
    calendar_invitees: m.calendar_invitees || [],
    recorded_by: m.recorded_by || null,
    organizer_email: m.recorded_by?.email || null,
  }
}

/**
 * Fetch meetings from Fathom API with pagination.
 * Fetches all pages until sinceDate is reached or no more results.
 */
export async function fetchMeetings(limit = 50) {
  const data = await fathomFetch('/meetings', {
    include_summary: 'true',
    include_action_items: 'true',
    limit: String(limit),
  })
  return (data.items || []).map(normalizeMeeting)
}

/**
 * Fetch ALL meetings from Fathom going back to a specific date.
 * Fathom returns ~10 items per page with next_cursor pagination.
 * Max 100 pages (should cover ~1000 meetings / several months).
 */
export async function fetchAllMeetingsSince(sinceDate = '2025-12-01') {
  const allMeetings = []
  let cursor = null
  const sinceTs = new Date(sinceDate).getTime()

  for (let page = 0; page < 100; page++) {
    const params = {
      include_summary: 'true',
      include_action_items: 'true',
      limit: '50',
    }
    if (cursor) params.next_cursor = cursor

    const data = await fathomFetch('/meetings', params)
    const items = data.items || []
    if (items.length === 0) break

    const normalized = items.map(normalizeMeeting)
    let reachedCutoff = false
    for (const m of normalized) {
      const meetingTs = m.start_time ? new Date(m.start_time).getTime() : Date.now()
      if (meetingTs < sinceTs) { reachedCutoff = true; break }
      allMeetings.push(m)
    }
    if (reachedCutoff) break

    cursor = data.next_cursor || null
    if (!cursor) break
  }

  return allMeetings
}

export function formatDuration(seconds) {
  if (!seconds) return '0 min'
  const mins = Math.round(seconds / 60)
  return `${mins} min`
}
