import { apiProxy } from '../lib/apiProxy'

async function fathomFetch(endpoint, params = {}) {
  return apiProxy('fathom', 'fetch', { endpoint, queryParams: params })
}

/**
 * Fetch meetings from Fathom API.
 * Normalizes the response to consistent field names.
 */
export async function fetchMeetings(limit = 50) {
  const data = await fathomFetch('/meetings', {
    include_summary: 'true',
    include_action_items: 'true',
    limit: String(limit),
  })

  // Normalize Fathom's field names to what our sync code expects
  return (data.items || []).map(m => {
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
  })
}

export function formatDuration(seconds) {
  if (!seconds) return '0 min'
  const mins = Math.round(seconds / 60)
  return `${mins} min`
}
