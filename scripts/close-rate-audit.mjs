// Close-rate audit. Compares the current (call-level) close rate formula
// against a prospect-deduped formula, per closer, last 30 days.
//
// Run: node scripts/close-rate-audit.mjs
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const DAYS = parseInt(process.argv[2]) || 30
const since = new Date(Date.now() - DAYS * 86400e3).toISOString().slice(0, 10)

const { data: members } = await sb.from('team_members').select('id, name').eq('role', 'closer')
const closersById = Object.fromEntries(members.map(m => [m.id, m.name]))

const { data: reports } = await sb
  .from('closer_eod_reports')
  .select('id, closer_id, report_date')
  .gte('report_date', since)

const reportToCloser = Object.fromEntries(reports.map(r => [r.id, r.closer_id]))
const reportIds = reports.map(r => r.id)

if (reportIds.length === 0) { console.log('No EOD reports in window'); process.exit(0) }

const { data: calls } = await sb
  .from('closer_calls')
  .select('eod_report_id, call_type, outcome, prospect_name')
  .in('eod_report_id', reportIds)

const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')

const byCloser = {}
for (const c of calls) {
  const cid = reportToCloser[c.eod_report_id]
  if (!cid) continue
  if (!byCloser[cid]) byCloser[cid] = {
    ncCloses: 0, fuCloses: 0, ncLive: 0, fuLive: 0,
    livePeople: new Set(), closedPeople: new Set(),
    ncLivePeople: new Set(), ncClosedPeople: new Set(),
    fuOnlyPeople: new Set(),
  }
  const b = byCloser[cid]
  const isNew = c.call_type === 'new_call'
  const isFu  = c.call_type === 'follow_up'
  // For show-rate purposes, an ascended-client call is "live". For close
  // rate it is NOT — ascensions are existing-client upgrades, not new
  // closes. Mirror the current code: only NC + FU contribute to close-rate
  // numerator/denominator.
  const isCloseEligible = isNew || isFu
  const isLiveForClose = isCloseEligible && ['closed', 'not_closed'].includes(c.outcome)
  const isClose = isCloseEligible && c.outcome === 'closed'
  const name = norm(c.prospect_name)
  if (isNew && c.outcome === 'closed') b.ncCloses++
  if (isFu  && c.outcome === 'closed') b.fuCloses++
  if (isNew && ['closed', 'not_closed'].includes(c.outcome)) b.ncLive++
  if (isFu  && ['closed', 'not_closed'].includes(c.outcome)) b.fuLive++
  if (isLiveForClose && name) {
    b.livePeople.add(name)
    if (isNew) b.ncLivePeople.add(name)
  }
  if (isClose && name) {
    b.closedPeople.add(name)
    if (isNew) b.ncClosedPeople.add(name)
  }
}

// fuOnlyPeople = live FU-only prospects (no NC live in window)
for (const cid of Object.keys(byCloser)) {
  const b = byCloser[cid]
  for (const p of b.livePeople) if (!b.ncLivePeople.has(p)) b.fuOnlyPeople.add(p)
}

const pad = (s, n) => String(s).padEnd(n)
const padR = (s, n) => String(s).padStart(n)
const pct = (n, d) => d > 0 ? `${(n / d * 100).toFixed(1)}%` : '—'

const header = `${pad('Closer', 18)} ${padR('Current closeRate', 18)} ${padR('Current netClose', 16)} ${padR('Prospect-level', 16)} ${padR('Δ vs current', 14)} ${padR('FU-only', 8)}`
console.log(`Window: last ${DAYS} days (since ${since})\n`)
console.log(header)
console.log('-'.repeat(header.length))

const rows = []
let totals = { ncCloses: 0, fuCloses: 0, ncLive: 0, fuLive: 0, live: new Set(), closed: new Set(), fuOnly: new Set() }

for (const [cid, b] of Object.entries(byCloser)) {
  const name = closersById[cid] || cid.slice(0, 8)
  const cur     = b.ncLive > 0 ? b.ncCloses / b.ncLive : null
  const net     = b.ncLive > 0 ? (b.ncCloses + b.fuCloses) / b.ncLive : null
  const proposed = b.livePeople.size > 0 ? b.closedPeople.size / b.livePeople.size : null
  rows.push({ name, cur, net, proposed, b })
  totals.ncCloses += b.ncCloses
  totals.fuCloses += b.fuCloses
  totals.ncLive   += b.ncLive
  totals.fuLive   += b.fuLive
  for (const p of b.livePeople)  totals.live.add(p)
  for (const p of b.closedPeople) totals.closed.add(p)
  for (const p of b.fuOnlyPeople) totals.fuOnly.add(p)
}

rows.sort((a, b) => (b.proposed ?? 0) - (a.proposed ?? 0))
for (const r of rows) {
  const cur = pct(r.b.ncCloses, r.b.ncLive)
  const net = pct(r.b.ncCloses + r.b.fuCloses, r.b.ncLive)
  const pp  = pct(r.b.closedPeople.size, r.b.livePeople.size)
  const delta = (r.proposed != null && r.cur != null)
    ? `${((r.proposed - r.cur) * 100).toFixed(1)}pp`
    : '—'
  console.log(`${pad(r.name, 18)} ${padR(cur, 18)} ${padR(net, 16)} ${padR(pp, 16)} ${padR(delta, 14)} ${padR(r.b.fuOnlyPeople.size, 8)}`)
}

console.log('-'.repeat(header.length))
const cur = pct(totals.ncCloses, totals.ncLive)
const net = pct(totals.ncCloses + totals.fuCloses, totals.ncLive)
const pp  = pct(totals.closed.size, totals.live.size)
console.log(`${pad('COMPANY', 18)} ${padR(cur, 18)} ${padR(net, 16)} ${padR(pp, 16)} ${padR('—', 14)} ${padR(totals.fuOnly.size, 8)}`)

console.log(`\nRow counts: ${calls.length} calls across ${reportIds.length} reports`)
console.log(`Unique live prospects (company): ${totals.live.size}`)
console.log(`Unique closed prospects (company): ${totals.closed.size}`)
console.log(`Prospects with NO live NC in window (FU-only — currently invisible to denom): ${totals.fuOnly.size}`)

// Sanity: name-collision risk. How many prospect names appear under >1 closer?
const seen = new Map()
for (const [cid, b] of Object.entries(byCloser)) {
  for (const p of b.livePeople) {
    if (!seen.has(p)) seen.set(p, new Set())
    seen.get(p).add(cid)
  }
}
const shared = [...seen.entries()].filter(([, s]) => s.size > 1)
console.log(`Prospect names attached to >1 closer: ${shared.length} (potential cross-closer dedup noise — usually fine, can be a real handoff)`)

// How many prospect_name values are blank/null in the data we read?
const nullNames = calls.filter(c => !norm(c.prospect_name) && c.outcome).length
console.log(`Calls with empty prospect_name (will be excluded from prospect-level math): ${nullNames}`)
