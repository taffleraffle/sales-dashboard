import { useEffect, useState } from 'react'
import { Loader } from 'lucide-react'
import Modal from '../editorial/Modal'
import KPICard from '../KPICard'
import LeadStatusBadge from '../LeadStatusBadge'
import LeaderTable, { Person } from './LeaderTable'
import { supabase } from '../../lib/supabase'
import { sinceDate } from '../../lib/dateUtils'

/*
  The rows behind a Setters-page tile.

  kind       rows
  'dials'    every WAVV dial in the window (fetched on open)
  'pickups'  dials over 45 seconds
  'mcs'      dials of 60 seconds or more (meaningful conversations)
  'sets'     every lead the setters logged (setter_leads)
  'shows'    logged leads that showed (showed / not closed / closed)
  'no_shows' logged leads marked no show
  'revenue'  logged leads with revenue attributed

  Same rows the tiles count, so the numbers always agree.
*/

const money = (n) => `$${Math.round(parseFloat(n || 0)).toLocaleString()}`
const fmtDay = (iso) => {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const fmtDur = (s) => { const n = Math.round(s || 0); return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s` }
const fmtPhone = (p) => { const d = (p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '—') }

export default function SetterDrilldown({ kind, onClose, range, leads = [], setters = [], windowLabel }) {
  const [calls, setCalls] = useState(null)
  const isCallKind = ['dials', 'pickups', 'mcs'].includes(kind)
  const setterByWavv = Object.fromEntries(setters.filter(s => s.wavv_user_id).map(s => [s.wavv_user_id, s.name]))

  useEffect(() => {
    if (!isCallKind) return
    let alive = true
    setCalls(null)
    ;(async () => {
      const rows = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('wavv_calls')
          .select('id, contact_name, phone_number, started_at, call_duration, user_id')
          .gte('started_at', `${sinceDate(range)}T00:00:00`)
          .order('started_at', { ascending: false })
          .range(from, from + 999)
        if (error) { console.warn('wavv drilldown failed:', error.message); break }
        rows.push(...(data || []))
        if (!data || data.length < 1000) break
      }
      if (alive) setCalls(rows)
    })()
    return () => { alive = false }
  }, [kind, range]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!kind) return null

  let title, subtitle, tiles, table

  if (isCallKind) {
    const all = calls || []
    const pickups = all.filter(c => (c.call_duration || 0) > 45)
    const mcs = all.filter(c => (c.call_duration || 0) >= 60)
    const rows = kind === 'pickups' ? pickups : kind === 'mcs' ? mcs : all
    title = kind === 'dials' ? 'Total dials: every call placed' : kind === 'pickups' ? 'Pickups: dials over 45 seconds' : 'Meaningful conversations: dials of a minute or more'
    subtitle = 'From WAVV. A pickup is any call longer than 45 seconds; a meaningful conversation is 60 seconds or more.'
    tiles = <>
      <KPICard label="Dials" value={calls ? all.length : '…'} />
      <KPICard label="Pickups" value={calls ? pickups.length : '…'} subtitle={calls && all.length ? `${((pickups.length / all.length) * 100).toFixed(1)}% pickup rate` : undefined} />
      <KPICard label="Meaningful conversations" value={calls ? mcs.length : '…'} subtitle={calls && all.length ? `${((mcs.length / all.length) * 100).toFixed(1)}% of dials` : undefined} />
      <KPICard label="Unique numbers" value={calls ? new Set(all.map(c => (c.phone_number || '').replace(/\D/g, '').slice(-10))).size : '…'} />
    </>
    table = calls == null ? <div className="flex items-center justify-center py-8"><Loader className="animate-spin" size={20} /></div> : (
      <LeaderTable rows={rows.slice(0, 400)} highlightFirst={false} empty="No calls in this window."
        columns={[
          { key: 'started_at', label: 'When', width: 150, render: r => fmtStamp(r.started_at) },
          { key: 'contact_name', label: 'Contact', render: r => <Person name={r.contact_name || fmtPhone(r.phone_number)} sub={r.contact_name ? fmtPhone(r.phone_number) : undefined} /> },
          { key: 'user_id', label: 'Setter', render: r => setterByWavv[r.user_id] || <span style={{ color: 'var(--ink-4)' }}>{r.user_id || '—'}</span> },
          { key: 'call_duration', label: 'Length', align: 'right', render: r => fmtDur(r.call_duration) },
          { key: 'kind', label: 'Counts as', align: 'right', render: r => (r.call_duration || 0) >= 60 ? <span className="pill" style={{ color: 'var(--house-good)', borderColor: 'rgba(22,163,74,.35)' }}>MC</span> : (r.call_duration || 0) > 45 ? <span className="pill">Pickup</span> : <span className="pill" style={{ color: 'var(--ink-4)' }}>Dial</span> },
        ]} />
    )
    if (rows.length > 400) table = <>{table}<p style={{ margin: 0, padding: '10px 24px 16px', fontSize: 12.5, color: 'var(--ink-4)' }}>Showing the latest 400 of {rows.length}.</p></>
  } else {
    const showed = leads.filter(l => ['showed', 'not_closed', 'closed'].includes(l.status))
    const noShow = leads.filter(l => l.status === 'no_show')
    const closed = leads.filter(l => l.status === 'closed')
    const withRev = leads.filter(l => parseFloat(l.revenue_attributed || 0) > 0)
    const rows = kind === 'shows' ? showed : kind === 'no_shows' ? noShow : kind === 'revenue' ? withRev : leads
    title = kind === 'sets' ? 'Sets: every lead the setters logged' : kind === 'shows' ? 'Shows: logged leads that turned up' : kind === 'no_shows' ? 'No shows: logged leads that did not turn up' : 'Revenue: logged leads with revenue attributed'
    subtitle = 'From the setter leads log. Status is whatever was recorded on the lead.'
    tiles = <>
      <KPICard label="Sets" value={leads.length} />
      <KPICard label="Showed" value={showed.length} subtitle={leads.length ? `${((showed.length / leads.length) * 100).toFixed(1)}% show rate` : undefined} />
      <KPICard label="No show" value={noShow.length} />
      <KPICard label="Closed" value={closed.length} subtitle={withRev.length ? money(withRev.reduce((t, l) => t + parseFloat(l.revenue_attributed || 0), 0)) + ' attributed' : undefined} />
    </>
    table = <LeaderTable rows={[...rows].sort((a, b) => (b.date_set || '').localeCompare(a.date_set || ''))} highlightFirst={false} empty="Nothing in this bucket."
      columns={[
        { key: 'date_set', label: 'Set', width: 120, render: r => fmtDay(r.date_set) },
        { key: 'lead_name', label: 'Lead', render: r => <Person name={r.lead_name || '—'} sub={r.lead_source || undefined} /> },
        { key: 'setter', label: 'Setter', render: r => r.setter_name || setters.find(s => s.id === r.setter_id)?.name || '—' },
        { key: 'closer', label: 'Closer', render: r => r.closer?.name || r.closer_name || '—' },
        { key: 'appointment_date', label: 'Call date', width: 130, render: r => fmtDay(r.appointment_date) },
        { key: 'status', label: 'Status', render: r => <LeadStatusBadge status={r.status} /> },
        { key: 'revenue_attributed', label: 'Revenue', align: 'right', strong: true, render: r => parseFloat(r.revenue_attributed || 0) > 0 ? money(r.revenue_attributed) : '—' },
      ]} />
  }

  return (
    <Modal open onClose={onClose} eyebrow={windowLabel || 'Selected range'} title={title} subtitle={subtitle} size="lg">
      <div className="kpi-grid" style={{ padding: '18px 24px 14px' }}>{tiles}</div>
      {table}
    </Modal>
  )
}
