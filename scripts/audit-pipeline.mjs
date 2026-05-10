// End-to-end audit of every metric path the Marketing dashboard depends on.
// Goal: catch anything that's set up wrong, missing, or out of sync BEFORE
// Ben goes to use the dashboard.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const checks = []
const log = (status, name, detail = '') => {
  checks.push({ status, name, detail })
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'WARN' ? '!' : '?'
  console.log(`  [${icon}] ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(' END-TO-END PIPELINE AUDIT')
console.log('════════════════════════════════════════════════════════════\n')

// ─────────────────────────────────────────────────────────────────────
console.log('1. SCHEMA — required columns exist?')
// ─────────────────────────────────────────────────────────────────────
{
  const { error } = await supabase.from('ghl_appointments').select('revenue_tier').limit(1)
  if (error) log('FAIL', 'ghl_appointments.revenue_tier exists', error.message)
  else log('PASS', 'ghl_appointments.revenue_tier exists')
}
{
  const { error } = await supabase.from('ghl_appointments').select('booked_at').limit(1)
  if (error) log('FAIL', 'ghl_appointments.booked_at exists', error.message)
  else log('PASS', 'ghl_appointments.booked_at exists')
}
{
  const { error } = await supabase.from('closer_eod_reports').select('nc_cancels, fu_cancels').limit(1)
  if (error) log('FAIL', 'closer_eod_reports.nc_cancels + fu_cancels exist', error.message + ' — Ben needs to run migration 026')
  else log('PASS', 'closer_eod_reports.nc_cancels + fu_cancels exist')
}
{
  const { error } = await supabase.from('marketing_tracker').select('cancelled_by_prospect, new_live_calls, qualified_bookings').limit(1)
  if (error) log('FAIL', 'marketing_tracker has expected columns', error.message)
  else log('PASS', 'marketing_tracker has cancelled_by_prospect, new_live_calls, qualified_bookings')
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n2. DATA COVERAGE — recent bookings tagged correctly?')
// ─────────────────────────────────────────────────────────────────────
const since30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0] })()
{
  const { data, count: total } = await supabase
    .from('ghl_appointments')
    .select('revenue_tier, ghl_contact_id', { count: 'exact' })
    .gte('appointment_date', since30)
    .neq('appointment_status', 'cancelled')
  const withTier = (data || []).filter(r => r.revenue_tier).length
  const withoutContactId = (data || []).filter(r => !r.ghl_contact_id).length
  const pct = total > 0 ? Math.round((withTier / total) * 100) : 0
  log(
    pct >= 50 ? 'PASS' : 'WARN',
    `revenue_tier coverage on 30d ghl_appointments`,
    `${withTier}/${total} (${pct}%) — ${withoutContactId} rows have no contact_id (can't be tagged)`
  )
}
{
  const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
  const { data, count: total } = await supabase
    .from('ghl_appointments')
    .select('revenue_tier', { count: 'exact' })
    .in('calendar_name', STRAT)
    .gte('appointment_date', since30)
    .neq('appointment_status', 'cancelled')
  const withTier = (data || []).filter(r => r.revenue_tier).length
  const pct = total > 0 ? Math.round((withTier / total) * 100) : 0
  log(
    pct >= 90 ? 'PASS' : pct >= 50 ? 'WARN' : 'FAIL',
    `revenue_tier coverage on 30d STRATEGY bookings`,
    `${withTier}/${total} (${pct}%) — strategy calls should be near 100% since they all come from the form`
  )
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n3. SYNC FRESHNESS — when did each path last run?')
// ─────────────────────────────────────────────────────────────────────
{
  const { data } = await supabase.from('ghl_appointments').select('updated_at').order('updated_at', { ascending: false }).limit(1)
  const last = data?.[0]?.updated_at
  if (last) {
    const ageMin = Math.round((Date.now() - new Date(last).getTime()) / 60000)
    log(ageMin < 90 ? 'PASS' : 'WARN', `ghl_appointments most recent update`, `${ageMin} min ago`)
  } else log('WARN', 'ghl_appointments has no rows', '')
}
{
  const { data } = await supabase.from('marketing_tracker').select('updated_at').order('updated_at', { ascending: false }).limit(1)
  const last = data?.[0]?.updated_at
  if (last) {
    const ageMin = Math.round((Date.now() - new Date(last).getTime()) / 60000)
    log(ageMin < 90 ? 'PASS' : 'WARN', `marketing_tracker most recent update`, `${ageMin} min ago`)
  }
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n4. METRIC CONSISTENCY — does Net New = NC live calls only?')
// ─────────────────────────────────────────────────────────────────────
const from7d = '2026-04-28', to7d = '2026-05-04'
{
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('live_nc_calls, live_fu_calls, nc_cancels, fu_cancels')
    .gte('report_date', from7d).lte('report_date', to7d).eq('is_confirmed', true)
  const totalNC = (reports || []).reduce((s, r) => s + (r.live_nc_calls || 0), 0)
  const totalFU = (reports || []).reduce((s, r) => s + (r.live_fu_calls || 0), 0)
  const totalCancel = (reports || []).reduce((s, r) => s + (r.nc_cancels || 0) + (r.fu_cancels || 0), 0)
  log('INFO', `7d closer EODs aggregate`, `Net New (NC live) = ${totalNC} · FU live = ${totalFU} · cancels = ${totalCancel}`)
}
{
  const { data: mt } = await supabase
    .from('marketing_tracker')
    .select('new_live_calls, live_calls, cancelled_by_prospect')
    .gte('date', from7d).lte('date', to7d)
  const sumNew = (mt || []).reduce((s, r) => s + (r.new_live_calls || 0), 0)
  const sumLive = (mt || []).reduce((s, r) => s + (r.live_calls || 0), 0)
  const sumCancel = (mt || []).reduce((s, r) => s + (r.cancelled_by_prospect || 0), 0)
  log('INFO', `7d marketing_tracker aggregate`, `new_live_calls = ${sumNew} · live_calls = ${sumLive} · cancelled_by_prospect = ${sumCancel}`)
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n5. DQ CLASSIFICATION — does revenue tier produce expected counts?')
// ─────────────────────────────────────────────────────────────────────
{
  const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
  const { data } = await supabase
    .from('ghl_appointments')
    .select('revenue_tier, calendar_name')
    .in('calendar_name', STRAT)
    .neq('appointment_status', 'cancelled')
    .gte('booked_at', from7d).lte('booked_at', to7d + ' 23:59:59')
  const isDQ = v => v && /^\$\s*0/.test(String(v).trim())
  const dq = (data || []).filter(r => isDQ(r.revenue_tier)).length
  const qualified = (data || []).filter(r => r.revenue_tier && !isDQ(r.revenue_tier)).length
  const untagged = (data || []).filter(r => !r.revenue_tier).length
  log(
    untagged === 0 ? 'PASS' : 'WARN',
    `7d strategy bookings classification`,
    `total = ${data?.length || 0}, qualified = ${qualified}, DQ = ${dq}, untagged = ${untagged}`
  )
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n6. CALENDLY CALENDARS — are both Calendly mirrors in the strategy list?')
// ─────────────────────────────────────────────────────────────────────
{
  const constants = readFileSync(new URL('../src/utils/constants.js', import.meta.url), 'utf8')
  const hasT5Zif = constants.includes('T5Zif5GjDwulya6novU0')
  const hasGohF = constants.includes('gohFzPCilzwBtVfaC6fu')
  log(hasT5Zif && hasGohF ? 'PASS' : 'FAIL', 'STRATEGY_CALL_CALENDARS includes both Calendly mirrors', `T5Zif=${hasT5Zif}, gohF=${hasGohF}`)
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n7. AUTO-SYNC SCHEDULE — will the page stay fresh?')
// ─────────────────────────────────────────────────────────────────────
{
  const autoSync = readFileSync(new URL('../src/services/autoSync.js', import.meta.url), 'utf8')
  const hasGHLSync = /syncGHL[\s\S]+?ghlAppointments/i.test(autoSync)
  const hasMetaSync = /syncMeta[\s\S]+?metaAdsSync/i.test(autoSync)
  const hasEODSync = /syncMarketingTracker[\s\S]+?syncEODToTracker/i.test(autoSync)
  log(hasGHLSync ? 'PASS' : 'FAIL', 'autoSync.syncGHL wired', hasGHLSync ? 'every hour' : 'missing')
  log(hasMetaSync ? 'PASS' : 'FAIL', 'autoSync.syncMeta wired', hasMetaSync ? 'every hour' : 'missing')
  log(hasEODSync ? 'PASS' : 'FAIL', 'autoSync.syncMarketingTracker wired', hasEODSync ? 'every hour' : 'missing')
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════')
console.log(' SUMMARY')
console.log('════════════════════════════════════════════════════════════')
const pass = checks.filter(c => c.status === 'PASS').length
const fail = checks.filter(c => c.status === 'FAIL').length
const warn = checks.filter(c => c.status === 'WARN').length
const info = checks.filter(c => c.status === 'INFO').length
console.log(` ${pass} pass · ${fail} fail · ${warn} warn · ${info} info`)
if (fail > 0) {
  console.log('\n FAILURES require action:')
  for (const c of checks.filter(c => c.status === 'FAIL')) console.log(`   ✗ ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
}
if (warn > 0) {
  console.log('\n WARNINGS to monitor:')
  for (const c of checks.filter(c => c.status === 'WARN')) console.log(`   ! ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
}
process.exit(fail > 0 ? 1 : 0)
