import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'
import { ink, ink2, ink3, hair, hair2, neg } from './ui'

// Flags closers/setters whose key metrics dropped meaningfully week-over-week.
// Owner/manager only — pure noise for individual closers/setters.
//
// Threshold: any metric that drops >= 10 percentage points (for rates) OR >= 25% (for absolutes)
// vs the same window length one period ago.
//
// Only renders when there's at least one flag; silent otherwise.
export default function UnderperformerFlag({ days = 30 }) {
  const [flags, setFlags] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const numDays = typeof days === 'number' ? days : 30
      const today = new Date()
      const startCurrent = new Date(); startCurrent.setDate(today.getDate() - numDays)
      const startPrior   = new Date(); startPrior.setDate(today.getDate() - (numDays * 2))
      const fmt = d => d.toISOString().split('T')[0]

      const [members, curR, priR] = await Promise.all([
        supabase.from('team_members').select('id, name, role').eq('is_active', true),
        supabase.from('closer_eod_reports').select('*').gte('report_date', fmt(startCurrent)).lte('report_date', fmt(today)),
        supabase.from('closer_eod_reports').select('*').gte('report_date', fmt(startPrior)).lt('report_date', fmt(startCurrent)),
      ])

      const closers = (members.data || []).filter(m => m.role === 'closer')
      const flagged = []

      for (const c of closers) {
        const cur = aggregate((curR.data || []).filter(r => r.closer_id === c.id))
        const pri = aggregate((priR.data || []).filter(r => r.closer_id === c.id))

        // Skip if the prior period had no activity — can't compare a from-zero
        if (pri.booked === 0 && pri.cash === 0) continue
        // Skip if too little current data
        if (cur.booked < 3) continue

        const concerns = []
        if (pri.showRate >= 50 && (pri.showRate - cur.showRate) >= 10) {
          concerns.push(`show rate ${cur.showRate.toFixed(0)}% (was ${pri.showRate.toFixed(0)}%)`)
        }
        if (pri.closeRate >= 15 && (pri.closeRate - cur.closeRate) >= 8) {
          concerns.push(`close rate ${cur.closeRate.toFixed(0)}% (was ${pri.closeRate.toFixed(0)}%)`)
        }
        if (pri.cash > 1000 && cur.cash <= pri.cash * 0.6) {
          concerns.push(`cash $${Math.round(cur.cash).toLocaleString()} (was $${Math.round(pri.cash).toLocaleString()})`)
        }
        if (concerns.length) {
          flagged.push({ id: c.id, name: c.name, role: 'closer', concerns })
        }
      }

      if (!cancelled) { setFlags(flagged); setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [days])

  if (loading || flags.length === 0) return null

  return (
    <div style={{
      maxWidth: 1240, margin: '0 auto', padding: '20px 28px',
      borderBottom: hair, background: 'rgba(255,69,58,0.03)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="font-display" style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-0.012em', color: neg }}>
          Worth a look
        </div>
        <div style={{ fontSize: 11, color: ink3, letterSpacing: '-0.005em' }}>
          {flags.length} {flags.length === 1 ? 'person' : 'people'} regressing vs prior period
        </div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {flags.map(f => (
          <Link key={f.id} to={`/sales/${f.role}s/${f.id}`}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 12,
              fontSize: 13, color: ink, textDecoration: 'none',
              padding: '6px 0', borderBottom: hair2,
            }}
          >
            <span style={{ fontWeight: 500, minWidth: 100 }}>{f.name}</span>
            <span style={{ color: ink2, letterSpacing: '-0.005em' }}>{f.concerns.join(' · ')}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

function aggregate(reports) {
  const t = reports.reduce((a, r) => ({
    cash:      a.cash + parseFloat(r.total_cash_collected || 0),
    closes:    a.closes + (r.closes || 0),
    offers:    a.offers + (r.offers || 0),
    liveCalls: a.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
    booked:    a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
  }), { cash: 0, closes: 0, offers: 0, liveCalls: 0, booked: 0 })
  return {
    ...t,
    showRate:  t.booked ? (t.liveCalls / t.booked) * 100 : 0,
    closeRate: t.liveCalls ? (t.closes / t.liveCalls) * 100 : 0,
  }
}
