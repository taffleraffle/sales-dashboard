#!/usr/bin/env node
/**
 * QA Validation Script — Sales Dashboard
 * Audits data integrity across all sources: Supabase, GHL, Meta, EOD reports.
 *
 * Usage: node scripts/qa-validate.mjs
 * Env: requires .env with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_GHL_API_KEY, etc.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env manually (no dotenv dep)
const envPath = resolve(process.cwd(), '.env')
const envContent = readFileSync(envPath, 'utf-8')
const env = {}
envContent.split('\n').forEach(line => {
  const eq = line.indexOf('=')
  if (eq === -1 || line.startsWith('#')) return
  env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
})

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const results = []
let passCount = 0
let warnCount = 0
let failCount = 0

function pass(test, detail) {
  passCount++
  results.push({ status: 'PASS', test, detail })
  console.log(`  \x1b[32m✓\x1b[0m ${test}${detail ? ` — ${detail}` : ''}`)
}

function warn(test, detail) {
  warnCount++
  results.push({ status: 'WARN', test, detail })
  console.log(`  \x1b[33m⚠\x1b[0m ${test}${detail ? ` — ${detail}` : ''}`)
}

function fail(test, detail) {
  failCount++
  results.push({ status: 'FAIL', test, detail })
  console.log(`  \x1b[31m✗\x1b[0m ${test}${detail ? ` — ${detail}` : ''}`)
}

// ─── Test Groups ───

async function testTeamMembers() {
  console.log('\n\x1b[1m[Team Members]\x1b[0m')
  const { data, error } = await supabase.from('team_members').select('*')
  if (error) return fail('team_members table accessible', error.message)
  pass('team_members table accessible', `${data.length} members`)

  const active = data.filter(m => m.is_active)
  const setters = active.filter(m => m.role === 'setter')
  const closers = active.filter(m => m.role === 'closer')
  if (setters.length > 0) pass('Active setters exist', `${setters.length} setters`)
  else warn('No active setters found')
  if (closers.length > 0) pass('Active closers exist', `${closers.length} closers`)
  else warn('No active closers found')

  const noGhl = active.filter(m => !m.ghl_user_id)
  if (noGhl.length > 0) warn(`${noGhl.length} active member(s) missing ghl_user_id`, noGhl.map(m => m.name).join(', '))
  else pass('All active members have ghl_user_id')
}

async function testSetterEODs() {
  console.log('\n\x1b[1m[Setter EOD Reports]\x1b[0m')
  const since = new Date()
  since.setDate(since.getDate() - 7)
  const sinceStr = since.toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('setter_eod_reports')
    .select('*, setter:team_members(name)')
    .gte('report_date', sinceStr)
  if (error) return fail('setter_eod_reports query', error.message)

  if (data.length > 0) pass('Recent setter EODs exist', `${data.length} in last 7 days`)
  else warn('No setter EOD reports in last 7 days')

  // Check for negative values
  const negatives = data.filter(r => r.outbound_calls < 0 || r.sets < 0 || r.total_leads < 0)
  if (negatives.length > 0) fail('Negative values in setter EODs', `${negatives.length} report(s) with negative metrics`)
  else pass('No negative values in setter EODs')

  // Check for impossibly high values
  const suspicious = data.filter(r => r.outbound_calls > 500 || r.sets > 50)
  if (suspicious.length > 0) warn(`${suspicious.length} setter EOD(s) with unusually high values`, suspicious.map(r => `${r.setter?.name}: ${r.outbound_calls} dials on ${r.report_date}`).join('; '))
  else pass('Setter EOD values within normal range')

  // Check sets <= dials
  const badRatio = data.filter(r => r.sets > r.outbound_calls && r.outbound_calls > 0)
  if (badRatio.length > 0) warn(`${badRatio.length} EOD(s) where sets > dials`, badRatio.map(r => `${r.setter?.name}: ${r.sets} sets, ${r.outbound_calls} dials on ${r.report_date}`).join('; '))
  else pass('Sets ≤ dials in all setter EODs')
}

async function testCloserEODs() {
  console.log('\n\x1b[1m[Closer EOD Reports]\x1b[0m')
  const since = new Date()
  since.setDate(since.getDate() - 7)
  const sinceStr = since.toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('closer_eod_reports')
    .select('*, closer:team_members(name)')
    .gte('report_date', sinceStr)
  if (error) return fail('closer_eod_reports query', error.message)

  if (data.length > 0) pass('Recent closer EODs exist', `${data.length} in last 7 days`)
  else warn('No closer EOD reports in last 7 days')

  // Check live calls <= booked
  const badShows = data.filter(r => {
    const booked = (r.nc_booked || 0) + (r.fu_booked || 0)
    const live = (r.live_nc_calls || 0) + (r.live_fu_calls || 0)
    return live > booked && booked > 0
  })
  if (badShows.length > 0) warn(`${badShows.length} closer EOD(s) where live calls > booked`, badShows.map(r => `${r.closer?.name} on ${r.report_date}`).join('; '))
  else pass('Live calls ≤ booked calls in all closer EODs')

  // Check closes <= offers
  const badCloses = data.filter(r => r.closes > r.offers && r.offers > 0)
  if (badCloses.length > 0) warn(`${badCloses.length} closer EOD(s) where closes > offers`, badCloses.map(r => `${r.closer?.name}: ${r.closes} closes, ${r.offers} offers on ${r.report_date}`).join('; '))
  else pass('Closes ≤ offers in all closer EODs')

  // Check revenue consistency
  const badRevenue = data.filter(r => {
    const expected = parseFloat(r.offer1_revenue || 0) + parseFloat(r.offer2_revenue || 0)
    const actual = parseFloat(r.total_revenue || 0)
    return expected > 0 && actual > 0 && Math.abs(expected - actual) > 1
  })
  if (badRevenue.length > 0) warn(`${badRevenue.length} closer EOD(s) where offer1+offer2 revenue != total`, badRevenue.map(r => `${r.closer?.name} on ${r.report_date}`).join('; '))
  else pass('Revenue totals consistent in closer EODs')
}

async function testSetterLeads() {
  console.log('\n\x1b[1m[Setter Leads]\x1b[0m')
  const { data, error, count } = await supabase
    .from('setter_leads')
    .select('*', { count: 'exact' })
  if (error) return fail('setter_leads query', error.message)

  pass('setter_leads accessible', `${count} total leads`)

  // Check for valid statuses
  const validStatuses = ['set', 'booked', 'showed', 'not_closed', 'closed', 'no_show', 'cancelled']
  const badStatus = data.filter(l => !validStatuses.includes(l.status))
  if (badStatus.length > 0) fail(`${badStatus.length} lead(s) with invalid status`, badStatus.slice(0, 5).map(l => `${l.lead_name}: "${l.status}"`).join('; '))
  else pass('All leads have valid status values')

  // Check for leads without setter_id
  const noSetter = data.filter(l => !l.setter_id)
  if (noSetter.length > 0) warn(`${noSetter.length} lead(s) missing setter_id`)
  else pass('All leads have setter_id')

  // Check for orphaned closer_ids
  const { data: members } = await supabase.from('team_members').select('id')
  const memberIds = new Set((members || []).map(m => m.id))
  const orphanedCloser = data.filter(l => l.closer_id && !memberIds.has(l.closer_id))
  if (orphanedCloser.length > 0) fail(`${orphanedCloser.length} lead(s) with orphaned closer_id (FK broken)`)
  else pass('All closer_id references are valid')

  // Check for stale "set" leads (appointment_date passed, still status='set')
  const today = new Date().toISOString().split('T')[0]
  const stale = data.filter(l => l.status === 'set' && l.appointment_date && l.appointment_date < today)
  if (stale.length > 0) warn(`${stale.length} lead(s) still status='set' but appointment date has passed`, `Oldest: ${stale.sort((a, b) => a.appointment_date.localeCompare(b.appointment_date))[0]?.appointment_date}`)
  else pass('No stale set leads with past appointment dates')
}

async function testGHLAppointments() {
  console.log('\n\x1b[1m[GHL Appointments]\x1b[0m')
  const { data, error, count } = await supabase
    .from('ghl_appointments')
    .select('*', { count: 'exact' })
  if (error) return fail('ghl_appointments query', error.message)

  pass('ghl_appointments accessible', `${count} total`)

  // Check for appointments without closer_id
  const noCloser = data.filter(a => !a.closer_id)
  if (noCloser.length > 0) warn(`${noCloser.length} appointment(s) not matched to a closer`, 'Missing ghl_user_id mapping')
  else pass('All appointments matched to closers')

  // Check for duplicates on same day for same contact
  const seen = new Set()
  const dupes = []
  for (const a of data) {
    const key = `${a.ghl_contact_id}|${a.appointment_date}`
    if (a.ghl_contact_id && seen.has(key)) dupes.push(a)
    seen.add(key)
  }
  if (dupes.length > 0) warn(`${dupes.length} potential duplicate appointments (same contact + date)`)
  else pass('No duplicate appointments detected')

  // Check for missing booked_at field
  const noBookedAt = data.filter(a => !a.booked_at)
  if (noBookedAt.length > 0) warn(`${noBookedAt.length}/${data.length} appointments missing booked_at field`, 'Run GHL resync to backfill')
  else pass('All appointments have booked_at populated')
}

async function testMarketingTracker() {
  console.log('\n\x1b[1m[Marketing Tracker]\x1b[0m')
  const { data, error } = await supabase
    .from('marketing_tracker')
    .select('*')
    .order('date', { ascending: false })
    .limit(60)
  if (error) return fail('marketing_tracker query', error.message)

  if (data.length > 0) pass('marketing_tracker has data', `${data.length} recent days`)
  else return warn('marketing_tracker is empty — run sync')

  // Check for zero-adspend days (could indicate sync failure)
  const zeroSpend = data.filter(r => parseFloat(r.adspend || 0) === 0)
  if (zeroSpend.length > data.length * 0.5) warn(`${zeroSpend.length}/${data.length} days with $0 adspend`, 'May indicate Meta sync issues')
  else pass('Adspend data looks populated', `${data.length - zeroSpend.length}/${data.length} days with spend`)

  // Check for negative values
  const negMetrics = data.filter(r => parseFloat(r.adspend || 0) < 0 || (r.leads || 0) < 0)
  if (negMetrics.length > 0) fail(`${negMetrics.length} day(s) with negative adspend or leads`)
  else pass('No negative values in marketing tracker')

  // Check leads vs auto_bookings ratio (bookings can't exceed leads by a lot)
  const badBookings = data.filter(r => (r.auto_bookings || 0) > (r.leads || 0) * 3 && (r.leads || 0) > 0)
  if (badBookings.length > 0) warn(`${badBookings.length} day(s) where auto_bookings > 3x leads`, 'Review booking logic')
  else pass('Auto bookings to leads ratio is reasonable')
}

async function testMarketingDaily() {
  console.log('\n\x1b[1m[Marketing Daily (Meta Ads)]\x1b[0m')
  const { data, error, count } = await supabase
    .from('marketing_daily')
    .select('*', { count: 'exact' })
    .order('date', { ascending: false })
    .limit(30)
  if (error) return fail('marketing_daily query', error.message)

  if (count > 0) pass('Meta Ads data synced', `${count} total rows`)
  else return warn('marketing_daily is empty — run Meta sync')

  // Check for stale data (no recent entries)
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const recent = data.filter(r => r.date >= yesterday)
  if (recent.length > 0) pass('Meta Ads data is fresh', `Latest: ${data[0]?.date}`)
  else warn('Meta Ads data may be stale', `Latest entry: ${data[0]?.date}`)
}

async function testWavvCalls() {
  console.log('\n\x1b[1m[WAVV Calls]\x1b[0m')
  const { count, error } = await supabase
    .from('wavv_calls')
    .select('*', { count: 'exact', head: true })
  if (error) return fail('wavv_calls query', error.message)

  if (count > 0) pass('WAVV calls data exists', `${count} total rows`)
  else warn('wavv_calls is empty — check Zapier integration')
}

async function testDataConsistency() {
  console.log('\n\x1b[1m[Cross-Source Consistency]\x1b[0m')
  const since = new Date()
  since.setDate(since.getDate() - 14)
  const sinceStr = since.toISOString().split('T')[0]

  // Compare setter_leads count vs setter EOD sets count
  const { data: leads } = await supabase.from('setter_leads').select('date_set').gte('date_set', sinceStr)
  const { data: eods } = await supabase.from('setter_eod_reports').select('sets').gte('report_date', sinceStr)
  const leadCount = (leads || []).length
  const eodSets = (eods || []).reduce((s, r) => s + (r.sets || 0), 0)

  if (leadCount > 0 || eodSets > 0) {
    const diff = Math.abs(leadCount - eodSets)
    const pctDiff = Math.max(leadCount, eodSets) > 0 ? (diff / Math.max(leadCount, eodSets)) * 100 : 0
    if (pctDiff > 50) warn(`setter_leads (${leadCount}) vs EOD sets (${eodSets}) differ by ${pctDiff.toFixed(0)}%`, 'Large discrepancy — check if setters are logging leads')
    else pass(`setter_leads (${leadCount}) vs EOD sets (${eodSets}) within range`, `${pctDiff.toFixed(0)}% difference`)
  } else {
    warn('No setter leads or EOD data in last 14 days to compare')
  }

  // Check closer EOD vs GHL appointments
  const { data: closerEods } = await supabase
    .from('closer_eod_reports')
    .select('report_date, nc_booked, fu_booked')
    .gte('report_date', sinceStr)
  const { data: appts } = await supabase
    .from('ghl_appointments')
    .select('appointment_date')
    .gte('appointment_date', sinceStr)
    .neq('appointment_status', 'cancelled')

  const eodBooked = (closerEods || []).reduce((s, r) => s + (r.nc_booked || 0) + (r.fu_booked || 0), 0)
  const ghlCount = (appts || []).length

  if (eodBooked > 0 || ghlCount > 0) {
    const diff = Math.abs(eodBooked - ghlCount)
    if (diff > ghlCount * 0.5 && ghlCount > 5) warn(`Closer EOD booked (${eodBooked}) vs GHL appointments (${ghlCount}) differ significantly`)
    else pass(`Closer EOD booked (${eodBooked}) vs GHL appointments (${ghlCount}) aligned`)
  }
}

async function testReconciliation() {
  console.log('\n\x1b[1m[Lead Reconciliation]\x1b[0m')
  const today = new Date().toISOString().split('T')[0]
  const since = new Date()
  since.setDate(since.getDate() - 14)
  const sinceStr = since.toISOString().split('T')[0]

  const { data: pastAppts } = await supabase
    .from('ghl_appointments')
    .select('ghl_event_id, outcome, appointment_date')
    .gte('appointment_date', sinceStr)
    .lte('appointment_date', today)
    .neq('appointment_status', 'cancelled')

  const total = (pastAppts || []).length
  const withOutcome = (pastAppts || []).filter(a => a.outcome && ['no_show', 'showed', 'not_closed', 'closed'].includes(a.outcome)).length
  const pct = total > 0 ? ((withOutcome / total) * 100).toFixed(1) : 100

  if (total === 0) return pass('No past appointments to reconcile')
  if (pct >= 80) pass(`${pct}% of past appointments have outcomes`, `${withOutcome}/${total}`)
  else if (pct >= 50) warn(`Only ${pct}% of past appointments have outcomes`, `${total - withOutcome} unreconciled`)
  else fail(`Only ${pct}% of past appointments reconciled`, `${total - withOutcome} missing outcomes`)
}

// ─── Run All Tests ───

async function main() {
  console.log('\n\x1b[1m\x1b[36m━━━ Sales Dashboard QA Validation ━━━\x1b[0m')
  console.log(`  Date: ${new Date().toISOString().split('T')[0]}`)
  console.log(`  Supabase: ${env.VITE_SUPABASE_URL}`)

  await testTeamMembers()
  await testSetterEODs()
  await testCloserEODs()
  await testSetterLeads()
  await testGHLAppointments()
  await testMarketingTracker()
  await testMarketingDaily()
  await testWavvCalls()
  await testDataConsistency()
  await testReconciliation()

  console.log('\n\x1b[1m━━━ Summary ━━━\x1b[0m')
  console.log(`  \x1b[32m${passCount} passed\x1b[0m  \x1b[33m${warnCount} warnings\x1b[0m  \x1b[31m${failCount} failed\x1b[0m`)

  if (failCount > 0) {
    console.log('\n\x1b[31mFailed checks:\x1b[0m')
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  ✗ ${r.test}: ${r.detail}`))
  }
  if (warnCount > 0) {
    console.log('\n\x1b[33mWarnings:\x1b[0m')
    results.filter(r => r.status === 'WARN').forEach(r => console.log(`  ⚠ ${r.test}: ${r.detail}`))
  }

  console.log('')
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('\x1b[31mFatal error:\x1b[0m', err)
  process.exit(1)
})
