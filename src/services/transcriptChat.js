import { supabase } from '../lib/supabase'

/**
 * Build a system prompt containing FULL transcript summaries for the AI chat.
 * No truncation — sends the complete Fathom summary for each call.
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
    const summary = t.summary || ''
    const member = t.member?.name || 'Unassigned'
    const outcome = t.outcome || 'unknown'
    return `### Call #${i + 1}: ${t.prospect_name || 'Unknown'} — ${member} — ${t.meeting_date} — ${fmtDur(t.duration_seconds)} — ${outcome}
${summary}`
  }).join('\n\n---\n\n')

  const today = new Date().toISOString().split('T')[0]

  return `You are a sales call transcript analyst for a high-ticket digital marketing agency. Today is ${today}.

You have access to ${transcripts.length} call transcript summaries from the team's Fathom recordings.

RESPONSE RULES:
- Be CONCISE. Lead with the direct answer in 1-2 sentences. No preamble.
- If asked "what niche closes most?" say "Restoration at 35%" — don't list every niche and their pain points
- Only expand if the user asks for detail. Short answers by default.
- Use bullet points, not paragraphs. Max 5-8 bullet points per response.
- Use a markdown table ONLY when comparing 3+ items side-by-side
- Cite specific prospect names and dates when relevant
- Never repeat back what the user asked. Just answer it.

TRANSCRIPTS:

${transcriptBlocks}`
}
