import { useParams, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { Loader, Edit3 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import LeaderTable, { Card } from '../components/house/LeaderTable'
import Modal from '../components/editorial/Modal'
import { useBenchmarks } from '../hooks/useBenchmarks'
import { useSalesMetrics, rates, EMPTY_TOTALS } from '../hooks/useSalesMetrics'

/*
  One closer. Reads the same unified layer as the Overview and Closers
  pages (useSalesMetrics), filtered to this closer, so the numbers here are
  the closer's share of exactly what the company pages show. The Fathom
  sync and objection analysis that used to run on every visit are gone:
  they were the reason the page took seconds to paint.
*/

const money = (n) => `$${Math.round(n || 0).toLocaleString()}`

export default function CloserDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const [member, setMember] = useState(null)
  const [selectedDate, setSelectedDate] = useState(null)
  const [showCalls, setShowCalls] = useState(null) // 'show' | 'close' | null
  const { bm } = useBenchmarks()
  const m = useSalesMetrics(range)
  const days = typeof range === 'number' ? range : 30

  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single().then(({ data }) => setMember(data))
  }, [id])

  const allCalls = m.calls.filter(c => c.closer_id === id)
  const mine = m.byCloser[id] || { ...EMPTY_TOTALS }
  const my = rates(mine)
  const company = m.r

  // Default-select the most recent day with calls
  useEffect(() => {
    if (allCalls.length === 0) return
    const dates = [...new Set(allCalls.map(c => c.report_date).filter(Boolean))].sort()
    if (!dates.length) return
    if (!selectedDate || !dates.includes(selectedDate)) setSelectedDate(dates[dates.length - 1])
  }, [allCalls, selectedDate]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!member) {
    return <div className="flex items-center justify-center h-64"><Loader className="animate-spin" /></div>
  }

  const delta = (a, b) => parseFloat(((a || 0) - (b || 0)).toFixed(1))

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Closer</span>
          <h1 className="h2 mt-2">{member.name}</h1>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {m.error && <div className="callout" style={{ marginBottom: 18 }}><b>Could not load the numbers.</b> {m.error}</div>}

      <div className="kpi-grid mb-6">
        <KPICard label="Booked" value={mine.qualifiedBookings} subtitle={mine.calendarBookings > 0 ? 'calendar bookings assigned to them' : 'new-call rows on their EODs'} />
        <KPICard label="Live" value={mine.lives} subtitle={`${mine.fuLives} follow-up lives separately`} />
        <KPICard label="No shows" value={mine.noShows} subtitle={`${mine.reschedules} rescheduled · ${mine.cancels} cancelled`} />
        <KPICard label="Offers" value={mine.offers} />
        <KPICard label="Closes" value={mine.closes} subtitle={mine.ascensions > 0 ? `${mine.ascensions} ascensions separately` : undefined} />
        <KPICard label="Trial cash" value={money(mine.trialCash)} subtitle={`${money(mine.trialRevenue)} revenue`} />
        <KPICard label="Ascension cash" value={money(mine.ascendCash)} subtitle={`${money(mine.ascendRevenue)} revenue`} />
        <KPICard label="Total cash" value={money(my.cash)} subtitle={`${money(my.revenue)} total revenue`} />
        <KPICard label="Avg deal" value={my.avgDeal != null ? money(my.avgDeal) : '—'} />
      </div>

      <div className="kpi-grid mb-6">
        <Gauge label="Show rate" value={my.showRate} target={bm('show_rate_new', 50)} delta={delta(my.showRate, company.showRate)} avgLabel={company.showRate} onClick={() => setShowCalls('show')} hint="See which booked calls showed and which did not" />
        <Gauge label="Close rate" value={my.closeRate} target={bm('close_rate', 30)} delta={delta(my.closeRate, company.closeRate)} avgLabel={company.closeRate} onClick={() => setShowCalls('close')} hint="See which live calls closed" />
        <Gauge label="Offer rate" value={my.offerRate} target={bm('offer_rate', 80)} delta={delta(my.offerRate, company.offerRate)} avgLabel={company.offerRate} />
        <Gauge label="Offer to close" value={my.offerCloseRate} target={30} delta={delta(my.offerCloseRate, company.offerCloseRate)} avgLabel={company.offerCloseRate} />
        <Gauge label="Reschedule rate" value={my.rescheduleRate} target={10} max={50} direction="below" delta={delta(my.rescheduleRate, company.rescheduleRate)} avgLabel={company.rescheduleRate} />
        <Gauge label="No-show rate" value={my.noShowRate} target={20} max={50} direction="below" delta={delta(my.noShowRate, company.noShowRate)} avgLabel={company.noShowRate} />
        <Gauge label="Cash collected" value={my.cashCollectRate} target={50} delta={delta(my.cashCollectRate, company.cashCollectRate)} avgLabel={company.cashCollectRate} />
      </div>

      <CallsCalendar
        calls={allCalls}
        selectedDate={selectedDate}
        onSelectDate={(d) => setSelectedDate(d)}
        onEditEod={(d) => navigate(`/sales/eod/submit?tab=closer&member=${id}&date=${d}`)}
        days={days}
      />

      <CallsModal kind={showCalls} onClose={() => setShowCalls(null)} calls={allCalls} days={days} name={member?.name} />
    </div>
  )
}

// ---------- Calls Calendar ----------
// Outcome → { label, ring, dot } — colors mirror the EODReview chip palette so
// a call looks the same wherever it appears in the app.
const OUTCOME_META = {
  closed:       { label: 'Closed',       color: 'var(--house-good)' },
  ascended:     { label: 'Ascended',     color: 'var(--ink-2)' },
  not_closed:   { label: 'Not closed',   color: 'var(--ink-4)' },
  not_ascended: { label: 'Not ascended', color: 'var(--ink-4)' },
  no_show:      { label: 'No show',      color: 'var(--house-bad)' },
  rescheduled:  { label: 'Rescheduled',  color: 'var(--house-warn)' },
  cancelled:    { label: 'Cancelled',    color: 'var(--house-warn)' },
  canceled:     { label: 'Cancelled',    color: 'var(--house-warn)' },
}

const TYPE_META = {
  new_call:  { label: 'New call' },
  follow_up: { label: 'Follow-up' },
  ascension: { label: 'Ascension' },
}

function fmtDayShort(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]
  return `${wd} ${m}/${d}`
}

function fmtDayLong(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const wd = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()]
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]
  return `${wd}, ${mo} ${d}, ${y}`
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CallsCalendar({ calls, selectedDate, onSelectDate, onEditEod, days }) {
  const byDate = new Map()
  for (const c of calls) {
    if (!c.report_date) continue
    if (!byDate.has(c.report_date)) byDate.set(c.report_date, [])
    byDate.get(c.report_date).push(c)
  }
  const sortedDates = [...byDate.keys()].sort()
  const dayCalls = selectedDate ? (byDate.get(selectedDate) || []) : []
  const dayTotals = dayCalls.reduce((a, c) => {
    a.calls++
    if (c.outcome === 'closed') a.closes++
    if (c.outcome === 'ascended') a.ascensions++
    if (c.outcome === 'no_show') a.noShows++
    a.cash += parseFloat(c.cash_collected || 0)
    return a
  }, { calls: 0, closes: 0, ascensions: 0, noShows: 0, cash: 0 })

  return (
    <Card
      title="Calls"
      count={calls.length}
      right={selectedDate && (
        <button type="button" className="editorial-btn-ghost" style={{ height: 34, padding: '0 14px', fontSize: 12.5 }} onClick={() => onEditEod(selectedDate)}>
          <Edit3 size={12} /> Edit this day&apos;s EOD
        </button>
      )}
    >
      {sortedDates.length === 0 ? (
        <p style={{ margin: 0, padding: '28px 20px', fontSize: 13.5, color: 'var(--ink-4)', textAlign: 'center' }}>No calls in the last {days} days.</p>
      ) : (
        <>
          {/* Day strip: one chip per day with calls, newest on the right */}
          <div className="overflow-x-auto no-scrollbar" style={{ padding: '16px 20px 6px', borderBottom: '1px solid var(--rule)' }}>
            <div className="flex gap-2" style={{ minWidth: 'min-content' }}>
              {sortedDates.map(date => <DayChip key={date} date={date} calls={byDate.get(date)} selected={date === selectedDate} onClick={() => onSelectDate(date)} />)}
            </div>
            <div className="flex flex-wrap gap-4 mt-3" style={{ fontSize: 11.5, color: 'var(--ink-4)', fontWeight: 600 }}>
              {Object.entries(OUTCOME_META).filter(([k]) => k !== 'not_ascended').map(([k, meta]) => (
                <span key={k} className="inline-flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color }} />{meta.label}</span>
              ))}
            </div>
          </div>

          {selectedDate && (
            <>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--rule)', background: '#fbfbf9' }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtDayLong(selectedDate)}</span>
                <span style={{ fontSize: 12.5, color: 'var(--ink-4)', fontWeight: 500 }}>
                  {dayTotals.calls} {dayTotals.calls === 1 ? 'call' : 'calls'}
                  {dayTotals.closes > 0 && <span style={{ color: 'var(--house-good)' }}> · {dayTotals.closes} closed</span>}
                  {dayTotals.ascensions > 0 && <span style={{ color: 'var(--ink-2)' }}> · {dayTotals.ascensions} ascended</span>}
                  {dayTotals.noShows > 0 && <span style={{ color: 'var(--house-bad)' }}> · {dayTotals.noShows} no-show</span>}
                  {dayTotals.cash > 0 && <span style={{ color: 'var(--ink)' }}> · ${dayTotals.cash.toLocaleString()} cash</span>}
                </span>
              </div>
              <LeaderTable
                rows={[...dayCalls].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))}
                highlightFirst={false}
                empty="No calls recorded for this day."
                columns={[
                  { key: 'created_at', label: 'Time', width: 80, render: r => fmtTime(r.created_at) || '—' },
                  { key: 'prospect_name', label: 'Prospect', render: r => <span style={{ fontWeight: 600 }}>{(r.prospect_name || '—').split(' - ')[0]}</span> },
                  { key: 'call_type', label: 'Type', width: 90, render: r => <span className="pill">{TYPE_META[r.call_type]?.label || 'NC'}</span> },
                  { key: 'outcome', label: 'Outcome', width: 130, render: r => <OutcomePill outcome={r.outcome} /> },
                  { key: 'notes', label: 'Notes', render: r => r.notes ? <span title={r.notes} style={{ color: 'var(--ink-2)', fontWeight: 400, display: 'inline-block', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.notes}</span> : <span style={{ color: 'var(--ink-5)' }}>—</span> },
                  { key: 'revenue', label: 'Revenue', align: 'right', render: r => parseFloat(r.revenue || 0) > 0 ? `$${parseFloat(r.revenue).toLocaleString()}` : '—' },
                  { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => parseFloat(r.cash_collected || 0) > 0 ? `$${parseFloat(r.cash_collected).toLocaleString()}` : '—' },
                ]}
              />
            </>
          )}
        </>
      )}
    </Card>
  )
}

function DayChip({ date, calls, selected, onClick }) {
  const counts = {}
  for (const c of calls) counts[c.outcome || 'unknown'] = (counts[c.outcome || 'unknown'] || 0) + 1
  const total = calls.length
  const wins = (counts.closed || 0) + (counts.ascended || 0)
  const noShows = counts.no_show || 0
  const segs = ['closed', 'ascended', 'not_closed', 'not_ascended', 'rescheduled', 'no_show'].filter(k => counts[k]).map(k => ({ k, pct: (counts[k] / total) * 100 }))
  return (
    <button type="button" onClick={onClick} className="house-plain" style={{
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 104, textAlign: 'left',
      padding: '10px 12px', borderRadius: 14,
      background: selected ? 'var(--accent)' : '#ffffff',
      border: `1px solid ${selected ? 'var(--accent)' : 'var(--house-line-strong)'}`,
      boxShadow: selected ? '0 8px 20px -10px rgba(244,197,24,.9)' : 'var(--house-shadow-input)',
      color: 'var(--ink)',
    }}>
      <span className="flex items-baseline justify-between gap-2">
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtDayShort(date)}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: selected ? 'rgba(26,23,0,.7)' : 'var(--ink-4)' }}>{total}</span>
      </span>
      <span className="flex overflow-hidden" style={{ height: 6, borderRadius: 999, background: selected ? 'rgba(26,23,0,.12)' : '#f1efe3' }}>
        {segs.map(s => <span key={s.k} style={{ width: `${s.pct}%`, background: OUTCOME_META[s.k]?.color || 'var(--ink-4)' }} />)}
      </span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: selected ? 'rgba(26,23,0,.75)' : 'var(--ink-4)' }}>
        {wins > 0 && <span style={{ color: selected ? '#1a1700' : 'var(--house-good)' }}>{wins} won</span>}
        {wins > 0 && noShows > 0 && ' · '}
        {noShows > 0 && <span style={{ color: selected ? '#1a1700' : 'var(--house-bad)' }}>{noShows} no-show</span>}
        {wins === 0 && noShows === 0 && 'no result yet'}
      </span>
    </button>
  )
}

function OutcomePill({ outcome }) {
  const meta = OUTCOME_META[outcome] || { label: outcome || '—', color: 'var(--ink-4)' }
  return (
    <span className="pill" style={{ color: meta.color === 'var(--ink-4)' ? 'var(--ink-2)' : meta.color, borderColor: meta.color === 'var(--ink-4)' ? 'var(--rule)' : meta.color.replace(')', ',.35)').replace('var(--house-good)', 'rgba(22,163,74,.35)').replace('var(--house-bad)', 'rgba(224,86,30,.35)').replace('var(--ink-2)', 'var(--rule)').replace('var(--house-warn)', 'rgba(184,134,11,.35)') }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: meta.color }} />{meta.label}
    </span>
  )
}

/*
  The calls behind Show rate and Close rate. Show rate is live new calls over
  new calls booked, so the modal lists every NEW call in the window with what
  happened to it. Close rate is closed prospects over live prospects.
*/
function CallsModal({ kind, onClose, calls, days, name }) {
  if (!kind) return null
  const isShow = kind === 'show'
  const nc = calls.filter(c => c.call_type === 'new_call')
  const live = nc.filter(c => ['closed', 'not_closed'].includes(c.outcome))
  const noShow = nc.filter(c => c.outcome === 'no_show')
  const moved = nc.filter(c => ['rescheduled', 'cancelled', 'canceled'].includes(c.outcome))
  const liveAll = calls.filter(c => ['new_call', 'follow_up'].includes(c.call_type) && ['closed', 'not_closed'].includes(c.outcome))
  const closed = liveAll.filter(c => c.outcome === 'closed')
  const rows = (isShow ? nc : liveAll).slice().sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''))
  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—'
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={name ? `${name} · last ${days} days` : `Last ${days} days`}
      title={isShow ? 'Show rate: every new call booked' : 'Close rate: every live call'}
      subtitle={isShow ? 'Booked new calls and what happened to each one. Live means the prospect turned up.' : 'Live calls (new and follow-up) and which ones closed.'}
      size="lg"
    >
      <div className="kpi-grid" style={{ padding: '18px 24px 6px' }}>
        {isShow ? (<>
          <KPICard label="New calls booked" value={nc.length} />
          <KPICard label="Showed" value={live.length} subtitle={pct(live.length, nc.length)} />
          <KPICard label="No show" value={noShow.length} subtitle={pct(noShow.length, nc.length)} />
          <KPICard label="Rescheduled / cancelled" value={moved.length} subtitle={pct(moved.length, nc.length)} />
        </>) : (<>
          <KPICard label="Live calls" value={liveAll.length} />
          <KPICard label="Closed" value={closed.length} subtitle={pct(closed.length, liveAll.length)} />
          <KPICard label="Not closed" value={liveAll.length - closed.length} subtitle={pct(liveAll.length - closed.length, liveAll.length)} />
          <KPICard label="Cash" value={`$${Math.round(closed.reduce((t, c) => t + parseFloat(c.cash_collected || 0), 0)).toLocaleString()}`} />
        </>)}
      </div>
      <LeaderTable
        rows={rows}
        highlightFirst={false}
        empty="No calls in this window."
        columns={[
          { key: 'report_date', label: 'Date', width: 120, render: r => fmtDayShort(r.report_date) },
          { key: 'prospect_name', label: 'Prospect', render: r => <span style={{ fontWeight: 600 }}>{(r.prospect_name || '—').split(' - ')[0]}</span> },
          { key: 'call_type', label: 'Type', width: 80, render: r => <span className="pill">{TYPE_META[r.call_type]?.label || 'NC'}</span> },
          { key: 'outcome', label: isShow ? 'Showed?' : 'Result', width: 150, render: r => <OutcomePill outcome={r.outcome} /> },
          { key: 'cash_collected', label: 'Cash', align: 'right', strong: true, render: r => parseFloat(r.cash_collected || 0) > 0 ? `$${parseFloat(r.cash_collected).toLocaleString()}` : '—' },
        ]}
      />
    </Modal>
  )
}
