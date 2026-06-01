import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { PageShell, BrandedHero, Section, ink, ink2, ink3, hair, accent, fmt$ } from '../components/ui'
import PaymentLinkPicker from '../components/PaymentLinkPicker'

// Sales-script-ordered hero offers (per Daniel: 12W PIF → Trial → GBP).
// These get featured at the top with one-click Copy. Everything else
// drops under "Alternative options".
const HERO_AU = [
  { internal_name: 'AU 12W PIF',          tagline: '12 Week, paid up front',     priority: 'Primary close' },
  { internal_name: 'AU 14D Sprint PIF',   tagline: '14 Day Launch Sprint trial', priority: 'Fallback' },
  { internal_name: 'AU Maps Only PIF',    tagline: 'GBP only',                   priority: 'Floor' },
]

export default function PaymentLinks() {
  const [rows, setRows] = useState([])

  useEffect(() => {
    supabase
      .from('payment_link_catalog')
      .select('*')
      .eq('is_active', true)
      .order('region')
      .order('amount', { ascending: false })
      .then(({ data }) => setRows(data || []))
  }, [])

  const auRows = rows.filter(r => r.region === 'AU')
  const usRows = rows.filter(r => r.region === 'US')

  // Resolve the 3 hero AU offers from the catalog. Keep original order.
  const heroOffers = HERO_AU
    .map(h => ({ ...h, row: rows.find(r => r.internal_name === h.internal_name) }))
    .filter(h => h.row)

  // Alternatives = everything in AU not in the hero set
  const heroSet = new Set(HERO_AU.map(h => h.internal_name))
  const auAlternatives = auRows.filter(r => !heroSet.has(r.internal_name))

  const totalActive = rows.length
  const auCount = auRows.length
  const usCount = usRows.length

  return (
    <PageShell>
      <BrandedHero
        eyebrow="CLOSER TOOLKIT"
        title="Payment links"
        sub={<>
          <span className="num" style={{ color: '#FAF8F2', fontWeight: 600 }}>{totalActive}</span> active links ·
          <span className="num" style={{ color: '#FAF8F2', fontWeight: 600, marginLeft: 4 }}> {usCount}</span> US ·
          <span className="num" style={{ color: '#FAF8F2', fontWeight: 600, marginLeft: 4 }}> {auCount}</span> AU
        </>}
      />

      <Section title="AU · Hero offers">
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: ink2, marginBottom: 18,
        }}>
          Sales script order. Lead with #1. Drop down only if they balk.
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16,
        }}>
          {heroOffers.map((h, i) => <HeroCard key={h.internal_name} index={i + 1} offer={h} />)}
        </div>
      </Section>

      <Section title="Pick a link to send" alt>
        <PaymentLinkPicker />
      </Section>

      <Section title="All active links">
        <Group label="AU alternatives" rows={auAlternatives} />
        <Group label="US · Fanbasis" rows={usRows} />
      </Section>
    </PageShell>
  )
}

function HeroCard({ index, offer }) {
  const [done, setDone] = useState(false)
  const r = offer.row
  const isPrimary = index === 1
  const prefix = r.currency === 'AUD' ? 'A$' : 'US$'

  return (
    <div style={{
      padding: '22px 22px 18px', borderRadius: 12,
      background: isPrimary
        ? 'linear-gradient(135deg, #1F4D3C 0%, #0F2E22 100%)'
        : 'var(--color-bg-alt)',
      border: isPrimary ? 'none' : hair,
      color: isPrimary ? '#FAF8F2' : ink,
      position: 'relative', overflow: 'hidden',
      boxShadow: isPrimary ? '0 4px 24px rgba(15,46,34,0.18)' : '0 1px 2px rgba(0,0,0,0.04)',
    }}>
      {isPrimary && (
        <div style={{
          position: 'absolute', top: -60, right: -60, width: 200, height: 200,
          background: 'radial-gradient(circle, rgba(58,110,90,0.45) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ position: 'relative' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 14, gap: 8,
        }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.18em', textTransform: 'uppercase',
            color: isPrimary ? 'rgba(250,248,242,0.55)' : ink3,
          }}>#{String(index).padStart(2, '0')} · {offer.priority}</span>
          {r.is_recurring && (
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '2px 6px', borderRadius: 3,
              background: isPrimary ? 'rgba(250,248,242,0.15)' : 'rgba(31,77,60,0.08)',
              color: isPrimary ? 'rgba(250,248,242,0.85)' : accent,
            }}>Recurring</span>
          )}
        </div>
        <div className="font-display num" style={{
          fontSize: 44, fontWeight: 800, letterSpacing: '-0.038em',
          lineHeight: 1, fontFeatureSettings: '"tnum"',
        }}>
          {prefix}{Number(r.amount).toLocaleString()}
          {r.is_recurring && <span style={{
            fontSize: 14, fontWeight: 500, marginLeft: 6,
            color: isPrimary ? 'rgba(250,248,242,0.5)' : ink3,
          }}>/28d</span>}
        </div>
        <div style={{
          fontSize: 13, marginTop: 8, color: isPrimary ? 'rgba(250,248,242,0.78)' : ink2,
        }}>{offer.tagline}</div>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em',
          color: isPrimary ? 'rgba(250,248,242,0.45)' : ink3,
          marginTop: 4, marginBottom: 16,
        }}>{r.internal_name}</div>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(r.url)
            setDone(true); setTimeout(() => setDone(false), 1500)
          }}
          style={{
            width: '100%', padding: '10px 14px',
            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            background: done ? '#2D6B53' : (isPrimary ? 'rgba(250,248,242,0.95)' : accent),
            color: done ? '#FAF8F2' : (isPrimary ? accent : '#FAF8F2'),
            border: 0, borderRadius: 6, cursor: 'pointer',
          }}
        >
          {done ? 'Copied ✓' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}

function Group({ label, rows }) {
  if (!rows.length) return null
  return (
    <div style={{ marginBottom: 32 }}>
      <div className="receipt" style={{ marginBottom: 14 }}>{label}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: hair }}>
            <th style={th}>Internal name</th>
            <th style={th}>Term</th>
            <th style={th}>Structure</th>
            <th style={{ ...th, textAlign: 'right' }}>Per charge</th>
            <th style={th}>Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderBottom: hair }}>
              <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.internal_name}</td>
              <td style={td}>{r.term}</td>
              <td style={td}>{r.pay_structure}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="num">
                {r.currency === 'AUD' ? 'A$' : 'US$'}{Number(r.amount).toLocaleString()}
                {r.is_recurring && <span style={{ color: ink3, fontWeight: 400, fontSize: 11, marginLeft: 4 }}>/28d</span>}
              </td>
              <td style={td}>
                <CopyButton url={r.url} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CopyButton({ url }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(url)
        setDone(true); setTimeout(() => setDone(false), 1500)
      }}
      style={{
        padding: '5px 10px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase',
        background: done ? 'var(--color-pos)' : 'transparent',
        color: done ? '#FAF8F2' : ink, border: hair, borderRadius: 5, cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 500, color: ink2, letterSpacing: '0.02em', textTransform: 'uppercase' }
const td = { padding: '12px', verticalAlign: 'middle', color: ink }
