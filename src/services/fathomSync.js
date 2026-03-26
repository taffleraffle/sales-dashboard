import { supabase } from '../lib/supabase'
import { fetchMeetings } from './fathomApi'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Sync Fathom meetings via Supabase Edge Function.
 * The edge function handles the Fathom API call server-side (avoids CORS),
 * matches meetings to closers by email, and inserts into closer_transcripts.
 */
export async function syncFathomTranscripts() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-fathom`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Edge function error: ${res.status}`)
  }

  return res.json()
}

/**
 * Client-side Fathom sync that matches ALL team members (not just closers).
 * Falls back gracefully if the Fathom API key isn't configured.
 */
export async function syncFathomAllMembers() {
  const FATHOM_KEY = import.meta.env.VITE_FATHOM_API_KEY
  if (!FATHOM_KEY) return { synced: 0, skipped: 0, message: 'Fathom API key not configured' }

  const [meetings, membersRes, existingRes] = await Promise.all([
    fetchMeetings(100),
    supabase.from('team_members').select('id, name, email').eq('is_active', true),
    supabase.from('closer_transcripts').select('fathom_meeting_id'),
  ])

  const existingIds = new Set((existingRes.data || []).map(r => r.fathom_meeting_id))
  const emailMap = {}
  for (const m of (membersRes.data || [])) {
    if (m.email) emailMap[m.email.toLowerCase()] = m
  }

  let synced = 0, skipped = 0
  for (const m of meetings) {
    if (existingIds.has(m.id)) { skipped++; continue }

    // Match team member from calendar invitees (internal) or recorded_by
    let memberId = null
    for (const inv of (m.calendar_invitees || [])) {
      if (!inv.is_external && inv.email) {
        const match = emailMap[inv.email.toLowerCase()]
        if (match) { memberId = match.id; break }
      }
    }
    if (!memberId && m.organizer_email) {
      const match = emailMap[m.organizer_email.toLowerCase()]
      if (match) memberId = match.id
    }

    // Extract prospect (first external invitee)
    const external = (m.calendar_invitees || []).find(i => i.is_external)
    const prospectName = external?.name || m.title || 'Unknown'
    const prospectEmail = external?.email || null

    const { error } = await supabase.from('closer_transcripts').insert({
      closer_id: memberId,
      fathom_meeting_id: m.id,
      prospect_name: prospectName,
      prospect_email: prospectEmail,
      meeting_date: m.start_time ? m.start_time.split('T')[0] : null,
      duration_seconds: m.duration_seconds,
      summary: m.summary,
      transcript_url: m.share_url || m.recording_url,
      source: 'fathom',
    })

    if (error) {
      if (error.code === '23505') skipped++ // duplicate
      else console.error('Fathom sync insert error:', error)
    } else {
      synced++
    }
  }

  return { synced, skipped, total: meetings.length, message: `Synced ${synced} new calls (${skipped} already existed)` }
}
