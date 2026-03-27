import { supabase } from '../lib/supabase'
import { fetchAllMeetingsSince } from './fathomApi'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Sync Fathom meetings via Supabase Edge Function (legacy).
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

// Daniel's closer ID and email — only his calls get synced
const DANIEL_EMAIL = 'daniel@optdigital.io'

/**
 * Sync Daniel's Fathom calls going back to Dec 1 2025.
 * Only pulls calls where Daniel is an invitee or the recorder.
 * Ben's calls are excluded entirely — he doesn't take sales calls.
 */
export async function syncFathomAllMembers() {
  const FATHOM_KEY = import.meta.env.VITE_FATHOM_API_KEY
  if (!FATHOM_KEY) return { synced: 0, skipped: 0, message: 'Fathom API key not configured' }

  // Fetch all meetings since Dec 1 (paginated)
  const [meetings, existingRes, danielRes] = await Promise.all([
    fetchAllMeetingsSince('2025-12-01'),
    supabase.from('closer_transcripts').select('fathom_meeting_id'),
    supabase.from('team_members').select('id').eq('email', DANIEL_EMAIL).single(),
  ])

  if (!danielRes.data) return { synced: 0, message: 'Daniel not found in team_members' }
  const danielId = danielRes.data.id
  const existingIds = new Set((existingRes.data || []).map(r => r.fathom_meeting_id))

  // Only skip calls where the prospect is an OPT team member (internal-to-internal)
  const INTERNAL_EMAILS = new Set([
    'josh@optdigital.io', 'ben@opt.co.nz', 'ed@opt.co.nz',
    'jaketaroquin@gmail.com',
  ])
  // Only skip calls that are clearly internal team syncs (Daniel/Ben 1:1s, Dennis team calls)
  const INTERNAL_NAMES = ['daniel / ben', 'daniel/ben', 'ben windisch', 'dennis deheza']
  // Only skip summary content that is unambiguously NOT a prospect call
  const NON_SALES_PATTERNS = [
    /team (wins|call|meeting|sync|huddle|standup)/i,
    /weekly (wins|review|sync)/i,
    /process (constraints|updates)/i, /team morale/i,
    /interview.*role|screening.*interview|hiring.*candidate/i,
    /troubleshoot.*optimus|troubleshoot.*bot/i,
    /\b1\/1\b|one.on.one with (ben|josh|ed)/i,
  ]

  let synced = 0, skipped = 0, filtered = 0
  for (const m of meetings) {
    if (existingIds.has(m.id)) { skipped++; continue }

    // Only sync calls where Daniel is a participant
    const allEmails = [
      ...(m.calendar_invitees || []).map(i => (i.email || '').toLowerCase()),
      (m.organizer_email || '').toLowerCase(),
    ]
    if (!allEmails.includes(DANIEL_EMAIL)) { filtered++; continue }

    // Extract prospect (first external invitee)
    const external = (m.calendar_invitees || []).find(i => i.is_external)
    const prospectName = external?.name || m.title || 'Unknown'
    const prospectEmail = (external?.email || '').toLowerCase()

    // Skip internal team calls
    if (INTERNAL_EMAILS.has(prospectEmail)) { filtered++; continue }
    if (INTERNAL_NAMES.some(n => prospectName.toLowerCase().includes(n))) { filtered++; continue }

    // Skip non-sales calls by summary content
    const summaryPreview = (m.summary || '').slice(0, 500)
    if (NON_SALES_PATTERNS.some(p => p.test(summaryPreview))) { filtered++; continue }

    const { error } = await supabase.from('closer_transcripts').insert({
      closer_id: danielId,
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
      if (error.code === '23505') skipped++
      else console.error('Fathom sync insert error:', error)
    } else {
      synced++
    }
  }

  return { synced, skipped, filtered, total: meetings.length, message: `Synced ${synced} new Daniel calls (${skipped} existing, ${filtered} non-Daniel filtered)` }
}
