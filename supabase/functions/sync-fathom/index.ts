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
    const fathomKey = Deno.env.get('FATHOM_API_KEY')!

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 1. Fetch meetings from Fathom API
    const fathomRes = await fetch(
      'https://api.fathom.ai/external/v1/meetings?include_summary=true&limit=100',
      { headers: { 'X-Api-Key': fathomKey } }
    )
    if (!fathomRes.ok) {
      throw new Error(`Fathom API ${fathomRes.status}: ${await fathomRes.text()}`)
    }
    const fathomData = await fathomRes.json()
    const meetings = fathomData.items || []

    if (!meetings.length) {
      return new Response(
        JSON.stringify({ synced: 0, skipped: 0, total: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Get closers from team_members
    const { data: closers } = await supabase
      .from('team_members')
      .select('id, name, email')
      .eq('role', 'closer')

    const emailToCloser: Record<string, { id: string; name: string }> = {}
    for (const c of (closers || [])) {
      if (c.email) emailToCloser[c.email.toLowerCase()] = c
    }

    // 3. Get existing fathom_meeting_ids to skip duplicates
    const { data: existing } = await supabase
      .from('closer_transcripts')
      .select('fathom_meeting_id')
    const existingIds = new Set(
      (existing || []).map((r: { fathom_meeting_id: string }) => r.fathom_meeting_id).filter(Boolean)
    )

    let synced = 0
    let skipped = 0

    for (const m of meetings) {
      const meetingId = String(m.recording_id || m.id || '')
      if (!meetingId || existingIds.has(meetingId)) {
        skipped++
        continue
      }

      // Match to closer via internal invitee email
      let closerId: string | null = null
      const invitees = m.calendar_invitees || []

      // Check internal invitees (is_external = false)
      for (const inv of invitees) {
        if (!inv.is_external && inv.email) {
          const match = emailToCloser[inv.email.toLowerCase()]
          if (match) { closerId = match.id; break }
        }
      }

      // Fallback: check recorded_by
      if (!closerId && m.recorded_by?.email) {
        const match = emailToCloser[m.recorded_by.email.toLowerCase()]
        if (match) closerId = match.id
      }

      // Get prospect from external invitees
      const externals = invitees.filter((i: { is_external: boolean }) => i.is_external)
      const prospectName = externals[0]?.name || m.title || 'Unknown'
      const prospectEmail = externals[0]?.email || null

      // Compute duration
      const startTime = m.recording_start_time || m.scheduled_start_time || m.created_at
      const endTime = m.recording_end_time || m.scheduled_end_time
      let durationSecs: number | null = null
      if (startTime && endTime) {
        durationSecs = Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
      }

      // Get summary text
      const summary = m.default_summary?.markdown_formatted || null

      const record = {
        closer_id: closerId,
        fathom_meeting_id: meetingId,
        meeting_date: startTime ? startTime.split('T')[0] : new Date().toISOString().split('T')[0],
        prospect_name: prospectName,
        prospect_email: prospectEmail,
        summary,
        duration_seconds: durationSecs,
        transcript_url: m.share_url || m.url || null,
        outcome: null,
        revenue: 0,
      }

      const { error } = await supabase.from('closer_transcripts').insert(record)
      if (error) {
        console.error('Insert error:', error, record.fathom_meeting_id)
        skipped++
      } else {
        synced++
      }
    }

    return new Response(
      JSON.stringify({ synced, skipped, total: meetings.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
