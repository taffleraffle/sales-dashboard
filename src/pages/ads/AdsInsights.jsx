import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Trophy, AlertCircle, RefreshCw, Sparkles, DollarSign, Target, Activity } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { tagMissing, listOffers, getAttributeCoverage } from '../../services/creativeTagger'

/*
  Creative Insights — editorial chart dashboard.

  Top:      KPI tiles (spend, winners, avg CPB, attribute coverage)
  Mid:      Date range + offer chip filters
  Highlight: Winning attribute callout cards (yellow accent)
  Charts:   Recharts bar grid (6 attributes) + pie chart for proof distribution
  Bottom:   Winners table with rich attribute pills
*/

const DATE_PRESETS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
]

const PIVOTS = [
  { attr: 'hook_type',        label: 'Hook type' },
  { attr: 'message_frame',    label: 'Message frame' },
  { attr: 'mechanism_reveal', label: 'Mechanism reveal' },
  { attr: 'pain_angle',       label: 'Pain angle' },
  { attr: 'funnel_stage',     label: 'Funnel stage' },
  { attr: 'format',           label: 'Format' },
]

const PIE_PALETTE = [
  '#0a0a0a',  // ink
  '#f4e14a',  // accent
  '#3e8a5e',  // green
  '#e0a93e',  // amber
  '#b53e3e',  // red
  '#5b3a8f',  // purple
  '#0e7c86',  // teal
  '#b86a0c',  // orange
]

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10)

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtN(n) {
  if (n == null || isNaN(n)) return '—'
  return Math.round(n).toLocaleString()
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  return `${(n * 100).toFixed(0)}%`
}

export default function AdsInsights() {
  const [preset, setPreset] = useState(30)
  const [since, setSince] = useState(daysAgoISO(30))
  const [until, setUntil] = useState(todayISO())
  const [offerFilter, setOfferFilter] = useState([])
  const [offers, setOffers] = useState([])
  const [perf, setPerf] = useState(null)
  const [pivots, setPivots] = useState({})
  const [winners, setWinners] = useState([])
  const [coverage, setCoverage] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [tagging, setTagging] = useState(false)
  const [proofPie, setProofPie] = useState([])

  const setPresetRange = (days) => {
    setPreset(days)
    setSince(daysAgoISO(days))
    setUntil(todayISO())
  }

  const loadEverything = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [offersData, perfData, winnersData, coverageData, proofPivot] = await Promise.all([
        listOffers(),
        supabase.rpc('lib_ad_performance', { since, until }),
        supabase.rpc('lib_winning_attributes', { since, until }),
        getAttributeCoverage(),
        supabase.rpc('lib_perf_by_attribute', { attr: 'proof_character', since, until }),
      ])
      if (perfData.error) throw new Error(`perf: ${perfData.error.message}`)
      if (winnersData.error) throw new Error(`winners: ${winnersData.error.message}`)
      setOffers(offersData)
      setPerf(perfData.data || [])
      setWinners(winnersData.data || [])
      setCoverage(coverageData)
      setProofPie(proofPivot.error ? [] : (proofPivot.data || []))

      const pivotResults = await Promise.all(
        PIVOTS.map(p =>
          supabase.rpc('lib_perf_by_attribute', { attr: p.attr, since, until })
            .then(r => ({ attr: p.attr, rows: r.error ? [] : (r.data || []) }))
        )
      )
      const pivotMap = {}
      for (const r of pivotResults) pivotMap[r.attr] = r.rows
      setPivots(pivotMap)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [since, until])

  useEffect(() => { loadEverything() }, [loadEverything])

  const filteredPerf = useMemo(() => {
    if (!perf) return null
    if (!offerFilter.length) return perf
    return perf.filter(r => offerFilter.includes(r.offer_slug))
  }, [perf, offerFilter])

  // KPI tiles
  const kpi = useMemo(() => {
    const rows = filteredPerf || []
    const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const totalBooked = rows.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const totalClosed = rows.reduce((s, r) => s + (Number(r.closes) || 0), 0)
    const winnersCount = rows.filter(r => r.effective_winner).length
    const avgCpb = totalBooked > 0 ? totalSpend / totalBooked : null
    const coverageAvg = coverage.length
      ? coverage.reduce((s, c) => s + (parseFloat(c.coverage_pct) || 0), 0) / coverage.length
      : 0
    return { totalSpend, totalBooked, totalClosed, winnersCount, avgCpb, coverageAvg }
  }, [filteredPerf, coverage])

  async function handleTagMissing() {
    setTagging(true)
    try { await tagMissing(50); await loadEverything() }
    catch (e) { setErr(e.message) }
    finally { setTagging(false) }
  }

  const toggleOffer = (slug) => {
    setOfferFilter(prev => prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug])
  }

  return (
    <div style={{ padding: '24px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div className="eyebrow eyebrow-accent">OPT Sales · Creative <em>insights</em></div>
          <h1 className="h1" style={{ marginTop: 6, marginBottom: 8 }}>
            What's <em>winning</em>, by attribute.
          </h1>
          <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                      fontSize: 15, maxWidth: 640, lineHeight: 1.5, margin: 0 }}>
            Every ad tagged across 11 dimensions. Pivot by hook, frame, mechanism, proof,
            pain angle, or format. The "winning attributes" callout names the values that
            consistently appear in winners.
          </p>
        </div>
        <button onClick={handleTagMissing} disabled={tagging || loading}
          style={{
            padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
            letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
            border: '2px solid var(--ink)', background: 'white',
            color: 'var(--ink)', cursor: (tagging || loading) ? 'wait' : 'pointer',
            opacity: (tagging || loading) ? 0.5 : 1, borderRadius: 2,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            boxShadow: '3px 3px 0 var(--accent)',
          }}>
          <RefreshCw size={12} />
          {tagging ? 'Tagging…' : 'Tag missing ads'}
        </button>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 1, background: 'var(--rule)', border: '1px solid var(--rule)',
                    marginBottom: 24 }}>
        <KpiTile icon={<DollarSign size={14} />} label="Spend" value={fmt$(kpi.totalSpend)} sub={`${preset}d window`} />
        <KpiTile icon={<Target size={14} />} label="Booked calls" value={fmtN(kpi.totalBooked)} sub={`avg CPB ${fmt$(kpi.avgCpb)}`} />
        <KpiTile icon={<Trophy size={14} />} label="Winners" value={fmtN(kpi.winnersCount)} sub="spend≥$1k · ≥2 booked · CPB≤$300" accent />
        <KpiTile icon={<Activity size={14} />} label="Tag coverage" value={fmtPct(kpi.coverageAvg)} sub={`across ${coverage.length} attributes`} />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
                    padding: '16px 20px', background: 'var(--paper)', border: '1px solid var(--rule)',
                    marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: 'var(--ink-4)' }}>Window:</span>
          {DATE_PRESETS.map(p => (
            <button key={p.days} onClick={() => setPresetRange(p.days)}
              style={{
                padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                border: `1px solid ${preset === p.days ? 'var(--ink)' : 'var(--rule)'}`,
                background: preset === p.days ? 'var(--ink)' : 'white',
                color: preset === p.days ? 'var(--paper)' : 'var(--ink-3)',
                cursor: 'pointer', borderRadius: 2,
              }}>{p.label}</button>
          ))}
        </div>

        <span style={{ width: 1, height: 24, background: 'var(--rule)' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: 'var(--ink-4)' }}>Offer:</span>
          {offers.map(o => {
            const on = offerFilter.includes(o.slug)
            const isStub = o.slug.includes('stub') || o.slug.includes('template')
            if (isStub) return null  // hide stubs from filter — they have no data
            return (
              <button key={o.slug} onClick={() => toggleOffer(o.slug)}
                style={{
                  padding: '4px 10px', fontFamily: 'var(--sans)', fontSize: 12,
                  border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                  background: on ? 'var(--ink)' : 'white',
                  color: on ? 'var(--paper)' : 'var(--ink-3)',
                  cursor: 'pointer', borderRadius: 2,
                }}>
                {o.name.replace('OPT ', '').replace(' (Direct Call Engine)', '')}
              </button>
            )
          })}
          {offerFilter.length > 0 && (
            <button onClick={() => setOfferFilter([])}
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10,
                      color: 'var(--ink-4)', background: 'transparent', border: 'none',
                      cursor: 'pointer', textDecoration: 'underline' }}>clear</button>
          )}
        </div>
      </div>

      {err && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 2 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
        </div>
      )}

      {/* Winning attributes callout */}
      {winners.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
            <Trophy size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Most <em>consistent</em> winning attributes
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: 12 }}>
            {winners.slice(0, 9).map((w, i) => (
              <div key={i} style={{ padding: 16, background: 'white', border: '1px solid var(--rule)',
                                    borderLeft: '4px solid var(--accent)', borderRadius: 2 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                              textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 6 }}>
                  {w.attribute_name.replace(/_/g, ' ')}
                </div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)',
                              lineHeight: 1.1, marginBottom: 10, fontWeight: 400 }}>
                  {w.attribute_value}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                              fontFamily: 'var(--mono)', fontSize: 11 }}>
                  <span style={{ color: 'var(--ink-3)' }}>
                    <strong style={{ color: 'var(--ink)', fontSize: 14 }}>{w.winners}</strong> winners
                  </span>
                  <span style={{ color: 'var(--ink-3)' }}>
                    avg CPB <strong style={{ color: 'var(--ink)', fontSize: 14 }}>{fmt$(w.avg_cost_per_booked)}</strong>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts grid + proof pie */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24, marginBottom: 32 }}>
        {/* Bar charts grid */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>Performance by attribute</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            {PIVOTS.map(p => (
              <PivotChart key={p.attr} label={p.label} rows={pivots[p.attr] || []} loading={loading} />
            ))}
          </div>
        </div>

        {/* Proof character pie */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>Proof character distribution</div>
          <ProofPie rows={proofPie} loading={loading} />
        </div>
      </div>

      {/* Winners table */}
      <WinnersTable rows={(filteredPerf || []).filter(r => r.effective_winner)} />
    </div>
  )
}

function KpiTile({ icon, label, value, sub, accent }) {
  return (
    <div style={{ padding: '16px 20px', background: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color: accent ? 'var(--accent)' : 'var(--ink-4)',
                       background: accent ? 'var(--ink)' : 'transparent',
                       padding: accent ? '3px 4px' : 0, borderRadius: 2,
                       display: 'inline-flex' }}>
          {icon}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink-4)' }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 30, color: 'var(--ink)',
                    fontWeight: 400, lineHeight: 1, marginBottom: 6, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.04em' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function PivotChart({ label, rows, loading }) {
  const data = useMemo(() => {
    return [...rows]
      .sort((a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0))
      .slice(0, 8)
      .map(r => ({
        value: r.attribute_value,
        booked: Number(r.booked) || 0,
        spend: Number(r.spend) || 0,
        cpb: r.cost_per_booked == null ? null : Number(r.cost_per_booked),
        winners: Number(r.winners) || 0,
      }))
  }, [rows])

  const tooltip = ({ active, payload, label: tipLabel }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: 'var(--ink)', color: 'var(--paper)', padding: '10px 12px',
                    fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 2,
                    boxShadow: '0 8px 24px rgba(10,10,10,0.16)' }}>
        <div style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--accent)', marginBottom: 4 }}>{tipLabel}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>
          <strong>{d.booked}</strong> booked · {fmt$(d.spend)} spend · CPB {fmt$(d.cpb)}
        </div>
        {d.winners > 0 && (
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--accent)' }}>
            🏆 {d.winners} winner{d.winners > 1 ? 's' : ''}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: 14, background: 'white', border: '1px solid var(--rule)', borderRadius: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink)' }}>
          {label}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>
          {data.length} values
        </span>
      </div>
      {loading ? (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          Loading…
        </div>
      ) : data.length === 0 ? (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          No tagged data in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <XAxis dataKey="value" tick={{ fontSize: 10, fill: 'var(--ink-3)', fontFamily: 'var(--mono)' }}
                  axisLine={false} tickLine={false} interval={0} angle={-12} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--ink-4)', fontFamily: 'var(--mono)' }}
                   axisLine={false} tickLine={false} width={30} />
            <Tooltip content={tooltip} cursor={{ fill: 'var(--paper)' }} />
            <Bar dataKey="booked" radius={[2, 2, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.winners > 0 ? 'var(--accent)' : 'var(--ink)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

function ProofPie({ rows, loading }) {
  const data = useMemo(() => {
    return [...rows]
      .filter(r => r.attribute_value !== 'none')
      .sort((a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0))
      .slice(0, 8)
      .map(r => ({ name: r.attribute_value, value: Number(r.booked) || 0, spend: Number(r.spend) || 0 }))
  }, [rows])

  const tooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0]
    return (
      <div style={{ background: 'var(--ink)', color: 'var(--paper)', padding: '8px 10px',
                    fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 2 }}>
        <div style={{ fontSize: 9, color: 'var(--accent)', letterSpacing: '0.16em',
                      textTransform: 'uppercase', marginBottom: 2 }}>{d.name}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>
          {d.value} booked · {fmt$(d.payload.spend)}
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ height: 300, background: 'white', border: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
        Loading…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div style={{ height: 300, background: 'white', border: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
                    color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
        <Sparkles size={20} style={{ marginBottom: 8 }} />
        No proof-character data yet.
      </div>
    )
  }

  return (
    <div style={{ padding: 14, background: 'white', border: '1px solid var(--rule)', borderRadius: 2 }}>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%"
               innerRadius={45} outerRadius={90} paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />)}
          </Pie>
          <Tooltip content={tooltip} />
          <Legend wrapperStyle={{ fontFamily: 'var(--mono)', fontSize: 10,
                                  letterSpacing: '0.06em', color: 'var(--ink-3)' }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

function WinnersTable({ rows }) {
  return (
    <div>
      <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
        <Trophy size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
        Current <em>winners</em> ({rows.length})
      </div>
      <div style={{ background: 'white', border: '1px solid var(--rule)', borderRadius: 2 }}>
        {rows.length === 0 ? (
          <div style={{ padding: 36, color: 'var(--ink-4)', fontStyle: 'italic',
                       fontFamily: 'var(--serif)', textAlign: 'center', fontSize: 14 }}>
            No ads meet the winner threshold yet (spend ≥ $1k AND ≥2 booked AND CPB ≤ $300).
            <br />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontStyle: 'normal',
                          color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
              Tag more ads via the button above, or extend the date window.
            </span>
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 12, fontFamily: 'var(--sans)' }}>
            <thead>
              <tr style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                          textTransform: 'uppercase', color: 'var(--ink-4)',
                          borderBottom: '1px solid var(--rule)' }}>
                <th style={{ textAlign: 'left', padding: '10px 14px' }}>Ad name</th>
                <th style={{ textAlign: 'left' }}>Attributes</th>
                <th style={{ textAlign: 'right' }}>Spend</th>
                <th style={{ textAlign: 'right' }}>Booked</th>
                <th style={{ textAlign: 'right' }}>CPB</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.ad_id} style={{ borderTop: '1px solid var(--rule)' }}>
                  <td style={{ padding: '10px 14px', maxWidth: 280, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Link to={`/sales/ads/ad/${r.ad_id}`}
                      style={{ color: 'var(--ink)', textDecoration: 'none', fontWeight: 500 }}>
                      {r.ad_name || r.ad_id}
                    </Link>
                  </td>
                  <td style={{ padding: '10px 0' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {[r.hook_type, r.message_frame, r.pain_angle, r.proof_character]
                        .filter(v => v && v !== 'none').map((v, i) => (
                          <span key={i} style={{ padding: '2px 6px', background: 'var(--paper)',
                                                fontFamily: 'var(--mono)', fontSize: 10,
                                                color: 'var(--ink-3)', border: '1px solid var(--rule)',
                                                borderRadius: 2 }}>{v}</span>
                        ))}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '10px 0' }}>{fmt$(r.spend)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '10px 0' }}>{fmtN(r.booked)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '10px 14px',
                              fontWeight: 600, color: 'var(--ink)' }}>{fmt$(r.cost_per_booked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
