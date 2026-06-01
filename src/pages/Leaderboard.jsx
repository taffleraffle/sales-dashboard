import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  PageShell, BrandedHero, Section,
  ink, ink2, ink3, hair, hair2, accent, fmt$, fmtNum,
} from '../components/ui'

// Leaderboard for cash collected MTD across all closers.
// Manager+ sees the all-up board. Closer sees their own row pinned to top.
// Top dog per region gets a special treatment.

const TIERS = [
  { name: 'Starter',  min: 0,      max: 24999 },
  { name: 'Rising',   min: 25000,  max: 74999 },
  { name: 'On Fire',  min: 75000,  max: 149999 },
  { name: 'Top Dog',  min: 150000, max: Infinity },
]

function tierFor(cash) {
  return TIERS.find(t => cash >= t.min && cash <= t.max) || TIERS[0]
}

function startOfMonthUTC() {
  const d = new Date()
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString()
}

function lastMonthSameDOM() {
  const d = new Date()
  const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const start = new Date(Date.UTC(lastMonth.getFullYear(), lastMonth.getMonth(), 1)).toISOString()
  const end = new Date(Date.UTC(lastMonth.getFullYear(), lastMonth.getMonth(), d.getDate() + 1)).toISOString()
  return { start, end }
}

export default function Leaderboard() {
  const { profile, isManager } = useAuth()
  // Everyone sees the full board by default. Closers can't toggle, but they
  // see all regions for healthy competition. Managers + owner get the toggle.
  const [regionFilter, setRegionFilter] = useState('all')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const monthStart = startOfMonthUTC()
      const last = lastMonthSameDOM()

      // 1. All active closers, excluding anyone flagged hide_from_team_views
      // (owner-level users who shouldn't be on the leaderboard)
      const { data: closers } = await supabase
        .from('team_members')
        .select('id, name, region, email')
        .eq('role', 'closer')
        .eq('is_active', true)
        .eq('hide_from_team_views', false)
      if (cancelled) return

      // 2. Earnings this month
      const { data: monthEarn } = await supabase
        .from('commission_earnings')
        .select('closer_id, cash_collected, commission_amt, currency')
        .gte('collected_at', monthStart)

      // 3. Earnings same day-of-month last month for delta
      const { data: lastEarn } = await supabase
        .from('commission_earnings')
        .select('closer_id, cash_collected')
        .gte('collected_at', last.start)
        .lt('collected_at', last.end)

      if (cancelled) return

      // Aggregate per closer
      const data = (closers || []).map(c => {
        const me = (monthEarn || []).filter(e => e.closer_id === c.id)
        const cash = me.reduce((s, e) => s + Number(e.cash_collected || 0), 0)
        const commission = me.reduce((s, e) => s + Number(e.commission_amt || 0), 0)
        const lastCash = (lastEarn || [])
          .filter(e => e.closer_id === c.id)
          .reduce((s, e) => s + Number(e.cash_collected || 0), 0)
        const deals = me.length
        const currency = me[0]?.currency || (c.region === 'AU' ? 'AUD' : 'USD')
        return { ...c, cash, commission, deals, currency, lastCash }
      })
        .sort((a, b) => b.cash - a.cash)
        .map((r, i) => ({ ...r, rank: i + 1 }))

      // Determine top dog per region
      const topAU = data.find(r => r.region === 'AU')
      const topUS = data.find(r => r.region === 'US')
      const withTop = data.map(r => ({
        ...r,
        isTopDog: (r.region === 'AU' && r.id === topAU?.id && r.cash > 0)
               || (r.region === 'US' && r.id === topUS?.id && r.cash > 0),
      }))

      setRows(withTop)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filtered = regionFilter === 'all'
    ? rows
    : rows.filter(r => r.region === regionFilter)

  const myRow = profile?.teamMemberId ? rows.find(r => r.id === profile.teamMemberId) : null

  return (
    <PageShell>
      <BrandedHero
        eyebrow={`MTD CASH COLLECTED · ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase()}`}
        title="Leaderboard"
        sub={<>
          <span className="num" style={{ color: '#FAF8F2', fontWeight: 600 }}>{filtered.length}</span> closers in play
          {filtered[0] && filtered[0].cash > 0 && <>
            <span style={{ marginLeft: 8, color: 'rgba(250,248,242,0.6)' }}>·</span>
            <span style={{ marginLeft: 8 }}>Leading: <b>{filtered[0].name}</b> @ {fmt$(filtered[0].cash)}</span>
          </>}
        </>}
        action={isManager && <RegionPills value={regionFilter} onChange={setRegionFilter} />}
      />

      {/* Sticky "YOU" row */}
      {myRow && (
        <div style={{ borderBottom: hair, background: 'rgba(31,77,60,0.04)' }}>
          <div style={{ maxWidth: 1240, margin: '0 auto', padding: '16px 28px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.16em', color: accent,
              padding: '4px 8px', background: 'rgba(31,77,60,0.1)', borderRadius: 3,
            }}>YOU · #{myRow.rank}</span>
            <span style={{ fontWeight: 600, color: ink, fontSize: 15 }}>{myRow.name}</span>
            <span style={{ marginLeft: 'auto', color: accent, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, fontFeatureSettings: '"tnum"' }}>
              {myRow.currency === 'AUD' ? 'A$' : '$'}{Math.round(myRow.cash).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      <Section title="" padTop={0} padBottom={28}>
        {loading ? (
          <div style={{ padding: 40, color: ink2, fontSize: 13 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{
            padding: 60, fontFamily: 'var(--font-mono)', fontSize: 11,
            letterSpacing: '0.16em', color: ink3, textAlign: 'center',
          }}>NO COLLECTIONS LOGGED YET THIS MONTH</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '60px 1.5fr 110px 1fr 90px 1fr 90px',
              padding: '12px 18px', borderBottom: hair2, gap: 12,
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
              letterSpacing: '0.18em', textTransform: 'uppercase', color: ink3,
            }}>
              <div>RANK</div>
              <div>CLOSER</div>
              <div>TIER</div>
              <div className="num" style={{ textAlign: 'right' }}>CASH MTD</div>
              <div className="num" style={{ textAlign: 'right' }}>DEALS</div>
              <div className="num" style={{ textAlign: 'right' }}>COMMISSION</div>
              <div className="num" style={{ textAlign: 'right' }}>Δ M-1</div>
            </div>
            {filtered.map(r => {
              const tier = tierFor(r.cash)
              const isYou = r.id === profile?.teamMemberId
              const delta = r.lastCash > 0 ? ((r.cash - r.lastCash) / r.lastCash) * 100 : null
              return (
                <div key={r.id} style={{
                  display: 'grid', gridTemplateColumns: '60px 1.5fr 110px 1fr 90px 1fr 90px',
                  padding: '18px', borderBottom: hair, gap: 12,
                  alignItems: 'center',
                  background: isYou ? 'rgba(31,77,60,0.04)' : 'transparent',
                  borderLeft: isYou ? `2px solid ${accent}` : 'none',
                }}>
                  <RankPill rank={r.rank} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 500, color: ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {r.name}
                      {r.isTopDog && <TopDogStamp />}
                    </div>
                    <div style={{ fontSize: 10, color: ink3, marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' }}>
                      {r.region}
                    </div>
                  </div>
                  <TierChip tier={tier} />
                  <div className="num" style={{ textAlign: 'right', fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: ink, fontFeatureSettings: '"tnum"' }}>
                    {r.currency === 'AUD' ? 'A$' : '$'}{Math.round(r.cash).toLocaleString()}
                  </div>
                  <div className="num" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13, color: ink2 }}>
                    {r.deals}
                  </div>
                  <div className="num" style={{ textAlign: 'right', fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: accent, fontFeatureSettings: '"tnum"' }}>
                    {r.currency === 'AUD' ? 'A$' : '$'}{Math.round(r.commission).toLocaleString()}
                  </div>
                  <div className="num" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: delta == null ? ink3 : (delta >= 0 ? accent : ink2), letterSpacing: '0.06em' }}>
                    {delta == null ? '—' : `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)}%`}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="Tier ladder" alt>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {TIERS.map((t, i) => (
            <div key={t.name} style={{
              padding: 16, border: hair, borderRadius: 8, background: 'var(--color-bg)',
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.16em', color: accent, marginBottom: 6,
              }}>{t.name.toUpperCase()}</div>
              <div style={{ fontSize: 12, color: ink2 }}>
                {isFinite(t.max) ? `$${(t.min/1000).toFixed(0)}K to $${(t.max/1000).toFixed(0)}K` : `$${(t.min/1000).toFixed(0)}K+`}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </PageShell>
  )
}

function RankPill({ rank }) {
  const isTop3 = rank <= 3
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 36, height: 28, borderRadius: 6,
      fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
      background: isTop3 ? accent : 'transparent',
      color: isTop3 ? '#FAF8F2' : ink2,
      border: isTop3 ? 'none' : hair,
    }}>
      {String(rank).padStart(2, '0')}
    </span>
  )
}

function TierChip({ tier }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 999,
      background: 'rgba(31,77,60,0.1)', color: accent,
      fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
      letterSpacing: '0.14em', textTransform: 'uppercase',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent }} />
      {tier.name}
    </span>
  )
}

function TopDogStamp() {
  return (
    <span style={{
      fontFamily: 'var(--font-serif)', fontStyle: 'italic',
      fontSize: 13, fontWeight: 600, color: accent,
    }}>Top Dog</span>
  )
}

function RegionPills({ value, onChange }) {
  const opts = [['all', 'All'], ['US', 'US'], ['AU', 'AU']]
  return (
    <div style={{
      display: 'inline-flex', border: '1px solid rgba(250,248,242,0.22)',
      borderRadius: 6, overflow: 'hidden',
    }}>
      {opts.map(([v, l], i) => {
        const active = value === v
        return (
          <button key={v} onClick={() => onChange(v)} style={{
            padding: '6px 12px', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            border: 0, cursor: 'pointer',
            background: active ? 'rgba(250,248,242,0.95)' : 'transparent',
            color: active ? '#1F4D3C' : 'rgba(250,248,242,0.78)',
            borderLeft: i === 0 ? 'none' : '1px solid rgba(250,248,242,0.22)',
            fontFamily: 'var(--font-mono)',
          }}>{l}</button>
        )
      })}
    </div>
  )
}
