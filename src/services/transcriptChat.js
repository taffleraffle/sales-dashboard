import { supabase } from '../lib/supabase'

/**
 * Build a system prompt containing transcript summaries for the AI chat.
 * Sends full summaries (capped at 1500 chars each, 40 transcripts max).
 */
export async function buildTranscriptContext({ memberId, sinceDate, untilDate } = {}) {
  let query = supabase
    .from('closer_transcripts')
    .select('prospect_name, prospect_email, meeting_date, duration_seconds, summary, outcome, transcript_url, source, closer_id, member:team_members!closer_transcripts_closer_id_fkey(name)')
    .not('summary', 'is', null)
    .order('meeting_date', { ascending: false })
    .limit(40)

  if (memberId) query = query.eq('closer_id', memberId)
  if (sinceDate) query = query.gte('meeting_date', sinceDate)
  if (untilDate) query = query.lte('meeting_date', untilDate)

  const { data: transcripts } = await query

  if (!transcripts?.length) {
    return `You are a sales call transcript analyst. No transcripts are available for the selected filters. Let the user know and suggest they sync Fathom data or adjust their filters.`
  }

  const fmtDur = (s) => {
    if (!s) return '?min'
    const m = Math.round(s / 60)
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}min`
  }

  const transcriptBlocks = transcripts.map((t, i) => {
    const summary = (t.summary || '').slice(0, 1500)
    const member = t.member?.name || 'Unassigned'
    const outcome = t.outcome || 'unknown'
    return `### Call #${i + 1}: ${t.prospect_name || 'Unknown'} — ${member} — ${t.meeting_date} — ${fmtDur(t.duration_seconds)} — ${outcome}
${summary}`
  }).join('\n\n---\n\n')

  const today = new Date().toISOString().split('T')[0]

  return `You are a sales call transcript analyst for a high-ticket digital marketing agency. Today is ${today}.

You have access to ${transcripts.length} call transcript summaries from the team's Fathom recordings.

FORMATTING RULES:
- Be specific — cite prospect names, dates, and direct quotes from summaries
- Use markdown tables for comparisons
- Bold key insights and numbers
- When analyzing objections, group them by category and show frequency
- When comparing team members, show side-by-side stats
- Be direct and analytical — this is for sales leadership

TRANSCRIPTS:

${transcriptBlocks}`
}
