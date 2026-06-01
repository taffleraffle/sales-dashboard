import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ink, ink2, ink3, hair, accent } from './ui'

// Drop-in picker for closers to grab the right payment link in one click.
// Reads from payment_link_catalog. Filters by region → term → pay structure.
// Copy button puts the URL on the clipboard and (optionally) posts to GHL.

export default function PaymentLinkPicker({ region: regionProp, onPicked }) {
  const [rows, setRows] = useState([])
  const [region, setRegion] = useState(regionProp || 'AU')
  const [term, setTerm] = useState('')
  const [structure, setStructure] = useState('')
  const [copied, setCopied] = useState(null)

  useEffect(() => {
    supabase
      .from('payment_link_catalog')
      .select('*')
      .eq('is_active', true)
      .order('region')
      .order('amount')
      .then(({ data }) => setRows(data || []))
  }, [])

  const regions = [...new Set(rows.map(r => r.region))]
  const terms = [...new Set(rows.filter(r => r.region === region).map(r => r.term))]
  const structures = [...new Set(rows.filter(r => r.region === region && r.term === term).map(r => r.pay_structure))]

  const match = rows.find(r =>
    r.region === region && r.term === term && r.pay_structure === structure
  )

  const copy = async (link) => {
    await navigator.clipboard.writeText(link.url)
    setCopied(link.id)
    setTimeout(() => setCopied(null), 1500)
    if (onPicked) onPicked(link)
  }

  return (
    <div style={{
      border: hair, borderRadius: 10, padding: 18, background: 'var(--color-bg-alt)',
    }}>
      <div className="receipt" style={{ marginBottom: 10 }}>Payment link</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Pill label="Region" value={region} options={regions} onChange={v => { setRegion(v); setTerm(''); setStructure('') }} />
        {region && <Pill label="Term" value={term} options={terms} onChange={v => { setTerm(v); setStructure('') }} />}
        {term && <Pill label="Structure" value={structure} options={structures} onChange={setStructure} fmt={s => structureLabel(s)} />}
      </div>

      {match && (
        <div style={{
          marginTop: 14, padding: '12px 14px', borderRadius: 8, border: hair,
          background: 'var(--color-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: ink }}>
              {match.currency === 'AUD' ? 'A$' : 'US$'}{Number(match.amount).toLocaleString()}
              {match.is_recurring && <span style={{ color: ink3, fontWeight: 400, marginLeft: 6, fontSize: 12 }}>· every {match.recurring_interval_days}d</span>}
            </div>
            <div style={{ fontSize: 11, color: ink2, marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
              {match.internal_name}
            </div>
            <div style={{ fontSize: 10, color: ink3, marginTop: 4, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {match.url}
            </div>
          </div>
          <button
            onClick={() => copy(match)}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: copied === match.id ? 'var(--color-pos)' : accent,
              color: '#FAF8F2', border: 0, borderRadius: 6, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {copied === match.id ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

function structureLabel(s) {
  if (s === 'PIF') return 'Paid in full'
  if (s === '2-pay') return '2 payments'
  if (s === '3-pay') return '3 payments'
  if (s === 'sub') return 'Monthly subscription'
  return s
}

function Pill({ label, value, options, onChange, fmt }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 10, color: ink3, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{label}</div>
      <div style={{ display: 'inline-flex', border: hair, borderRadius: 6, overflow: 'hidden' }}>
        {options.map((opt, i) => {
          const active = opt === value
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 500,
                border: 0, borderLeft: i === 0 ? 'none' : hair, cursor: 'pointer',
                background: active ? accent : 'var(--color-bg)',
                color: active ? '#FAF8F2' : ink,
                fontFamily: 'inherit',
              }}
            >
              {fmt ? fmt(opt) : opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}
