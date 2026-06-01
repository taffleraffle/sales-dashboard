import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Section, fmt$, ink, ink2, ink3, hair, pos } from './ui'

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function PaymentsSection({ days = 30, region = 'all' }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const since = new Date()
    since.setDate(since.getDate() - days)
    let q = supabase
      .from('payments')
      .select('id, source, customer_name, customer_email, amount, paid_at, product_name, status, region, matched_closer:team_members!payments_matched_closer_id_fkey(name, region)')
      .gte('paid_at', since.toISOString())
      .order('paid_at', { ascending: false })
      .limit(20)
    if (region === 'US' || region === 'AU') q = q.eq('region', region)
    q.then(({ data }) => { setRows(data || []); setLoading(false) })
  }, [days, region])

  if (loading) return null

  const total = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0)

  return (
    <Section
      title="Payments"
      action={
        <span style={{ fontSize: 11, color: ink3, letterSpacing: '-0.005em' }}>
          {rows.length} in last {days}d · <span style={{ color: pos, fontWeight: 500 }}>{fmt$(total)}</span> collected
        </span>
      }
    >
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: ink3, padding: '16px 0' }}>
          No payments yet. Once Fanbasis sends a webhook for a new transaction, it'll appear here.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: hair }}>
                <th style={th}>Date</th>
                <th style={th}>Customer</th>
                <th style={th}>Product</th>
                <th style={th}>Closer</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderBottom: hair }}>
                  <td style={td}>{fmtDate(r.paid_at)}</td>
                  <td style={td}>
                    <div style={{ color: ink, fontWeight: 500 }}>{r.customer_name || '(no name)'}</div>
                    {r.customer_email && <div style={{ fontSize: 11, color: ink3 }}>{r.customer_email}</div>}
                  </td>
                  <td style={{ ...td, color: ink2, fontSize: 12 }}>{r.product_name || '—'}</td>
                  <td style={{ ...td, color: ink2 }}>{r.matched_closer?.name || <span style={{ color: ink3 }}>unmatched</span>}</td>
                  <td style={{ ...td, textAlign: 'right', color: pos, fontWeight: 500 }} className="num">
                    {fmt$(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 500, color: ink2, letterSpacing: '0.02em', textTransform: 'uppercase' }
const td = { padding: '12px', verticalAlign: 'top', color: ink }
