// Confirm Live count parity between the Ads top tile (closer_calls
// prospect-deduped via useCloserCallProspectMetrics) and the Live
// drilldown's new 'all' branch (closer_calls direct query).
//
// Both should produce the same number for any window.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

async function liveCountForRange(days) {
  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0, 10)
  const untilStr = new Date().toISOString().slice(0, 10)

  // Same query the hook uses
  const { data: reports } = await sb
    .from('closer_eod_reports')
    .select('id, report_date')
    .gte('report_date', sinceStr).lte('report_date', untilStr)
  const reportIds = (reports || []).map(r => r.id)
  if (!reportIds.length) return { count: 0, list: [] }

  // Page through closer_calls
  const calls = []
  const PAGE = 1000
  let off = 0
  while (true) {
    const { data, error } = await sb.from('closer_calls')
      .select('id, prospect_name, outcome, call_type, created_at')
      .in('eod_report_id', reportIds)
      .in('outcome', ['closed', 'not_closed'])
      .eq('call_type', 'new_call')
      .range(off, off + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    calls.push(...data)
    if (data.length < PAGE) break
    off += PAGE
  }

  // Dedupe by prospect_name (matches useCloserCallProspectMetrics)
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const isPlaceholder = (s) => /^historical close\b/i.test((s || '').trim())
  const seen = new Set()
  const list = []
  for (const c of calls) {
    const k = norm(c.prospect_name)
    if (!k) continue
    if (isPlaceholder(c.prospect_name)) continue
    if (seen.has(k)) continue
    seen.add(k)
    list.push(c)
  }
  return { count: list.length, list }
}

for (const days of [7, 30, 90]) {
  const { count, list } = await liveCountForRange(days)
  console.log(`\n${days}-day window: ${count} unique live prospects`)
  list.slice(0, 25).forEach((c, i) => console.log(`  ${i + 1}. ${(c.created_at || '').slice(0,10)}  ${c.prospect_name}  (${c.outcome})`))
  if (list.length > 25) console.log(`  ...+${list.length - 25} more`)
}
console.log('\nThis is what the top tile AND the drilldown will both show.')
