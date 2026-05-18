import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ReferenceLine,
} from 'recharts'
import { Trophy, AlertCircle, RefreshCw, Sparkles, Target, Activity, Zap, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { tagMissing, listOffers, getAttributeCoverage } from '../../services/creativeTagger'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import AdThumbnail from '../../components/ads/AdThumbnail'
import CreativeGrid from '../../components/ads/CreativeGrid'
import AttributeHeatmap from '../../components/ads/AttributeHeatmap'

/*
  Creative Insights — focused on WIN RATE, not spend.

  Headline KPIs:    win rate %, total tagged ads, winners count, avg CPB on winners
  Top callouts:     winning attributes with avg win rate
  Charts:           win rate by attribute (small multiples), proof character pie
  Tables:           top creatives by booked, current winners
*/

const DATE_PRESETS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
]

const PIVOTS = [
  { attr: 'hook_type',        label: 'Hook type' },
  { attr: 'mechanism_reveal', label: 'Mechanism reveal' },
  { attr: 'message_frame',    label: 'Message frame' },
  { attr: 'pain_angle',       label: 'Pain angle' },
  { attr: 'funnel_stage',     label: 'Funnel stage' },
  { attr: 'format',           label: 'Format' },
]

const PIE_PALETTE = ['#0a0a0a', '#f4e14a', '#3e8a5e', '#e0a93e', '#b53e3e', '#5b3a8f', '#0e7c86', '#b86a0c']

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10)

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }
function fmtPct(n, digits = 0) {
  if (n == null || isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export default function AdsInsights() {
  const [preset, setPreset] = useState(30)
  const [since, setSince] = useState(daysAgoISO(30))
  const [until, setUntil] = useState(todayISO())
  // Per-offer scoping. null = all offers combined.
  const [activeOffer, setActiveOffer] = useState(() => {
    try { return localStorage.getItem('insights.activeOffer') || null } catch { return null }
  })
  const [offers, setOffers] = useState([])
  const [perf, setPerf] = useState(null)
  const [pivots, setPivots] = useState({})
  const [winners, setWinners] = useState([])
  const [coverage, setCoverage] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [tagging, setTagging] = useState(false)
  const [proofPie, setProofPie] = useState([])
  const [addOrLinkOpen, setAddOrLinkOpen] = useState(false)
  const [editingAd, setEditingAd] = useState(null)

  const setPresetRange = (days) => {
    setPreset(days); setSince(daysAgoISO(days)); setUntil(todayISO())
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
    } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }, [since, until])

  useEffect(() => { loadEverything() }, [loadEverything])

  // Persist active offer
  useEffect(() => {
    try {
      if (activeOffer) localStorage.setItem('insights.activeOffer', activeOffer)
      else localStorage.removeItem('insights.activeOffer')
    } catch {}
  }, [activeOffer])

  // Validate active offer against loaded offers list. If localStorage points
  // at a slug that no longer exists (offer was renamed/deleted), reset to
  // null so the operator doesn't see a blank page with no escape hatch.
  useEffect(() => {
    if (!offers.length || !activeOffer) return
    if (!offers.find(o => o.slug === activeOffer)) {
      setActiveOffer(null)
    }
  }, [offers]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredPerf = useMemo(() => {
    if (!perf) return null
    if (!activeOffer) return perf
    return perf.filter(r => r.offer_slug === activeOffer)
  }, [perf, activeOffer])

  // Top-level stats
  const stats = useMemo(() => {
    const rows = filteredPerf || []
    const tagged = rows.filter(r => r.hook_type != null)
    const winnerRows = rows.filter(r => r.effective_winner)
    const winRate = tagged.length > 0 ? winnerRows.length / tagged.length : 0
    const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const totalBooked = rows.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const winnerSpend = winnerRows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const winnerBooked = winnerRows.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const avgCpbWinners = winnerBooked > 0 ? winnerSpend / winnerBooked : null
    return {
      totalAds: rows.length,
      taggedAds: tagged.length,
      winners: winnerRows.length,
      winRate,
      avgCpbWinners,
      totalSpend,
      totalBooked,
    }
  }, [filteredPerf])

  // Variables pulling ahead — for each attribute, the value with highest win rate
  // (only consider values with ≥2 tagged ads to filter noise)
  const variablesPullingAhead = useMemo(() => {
    const rows = filteredPerf || []
    const out = []
    PIVOTS.forEach(p => {
      const groups = {}
      rows.forEach(r => {
        const v = r[p.attr]
        if (!v) return
        if (!groups[v]) groups[v] = { total: 0, winners: 0, totalCpb: 0, cpbCount: 0 }
        groups[v].total++
        if (r.effective_winner) groups[v].winners++
        if (r.cost_per_booked != null) {
          groups[v].totalCpb += Number(r.cost_per_booked)
          groups[v].cpbCount++
        }
      })
      const overall = rows.length > 0
        ? rows.filter(r => r.effective_winner).length / rows.length
        : 0
      const ranked = Object.entries(groups)
        .filter(([_, g]) => g.total >= 2)
        .map(([value, g]) => ({
          attribute: p.attr,
          attribute_label: p.label,
          value,
          win_rate: g.winners / g.total,
          win_rate_lift: (g.winners / g.total) - overall,
          ads: g.total,
          winners: g.winners,
          avg_cpb: g.cpbCount > 0 ? g.totalCpb / g.cpbCount : null,
        }))
        .sort((a, b) => b.win_rate_lift - a.win_rate_lift)
      if (ranked[0] && ranked[0].win_rate_lift > 0) out.push(ranked[0])
    })
    return out.sort((a, b) => b.win_rate_lift - a.win_rate_lift)
  }, [filteredPerf])

  async function handleTagMissing() {
    setTagging(true)
    try { await tagMissing(50); await loadEverything() }
    catch (e) { setErr(e.message) }
    finally { setTagging(false) }
  }

  // Build offer counts for the switcher
  const offerCounts = useMemo(() => {
    const counts = {}
    ;(perf || []).forEach(r => {
      const k = r.offer_slug || '__untagged'
      counts[k] = (counts[k] || 0) + 1
    })
    return counts
  }, [perf])

  return (
    <div style={{ padding: '24px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div className="eyebrow eyebrow-accent">OPT Sales · Creative <em>insights</em></div>
          <h1 className="h1" style={{ marginTop: 6, marginBottom: 8 }}>What's <em>winning</em>.</h1>
          <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                      fontSize: 15, maxWidth: 640, lineHeight: 1.5, margin: 0 }}>
            Win rate, top creatives, and the attribute values pulling ahead. Every ad tagged
            across 11 dimensions so winners surface their own pattern.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setAddOrLinkOpen(true)}
            style={{
              padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
              border: '2px solid var(--ink)', background: 'var(--ink)', color: 'var(--paper)',
              cursor: 'pointer', borderRadius: 2,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            <Plus size={12} />
            Add or link creative
          </button>
          <button onClick={handleTagMissing} disabled={tagging || loading}
            style={{
              padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
              border: '1px solid var(--rule)', background: 'white',
              color: 'var(--ink-3)', cursor: (tagging || loading) ? 'wait' : 'pointer',
              opacity: (tagging || loading) ? 0.5 : 1, borderRadius: 2,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            <RefreshCw size={12} />
            {tagging ? 'Tagging…' : 'Tag more ads'}
          </button>
        </div>
      </div>

      <AddOrLinkCreativeDrawer
        open={addOrLinkOpen}
        onClose={() => setAddOrLinkOpen(false)}
        onSaved={() => { setAddOrLinkOpen(false); loadEverything() }} />
      <CreativeEditDrawer
        open={!!editingAd}
        ad={editingAd}
        onClose={() => { setEditingAd(null); loadEverything() }} />

      {/* Per-offer switcher */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
                    marginBottom: 20 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                      textTransform: 'uppercase', color: 'var(--ink-4)', marginRight: 4 }}>Offer:</span>
        <button onClick={() => setActiveOffer(null)}
          style={offerBtnStyle(activeOffer === null)}>
          All offers
          <span style={offerCountStyle(activeOffer === null)}>{(perf || []).length}</span>
        </button>
        {offers.filter(o => !o.slug.includes('template')).map(o => {
          const on = activeOffer === o.slug
          const count = offerCounts[o.slug] || 0
          return (
            <button key={o.slug} onClick={() => setActiveOffer(o.slug)}
              style={offerBtnStyle(on)}>
              {o.name.replace('OPT ', '').replace(' (Direct Call Engine)', '')}
              <span style={offerCountStyle(on)}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Headline KPI row — WIN RATE prominent, spend de-emphasized */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 1,
                    background: 'var(--rule)', border: '1px solid var(--rule)', marginBottom: 24 }}>
        <BigKpi label="Win rate" value={fmtPct(stats.winRate, 1)} accent
                sub={`${stats.winners} winners of ${stats.taggedAds} tagged ads`}
                icon={<Trophy size={18} />} />
        <Kpi label="Avg CPB on winners" value={fmt$(stats.avgCpbWinners)} sub="cost per booked call" icon={<Target size={14} />} />
        <Kpi label="Total booked" value={fmtN(stats.totalBooked)} sub={`across ${stats.totalAds} ads`} icon={<Activity size={14} />} />
        <Kpi label="Tag coverage" value={fmtPct(coverage.length ? coverage.reduce((s, c) => s + (parseFloat(c.coverage_pct) || 0), 0) / coverage.length : 0)} sub={`${coverage.length} attributes`} icon={<Sparkles size={14} />} />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
                    padding: '14px 18px', background: 'var(--paper)', border: '1px solid var(--rule)',
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
      </div>

      {err && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 2 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
        </div>
      )}

      {/* Variables pulling ahead — THE headline insight */}
      {variablesPullingAhead.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
            <Zap size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Variables <em>pulling ahead</em>
          </div>
          <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)',
                      fontSize: 13, margin: '0 0 12px', maxWidth: 720 }}>
            For each attribute, the value with the highest win-rate lift versus the overall
            baseline ({fmtPct(stats.winRate, 1)}). If you write more scripts, bias toward these.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {variablesPullingAhead.map((v, i) => (
              <div key={i} style={{ padding: '18px 20px', background: 'white', border: '1px solid var(--rule)',
                                    borderLeft: '4px solid var(--accent)', borderRadius: 2,
                                    display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                                textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                    {v.attribute_label}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)',
                                background: 'var(--ink)', padding: '3px 8px', fontWeight: 700,
                                letterSpacing: '0.08em', borderRadius: 2, whiteSpace: 'nowrap' }}>
                    +{fmtPct(v.win_rate_lift, 1)}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)',
                              lineHeight: 1.15, fontWeight: 400 }}>
                  {v.value}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
                              gap: 12, flexWrap: 'wrap', paddingTop: 8,
                              borderTop: '1px solid var(--rule)' }}>
                  <span>win rate <strong style={{ color: 'var(--ink)', fontSize: 13 }}>{fmtPct(v.win_rate, 1)}</strong></span>
                  <span>{v.winners}/{v.ads} ads</span>
                  {v.avg_cpb && <span>CPB <strong style={{ color: 'var(--ink)', fontSize: 13 }}>{fmt$(v.avg_cpb)}</strong></span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All creatives grid (pinned winners + paginated grid + filter + sort) */}
      <div style={{ marginBottom: 32 }}>
        <CreativeGrid
          rows={filteredPerf || []}
          loading={loading}
          onClickRow={r => setEditingAd(r)}
          pinnedTopN={3}
        />
      </div>

      {/* Cross-attribute heatmap */}
      <AttributeHeatmap since={since} until={until} baseline={stats.winRate} />

      {/* Win rate by attribute charts */}
      <div style={{ marginBottom: 32 }}>
        <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--ink-3)' }}>
          Win rate by attribute
        </div>
        <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)',
                    fontSize: 13, margin: '0 0 16px', maxWidth: 720 }}>
          Each bar = % of ads with this attribute value that became winners. Yellow bars beat
          the overall baseline (dashed line).
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16 }}>
          {PIVOTS.map(p => (
            <WinRateChart key={p.attr}
              label={p.label}
              attr={p.attr}
              rows={filteredPerf || []}
              baseline={stats.winRate}
              loading={loading} />
          ))}
          {/* Proof character pie — appears as a peer card only when data exists */}
          {proofPie.filter(r => r.attribute_value !== 'none' && (Number(r.booked) || 0) > 0).length > 0 && (
            <ProofPie rows={proofPie} loading={loading} />
          )}
        </div>
      </div>
    </div>
  )
}

function offerBtnStyle(active) {
  return {
    padding: '8px 14px', fontFamily: 'var(--sans)', fontSize: 13, fontWeight: active ? 600 : 400,
    border: `2px solid ${active ? 'var(--ink)' : 'var(--rule)'}`,
    background: active ? 'var(--ink)' : 'white',
    color: active ? 'var(--paper)' : 'var(--ink)',
    cursor: 'pointer', borderRadius: 2,
    display: 'inline-flex', alignItems: 'center', gap: 8,
    transition: 'all 140ms ease',
  }
}
function offerCountStyle(active) {
  return {
    padding: '1px 6px', fontFamily: 'var(--mono)', fontSize: 10,
    background: active ? 'var(--accent)' : 'var(--paper)',
    color: active ? 'var(--ink)' : 'var(--ink-4)',
    border: `1px solid ${active ? 'var(--ink)' : 'var(--rule)'}`,
    borderRadius: 2, fontWeight: 700,
  }
}

function BigKpi({ label, value, sub, accent, icon }) {
  return (
    <div style={{ padding: '20px 24px', background: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: accent ? 'var(--accent)' : 'var(--ink-3)',
                       background: accent ? 'var(--ink)' : 'transparent',
                       padding: accent ? '4px 6px' : 0, borderRadius: 2,
                       display: 'inline-flex' }}>
          {icon}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 48, color: 'var(--ink)',
                    fontWeight: 400, lineHeight: 1, marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic', color: 'var(--ink-4)' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, icon }) {
  return (
    <div style={{ padding: '20px 22px', background: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color: 'var(--ink-4)' }}>{icon}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                      textTransform: 'uppercase', color: 'var(--ink-4)' }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)',
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

function WinRateChart({ label, attr, rows, baseline, loading }) {
  const data = useMemo(() => {
    const groups = {}
    rows.forEach(r => {
      const v = r[attr]
      if (!v) return
      if (!groups[v]) groups[v] = { total: 0, winners: 0 }
      groups[v].total++
      if (r.effective_winner) groups[v].winners++
    })
    return Object.entries(groups)
      .filter(([_, g]) => g.total >= 1)
      .map(([value, g]) => {
        const winRate = g.winners / g.total
        // Only mark as "beats" when there's a real baseline to beat.
        // If baseline is 0, any winner > 0 would technically pass — but that's
        // misleading during cold-start (every non-zero bar would render yellow).
        return {
          value,
          winRate,
          ads: g.total,
          winners: g.winners,
          beatsBaseline: baseline > 0 && winRate > baseline,
        }
      })
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 8)
  }, [rows, attr, baseline])

  // Smart Y-axis formatter — decimals when values are sub-1%
  const maxRate = Math.max(...data.map(d => d.winRate), 0)
  const yTickFormatter = useMemo(() => {
    if (maxRate >= 0.1) return v => `${(v * 100).toFixed(0)}%`     // ≥10% range: whole percent
    if (maxRate >= 0.02) return v => `${(v * 100).toFixed(1)}%`    // 2-10%: 1 decimal
    return v => `${(v * 100).toFixed(2)}%`                          // <2%: 2 decimals
  }, [maxRate])

  const tooltip = ({ active, payload, label: tipLabel }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: 'var(--ink)', color: 'var(--paper)', padding: '10px 12px',
                    fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 2 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--accent)', marginBottom: 4 }}>{tipLabel}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>
          <strong>{fmtPct(d.winRate, 0)}</strong> win rate · {d.winners}/{d.ads} ads
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 14, background: 'white', border: '1px solid var(--rule)', borderRadius: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)' }}>
          baseline {fmtPct(baseline, 0)}
        </span>
      </div>
      {loading ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>Loading…</div>
      ) : data.length === 0 ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          No data.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <XAxis dataKey="value" tick={{ fontSize: 10, fill: 'var(--ink-3)', fontFamily: 'var(--mono)' }}
                  axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" height={50} />
            <YAxis tickFormatter={yTickFormatter}
                   tick={{ fontSize: 9, fill: 'var(--ink-4)', fontFamily: 'var(--mono)' }}
                   axisLine={false} tickLine={false} width={44} allowDecimals={true} />
            <Tooltip content={tooltip} cursor={{ fill: 'var(--paper)' }} />
            <ReferenceLine y={baseline} stroke="var(--ink-4)" strokeDasharray="3 3" />
            <Bar dataKey="winRate" radius={[2, 2, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.beatsBaseline ? 'var(--accent)' : 'var(--ink-3)'} />
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
      .map(r => ({ name: r.attribute_value, value: Number(r.booked) || 0 }))
  }, [rows])

  const tooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0]
    return (
      <div style={{ background: 'var(--ink)', color: 'var(--paper)', padding: '8px 10px',
                    fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 2 }}>
        <div style={{ fontSize: 9, color: 'var(--accent)', letterSpacing: '0.16em',
                      textTransform: 'uppercase', marginBottom: 2 }}>{d.name}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>{d.value} booked</div>
      </div>
    )
  }

  if (loading || data.length === 0) return null  // pie hidden entirely when no data — parent gates rendering

  return (
    <div style={{ padding: 14, background: 'white', border: '1px solid var(--rule)', borderRadius: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink)' }}>Proof character</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)' }}>
          by booked
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%"
               innerRadius={36} outerRadius={68} paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />)}
          </Pie>
          <Tooltip content={tooltip} />
          <Legend wrapperStyle={{ fontFamily: 'var(--mono)', fontSize: 9,
                                  letterSpacing: '0.06em', color: 'var(--ink-3)' }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
