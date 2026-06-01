import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Section, ink, ink2, ink3, hair, accent } from './ui'

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function fmtDur(secs) {
  if (!secs || secs <= 0) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export default function RecentCalls({ days = 30, limit = 20 }) {
  const [calls, setCalls] = useState([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    const since = new Date()
    since.setDate(since.getDate() - days)
    supabase
      .from('contact_attempts')
      .select('id, platform, contact_name, prospect_phone, attempted_at, duration_secs, outcome, recording_url, transcript, setter:team_members!contact_attempts_setter_id_fkey(name)')
      .gte('attempted_at', since.toISOString())
      .not('recording_url', 'is', null)
      .order('attempted_at', { ascending: false })
      .limit(limit)
      .then(({ data }) => {
        setCalls(data || [])
        setLoading(false)
      })
  }, [days, limit])

  if (loading) return null
  if (calls.length === 0) return null

  return (
    <Section title="Recent recorded calls" action={<span style={{ fontSize: 11, color: ink3, letterSpacing: '-0.005em' }}>{calls.length} with recording</span>}>
      <div style={{ display: 'grid', gap: 8 }}>
        {calls.map(c => {
          const open = openId === c.id
          return (
            <div key={c.id} style={{ border: hair, borderRadius: 8 }}>
              <div style={{
                padding: '12px 14px', display: 'grid',
                gridTemplateColumns: '1fr auto auto auto', gap: 16, alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontSize: 13, color: ink, fontWeight: 500 }}>
                    {c.contact_name || c.prospect_phone || '(unknown)'}
                    <span style={{ fontSize: 11, color: ink3, fontWeight: 400, marginLeft: 8, textTransform: 'uppercase' }}>{c.platform}</span>
                  </div>
                  <div style={{ fontSize: 11, color: ink2, marginTop: 2 }}>
                    {fmtTime(c.attempted_at)}
                    {c.setter?.name && <> · {c.setter.name}</>}
                    {c.outcome && <> · {c.outcome}</>}
                  </div>
                </div>
                <div className="num" style={{ fontSize: 12, color: ink2 }}>{fmtDur(c.duration_secs)}</div>
                <button
                  onClick={() => setOpenId(open ? null : c.id)}
                  style={{
                    padding: '5px 10px', fontSize: 11, fontFamily: 'inherit',
                    border: hair, borderRadius: 4, background: open ? accent : 'var(--color-bg-alt)',
                    color: open ? '#FAF8F2' : ink, cursor: 'pointer',
                  }}
                >
                  {open ? 'Hide' : 'Play'}
                </button>
                {c.transcript && (
                  <a
                    href="#"
                    onClick={e => { e.preventDefault(); setOpenId(open && openId === c.id ? null : c.id) }}
                    style={{ fontSize: 11, color: accent, textDecoration: 'none' }}
                  >
                    Transcript
                  </a>
                )}
              </div>
              {open && (
                <div style={{ padding: '0 14px 14px' }}>
                  <audio controls src={c.recording_url} style={{ width: '100%', height: 36 }} preload="none" />
                  {c.transcript && (
                    <div style={{
                      marginTop: 12, padding: 12, background: 'rgba(0,0,0,0.02)', borderRadius: 6,
                      fontSize: 12, color: ink2, lineHeight: 1.5, maxHeight: 280, overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                    }}>
                      {c.transcript}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}
