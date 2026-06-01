import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ink, ink2, ink3, hair, accent } from './ui'
import PreCallBrief from './PreCallBrief'

const GHL_LOCATION_ID = 'sc7hQPeXFfKyjtJtI7Ou'

const ghlContactLink = (contactId) =>
  `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function dayBucket(iso) {
  const d = new Date(iso)
  const today = new Date()
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}

export default function PipelineWidget({ closerId }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    if (!closerId) { setLoading(false); return }
    const now = new Date()
    const sevenOut = new Date(now); sevenOut.setDate(now.getDate() + 7)
    supabase
      .from('ghl_appointments')
      .select('ghl_event_id, contact_name, contact_email, start_time, calendar_name, ghl_contact_id, appointment_status, region')
      .eq('closer_id', closerId)
      .gte('start_time', now.toISOString())
      .lte('start_time', sevenOut.toISOString())
      .in('appointment_status', ['confirmed', 'showed', 'new'])
      .order('start_time', { ascending: true })
      .limit(40)
      .then(({ data }) => { setRows(data || []); setLoading(false) })
  }, [closerId])

  if (loading) return null
  if (!rows.length) {
    return (
      <div style={{
        padding: '20px 22px', border: hair, borderRadius: 10,
        background: 'var(--color-bg-alt)', fontSize: 13, color: ink2,
      }}>
        <div className="receipt" style={{ marginBottom: 6 }}>This week</div>
        Nothing booked in the next 7 days. <span style={{ color: ink3 }}>Time to fill the calendar.</span>
      </div>
    )
  }

  // Group by day bucket
  const buckets = []
  let currentBucket = null
  rows.forEach(r => {
    const bucket = dayBucket(r.start_time)
    if (!currentBucket || currentBucket.label !== bucket) {
      currentBucket = { label: bucket, items: [] }
      buckets.push(currentBucket)
    }
    currentBucket.items.push(r)
  })

  return (
    <div style={{
      padding: '20px 22px', border: hair, borderRadius: 10,
      background: 'var(--color-bg-alt)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="receipt">This week</div>
        <div style={{ fontSize: 11, color: ink3, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
          {rows.length} BOOKED
        </div>
      </div>
      {buckets.map(b => (
        <div key={b.label} style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: accent, marginBottom: 8,
            fontFamily: 'var(--font-mono)',
          }}>
            {b.label}
          </div>
          {b.items.map(r => (
            <div key={r.ghl_event_id} style={{ borderBottom: hair }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 0', gap: 10,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: ink }}>
                    {r.contact_name || '(no name)'}
                    {r.region === 'AU' && <span style={{ marginLeft: 6, fontSize: 10, color: ink3, fontFamily: 'var(--font-mono)' }}>AU</span>}
                  </div>
                  <div style={{ fontSize: 11, color: ink2, marginTop: 2 }}>
                    {fmtTime(r.start_time)}
                  </div>
                </div>
                <button
                  onClick={() => setExpandedId(expandedId === r.ghl_event_id ? null : r.ghl_event_id)}
                  style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: ink2, background: 'transparent',
                    border: hair, borderRadius: 5, padding: '5px 9px', cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {expandedId === r.ghl_event_id ? 'Hide' : 'Brief'}
                </button>
                {r.ghl_contact_id && (
                  <a
                    href={ghlContactLink(r.ghl_contact_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: accent, textDecoration: 'none',
                      border: hair, borderRadius: 5, padding: '5px 9px',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    GHL
                  </a>
                )}
              </div>
              {expandedId === r.ghl_event_id && (
                <div style={{ padding: '8px 0 16px' }}>
                  <PreCallBrief ghlEventId={r.ghl_event_id} onClose={() => setExpandedId(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
