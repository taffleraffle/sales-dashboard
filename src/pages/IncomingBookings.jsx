import { useEffect, useState, useMemo } from 'react'
import { fetchIncomingBookings, syncIncomingBookings } from '../services/ghlIncomingBookings'
import { GRADE_LABELS } from '../lib/gradeApplication'
import {
  PageShell, PageHeader, Section, Loading,
  fmt$, ink, ink2, ink3, hair, accent, neg, pos,
} from '../components/ui'

const TONE_STYLE = {
  priority: { bg: 'rgba(0,102,204,0.08)',   border: 'rgba(0,102,204,0.25)',   color: '#0066cc' },
  ok:       { bg: 'rgba(48,164,108,0.08)',  border: 'rgba(48,164,108,0.25)',  color: '#1f7a4d' },
  caution:  { bg: 'rgba(204,140,0,0.08)',   border: 'rgba(204,140,0,0.25)',   color: '#a16d00' },
  flag:     { bg: 'rgba(204,55,55,0.08)',   border: 'rgba(204,55,55,0.30)',   color: '#a52323' },
}

function GradeBadge({ grade }) {
  const meta = GRADE_LABELS[grade]
  if (!meta) return null
  const style = TONE_STYLE[meta.tone]
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 6,
      fontSize: 11, fontWeight: 500, letterSpacing: '-0.005em',
      background: style.bg, border: `1px solid ${style.border}`, color: style.color,
    }}>
      {meta.short}
    </span>
  )
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function IncomingBookings() {
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const rows = await fetchIncomingBookings({ daysAhead: 7 })
      setBookings(rows)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function runSync() {
    setSyncing(true)
    setSyncMsg('Starting…')
    try {
      const r = await syncIncomingBookings({ onProgress: setSyncMsg })
      setSyncMsg(`Graded ${r.graded} bookings`)
      await load()
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    if (filter === 'all') return bookings
    if (filter === 'flagged') return bookings.filter(b => b.grade === 1)
    if (filter === 'priority') return bookings.filter(b => b.grade === 4)
    return bookings.filter(b => String(b.grade) === filter)
  }, [bookings, filter])

  const counts = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 }
    bookings.forEach(b => { if (c[b.grade] != null) c[b.grade]++ })
    return c
  }, [bookings])

  if (loading) return <PageShell><Loading>Loading incoming bookings…</Loading></PageShell>

  return (
    <PageShell>
      <PageHeader
        title="Incoming bookings"
        eyebrow="Next 7 days · graded by application rubric"
        action={
          <button
            onClick={runSync}
            disabled={syncing}
            style={{
              fontSize: 12, padding: '6px 12px', border: hair, borderRadius: 6,
              background: '#fff', color: ink, cursor: syncing ? 'wait' : 'pointer',
              fontFamily: 'inherit', letterSpacing: '-0.005em',
            }}
          >
            {syncing ? syncMsg || 'Syncing…' : 'Re-grade now'}
          </button>
        }
      />

      <Section title="Pipeline">
        <div style={{ display: 'flex', gap: 24, marginBottom: 18, flexWrap: 'wrap' }}>
          {[
            { key: 'all',      label: 'All',       value: bookings.length },
            { key: '4',        label: 'Priority',  value: counts[4] },
            { key: '3',        label: 'Confirm',   value: counts[3] },
            { key: '2',        label: 'Double-book', value: counts[2] },
            { key: '1',        label: 'Flagged',   value: counts[1] },
          ].map(s => (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              style={{
                background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontSize: 11, color: ink2, marginBottom: 2 }}>{s.label}</div>
              <div className="num" style={{
                fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em',
                color: filter === s.key ? accent : ink,
              }}>
                {s.value}
              </div>
            </button>
          ))}
        </div>

        {error && <div style={{ color: neg, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}

        {filtered.length === 0 ? (
          <div style={{ fontSize: 13, color: ink2, padding: '32px 0' }}>
            No bookings in the next 7 days. Hit "Re-grade now" to pull the latest from GHL.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: hair }}>
                  <th style={th}>When</th>
                  <th style={th}>Prospect</th>
                  <th style={th}>Closer</th>
                  <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                  <th style={{ ...th, textAlign: 'right' }}>Price</th>
                  <th style={{ ...th, textAlign: 'right' }}>Calls/mo</th>
                  <th style={th}>Grade</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => (
                  <tr key={b.ghl_event_id} style={{ borderBottom: hair }}>
                    <td style={td}>{fmtDateTime(b.start_time)}</td>
                    <td style={td}>
                      <div style={{ color: ink, fontWeight: 500 }}>{b.contact_name || '—'}</div>
                      {b.contact_email && <div style={{ fontSize: 11, color: ink3 }}>{b.contact_email}</div>}
                    </td>
                    <td style={{ ...td, color: ink2 }}>{b.closer?.name || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{b.monthly_revenue ? fmt$(b.monthly_revenue) : <span style={{ color: ink3 }}>—</span>}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{b.price_point ? fmt$(b.price_point) : <span style={{ color: ink3 }}>—</span>}</td>
                    <td style={{ ...td, textAlign: 'right', color: ink2 }}>{b.monthly_calls != null ? b.monthly_calls : <span style={{ color: ink3 }}>—</span>}</td>
                    <td style={td}><GradeBadge grade={b.grade} /></td>
                    <td style={{ ...td, color: ink2, fontSize: 12 }}>
                      {b.recommended_action}
                      {b.grade_reason && <div style={{ fontSize: 11, color: ink3, marginTop: 2 }}>{b.grade_reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </PageShell>
  )
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 500, color: ink2, letterSpacing: '0.02em', textTransform: 'uppercase' }
const td = { padding: '12px', verticalAlign: 'top', color: ink }
