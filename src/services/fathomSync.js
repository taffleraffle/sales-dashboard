import { supabase } from '../lib/supabase'
import { fetchMeetings } from './fathomApi'

/**
 * Sync Fathom meetings into closer_transcripts table.
 * Matches meetings to closers by comparing Fathom invitee emails
 * to team_members.email in Supabase.
 * Deduplicates on fathom_meeting_id.
 */
export async function syncFathomTranscripts() {
  // Fetch recent meetings from Fathom
  const meetings = await fetchMeetings(100)
  if (!meetings.length) return { synced: 0, skipped: 0 }

  // Get all closers from team_members
  const { data: closers } = await supabase
    .from('team_members')
    .select('id, name, email')
    .eq('role', 'closer')

  // Build email → closer map
  const emailToCloser = {}
  for (const c of (closers || [])) {
    if (c.email) emailToCloser[c.email.toLowerCase()] = c
  }

  // Get existing fathom_meeting_ids to skip duplicates
  const { data: existing } = await supabase
    .from('closer_transcripts')
    .select('fathom_meeting_id')
  const existingIds = new Set((existing || []).map(r => r.fathom_meeting_id).filter(Boolean))

  let synced = 0
  let skipped = 0

  for (const meeting of meetings) {
    const meetingId = meeting.id || meeting.meeting_id
    if (!meetingId || existingIds.has(meetingId)) {
      skipped++
      continue
    }

    // Try to match to a closer via invitee emails (internal = our team)
    const internalEmails = (meeting.calendar_invitees || [])
      .filter(i => !i.is_external)
      .map(i => i.email?.toLowerCase())
      .filter(Boolean)

    const externalEmails = (meeting.calendar_invitees || [])
      .filter(i => i.is_external)
      .map(i => i.email?.toLowerCase())
      .filter(Boolean)

    // Match internal email to a closer
    let closerId = null
    for (const email of internalEmails) {
      if (emailToCloser[email]) {
        closerId = emailToCloser[email].id
        break
      }
    }

    // If no internal match, check if the meeting organizer matches
    if (!closerId && meeting.organizer_email) {
      const orgEmail = meeting.organizer_email.toLowerCase()
      if (emailToCloser[orgEmail]) {
        closerId = emailToCloser[orgEmail].id
      }
    }

    // Get prospect name from external invitees or meeting title
    const externalNames = (meeting.calendar_invitees || [])
      .filter(i => i.is_external)
      .map(i => i.name || i.email)
      .filter(Boolean)
    const prospectName = externalNames[0] || meeting.title || 'Unknown'

    const record = {
      closer_id: closerId,
      fathom_meeting_id: meetingId,
      meeting_date: meeting.start_time ? meeting.start_time.split('T')[0] : new Date().toISOString().split('T')[0],
      prospect_name: prospectName,
      prospect_email: externalEmails[0] || null,
      summary: meeting.summary || null,
      duration_seconds: meeting.duration_seconds || meeting.duration || null,
      transcript_url: meeting.share_url || meeting.recording_url || null,
      outcome: null,
      revenue: 0,
    }

    const { error } = await supabase
      .from('closer_transcripts')
      .insert(record)

    if (error) {
      console.error('Failed to insert transcript:', error, record)
      skipped++
    } else {
      synced++
    }
  }

  return { synced, skipped, total: meetings.length }
}
