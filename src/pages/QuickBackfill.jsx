import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { pushOutcomeToGHL, pushCallToGHL } from '../services/ghlOutcomePush'
import { syncGHLAppointments } from '../services/ghlCalendar'
import { getCallTypeFromCalendar, getRegionFromCalendar } from '../lib/callTypes'
import GranularOutcomeFields from '../components/eod/GranularOutcomeFields'
import AIPrefillBanner, { applySuggestionsToMark } from '../components/eod/AIPrefillBanner'
import {
  PageShell, PageHeader, Section, Loading,
  fmt$, ink, ink2, ink3, hair, accent, pos, neg,
} from '../components/ui'

// Owner-only Quick Backfill — list every GHL appointment across the last N days
// for the selected closer, let user mark outcome per appointment, save in one shot.
//
// Per-appointment mark = same model as the regular EOD page, just bulk.
// Writes both closer_eod_reports (one per date) and closer_calls (one per appointment).

const OUTCOMES = [
  { key: 'closed',            label: 'Closed',             tone: 'pos' },
  { key: 'follow_up_booked',  label: 'Follow-up Booked',   tone: 'accent' },
  { key: 'not_closed',        label: 'Not Closed',         tone: 'ink' },
  { key: 'no_show',           label: 'No Show',            tone: 'neg' },
  { key: 'rescheduled',       label: 'Rescheduled',        tone: 'accent' },
  { key: 'cancelled',         label: 'Cancelled',          tone: 'ink2' },
]
const LIVE_OUTCOMES = ['closed', 'not_closed', 'follow_up_booked']

function fmtDay(iso) {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function QuickBackfill() {
  const { profile } = useAuth()
  const [closers, setClosers] = useState([])
  const [selectedCloser, setSelectedCloser] = useState(profile?.teamMemberId || '')
  const [daysBack, setDaysBack] = useState(14)
  const [appointments, setAppointments] = useState([])     // raw appointments
  const [marks, setMarks] = useState({})                   // { ghl_event_id: { outcome, revenue, cash } }
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState(null)
  const [reloadTick, setReloadTick] = useState(0)

  // Active closers for the dropdown
  useEffect(() => {
    supabase
      .from('team_members')
      .select('id, name, ghl_user_id')
      .eq('role', 'closer')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setClosers(data || []))
  }, [])

  // Window of dates
  const dates = useMemo(() => {
    const arr = []
    const today = new Date()
    for (let i = 0; i < daysBack; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      arr.push(d.toISOString().split('T')[0])
    }
    return arr
  }, [daysBack])

  // Load appointments + existing closer_calls (to pre-fill outcomes already marked)
  useEffect(() => {
    if (!selectedCloser) { setAppointments([]); setMarks({}); return }
    setLoading(true)
    setError(null)
    ;(async () => {
      const closer = closers.find(c => c.id === selectedCloser)
      const ghlUserId = closer?.ghl_user_id
      const start = dates[dates.length - 1]
      const end = dates[0]

      // 1) Pull GHL appointments for this closer in the window
      let q = supabase
        .from('ghl_appointments')
        .select('ghl_event_id, contact_name, contact_email, start_time, calendar_name, appointment_date, appointment_status, ghl_contact_id')
        .gte('appointment_date', start)
        .lte('appointment_date', end)
        .order('start_time', { ascending: true })
      if (ghlUserId) {
        q = q.or(`closer_id.eq.${selectedCloser},ghl_user_id.eq.${ghlUserId}`)
      } else {
        q = q.eq('closer_id', selectedCloser)
      }
      const { data: appts, error: aErr } = await q
      if (aErr) { setError(aErr.message); setLoading(false); return }

      // Only keep sales calls — growth_call / growth_consult / follow_up. Skip catch-ups, internal, unknown.
      const salesOnly = (appts || []).filter(a => getCallTypeFromCalendar(a.calendar_name) !== null)
      setAppointments(salesOnly)

      // 2) Find existing closer_calls for these appointments (so previously-marked outcomes pre-fill)
      const eventIds = (appts || []).map(a => a.ghl_event_id).filter(Boolean)
      const prefilled = {}
      if (eventIds.length > 0) {
        const { data: existingCalls } = await supabase
          .from('closer_calls')
          .select('id, ghl_event_id, outcome, revenue, cash_collected, offered, offered_finance, notes, ai_prefill_status, ai_prefill_payload')
          .in('ghl_event_id', eventIds)
        for (const c of existingCalls || []) {
          prefilled[c.ghl_event_id] = {
            outcome: c.outcome || '',
            revenue: c.revenue || 0,
            cash: c.cash_collected || 0,
            offered: !!c.offered,
            offered_finance: !!c.offered_finance,
            notes: c.notes || '',
            _closer_call_id: c.id,
            _ai_prefill_status: c.ai_prefill_status,
            _ai_prefill_payload: c.ai_prefill_payload,
          }
        }
      }
      setMarks(prefilled)
      setLoading(false)
    })()
  }, [selectedCloser, dates, closers, reloadTick])

  const pullFromGHL = async () => {
    setSyncing(true)
    setSyncMsg('Starting…')
    try {
      const start = dates[dates.length - 1]
      const end = dates[0]
      const r = await syncGHLAppointments(start, end, (m) => setSyncMsg(m))
      setSyncMsg(`Synced ${r.synced} appointments from ${r.scanned} contacts`)
      setReloadTick(t => t + 1)  // trigger re-fetch
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const setMark = (eventId, field, value) => {
    setMarks(prev => {
      const cur = prev[eventId] || { outcome: '', revenue: 0, cash: 0, offered: false, offered_finance: false, notes: '' }
      const next = { ...cur, [field]: value }
      // Reset revenue/cash on non-won outcomes
      if (field === 'outcome' && !['closed'].includes(value)) {
        next.revenue = 0; next.cash = 0
      }
      // Fire-and-forget GHL sync on outcome change
      if (field === 'outcome' && eventId) {
        pushOutcomeToGHL(eventId, value).then(r => {
          if (!r.ok) console.warn('GHL push failed:', r.error)
        })
      }
      return { ...prev, [eventId]: next }
    })
  }

  // Group appointments by date
  const byDate = useMemo(() => {
    const map = {}
    for (const a of appointments) {
      const d = a.appointment_date
      if (!map[d]) map[d] = []
      map[d].push(a)
    }
    return map
  }, [appointments])

  // Save: for each date with marked calls, upsert an eod_report + write closer_calls rows
  const saveAll = async () => {
    if (!selectedCloser) return
    setSaving(true)
    setMsg('')
    setError(null)
    let reports = 0, callsWritten = 0
    try {
      for (const date of dates) {
        const dayAppts = byDate[date] || []
        const dayMarks = dayAppts
          .map(a => ({ appt: a, mark: marks[a.ghl_event_id] }))
          .filter(x => x.mark && x.mark.outcome)
        if (dayMarks.length === 0) continue

        // Aggregate per-day stats from marks
        let booked = 0, live = 0, noShow = 0, rescheduled = 0, closes = 0, offers = 0, revenue = 0, cash = 0
        for (const { mark } of dayMarks) {
          booked += 1
          if (LIVE_OUTCOMES.includes(mark.outcome)) live += 1
          if (mark.outcome === 'no_show')      noShow += 1
          if (mark.outcome === 'rescheduled')  rescheduled += 1
          if (mark.outcome === 'closed')       closes += 1
          if (mark.offered)                    offers += 1
          revenue += Number(mark.revenue || 0)
          cash    += Number(mark.cash    || 0)
        }

        // Upsert closer_eod_report for this (closer, date)
        const { data: existing } = await supabase
          .from('closer_eod_reports')
          .select('id')
          .eq('closer_id', selectedCloser)
          .eq('report_date', date)
          .maybeSingle()

        const reportPayload = {
          closer_id: selectedCloser,
          report_date: date,
          nc_booked: booked,
          live_nc_calls: live,
          nc_no_shows: noShow,
          reschedules: rescheduled,
          offers: offers,
          closes: closes,
          total_revenue: revenue,
          total_cash_collected: cash,
          is_confirmed: true,
        }
        let reportId
        if (existing?.id) {
          const { error: e } = await supabase.from('closer_eod_reports').update(reportPayload).eq('id', existing.id)
          if (e) throw e
          reportId = existing.id
        } else {
          const { data: ins, error: e } = await supabase.from('closer_eod_reports').insert(reportPayload).select('id').single()
          if (e) throw e
          reportId = ins.id
        }
        reports++

        // Upsert each closer_calls row by ghl_event_id
        for (const { appt, mark } of dayMarks) {
          const callPayload = {
            eod_report_id: reportId,
            ghl_event_id: appt.ghl_event_id,
            prospect_name: appt.contact_name,
            outcome: mark.outcome,
            revenue: Number(mark.revenue || 0),
            cash_collected: Number(mark.cash || 0),
            offered: !!mark.offered,
            offered_finance: !!mark.offered_finance,
            notes: mark.notes || null,
            showed: LIVE_OUTCOMES.includes(mark.outcome),
            call_type: getCallTypeFromCalendar(appt.calendar_name) || 'new_call',
            calendar_name: appt.calendar_name,
            region: getRegionFromCalendar(appt.calendar_name),
            // Granular tracking
            confirm_method:           mark.confirm_method || null,
            decision_maker_present:   mark.decision_maker_present ?? null,
            offers_pitched:           mark.offers_pitched && mark.offers_pitched.length > 0 ? mark.offers_pitched : null,
            offer_downsell_occurred:  mark.offer_downsell_occurred ?? null,
            follow_up_reason:         mark.follow_up_reason || null,
            follow_up_timeframe_days: mark.follow_up_timeframe_days ?? null,
            follow_up_timeframe_reason: mark.follow_up_timeframe_reason || null,
            objection_category:       mark.objection_category || null,
            next_state:               mark.next_state || null,
            pre_call_video_watched_pct: mark.pre_call_video_watched_pct ?? null,
          }
          const { data: existingCall } = await supabase
            .from('closer_calls')
            .select('id')
            .eq('ghl_event_id', appt.ghl_event_id)
            .maybeSingle()
          if (existingCall?.id) {
            const { error: e } = await supabase.from('closer_calls').update(callPayload).eq('id', existingCall.id)
            if (e) throw e
          } else {
            const { error: e } = await supabase.from('closer_calls').insert(callPayload)
            if (e) throw e
          }
          // Push granular snapshot to GHL (status + tags + custom fields) — fire and forget
          pushCallToGHL({ ...callPayload, ghl_contact_id: appt.ghl_contact_id })
            .catch(err => console.warn('GHL granular push failed:', err.message))
          callsWritten++
        }
      }
      setMsg(`Saved · ${reports} EOD reports, ${callsWritten} call outcomes`)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const totalAppts = appointments.length
  const totalMarked = Object.values(marks).filter(m => m.outcome).length

  return (
    <PageShell>
      <PageHeader
        title="Quick backfill"
        eyebrow="Mark outcomes per appointment, save all days at once"
      />

      <Section title="Setup">
        <div style={{ display: 'flex', gap: 24, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: ink2 }}>
            Closer
            <select
              value={selectedCloser}
              onChange={e => setSelectedCloser(e.target.value)}
              style={{ marginLeft: 8, padding: '6px 10px', fontSize: 13, border: hair, borderRadius: 6, fontFamily: 'inherit', color: ink, background: 'var(--color-bg-alt)' }}
            >
              <option value="">— select —</option>
              {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: ink2 }}>
            Days back
            <select
              value={daysBack}
              onChange={e => setDaysBack(Number(e.target.value))}
              style={{ marginLeft: 8, padding: '6px 10px', fontSize: 13, border: hair, borderRadius: 6, fontFamily: 'inherit', color: ink, background: 'var(--color-bg-alt)' }}
            >
              {[7, 14, 21, 30].map(n => <option key={n} value={n}>{n} days</option>)}
            </select>
          </label>
          <div style={{ fontSize: 12, color: ink2 }}>
            {totalAppts} appointments · {totalMarked} marked
          </div>
          <button
            onClick={pullFromGHL}
            disabled={syncing}
            style={{
              padding: '6px 12px', fontSize: 12, fontFamily: 'inherit',
              background: 'var(--color-bg-alt)', color: ink, border: hair, borderRadius: 6,
              cursor: syncing ? 'wait' : 'pointer',
            }}
          >
            {syncing ? syncMsg || 'Syncing…' : 'Pull from GHL'}
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
            {syncMsg && !syncing && <span style={{ fontSize: 11, color: ink3 }}>{syncMsg}</span>}
            {msg && <span style={{ fontSize: 12, color: pos }}>{msg}</span>}
            {error && <span style={{ fontSize: 12, color: neg }}>{error}</span>}
            <button
              onClick={saveAll}
              disabled={saving || !selectedCloser || totalMarked === 0}
              style={{
                padding: '8px 16px', fontSize: 13, fontFamily: 'inherit',
                background: accent, color: '#FAF8F2', border: 0, borderRadius: 6,
                cursor: saving || !selectedCloser || totalMarked === 0 ? 'not-allowed' : 'pointer',
                opacity: saving || !selectedCloser || totalMarked === 0 ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving…' : `Save all (${totalMarked})`}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: ink3, marginTop: 12, letterSpacing: '-0.005em' }}>
          Outcome clicks also push live to GHL (one-way). Closed needs revenue + cash. Days with no marked appointments are skipped. Already-marked appointments pre-fill so re-saves don't lose data.
        </div>
      </Section>

      {loading ? (
        <Loading>Loading appointments…</Loading>
      ) : totalAppts === 0 && selectedCloser ? (
        <Section title="No appointments">
          <div style={{ fontSize: 13, color: ink2, padding: '24px 0' }}>
            No GHL appointments for this closer in the last {daysBack} days. Either the GHL sync hasn't pulled them yet, or there genuinely weren't any. Try increasing the window or checking GHL directly.
          </div>
        </Section>
      ) : (
        dates.map(date => {
          const dayAppts = byDate[date] || []
          if (dayAppts.length === 0) return null
          const dayMarked = dayAppts.filter(a => marks[a.ghl_event_id]?.outcome).length
          return (
            <Section key={date} title={fmtDay(date)} action={<span style={{ fontSize: 11, color: ink2 }}>{dayMarked}/{dayAppts.length} marked</span>}>
              <div style={{ display: 'grid', gap: 10 }}>
                {dayAppts.map(a => {
                  const mark = marks[a.ghl_event_id] || {}
                  const callType = getCallTypeFromCalendar(a.calendar_name)
                  return (
                    <div key={a.ghl_event_id} style={{
                      border: hair, borderRadius: 8, padding: 14,
                      background: mark.outcome ? 'rgba(31,77,60,0.02)' : 'var(--color-bg-alt)',
                      display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
                    }}>
                      <div style={{ gridColumn: '1 / -1' }}>
                        {mark._closer_call_id && (
                          <AIPrefillBanner
                            call={{
                              id: mark._closer_call_id,
                              ai_prefill_status: mark._ai_prefill_status,
                              ai_prefill_payload: mark._ai_prefill_payload,
                            }}
                            onApply={(suggestions) => {
                              setMarks(prev => ({
                                ...prev,
                                [a.ghl_event_id]: applySuggestionsToMark(prev[a.ghl_event_id] || {}, suggestions),
                              }))
                            }}
                            onRefresh={() => setReloadTick(t => t + 1)}
                          />
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, color: ink, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {a.contact_name || '(no name)'}
                          {a.ghl_contact_id && (
                            <a
                              href={`https://app.gohighlevel.com/v2/location/sc7hQPeXFfKyjtJtI7Ou/contacts/detail/${a.ghl_contact_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open in GHL"
                              style={{
                                fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                                textTransform: 'uppercase', color: accent, textDecoration: 'none',
                                border: hair, borderRadius: 4, padding: '2px 6px',
                                fontFamily: 'var(--font-mono)',
                              }}
                            >GHL</a>
                          )}
                          {a.contact_phone && (
                            <a
                              href={`tel:${a.contact_phone}`}
                              title={`Call ${a.contact_phone}`}
                              style={{
                                fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                                textTransform: 'uppercase', color: ink2, textDecoration: 'none',
                                border: hair, borderRadius: 4, padding: '2px 6px',
                                fontFamily: 'var(--font-mono)',
                              }}
                            >CALL</a>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: ink3, fontWeight: 400 }}>
                            {fmtTime(a.start_time)} {callType ? `· ${callType.replace('_', ' ')}` : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {OUTCOMES.map(o => (
                            <button
                              key={o.key}
                              onClick={() => setMark(a.ghl_event_id, 'outcome', o.key)}
                              style={{
                                padding: '5px 10px', fontSize: 11, borderRadius: 4,
                                border: hair, cursor: 'pointer', fontFamily: 'inherit',
                                background: mark.outcome === o.key ? accent : 'var(--color-bg-alt)',
                                color: mark.outcome === o.key ? '#FAF8F2' : ink2,
                              }}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {LIVE_OUTCOMES.includes(mark.outcome) && (
                          <>
                            <label style={{ fontSize: 11, color: ink2, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={!!mark.offered}
                                onChange={e => setMark(a.ghl_event_id, 'offered', e.target.checked)}
                              />
                              Offered
                            </label>
                            <label style={{ fontSize: 11, color: ink2, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={!!mark.offered_finance}
                                onChange={e => setMark(a.ghl_event_id, 'offered_finance', e.target.checked)}
                              />
                              Finance
                            </label>
                          </>
                        )}
                        {mark.outcome === 'closed' && (
                          <>
                            <label style={{ fontSize: 11, color: ink2 }}>
                              Rev
                              <input
                                type="number" min="0" step="0.01"
                                value={mark.revenue ?? ''}
                                onChange={e => setMark(a.ghl_event_id, 'revenue', e.target.value)}
                                style={{ marginLeft: 6, width: 90, padding: '4px 6px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit' }}
                              />
                            </label>
                            <label style={{ fontSize: 11, color: ink2 }}>
                              Cash
                              <input
                                type="number" min="0" step="0.01"
                                value={mark.cash ?? ''}
                                onChange={e => setMark(a.ghl_event_id, 'cash', e.target.value)}
                                style={{ marginLeft: 6, width: 90, padding: '4px 6px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit' }}
                              />
                            </label>
                          </>
                        )}
                      </div>
                      {mark.outcome && (
                        <>
                          <input
                            type="text"
                            placeholder="Notes (optional)"
                            value={mark.notes ?? ''}
                            onChange={e => setMark(a.ghl_event_id, 'notes', e.target.value)}
                            style={{ gridColumn: '1 / -1', marginTop: 4, padding: '5px 8px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit', color: ink }}
                          />
                          <div style={{ gridColumn: '1 / -1' }}>
                            <GranularOutcomeFields
                              value={mark}
                              onChange={(field, val) => setMark(a.ghl_event_id, field, val)}
                              outcome={mark.outcome}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </Section>
          )
        })
      )}
    </PageShell>
  )
}
