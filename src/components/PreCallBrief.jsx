import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ink, ink2, ink3, hair, accent } from './ui'

// Auto-generated pre-call brief for a single upcoming booking.
// Pulls everything we know about the prospect: GHL custom fields,
// intake answers, prior contact attempts, Maps presence, website.

const GHL_LOCATION_ID = 'sc7hQPeXFfKyjtJtI7Ou'

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function PreCallBrief({ ghlEventId, onClose }) {
  const [appt, setAppt] = useState(null)
  const [contact, setContact] = useState(null)
  const [attempts, setAttempts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!ghlEventId) return
    let cancelled = false
    async function load() {
      // 1. Appointment row
      const { data: a } = await supabase
        .from('ghl_appointments')
        .select('*')
        .eq('ghl_event_id', ghlEventId)
        .maybeSingle()
      if (cancelled) return
      setAppt(a)

      // 2. Contact custom fields (Application_Grade, business_name, location, etc.)
      if (a?.ghl_contact_id) {
        const { data: c } = await supabase
          .from('ghl_contacts')
          .select('*')
          .eq('ghl_contact_id', a.ghl_contact_id)
          .maybeSingle()
        if (cancelled) return
        setContact(c)
      }

      // 3. Prior contact attempts (calls, texts) before booking
      if (a?.contact_email) {
        const { data: atts } = await supabase
          .from('contact_attempts')
          .select('platform, channel, attempted_at, outcome, duration_seconds')
          .ilike('contact_email', a.contact_email)
          .order('attempted_at', { ascending: false })
          .limit(10)
        if (cancelled) return
        setAttempts(atts || [])
      }

      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [ghlEventId])

  if (loading) return null
  if (!appt) {
    return <div style={{ padding: 24, color: ink2, fontSize: 13 }}>Booking not found.</div>
  }

  return (
    <div style={{
      background: 'var(--color-bg-alt)', border: hair, borderRadius: 10,
      padding: 22, maxWidth: 720,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="receipt">Pre-call brief</div>
        {onClose && (
          <button onClick={onClose} style={{
            border: 0, background: 'transparent', color: ink3, cursor: 'pointer',
            fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em',
          }}>CLOSE</button>
        )}
      </div>

      <div style={{ fontSize: 22, fontWeight: 600, color: ink, letterSpacing: '-0.02em', marginBottom: 4 }}>
        {appt.contact_name || '(no name)'}
        {appt.region === 'AU' && <span style={{ marginLeft: 8, fontSize: 11, color: ink3, fontFamily: 'var(--font-mono)' }}>AU</span>}
      </div>
      <div style={{ fontSize: 13, color: ink2, marginBottom: 18 }}>
        {fmtTime(appt.start_time)} {appt.calendar_name ? `· ${appt.calendar_name}` : ''}
      </div>

      <Grid>
        <Field label="Email">{appt.contact_email || '—'}</Field>
        <Field label="Phone" mono>{appt.contact_phone || '—'}</Field>
        {contact?.business_name && <Field label="Business">{contact.business_name}</Field>}
        {contact?.industry && <Field label="Industry">{contact.industry}</Field>}
        {contact?.location && <Field label="Location">{contact.location}</Field>}
        {contact?.application_grade && <Field label="Lead grade"><Badge>{contact.application_grade}</Badge></Field>}
        {contact?.monthly_revenue && <Field label="Monthly revenue">{contact.monthly_revenue}</Field>}
        {contact?.current_ranking && <Field label="Google ranking">{contact.current_ranking}</Field>}
        {contact?.website && <Field label="Website"><a href={contact.website} target="_blank" rel="noopener noreferrer" style={{ color: accent }}>{contact.website}</a></Field>}
      </Grid>

      {attempts.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="receipt" style={{ marginBottom: 10 }}>Prior touches ({attempts.length})</div>
          <div style={{ fontSize: 12, color: ink2 }}>
            {attempts.slice(0, 5).map((a, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: hair }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em' }}>
                  {a.platform || a.channel || '?'} {a.outcome ? `· ${a.outcome}` : ''}
                </span>
                <span style={{ color: ink3, fontSize: 11 }}>
                  {new Date(a.attempted_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {appt.ghl_contact_id && (
          <a
            href={`https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${appt.ghl_contact_id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={ctaStyle}
          >
            Open in GHL
          </a>
        )}
        {appt.contact_phone && (
          <a href={`tel:${appt.contact_phone}`} style={ctaSecondary}>
            Call now
          </a>
        )}
      </div>
    </div>
  )
}

function Grid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      {children}
    </div>
  )
}

function Field({ label, children, mono }) {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--color-bg)', borderRadius: 6, border: hair }}>
      <div style={{ fontSize: 10, color: ink3, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: ink, fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}>
        {children}
      </div>
    </div>
  )
}

function Badge({ children }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 4,
      background: 'rgba(31,77,60,0.1)', color: accent,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      fontFamily: 'var(--font-mono)',
    }}>{children}</span>
  )
}

const ctaStyle = {
  padding: '8px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', background: accent, color: '#FAF8F2',
  textDecoration: 'none', borderRadius: 6, fontFamily: 'var(--font-mono)',
}
const ctaSecondary = {
  ...ctaStyle, background: 'transparent', color: ink, border: hair,
}
