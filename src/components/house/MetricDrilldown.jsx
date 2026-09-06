import { useEffect, useMemo, useState } from 'react'
import { Loader } from 'lucide-react'
import Modal from '../editorial/Modal'
import KPICard from '../KPICard'
import LeaderTable, { Person } from './LeaderTable'
import { supabase } from '../../lib/supabase'
import { etOffset } from '../../services/speedToLeadDb'

/*
  The rows behind a headline tile on the Overview.

  kind        what opens
  'leads'     every Typeform opt-in in the window (fetched on open)
  'booked'    every qualified strategy booking (from useSalesMetrics)
  'live'      new calls that went live (closed / not closed)
  'show'      every booked new call with a Showed / No show / Rescheduled filter
  'close'     the closes, with revenue and cash (CAC uses this too)

  All of it is the same data the tiles were computed from, so the counts in
  the pop-up always equal the number on the tile.
*/

const money = (n) => `$${Math.round(parseFloat(n || 0)).toLocaleString()}`
const fmtDay = (iso) => {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const clean = (name) => (name || '—').split(' - ')[0].split(' and ')[0].trim()

const OUTCOME = {
  closed:       { label: 'Closed',      color: 'var(--house-good)' },
  not_closed:   { label: 'Not closed',  color: 'var(--ink-2)' },
  no_show:      { label: 'No show',     color: 'var(--house-bad)' },
  rescheduled:  { label: 'Rescheduled', color: 'var(--house-warn)' },
  canceled:     { label: 'Cancelled',   color: 'var(--house-warn)' },
  cancelled:    { label: 'Cancelled',   color: 'var(--house-warn)' },
  ascended:     { label: 'Ascended',    color: 'var(--house-good)' },
  not_ascended: { label: 'Not ascended', color: 'var(--ink-2)' },
}
function Pill({ label, color = 'var(--ink-2)', on = true }) {
  const border = color === 'var(--house-good)' ? 'rgba(22,163,74,.35)' : color === 'var(--house-bad)' ? 'rgba(224,86,30,.35)' : color === 'var(--house-warn)' ? 'rgba(184,134,11,.35)' : 'var(--rule)'
  return <span className="pill" style={{ color, borderColor: border, opacity: on ? 1 : .55 }}><span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />{label}</span>
}
function OutcomePill({ outcome }) {
  const o = OUTCOME[outcome] || { label: outcome || 'No outcome yet', color: 'var(--ink-4)' }
  return <Pill label={o.label} color={o.color} />
}
function Filter({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2" style={{ padding: '0 24px 14px' }}>
      {options.map(o => (
        <button key={o.value} type="button" className="house-plain" onClick={() => onChange(o.value)} style={{
          height: 32, padding: '0 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
          background: value === o.value ? 'var(--accent)' : '#fff', color: value === o.value ? '#1a1700' : 'var(--ink)',
          border: `1px solid ${value === o.value ? 'var(--accent)' : 'var(--house-line-strong)'}`, boxShadow: 'var(--house-shadow-input)',
        }}>{o.label}{o.count != null && <span style={{ marginLeft: 6, color: value === o.value ? 'rgba(26,23,0,.65)' : 'var(--ink-4)' }}>{o.count}</span>}</button>
      ))}
    </div>
  )
}

export default function MetricDrilldown({ kind, onClose, metrics, closers = [], windowLabel }) {
  const [filter, setFilter] = useState('all')
  const [leads, setLeads] = useState(null)
  const closerName = useMemo(() => Object.fromEntries(closers.map(c => [c.id, c.name])), [closers])
  const { totals: T, r: R, calls, bookings, window: win } = metrics

  useEffect(() => { setFilter('all') }, [kind])

  // Leads are not part of the metrics hook (nothing else needs the rows), so fetch on open
  useEffect(() => {
    if (kind !== 'leads' || !win) return
    let alive = true
    setLeads(null)
    ;(async () => {
      const rows = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('typeform_responses')
          .select('response_id, submitted_at, first_name, last_name, email, form_name, revenue_tier, qualified, utm_campaign')
          .gte('submitted_at', `${win.startStr}T00:00:00${etOffset(win.startStr)}`).lte('submitted_at', `${win.endStr}T23:59:59${etOffset(win.endStr)}`)
          .order('submitted_at', { ascending: false }).range(from, from + 999)
        if (error) { console.warn('leads drilldown failed:', error.message); break }
        rows.push(...(data || []))
        if (!data || data.length < 1000) break
      }
      const { data: excl } = await supabase.from('lead_excluded').select('response_id')
      const ex = new Set((excl || []).map(e => e.response_id))
      if (alive) setLeads(rows.filter(r => !ex.has(r.response_id)))
    })()
    return () => { alive = false }
  }, [kind, win])

  if (!kind) return null

  const nc = calls.filter(c => c.call_type === 'new_call')
  const live = nc.filter(c => ['closed', 'not_closed'].includes(c.outcome))
  const noShow = nc.filter(c => c.outcome === 'no_show')
  const moved = nc.filter(c => ['rescheduled', 'canceled', 'cancelled'].includes(c.outcome))
  const closes = calls.filter(c => c.outcome === 'closed')
  const byDate = (a, b) => (b.report_date || '').localeCompare(a.report_date || '')
  const eyebrow = windowLabel || (win ? `${fmtDay(win.startStr)} to ${fmtDay(win.endStr)}` : '')

  const callCols = (resultLabel) => [
    { key: 'report_date', label: 'Date', width: 120, render: r => fmtDay(r.report_date) },
    { key: 'prospect_name', label: 'Prospect', render: r => <Person name={clean(r.prospect_name)} sub={closerName[r.closer_id] ? `with ${closerName[r.closer_id]}` : undefined} /> },
    { key: 'outcome', label: resultLabel, width: 150, render: r => <OutcomePill outcome={r.outcome} /> },
    { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => parseFloat(r.cash_collected || 0) > 0 ? money(r.cash_collected) : '—' },
  ]

  let title, subtitle, tiles, table

  if (kind === 'leads') {
    title = 'Cost per lead: every lead'
    subtitle = 'Typeform opt-ins in the window, the same count the tile divides ad spend by.'
    const q = (leads || []).filter(l => l.qualified).length
    tiles = <>
      <KPICard label="Leads" value={leads ? leads.length : '…'} subtitle={`${money(T.adspend)} ad spend`} />
      <KPICard label="Cost per lead" value={R.cpl != null ? money(R.cpl) : '—'} />
      <KPICard label="Marked qualified" value={leads ? q : '…'} subtitle={leads && leads.length ? `${Math.round((q / leads.length) * 100)}% of leads` : undefined} />
      <KPICard label="Booked a call" value={T.qualifiedBookings} subtitle={leads && leads.length ? `${Math.round((T.qualifiedBookings / leads.length) * 100)}% lead to booked` : undefined} />
    </>
    table = leads == null ? <div className="flex items-center justify-center py-8"><Loader className="animate-spin" size={20} /></div> : (
      <LeaderTable rows={leads} rowKey={r => r.response_id} highlightFirst={false} empty="No leads in this window."
        columns={[
          { key: 'submitted_at', label: 'When', width: 150, render: r => fmtStamp(r.submitted_at) },
          { key: 'name', label: 'Lead', render: r => <Person name={[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Unknown'} sub={r.email || undefined} /> },
          { key: 'form_name', label: 'Funnel', render: r => <span style={{ color: 'var(--ink-2)', fontWeight: 400 }}>{r.form_name || r.utm_campaign || '—'}</span> },
          { key: 'revenue_tier', label: 'Revenue band', render: r => r.revenue_tier || '—' },
          { key: 'qualified', label: 'Qualified', align: 'right', render: r => r.qualified ? <Pill label="Qualified" color="var(--house-good)" /> : <Pill label="DQ" color="var(--ink-4)" /> },
        ]} />
    )
  } else if (kind === 'booked') {
    title = 'Cost per booked call: every qualified booking'
    subtitle = 'Strategy calls on the calendar in the window: not DQ, not spam, not excluded, test bookings removed.'
    const upcoming = bookings.filter(b => b.appointment_date && b.appointment_date > (win?.endStr || ''))
    tiles = <>
      <KPICard label="Booked" value={bookings.length} subtitle={`${money(T.adspend)} ad spend`} />
      <KPICard label="Cost per booked call" value={R.costPerBooked != null ? money(R.costPerBooked) : '—'} />
      <KPICard label="Went live" value={T.lives} subtitle={`${R.showRate}% show rate`} />
      <KPICard label="Still to come" value={upcoming.length} subtitle="call date after the window" />
    </>
    table = <LeaderTable rows={[...bookings].sort((a, b) => (b.booked_at || '').localeCompare(a.booked_at || ''))} highlightFirst={false} empty="No bookings in this window."
      columns={[
        { key: 'booked_at', label: 'Booked', width: 120, render: r => fmtDay(r.booked_at) },
        { key: 'contact_name', label: 'Prospect', render: r => <Person name={clean(r.contact_name)} sub={r.contact_email || undefined} /> },
        { key: 'appointment_date', label: 'Call date', width: 130, render: r => fmtDay(r.appointment_date) },
        { key: 'audience', label: 'Audience', render: r => <span style={{ color: 'var(--ink-2)', fontWeight: 400 }}>{r.audience || 'Unknown'}</span> },
        { key: 'appointment_status', label: 'Status', align: 'right', render: r => <Pill label={r.appointment_status || 'booked'} color={r.appointment_status === 'confirmed' ? 'var(--house-good)' : 'var(--ink-2)'} /> },
      ]} />
  } else if (kind === 'live') {
    title = 'Cost per live call: every live call'
    subtitle = 'New calls where the prospect turned up (closed or not closed), on confirmed EODs.'
    tiles = <>
      <KPICard label="Live calls" value={live.length} subtitle={`${money(T.adspend)} ad spend`} />
      <KPICard label="Cost per live call" value={R.costPerLive != null ? money(R.costPerLive) : '—'} />
      <KPICard label="Closed" value={closes.filter(c => c.call_type === 'new_call').length} subtitle={`${R.closeRate}% close rate`} />
      <KPICard label="Not closed" value={live.filter(c => c.outcome === 'not_closed').length} />
    </>
    table = <LeaderTable rows={[...live].sort(byDate)} highlightFirst={false} empty="No live calls on confirmed EODs in this window." columns={callCols('Result')} />
  } else if (kind === 'show') {
    title = 'Show rate: every booked new call'
    subtitle = 'Each new call on a confirmed EOD and what happened to it. Live means the prospect showed.'
    const opts = [
      { value: 'all', label: 'All', count: nc.length },
      { value: 'live', label: 'Showed', count: live.length },
      { value: 'no_show', label: 'No show', count: noShow.length },
      { value: 'moved', label: 'Rescheduled / cancelled', count: moved.length },
    ]
    const rows = filter === 'live' ? live : filter === 'no_show' ? noShow : filter === 'moved' ? moved : nc
    tiles = <>
      <KPICard label="Booked" value={T.qualifiedBookings} subtitle="qualified calls on the calendar" />
      <KPICard label="Showed" value={live.length} subtitle={`${R.showRate}% show rate`} />
      <KPICard label="No show" value={noShow.length} subtitle={`${R.noShowRate}% of booked`} />
      <KPICard label="Rescheduled / cancelled" value={moved.length} />
    </>
    table = <>
      <Filter options={opts} value={filter} onChange={setFilter} />
      <LeaderTable rows={[...rows].sort(byDate)} highlightFirst={false} empty="Nothing in this bucket." columns={callCols('Showed?')} />
    </>
  } else {
    title = kind === 'cac' ? 'CAC: every close' : 'Close rate: every close'
    subtitle = kind === 'cac' ? 'Ad spend divided by closes. These are the closes.' : 'Closes over live new calls. These are the closes.'
    tiles = <>
      <KPICard label="Closes" value={closes.length} subtitle={`${R.closeRate}% of ${T.lives} live`} />
      <KPICard label={kind === 'cac' ? 'CAC' : 'Ad spend'} value={kind === 'cac' ? (R.cac != null ? money(R.cac) : '—') : money(T.adspend)} />
      <KPICard label="Revenue" value={money(closes.reduce((t, c) => t + parseFloat(c.revenue || 0), 0))} subtitle="trial revenue on these closes" />
      <KPICard label="Cash collected" value={money(closes.reduce((t, c) => t + parseFloat(c.cash_collected || 0), 0))} />
    </>
    table = <LeaderTable rows={[...closes].sort(byDate)} highlightFirst={false} empty="No closes on confirmed EODs in this window."
      columns={[
        { key: 'report_date', label: 'Date', width: 120, render: r => fmtDay(r.report_date) },
        { key: 'prospect_name', label: 'Prospect', render: r => <Person name={clean(r.prospect_name)} sub={closerName[r.closer_id] ? `closed by ${closerName[r.closer_id]}` : undefined} /> },
        { key: 'call_type', label: 'Type', width: 110, render: r => <span className="pill">{r.call_type === 'follow_up' ? 'Follow-up' : 'New call'}</span> },
        { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) },
        { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => money(r.cash_collected) },
      ]} />
  }

  return (
    <Modal open onClose={onClose} eyebrow={eyebrow} title={title} subtitle={subtitle} size="lg">
      <div className="kpi-grid" style={{ padding: '18px 24px 14px' }}>{tiles}</div>
      {table}
    </Modal>
  )
}
