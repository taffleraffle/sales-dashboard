import { supabase } from '../lib/supabase'

const GHL_BASE = 'https://services.leadconnectorhq.com'
const GHL_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOC = import.meta.env.VITE_GHL_LOCATION_ID
const SCIO_PIPELINE = 'ZN1DW9S9qS540PNAXSxa'

const ghlHeaders = { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28' }

async function fetchGHLLeads(since) {
  const leads = []
  if (!GHL_KEY || !GHL_LOC) return leads
  try {
    let url = `${GHL_BASE}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${SCIO_PIPELINE}&limit=100`
    while (url && leads.length < 3000) {
      const res = await fetch(url, { headers: ghlHeaders })
      const data = await res.json()
      for (const o of (data.opportunities || [])) {
        if (o.createdAt && new Date(o.createdAt) >= since) {
          leads.push({
            name: o.contact?.name || o.name || 'Unknown',
            phone: o.contact?.phone || '',
            createdAt: o.createdAt,
            status: o.status,
            monetaryValue: o.monetaryValue || 0,
            source: o.source || '',
          })
        }
      }
      url = data.meta?.nextPageUrl || null
    }
  } catch {}
  return leads
}

export async function buildSalesContext() {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7)
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30)
  const d90 = new Date(now); d90.setDate(d90.getDate() - 90)
  const d7s = d7.toISOString().split('T')[0]
  const d30s = d30.toISOString().split('T')[0]
  const d90s = d90.toISOString().split('T')[0]

  // Parallel fetch all data sources
  const [
    teamRes, closerEodRes, setterEodRes, setterLeadsRes,
    wavvRes, marketingRes, benchmarksRes, appointmentsRes,
    transcriptsRes, closerCallsRes, ghlLeads,
  ] = await Promise.all([
    supabase.from('team_members').select('id, name, role, email, wavv_user_id, is_active').eq('is_active', true),
    supabase.from('closer_eod_reports').select('*, closer:team_members(name)')
      .gte('report_date', d30s).eq('is_confirmed', true).order('report_date', { ascending: false }),
    supabase.from('setter_eod_reports').select('*, setter:team_members(name)')
      .gte('report_date', d30s).eq('is_confirmed', true).order('report_date', { ascending: false }),
    supabase.from('setter_leads')
      .select('id, setter_id, closer_id, lead_name, lead_source, date_set, appointment_date, status, revenue_attributed')
      .gte('date_set', d90s).order('date_set', { ascending: false }).limit(500),
    supabase.from('wavv_calls').select('user_id, call_duration, started_at, phone_number, contact_name')
      .gte('started_at', d30.toISOString()).order('started_at', { ascending: false }).limit(5000),
    supabase.from('marketing_tracker').select('*')
      .gte('date', d90s).order('date', { ascending: false }),
    supabase.from('marketing_benchmarks').select('metric, value'),
    supabase.from('ghl_appointments').select('closer_id, contact_name, appointment_date, start_time, outcome, revenue, calendar_name, appointment_status')
      .gte('appointment_date', d30s).order('appointment_date', { ascending: false }).limit(500),
    supabase.from('closer_transcripts').select('closer_id, prospect_name, meeting_date, duration_seconds, summary, outcome')
      .gte('meeting_date', d30s).order('meeting_date', { ascending: false }).limit(100),
    supabase.from('closer_calls').select('prospect_name, call_type, outcome, revenue, cash_collected, created_at, eod_report:closer_eod_reports!closer_calls_eod_report_id_fkey(report_date)')
      .gte('created_at', d30.toISOString()).order('created_at', { ascending: false }).limit(500),
    fetchGHLLeads(d90),
  ])

  const team = teamRes.data || []
  const closerEods = closerEodRes.data || []
  const setterEods = setterEodRes.data || []
  const setterLeads = setterLeadsRes.data || []
  const wavvCalls = wavvRes.data || []
  const marketing = marketingRes.data || []
  const benchmarks = benchmarksRes.data || []
  const transcripts = transcriptsRes.data || []
  const closerCalls = closerCallsRes.data || []

  // ── Aggregations ──

  // WAVV by user
  const wavvByUser = {}
  const wavvByDate = {}
  for (const c of wavvCalls) {
    const uid = c.user_id || 'unknown'
    if (!wavvByUser[uid]) wavvByUser[uid] = { dials: 0, pickups: 0, mcs: 0 }
    wavvByUser[uid].dials++
    if ((c.call_duration || 0) > 15) wavvByUser[uid].pickups++
    if ((c.call_duration || 0) >= 60) wavvByUser[uid].mcs++
    const day = c.started_at?.split('T')[0]
    if (day) wavvByDate[day] = (wavvByDate[day] || 0) + 1
  }

  // Leads by hour / day
  const leadsByHour = new Array(24).fill(0)
  const leadsByDay = {}
  const leadsByDayOfWeek = new Array(7).fill(0)
  for (const l of ghlLeads) {
    const d = new Date(l.createdAt)
    const eastern = new Date(d.getTime() - 5 * 60 * 60 * 1000)
    leadsByHour[eastern.getUTCHours()]++
    const day = eastern.toISOString().split('T')[0]
    leadsByDay[day] = (leadsByDay[day] || 0) + 1
    leadsByDayOfWeek[eastern.getUTCDay()]++
  }

  // Closer performance
  const closerPerf = {}
  for (const eod of closerEods) {
    const name = eod.closer?.name || 'Unknown'
    if (!closerPerf[name]) closerPerf[name] = { booked: 0, live: 0, closes: 0, revenue: 0, cash: 0, noShows: 0, offers: 0, days: 0, reschedules: 0, ascensions: 0, ascendCash: 0 }
    closerPerf[name].booked += (eod.nc_booked || 0) + (eod.fu_booked || 0)
    closerPerf[name].live += (eod.live_nc_calls || 0) + (eod.live_fu_calls || 0)
    closerPerf[name].closes += eod.closes || 0
    closerPerf[name].revenue += parseFloat(eod.total_revenue || 0)
    closerPerf[name].cash += parseFloat(eod.total_cash_collected || 0)
    closerPerf[name].noShows += (eod.nc_no_shows || 0) + (eod.fu_no_shows || 0)
    closerPerf[name].offers += eod.offers || 0
    closerPerf[name].reschedules += eod.reschedules || 0
    closerPerf[name].ascensions += eod.deposits || 0
    closerPerf[name].ascendCash += parseFloat(eod.ascend_cash || 0)
    closerPerf[name].days++
  }

  // Setter performance
  const setterPerf = {}
  for (const eod of setterEods) {
    const name = eod.setter?.name || 'Unknown'
    if (!setterPerf[name]) setterPerf[name] = { dials: 0, pickups: 0, mcs: 0, sets: 0, reschedules: 0, totalLeads: 0, days: 0 }
    setterPerf[name].dials += eod.outbound_calls || 0
    setterPerf[name].pickups += eod.pickups || 0
    setterPerf[name].mcs += eod.meaningful_conversations || 0
    setterPerf[name].sets += eod.sets || 0
    setterPerf[name].reschedules += eod.reschedules || 0
    setterPerf[name].totalLeads += eod.total_leads || 0
    setterPerf[name].days++
  }

  // Lead pipeline
  const leadPipeline = { set: 0, booked: 0, showed: 0, closed: 0, noShow: 0, rescheduled: 0, totalRevenue: 0 }
  for (const l of setterLeads) {
    if (l.status === 'set') leadPipeline.set++
    else if (l.status === 'booked') leadPipeline.booked++
    else if (l.status === 'showed' || l.status === 'not_closed') leadPipeline.showed++
    else if (l.status === 'closed') { leadPipeline.closed++; leadPipeline.totalRevenue += parseFloat(l.revenue_attributed || 0) }
    else if (l.status === 'no_show') leadPipeline.noShow++
    else if (l.status === 'rescheduled') leadPipeline.rescheduled++
  }

  // Marketing funnel (30d)
  const mktg30 = marketing.filter(m => m.date >= d30s)
  const mktgTotals = mktg30.reduce((a, m) => ({
    adspend: a.adspend + parseFloat(m.adspend || 0),
    leads: a.leads + (m.leads || 0),
    bookings: a.bookings + (m.qualified_bookings || 0),
    offers: a.offers + (m.offers || 0),
    closes: a.closes + (m.closes || 0),
    trialCash: a.trialCash + parseFloat(m.trial_cash || 0),
    trialRevenue: a.trialRevenue + parseFloat(m.trial_revenue || 0),
    ascensions: a.ascensions + (m.ascensions || 0),
    ascendCash: a.ascendCash + parseFloat(m.ascend_cash || 0),
    ascendRevenue: a.ascendRevenue + parseFloat(m.ascend_revenue || 0),
    liveCalls: a.liveCalls + (m.new_live_calls || 0),
  }), { adspend: 0, leads: 0, bookings: 0, offers: 0, closes: 0, trialCash: 0, trialRevenue: 0, ascensions: 0, ascendCash: 0, ascendRevenue: 0, liveCalls: 0 })

  // ── Build the system prompt ──
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return `You are the OPT Digital Sales Intelligence Assistant. You have access to comprehensive, real-time data about the entire sales operation. Today's date is ${today}.

FORMATTING RULES:
- Use markdown tables for comparisons
- Bold key numbers and metrics
- Specify timezone (US Eastern / ET) for time-based data
- Be direct and analytical — this is for sales leadership
- Compare periods when discussing trends (this week vs last, etc.)
- When asked about a specific person, give their full stats
- Always include context — don't just give a number, explain what it means

## TEAM
${team.map(m => `- ${m.name} (${m.role})${m.wavv_user_id ? ` [WAVV: ${m.wavv_user_id}]` : ''}`).join('\n')}

## GHL PIPELINE — LAST 90 DAYS
Total leads: **${ghlLeads.length}**

### Lead Volume by Day (last 30 days):
${Object.entries(leadsByDay).sort().slice(-30).map(([d, c]) => `${d}: ${c}`).join('\n')}

### Lead Creation by Hour (ET, last 90 days):
${leadsByHour.map((c, h) => `${h.toString().padStart(2, '0')}:00 — ${c} leads`).join('\n')}

### Lead Creation by Day of Week (last 90 days):
${dayNames.map((n, i) => `${n}: ${leadsByDayOfWeek[i]}`).join(', ')}

## WAVV DIALER — LAST 30 DAYS
Total calls: **${wavvCalls.length}**
${Object.entries(wavvByUser).map(([uid, s]) => {
    const member = team.find(m => m.wavv_user_id === uid)
    return `${member?.name || uid}: ${s.dials} dials, ${s.pickups} pickups (${s.dials ? ((s.pickups / s.dials) * 100).toFixed(1) : 0}%), ${s.mcs} MCs (${s.dials ? ((s.mcs / s.dials) * 100).toFixed(1) : 0}%)`
  }).join('\n')}

### Daily WAVV volume (last 14 days):
${Object.entries(wavvByDate).sort().slice(-14).map(([d, c]) => `${d}: ${c} calls`).join('\n')}

## CLOSER PERFORMANCE — LAST 30 DAYS
${Object.entries(closerPerf).map(([name, p]) => `### ${name} (${p.days} days reported)
Booked: ${p.booked} | Live: ${p.live} | Closes: ${p.closes} | No Shows: ${p.noShows} | Reschedules: ${p.reschedules}
Show Rate: ${p.booked ? ((p.live / p.booked) * 100).toFixed(0) : 0}% | Close Rate: ${p.live ? ((p.closes / p.live) * 100).toFixed(0) : 0}% | Offer Rate: ${p.live ? ((p.offers / p.live) * 100).toFixed(0) : 0}%
Revenue: $${p.revenue.toLocaleString()} | Cash: $${p.cash.toLocaleString()}
Ascensions: ${p.ascensions} | Ascend Cash: $${p.ascendCash.toLocaleString()}`).join('\n\n')}

## SETTER PERFORMANCE — LAST 30 DAYS
${Object.entries(setterPerf).map(([name, p]) => `### ${name} (${p.days} days reported)
Dials: ${p.dials} | Pickups: ${p.pickups} | MCs: ${p.mcs} | Sets: ${p.sets} | Reschedules: ${p.reschedules}
Pickup Rate: ${p.dials ? ((p.pickups / p.dials) * 100).toFixed(1) : 0}% | MC Rate: ${p.dials ? ((p.mcs / p.dials) * 100).toFixed(1) : 0}% | Dials/Set: ${p.sets ? (p.dials / p.sets).toFixed(0) : 'N/A'}
Total Leads Assigned: ${p.totalLeads}`).join('\n\n')}

## SETTER LEAD PIPELINE (last 90 days)
Set: ${leadPipeline.set} | Booked: ${leadPipeline.booked} | Showed: ${leadPipeline.showed} | Closed: ${leadPipeline.closed} | No Show: ${leadPipeline.noShow} | Rescheduled: ${leadPipeline.rescheduled}
Total Revenue from Closed: $${leadPipeline.totalRevenue.toLocaleString()}

## MARKETING FUNNEL — LAST 30 DAYS
Ad Spend: $${mktgTotals.adspend.toLocaleString()} | Leads: ${mktgTotals.leads} | Bookings: ${mktgTotals.bookings}
CPL: $${mktgTotals.leads ? (mktgTotals.adspend / mktgTotals.leads).toFixed(2) : 'N/A'}
Offers: ${mktgTotals.offers} | Closes: ${mktgTotals.closes}
Trial Cash: $${mktgTotals.trialCash.toLocaleString()} | Trial Revenue: $${mktgTotals.trialRevenue.toLocaleString()}
Ascensions: ${mktgTotals.ascensions} | Ascend Cash: $${mktgTotals.ascendCash.toLocaleString()} | Ascend Revenue: $${mktgTotals.ascendRevenue.toLocaleString()}
Live Calls: ${mktgTotals.liveCalls}
${mktgTotals.closes ? `CPA (Trial): $${(mktgTotals.adspend / mktgTotals.closes).toFixed(2)}` : ''}
${mktgTotals.adspend ? `ROAS (Trial Cash): ${(mktgTotals.trialCash / mktgTotals.adspend).toFixed(2)}x` : ''}

### Daily Marketing Data (last 14 days):
${mktg30.slice(0, 14).map(m => `${m.date}: spend=$${parseFloat(m.adspend || 0).toFixed(0)} leads=${m.leads || 0} bookings=${m.qualified_bookings || 0} offers=${m.offers || 0} closes=${m.closes || 0} cash=$${parseFloat(m.trial_cash || 0).toFixed(0)}`).join('\n')}

## BENCHMARKS (targets)
${benchmarks.map(b => `${b.metric}: ${b.value}`).join('\n')}

## SPEED TO LEAD (last 30 days)
${(() => {
    // Normalize phone for matching
    const norm = p => (p || '').replace(/\D/g, '').slice(-10)
    // Build phone → first call timestamp + duration
    const firstCallByPhone = {}
    const callInfoByPhone = {}
    for (const c of wavvCalls) {
      const phone = norm(c.phone_number)
      if (!phone) continue
      const ts = new Date(c.started_at).getTime()
      if (!firstCallByPhone[phone] || ts < firstCallByPhone[phone]) {
        firstCallByPhone[phone] = ts
      }
      if (!callInfoByPhone[phone]) callInfoByPhone[phone] = { dur: 0, count: 0, user: c.user_id }
      callInfoByPhone[phone].dur += c.call_duration || 0
      callInfoByPhone[phone].count++
    }
    // Match leads to calls
    const stlResults = []
    const uncalled = []
    for (const l of ghlLeads) {
      const phone = norm(l.phone || '')
      const created = new Date(l.createdAt).getTime()
      if (!phone) { uncalled.push(l); continue }
      const firstCall = firstCallByPhone[phone]
      if (!firstCall) { uncalled.push(l); continue }
      const diffSecs = (firstCall - created) / 1000
      if (diffSecs < -3600) { uncalled.push(l); continue }
      const secs = Math.max(0, diffSecs)
      const info = callInfoByPhone[phone] || {}
      const setter = team.find(m => m.wavv_user_id === info.user)
      stlResults.push({ name: l.name, secs, dur: info.dur || 0, setter: setter?.name || 'Unknown', created: l.createdAt })
    }
    stlResults.sort((a, b) => new Date(b.created) - new Date(a.created))
    const fmtDur = s => s >= 3600 ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` : s >= 60 ? `${Math.floor(s/60)}m ${Math.round(s%60)}s` : `${Math.round(s)}s`
    const times = stlResults.map(r => r.secs)
    const avg = times.length ? times.reduce((a,b)=>a+b,0)/times.length : 0
    const under5m = times.filter(t => t < 300).length
    const under1h = times.filter(t => t < 3600).length
    return `Total leads: ${ghlLeads.length} | Matched with calls: ${stlResults.length} | Not called: ${uncalled.length}
Average STL: ${fmtDur(avg)} | Median: ${times.length ? fmtDur(times.sort((a,b)=>a-b)[Math.floor(times.length/2)]) : 'N/A'}
Under 5 min: ${under5m} (${times.length ? ((under5m/times.length)*100).toFixed(1) : 0}%) | Under 1 hour: ${under1h} (${times.length ? ((under1h/times.length)*100).toFixed(1) : 0}%)

### Recent leads with response times (last 20):
${stlResults.slice(0, 20).map(r => `${new Date(r.created).toISOString().slice(0,16).replace('T',' ')} | ${r.name} | STL: ${fmtDur(r.secs)} | Talk: ${fmtDur(r.dur)} | Setter: ${r.setter}`).join('\n')}

### Uncalled leads (last 10):
${uncalled.slice(0, 10).map(l => `${new Date(l.createdAt).toISOString().slice(0,16).replace('T',' ')} | ${l.name} | NOT CALLED`).join('\n')}`
  })()}

## APPOINTMENT TIME ANALYSIS — SHOW & CLOSE RATES BY HOUR
${(() => {
  // Strategy call calendar IDs (qualified bookings — the ones that matter for show/close)
  const STRAT_CALS = new Set(['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j'])
  const appts = (appointmentsRes.data || []).filter(a => a.start_time && a.appointment_status !== 'cancelled' && STRAT_CALS.has(a.calendar_name))

  // Build a lookup from closer_calls outcomes by matching prospect name + report date
  const callOutcomes = {}
  for (const c of closerCalls) {
    // Use EOD report_date (actual appointment date), not created_at (when record was saved)
    const date = c.eod_report?.report_date || c.created_at?.split('T')[0]
    // Extract first name, ignoring calendar suffixes like "- RemodelerConnect Strategy Call"
    const cleanName = (c.prospect_name || '').split(/\s*-\s*/)[0].trim()
    const firstName = cleanName.toLowerCase().split(/\s+/)[0]
    if (date && firstName && !firstName.startsWith('historical')) {
      callOutcomes[`${date}:${firstName}`] = { outcome: c.outcome, revenue: parseFloat(c.revenue || 0), cash: parseFloat(c.cash_collected || 0) }
    }
  }

  const byHour = {}
  for (const a of appts) {
    let hour
    try {
      const d = new Date(a.start_time)
      if (isNaN(d.getTime())) continue
      hour = parseInt(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }))
    } catch { continue }
    if (!byHour[hour]) byHour[hour] = { total: 0, showed: 0, closed: 0, noShow: 0, rescheduled: 0, revenue: 0 }
    byHour[hour].total++

    // Match appointment to closer_call outcome by first name + date
    const cleanApptName = (a.contact_name || '').split(/\s*-\s*/)[0].trim()
    const firstName = cleanApptName.toLowerCase().split(/\s+/)[0]
    const callMatch = callOutcomes[`${a.appointment_date}:${firstName}`]
    const outcome = a.outcome || callMatch?.outcome || null

    if (outcome === 'closed' || outcome === 'ascended') {
      byHour[hour].showed++; byHour[hour].closed++; byHour[hour].revenue += callMatch?.revenue || parseFloat(a.revenue || 0)
    } else if (outcome === 'not_closed') {
      byHour[hour].showed++
    } else if (outcome === 'no_show') {
      byHour[hour].noShow++
    } else if (outcome === 'rescheduled') {
      byHour[hour].rescheduled++
    }
    // If no outcome at all (future appt or unprocessed), don't count as showed
  }
  const hours = Object.keys(byHour).map(Number).sort((a,b) => a-b)
  if (!hours.length) return 'No appointment time data available.'
  const fmt12 = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`
  const totalProcessed = hours.reduce((s, h) => s + byHour[h].showed + byHour[h].noShow + byHour[h].rescheduled, 0)
  return `Strategy call appointments: ${appts.length} total, ${totalProcessed} with outcomes
Hour (ET) | Booked | Showed | Closed | NoShow | Resch | Show% | Close% | Revenue
${hours.map(h => {
    const d = byHour[h]
    const processed = d.showed + d.noShow + d.rescheduled
    const showPct = processed > 0 ? ((d.showed / processed) * 100).toFixed(0) : '—'
    const closePct = d.showed > 0 ? ((d.closed / d.showed) * 100).toFixed(0) : '—'
    return `${fmt12(h).padEnd(8)} | ${String(d.total).padStart(6)} | ${String(d.showed).padStart(6)} | ${String(d.closed).padStart(6)} | ${String(d.noShow).padStart(6)} | ${String(d.rescheduled).padStart(5)} | ${String(showPct).padStart(5)}${showPct !== '—' ? '%' : ' '} | ${String(closePct).padStart(6)}${closePct !== '—' ? '%' : ' '} | $${d.revenue.toLocaleString()}`
  }).join('\n')}

Best show rate hours (min 3 processed): ${hours.filter(h => (byHour[h].showed + byHour[h].noShow + byHour[h].rescheduled) >= 3).sort((a,b) => {const aP=byHour[a],bP=byHour[b];return(bP.showed/(bP.showed+bP.noShow+bP.rescheduled))-(aP.showed/(aP.showed+aP.noShow+aP.rescheduled))}).slice(0,3).map(h => {const d=byHour[h],p=d.showed+d.noShow+d.rescheduled;return`${fmt12(h)} (${((d.showed/p)*100).toFixed(0)}% of ${p})`}).join(', ') || 'Not enough data'}
Best close rate hours (min 2 showed): ${hours.filter(h => byHour[h].showed >= 2).sort((a,b) => (byHour[b].closed/byHour[b].showed) - (byHour[a].closed/byHour[a].showed)).slice(0,3).map(h => `${fmt12(h)} (${((byHour[h].closed/byHour[h].showed)*100).toFixed(0)}% of ${byHour[h].showed})`).join(', ') || 'Not enough data'}`
})()}

## RECENT CLOSER CALLS (last 30 days, sample)
${closerCalls.slice(0, 40).map(c => `${c.created_at?.split('T')[0]} | ${c.prospect_name} | ${c.call_type} | ${c.outcome} | rev=$${c.revenue || 0} cash=$${c.cash_collected || 0}`).join('\n')}

## FATHOM TRANSCRIPTS (last 30 days)
${transcripts.slice(0, 15).map(t => `${t.meeting_date} | ${t.prospect_name} | ${t.duration_seconds}s | ${t.outcome || 'N/A'}`).join('\n')}
${transcripts.filter(t => t.summary).slice(0, 3).map(t => `\n### Call: ${t.prospect_name} (${t.meeting_date})\n${t.summary?.slice(0, 300)}`).join('\n')}`
}
