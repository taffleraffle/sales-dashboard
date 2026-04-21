import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://sales-dashboard-ftct.onrender.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

    const supabase = createClient(supabaseUrl, supabaseKey)

    const { closer_id, days = 30 } = await req.json()

    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceStr = since.toISOString().split('T')[0]

    let query = supabase
      .from('closer_transcripts')
      .select('id, closer_id, prospect_name, summary, meeting_date, transcript_url')
      .gte('meeting_date', sinceStr)
      .not('summary', 'is', null)
      .order('meeting_date', { ascending: false })
      .limit(50)

    if (closer_id) query = query.eq('closer_id', closer_id)

    const { data: transcripts, error: fetchErr } = await query
    if (fetchErr) throw fetchErr
    if (!transcripts?.length) {
      return new Response(
        JSON.stringify({ message: 'No transcripts to analyze', analyzed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Build a lookup for transcript references
    const transcriptMap: Record<number, { name: string; date: string; url: string | null }> = {}
    transcripts.forEach((t, i) => {
      transcriptMap[i + 1] = { name: t.prospect_name, date: t.meeting_date, url: t.transcript_url }
    })

    // Group transcripts by closer_id
    const byCloser: Record<string, typeof transcripts> = {}
    for (const t of transcripts) {
      const key = t.closer_id || 'unmatched'
      if (!byCloser[key]) byCloser[key] = []
      byCloser[key].push(t)
    }

    let totalAnalyzed = 0

    for (const [cId, closerTranscripts] of Object.entries(byCloser)) {
      if (cId === 'unmatched') continue

      // Build transcript summaries with numbered references
      const summaryText = closerTranscripts
        .map((t, i) => `[Call ${i + 1}] ${t.prospect_name} (${t.meeting_date}):\n${t.summary}`)
        .join('\n\n---\n\n')

      // Build reference list for Claude
      const refList = closerTranscripts
        .map((t, i) => `Call ${i + 1}: ${t.prospect_name} (${t.meeting_date})`)
        .join('\n')

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          messages: [{
            role: 'user',
            content: `Analyze these sales call summaries and identify the most common objections raised by prospects.

For each objection category, provide:
1. A short category name (e.g., "Price too high", "Need to think about it")
2. How many times it appeared across all calls
3. Which specific calls it appeared in (use the call numbers: 1, 2, 3, etc.)
4. 1-2 direct quotes or paraphrases from the calls
5. An estimated win rate (% of times the closer overcame this objection and closed the deal)

Call reference list:
${refList}

Return ONLY valid JSON as an array:
[{"category": "...", "count": N, "call_numbers": [1, 3], "quotes": ["...", "..."], "win_rate": N}]

Here are the call summaries:

${summaryText}`
          }],
        }),
      })

      if (!claudeRes.ok) {
        console.error('Claude API error:', await claudeRes.text())
        continue
      }

      const claudeData = await claudeRes.json()
      const responseText = claudeData.content?.[0]?.text || ''

      let objections
      try {
        const jsonMatch = responseText.match(/\[[\s\S]*\]/)
        objections = jsonMatch ? JSON.parse(jsonMatch[0]) : []
      } catch {
        console.error('Failed to parse Claude response:', responseText)
        continue
      }

      const periodStart = sinceStr
      const periodEnd = new Date().toISOString().split('T')[0]

      // Build call references for each objection
      for (const obj of objections) {
        const callRefs = (obj.call_numbers || []).map((n: number) => {
          const t = closerTranscripts[n - 1]
          if (!t) return null
          return {
            prospect: t.prospect_name,
            date: t.meeting_date,
            url: t.transcript_url,
          }
        }).filter(Boolean)

        const { error: upsertErr } = await supabase
          .from('objection_analysis')
          .upsert({
            closer_id: cId,
            period_start: periodStart,
            period_end: periodEnd,
            objection_category: obj.category,
            occurrence_count: obj.count || 1,
            example_quotes: obj.quotes || [],
            win_rate: obj.win_rate ?? null,
            call_references: callRefs,
          }, {
            onConflict: 'closer_id,period_start,period_end,objection_category',
          })

        if (upsertErr) console.error('Upsert error:', upsertErr)
      }

      totalAnalyzed += closerTranscripts.length
    }

    return new Response(
      JSON.stringify({ analyzed: totalAnalyzed, closers: Object.keys(byCloser).filter(k => k !== 'unmatched').length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
