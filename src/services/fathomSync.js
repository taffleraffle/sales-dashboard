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

  // Internal meeting patterns to skip (by title)
  const INTERNAL_TITLE_PATTERNS = [/^impromptu/i, /^standup/i, /^team\s+meeting/i, /^internal/i]
  // Non-sales summary patterns (interviews, internal syncs, staff onboarding)
  const NON_SALES_SUMMARY_PATTERNS = [
    /interview.*role/i, /screening.*interview/i, /hiring/i, /job.*candidate/i,
    /account manager role/i, /role at opt/i,
    /troubleshoot.*bot/i, /troubleshoot.*optimus/i,
    /onboard.*payment process/i, /onboard.*team best practice/i,
  ]
  // Known internal contact emails (not prospects)
  const INTERNAL_CONTACTS = new Set(['jaketaroquin@gmail.com', 'kenleejobhunting@gmail.com', 'valeriabadillo234@gmail.com'])
  const teamEmails = new Set(Object.keys(emailMap))

  let synced = 0, skipped = 0, filtered = 0
  for (const m of meetings) {
    if (existingIds.has(m.id)) { skipped++; continue }

    // Skip internal meetings by title
    const title = m.title || ''
    if (INTERNAL_TITLE_PATTERNS.some(p => p.test(title))) { filtered++; continue }

    // Skip meetings where the prospect is actually an internal team member
    const external = (m.calendar_invitees || []).find(i => i.is_external)
    const prospectEmail = external?.email?.toLowerCase() || null
    if (prospectEmail && teamEmails.has(prospectEmail)) { filtered++; continue }

    // Skip known internal contacts
    if (prospectEmail && INTERNAL_CONTACTS.has(prospectEmail)) { filtered++; continue }

    // Skip meetings with no external invitees and a generic title (likely internal)
    if (!external && !title.includes(' - ') && (m.calendar_invitees || []).length <= 2) { filtered++; continue }

    // Skip if summary indicates non-sales (interview, internal troubleshooting, staff onboarding)
    const summaryPreview = (m.summary || '').slice(0, 400)
    if (NON_SALES_SUMMARY_PATTERNS.some(p => p.test(summaryPreview))) { filtered++; continue }

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

    // Prospect name/email from the external invitee we already found
    const prospectName = external?.name || m.title || 'Unknown'

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

  return { synced, skipped, filtered, total: meetings.length, message: `Synced ${synced} new calls (${skipped} existing, ${filtered} internal filtered)` }
}
