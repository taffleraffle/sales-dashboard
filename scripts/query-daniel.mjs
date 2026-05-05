import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const DANIEL_ID = '76f61d92-83d8-45ec-87a7-82b0dc6d607e'
const sinceDate = '2026-04-28'
const sinceISO = '2026-04-28T00:00:00Z'

// 1. Daniel's EOD reports — what HE filled in
console.log('=== closer_eod_reports — what Daniel reported ===')
const { data: eod, error: eodErr } = await sb.from('closer_eod_reports')
  .select('*')
  .eq('closer_id', DANIEL_ID)
  .gte('report_date', sinceDate)
  .order('report_date', { ascending: false })
if (eodErr) console.log('err', eodErr)
else console.log(JSON.stringify(eod, null, 2))
console.log()

// 2. ALL Fathom transcripts last 7 days — see what's there
console.log('=== closer_transcripts — ALL last 7d (any closer) ===')
const { data: tr } = await sb.from('closer_transcripts')
  .select('id, meeting_date, prospect_name, outcome, duration_seconds, source, closer_id, member:team_members!closer_transcripts_closer_id_fkey(name)')
  .gte('meeting_date', sinceDate)
  .order('meeting_date', { ascending: false })
console.log('count:', tr?.length)
console.log(JSON.stringify(tr, null, 2))
console.log()

// 3. Search for the specific names Ben mentioned
console.log('=== Search transcripts by name (Tom/Steve/Dave/Shain/etc) ===')
const names = ['Thomas','Tom ','Steve','Stephen','Dave','David','Shain','Mann','Gio','Brandi','Kimberly','Isaac','Craig']
for (const n of names) {
  const { data } = await sb.from('closer_transcripts')
    .select('meeting_date, prospect_name, outcome, closer_id')
    .ilike('prospect_name', `%${n}%`)
    .gte('meeting_date', '2026-04-15')
    .order('meeting_date', { ascending: false })
    .limit(5)
  if (data?.length) console.log(`  "${n}":`, JSON.stringify(data))
}
console.log()

// 4. closer_calls with Daniel-named or other names
console.log('=== closer_calls last 7d for ALL closers (to find names) ===')
const { data: allCalls } = await sb.from('closer_calls')
  .select('prospect_name, call_type, outcome, eod_report:closer_eod_reports!closer_calls_eod_report_id_fkey(report_date, closer_id, closer:team_members!closer_eod_reports_closer_id_fkey(name))')
  .gte('created_at', sinceISO)
  .order('created_at', { ascending: false })
console.log('total:', allCalls?.length)
const summary = (allCalls || []).map(c => ({
  closer: c.eod_report?.closer?.name,
  date: c.eod_report?.report_date,
  prospect: c.prospect_name,
  type: c.call_type,
  outcome: c.outcome,
}))
console.log(JSON.stringify(summary, null, 2))
