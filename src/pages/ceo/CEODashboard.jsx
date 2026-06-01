import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useMarketingTracker } from '../../hooks/useMarketingTracker'
import { computeMarketingStats } from '../../hooks/useMarketingTracker'
import { evaluateConstraints } from '../../lib/constraints'
import {
  PageShell, BrandedHero, Section, KpiStrip,
  Th, Td, DataTable, EmptyRow,
  ink, ink2, ink3, pos, neg, hair, hair2, fmt$, fmtPct, fmtNum,
} from '../../components/ui'

/*
  CEO cockpit — the live version of the master tracker's Annual Dashboard.

  Layered per the plan: daily glance on top (north-star tiles + the single
  biggest constraint), weekly deep-review below (acquisition scorecard scored
  against KPI thresholds + trailing-period table + portfolio).

  Phase A runs on data already flowing (marketing_tracker via
  computeMarketingStats, clients for MRR). LTGP:CAC, churn, and the P&L join in
  Phase B/C.
*/

const WARNING = '#b88200'
const STATUS_COLOR = { healthy: pos, warning: WARNING, critical: neg, nodata: ink3 }
const STATUS_LABEL = { healthy: 'On KPI', warning: 'Near KPI', critical: 'Below KPI', nodata: 'No data' }

const todayStr = () => new Date().toISOString().split('T')[0]
function cutoffStr(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}
function monthStartStr() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), 1).toISOString().split('T')[0]
}

export default function CEODashboard() {
  const { entries, loading: mktLoading } = useMarketingTracker()
  const [portfolio, setPortfolio] = useState(null)
  const [portfolioLoading, setPortfolioLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function load() {
      setPortfolioLoading(true)
      try {
        const [clientsRes, leads7Res, attentionRes, mrrRes, payRes] = await Promise.all([
          supabase.from('clients').select('id, status, vertical, monthly_fee, created_at'),
          supabase.from('client_leads')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', new Date(cutoffStr(7)).toISOString()),
          supabase.from('client_communications')
            .select('id', { count: 'exact', head: true })
            .is('acknowledged_at', null)
            .eq('direction', 'inbound'),
          // Real money model from Stripe (aggregate snapshot + cash).
          supabase.from('mrr_snapshots').select('*').order('snapshot_date', { ascending: false }).limit(1),
          supabase.from('payments').select('amount, payment_date').eq('source', 'stripe'),
        ])
        if (!mounted) return
        const clients = clientsRes.data || []
        const active = clients.filter(c => ['active', 'trial', 'onboarding'].includes(c.status))
        const verticalBreakdown = active.reduce((acc, c) => {
          const v = c.vertical || 'unspecified'
          acc[v] = (acc[v] || 0) + 1
          return acc
        }, {})
        // Stripe is the source of truth for MRR; fall back to contract sum if not synced.
        const snap = (mrrRes.data && mrrRes.data[0]) || null
        const contractMrr = active.reduce((s, c) => s + Number(c.monthly_fee || 0), 0)
        const realMrr = snap ? Number(snap.active_mrr) : contractMrr
        const since30 = cutoffStr(30)
        const stripeCash30 = (payRes.data || [])
          .filter(p => (p.payment_date || '') >= since30)
          .reduce((s, p) => s + Number(p.amount || 0), 0)
        setPortfolio({
          activeClients: active.length,
          newThisMonth: clients.filter(c => c.created_at >= monthStartStr()).length,
          churned: clients.filter(c => c.status === 'churned').length,
          mrr: realMrr, arr: realMrr * 12,
          activeSubs: snap ? snap.active_subs : null,
          pastDueSubs: snap ? snap.past_due_subs : 0,
          arOutstanding: snap ? Number(snap.ar_outstanding) : null,
          stripeCash30,
          leads7d: leads7Res.count || 0,
          unackedComms: attentionRes.count || 0,
          verticalBreakdown,
        })
      } finally {
        if (mounted) setPortfolioLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [])

  // Trailing windows off the 90-day entries the hook already holds.
  const windows = useMemo(() => {
    const inWindow = (since) => entries.filter(e => e.date >= since && e.date <= todayStr())
    return {
      d7: computeMarketingStats(inWindow(cutoffStr(7))),
      d30: computeMarketingStats(inWindow(cutoffStr(30))),
      d90: computeMarketingStats(inWindow(cutoffStr(90))),
      mtd: computeMarketingStats(inWindow(monthStartStr())),
    }
  }, [entries])

  // Constraint is judged on a reconciled 30-day window (per the ToC method).
  const { readings, constraint } = useMemo(() => evaluateConstraints(windows.d30), [windows])

  if (mktLoading || portfolioLoading) {
    return <PageShell><div style={{ padding: '80px 28px', textAlign: 'center', color: ink2 }}>Loading cockpit…</div></PageShell>
  }

  const p = portfolio || {}
  const s30 = windows.d30
  const periodLabel = `Trailing 30 days · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  const northStars = [
    { label: 'MRR', value: fmt$(p.mrr), ctx: p.activeSubs != null ? `${p.activeSubs} active subs${p.pastDueSubs ? ` · ${p.pastDueSubs} past due` : ''}` : `ARR ${fmt$(p.arr)}` },
    { label: 'Cash collected · 30d', value: fmt$(p.stripeCash30), ctx: 'Stripe, this period' },
    { label: 'AR outstanding', value: p.arOutstanding != null ? fmt$(p.arOutstanding) : '—', ctx: 'open invoices' },
    { label: 'Close rate · 30d', value: fmtPct(s30.close_rate), ctx: `${fmtNum(s30.closes)} closes` },
    { label: 'Active clients', value: fmtNum(p.activeClients), ctx: `+${p.newThisMonth} new · ${p.churned} churned` },
  ]

  return (
    <PageShell>
      <BrandedHero eyebrow="Rank On Maps · CEO" title="Command center" sub={periodLabel} />

      <KpiStrip cells={northStars} columns={5} />

      {/* Biggest constraint — the one lever to pull. */}
      <ConstraintBanner constraint={constraint} />

      {/* Acquisition scorecard — every KPI against its threshold. */}
      <Section title="Acquisition scorecard" action="Trailing 30 days vs KPI">
        <div style={{
          display: 'grid', gap: 0,
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          border: hair, borderRadius: 4, overflow: 'hidden',
        }}>
          {readings.map((r, i) => <ScoreCell key={r.key} r={r} index={i} />)}
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: ink3, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
          Drill in: <Link to="/sales/marketing" style={{ color: ink2 }}>Marketing performance</Link> · <Link to="/sales" style={{ color: ink2 }}>Sales overview</Link>
        </div>
      </Section>

      {/* Trailing-period table — the master tracker's rollup, live. */}
      <Section title="Trailing periods" alt>
        <DataTable>
          <thead>
            <tr>
              <Th>Window</Th>
              <Th right>Spend</Th>
              <Th right>CPQBC</Th>
              <Th right>Show %</Th>
              <Th right>Close %</Th>
              <Th right>CPA</Th>
              <Th right>New cash</Th>
              <Th right>Cash ROAS</Th>
              <Th right>Rev ROAS</Th>
              <Th right>All cash</Th>
            </tr>
          </thead>
          <tbody>
            {[
              { k: 'MTD', s: windows.mtd },
              { k: '7 days', s: windows.d7 },
              { k: '30 days', s: windows.d30 },
              { k: '90 days', s: windows.d90 },
            ].map(({ k, s }) => (
              <tr key={k}>
                <Td v>{k}</Td>
                <Td right>{fmt$(s.adspend)}</Td>
                <Td right>{s.cpb > 0 ? fmt$(s.cpb) : '—'}</Td>
                <Td right>{fmtPct(s.show_rate)}</Td>
                <Td right>{fmtPct(s.close_rate)}</Td>
                <Td right>{s.cpa_trial > 0 ? fmt$(s.cpa_trial) : '—'}</Td>
                <Td right>{fmt$(s.trial_cash)}</Td>
                <Td right>{s.trial_fe_roas.toFixed(2)}x</Td>
                <Td right>{s.revenue_roas.toFixed(2)}x</Td>
                <Td right>{fmt$(s.all_cash)}</Td>
              </tr>
            ))}
            {entries.length === 0 && <EmptyRow span={10}>No marketing tracker data in the last 90 days.</EmptyRow>}
          </tbody>
        </DataTable>
      </Section>

      {/* Portfolio + attention. */}
      <Section title="Portfolio">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 28 }}>
          <div>
            <div style={eyebrowStyle}>Vertical mix</div>
            {Object.keys(p.verticalBreakdown || {}).length === 0
              ? <div style={{ fontSize: 13, color: ink3, marginTop: 12 }}>No active clients yet.</div>
              : <div style={{ marginTop: 12 }}>
                  {Object.entries(p.verticalBreakdown).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                    <div key={v} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: hair2 }}>
                      <span style={{ fontSize: 13, color: ink, textTransform: 'capitalize' }}>{v}</span>
                      <div style={{ flex: 1, height: 4, background: 'var(--color-hairline)', borderRadius: 2, overflow: 'hidden', maxWidth: 120 }}>
                        <div style={{ width: `${(n / p.activeClients) * 100}%`, height: '100%', background: 'var(--color-accent)' }} />
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: ink }}>{n}</span>
                    </div>
                  ))}
                </div>
            }
          </div>
          <div>
            <div style={eyebrowStyle}>Needs attention</div>
            <div style={{ marginTop: 12 }}>
              {p.unackedComms > 0
                ? <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: hair2, color: WARNING, fontSize: 13 }}>
                    <span>Unacknowledged client messages</span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{p.unackedComms}</span>
                  </div>
                : <div style={{ fontSize: 13, color: ink3 }}>No flags right now.</div>}
              <Link to="/clients" style={{ display: 'inline-block', marginTop: 14, fontSize: 12, color: 'var(--color-accent)' }}>Open clients →</Link>
            </div>
          </div>
        </div>
      </Section>
    </PageShell>
  )
}

const eyebrowStyle = {
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
  letterSpacing: '0.18em', textTransform: 'uppercase', color: ink2,
}

function ConstraintBanner({ constraint }) {
  if (!constraint) {
    return (
      <div style={{ borderBottom: hair, background: 'var(--color-bg)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: pos, flexShrink: 0 }} />
          <div style={{ fontSize: 14, color: ink }}>
            Every tracked KPI is on target. Ask the real question: <span style={{ color: ink2 }}>why can't we double ad spend tomorrow?</span>
          </div>
        </div>
      </div>
    )
  }
  const color = STATUS_COLOR[constraint.status]
  return (
    <div style={{ borderBottom: hair, background: 'linear-gradient(135deg, rgba(184,130,0,0.06) 0%, rgba(184,130,0,0.02) 100%)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px' }}>
        <div style={{ ...eyebrowStyle, color }}>Biggest constraint right now</div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span className="font-display" style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: ink }}>
            {constraint.label}
          </span>
          <span className="num" style={{ fontFamily: 'var(--font-display)', fontSize: 22, color, fontWeight: 600 }}>
            {constraint.display}
          </span>
          <span style={{ fontSize: 13, color: ink2 }}>
            vs {constraint.targetDisplay} target ({STATUS_LABEL[constraint.status]})
          </span>
        </div>
        <div style={{ marginTop: 10, fontSize: 14, color: ink, maxWidth: 720, lineHeight: 1.5 }}>
          {constraint.lever}
        </div>
      </div>
    </div>
  )
}

function ScoreCell({ r, index }) {
  const color = STATUS_COLOR[r.status]
  return (
    <div style={{
      padding: '18px 18px',
      borderRight: hair2, borderBottom: hair2,
      background: 'var(--color-bg)',
    }}>
      <div style={{ ...eyebrowStyle, fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.label}>
        {r.label}
      </div>
      <div className="num" style={{
        fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600,
        letterSpacing: '-0.025em', lineHeight: 1, marginTop: 10, color,
      }}>
        {r.display}
      </div>
      <div style={{ marginTop: 8, fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: ink3 }}>
        {r.direction === 'below' ? '≤' : '≥'} {r.targetDisplay} · {STATUS_LABEL[r.status]}
      </div>
    </div>
  )
}
