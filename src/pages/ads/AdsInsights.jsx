import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { tagMissing, listOffers, getAttributeCoverage } from '../../services/creativeTagger'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import CreativeGrid from '../../components/ads/CreativeGrid'
import AttributeHeatmap from '../../components/ads/AttributeHeatmap'
import {
  Eyebrow, SectionHead, Button, Pill, Card, Sparkline, BigNumber, Icon,
  fmtMoney, fmtMoneyFull, fmtNum, fmtPct, fmtLift, humanAttr, frameColor,
} from '../../components/editorial/atoms'

/*
  Creative Insights — implemented from the Claude Design handoff
  (design-pkg/ad-performance/project/Insights.html + supporting jsx).

  Section order:
    1. Hero header  (eyebrow + serif title + tagline + action buttons)
    2. Filter bar   (date presets + offer chip toggles + last-synced)
    3. KPI grid     (dominant: hero win-rate + 3 secondary)
    4. Variables pulling ahead (leaderboard)
    5. Top performing creatives (CreativeGrid)
    6. Cross-attribute heatmap
    7. Win rate by attribute (small-multiples)
    8. Proof character mix (donut)
    9. Footer
*/

const DATE_PRESETS = [
  { id: '7d',  label: '7d',  days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '60d', label: '60d', days: 60 },
  { id: '90d', label: '90d', days: 90 },
]

const PIVOTS = [
  { attr: 'hook_type',        label: 'Hook type' },
  { attr: 'message_frame',    label: 'Message frame' },
  { attr: 'mechanism_reveal', label: 'Mechanism reveal' },
  { attr: 'pain_angle',       label: 'Pain angle' },
  { attr: 'funnel_stage',     label: 'Funnel stage' },
  { attr: 'format',           label: 'Format' },
]

// Offer chip colors (visual identification — restoration red, plumbing teal, roofing purple, etc.)
const OFFER_COLORS = {
  'opt-restoration': 'var(--frame-problem)',
  'opt-plumbing': 'var(--teal)',
  'opt-roofing-stub': '#5b3a8f',
  'opt-electrical-stub': '#b86a0c',
  'opt-hvac-stub': '#0e7c86',
  'opt-whitelabel-template': 'var(--ink-3)',
}
function offerColor(slug) {
  return OFFER_COLORS[slug] || 'var(--ink-3)'
}

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10)

export default function AdsInsights() {
  const [preset, setPreset] = useState('30d')
  const [since, setSince] = useState(daysAgoISO(30))
  const [until, setUntil] = useState(todayISO())
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem('insights.activeTab') || 'overview' } catch { return 'overview' }
  })
  // Multi-select offer filter (matches design — operator can compare).
  // null/empty = all offers. Persisted in localStorage.
  const [activeOffers, setActiveOffers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
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
  const [lastSyncedAt, setLastSyncedAt] = useState(null)

  function setPresetRange(p) {
    setPreset(p.id)
    setSince(daysAgoISO(p.days))
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
      setLastSyncedAt(new Date())

      const pivotResults = await Promise.all(
        PIVOTS.map(p =>
          supabase.rpc('lib_perf_by_attribute', { attr: p.attr, since, until })
            .then(r => ({ attr: p.attr, rows: r.error ? [] : (r.data || []) }))
        )
      )
      const map = {}
      for (const r of pivotResults) map[r.attr] = r.rows
      setPivots(map)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [since, until])

  useEffect(() => { loadEverything() }, [loadEverything])

  // Persist offer filter
  useEffect(() => {
    try { localStorage.setItem('insights.activeOffers', JSON.stringify(activeOffers)) } catch {}
  }, [activeOffers])

  // Persist active sub-tab
  useEffect(() => {
    try { localStorage.setItem('insights.activeTab', activeTab) } catch {}
  }, [activeTab])

  // Validate stale offer slugs against loaded list
  useEffect(() => {
    if (!offers.length || activeOffers.length === 0) return
    const valid = activeOffers.filter(slug => offers.find(o => o.slug === slug))
    if (valid.length !== activeOffers.length) setActiveOffers(valid)
  }, [offers]) // eslint-disable-line react-hooks/exhaustive-deps

  // Filter perf to active offers (empty = all)
  const filteredPerf = useMemo(() => {
    if (!perf) return null
    if (!activeOffers.length) return perf
    return perf.filter(r => activeOffers.includes(r.offer_slug))
  }, [perf, activeOffers])

  // Top-level summary stats
  const summary = useMemo(() => {
    const rows = filteredPerf || []
    const tagged = rows.filter(r => r.hook_type != null)
    const winnerRows = rows.filter(r => r.effective_winner)
    const winRate = tagged.length > 0 ? (winnerRows.length / tagged.length) * 100 : 0
    const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const totalBooked = rows.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const winnerSpend = winnerRows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const winnerBooked = winnerRows.reduce((s, r) => s + (Number(r.booked) || 0), 0)
    const avgCpbWinners = winnerBooked > 0 ? Math.round(winnerSpend / winnerBooked) : 0
    const tagCoverage = coverage.length
      ? Math.round((coverage.reduce((s, c) => s + (parseFloat(c.coverage_pct) || 0), 0) / coverage.length) * 100)
      : 0
    return {
      totalAds: rows.length,
      taggedAds: tagged.length,
      winners: winnerRows.length,
      winRate,
      baselineWinRate: winRate,  // alias used by leaderboard
      avgCpbWinners,
      totalSpend,
      totalBooked,
      tagCoverage,
      weeksTracked: Math.max(1, Math.round((new Date(until) - new Date(since)) / (7 * 86400 * 1000))),
    }
  }, [filteredPerf, coverage, since, until])

  // "Variables pulling ahead" — for each attribute, the value with highest win-rate lift
  const variablesAhead = useMemo(() => {
    const rows = filteredPerf || []
    const baseline = summary.winRate
    const result = []
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
      const ranked = Object.entries(groups)
        .filter(([_, g]) => g.total >= 2)
        .map(([value, g]) => ({
          value,
          winRate: (g.winners / g.total) * 100,
          lift: (g.winners / g.total) * 100 - baseline,
          ads: g.total,
          winners: g.winners,
          cpb: g.cpbCount > 0 ? Math.round(g.totalCpb / g.cpbCount) : null,
        }))
        .sort((a, b) => b.lift - a.lift)
      if (ranked[0]) {
        result.push({
          attr: p.attr,
          label: p.label,
          value: ranked[0].value,
          winRate: ranked[0].winRate,
          lift: ranked[0].lift,
          ads: ranked[0].ads,
          winners: ranked[0].winners,
          cpb: ranked[0].cpb,
          runnerUpValue: ranked[1]?.value,
          runnerUpWinRate: ranked[1]?.winRate,
        })
      }
    })
    return result.sort((a, b) => b.lift - a.lift)
  }, [filteredPerf, summary.winRate])

  // Win-rate-by-attribute (for charts section)
  const attrStats = useMemo(() => {
    const rows = filteredPerf || []
    const out = {}
    PIVOTS.forEach(p => {
      const groups = {}
      rows.forEach(r => {
        const v = r[p.attr]
        if (!v) return
        if (!groups[v]) groups[v] = { value: v, ads: 0, winners: 0 }
        groups[v].ads++
        if (r.effective_winner) groups[v].winners++
      })
      out[p.attr] = Object.values(groups)
    })
    return out
  }, [filteredPerf])

  // Sparkline data — winners per week over the last 12 weeks (synthetic if data thin)
  const winnerSpark = useMemo(() => {
    const rows = filteredPerf || []
    const weeks = 12
    const counts = Array(weeks).fill(0)
    rows.forEach(r => {
      if (!r.effective_winner || !r.extracted_at) return
      const weeksAgo = Math.floor((Date.now() - new Date(r.extracted_at)) / (7 * 86400 * 1000))
      const idx = weeks - 1 - weeksAgo
      if (idx >= 0 && idx < weeks) counts[idx]++
    })
    return counts
  }, [filteredPerf])

  async function handleTagMissing() {
    setTagging(true)
    try { await tagMissing(50); await loadEverything() }
    catch (e) { setErr(e.message) }
    finally { setTagging(false) }
  }

  function toggleOffer(slug) {
    setActiveOffers(prev => prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug])
  }

  return (
    <div style={{ padding: '40px 0 80px', maxWidth: 1480, margin: '0 auto' }}>
      {/* 1. Hero header */}
      <SectionHead
        eyebrow="OPT Sales · Creative insights"
        title="What's winning."
        italicWord="winning"
        tagline="Every ad, classified across eleven dimensions. Winners feed the script generator. Here's the pattern emerging from the last 18 weeks of testing."
        gap={28}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" leftIcon={Icon.tag(13)}
              onClick={handleTagMissing} disabled={tagging || loading}>
              {tagging ? 'Tagging…' : 'Tag more ads'}
            </Button>
            <Button variant="primary" leftIcon={Icon.plus(13)}
              onClick={() => setAddOrLinkOpen(true)}>
              Add or link creative
            </Button>
          </div>
        }
      />

      {/* 2. Filter bar */}
      <FilterBar
        date={preset} dateOptions={DATE_PRESETS} onSetDate={setPresetRange}
        offers={offers} activeOffers={activeOffers} onToggleOffer={toggleOffer}
        lastSyncedAt={lastSyncedAt}
      />

      {err && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#fef2f2',
                      border: '1px solid #fca5a5', color: '#b53e3e', fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Sub-tab nav */}
      <SubTabNav active={activeTab} onChange={setActiveTab} counts={{
        overview: null,
        library: (filteredPerf || []).length,
        attributes: 11,
        explorations: null,
      }} />

      {/* ─── OVERVIEW TAB ───────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <>
          {/* KPI grid */}
          <div style={{ marginBottom: 44 }}>
            <KPIDominant summary={summary} spark={winnerSpark} />
          </div>

          {/* Variables pulling ahead — leaderboard */}
          <div style={{ marginBottom: 44 }}>
            <SectionHead
              eyebrow="Section II"
              title="Variables pulling ahead."
              italicWord="pulling ahead"
              tagline="For each attribute, the value beating the baseline win rate by the largest margin — ranked by lift, not by raw win rate."
            />
            <VariablesLeaderboard items={variablesAhead} baseline={summary.winRate} />
          </div>

          {/* Top 10 performers preview — links to Library tab */}
          <div style={{ marginBottom: 44 }}>
            <SectionHead
              eyebrow="Section III"
              title="Top performers."
              italicWord="performers"
              tagline={`${summary.winners} winners across the current window. Click any row to edit attributes.`}
              right={
                <Button variant="ghost" size="sm"
                  onClick={() => setActiveTab('library')}
                  rightIcon={Icon.arrow(11)}>
                  See all {summary.taggedAds}
                </Button>
              }
            />
            <TopPerformersTable rows={filteredPerf || []} loading={loading}
              onClickRow={r => setEditingAd(r)} limit={10} />
          </div>

          {/* Proof donut on overview when data exists */}
          {proofPie.some(r => r.attribute_value !== 'none' && Number(r.booked) > 0) && (
            <div style={{ marginBottom: 44 }}>
              <SectionHead
                eyebrow="Section IV"
                title="Proof character mix."
                italicWord="character"
                tagline="Which on-camera character is doing the lifting — booked counts and ad volume by named proof."
              />
              <ProofDonut data={proofPie} />
            </div>
          )}
        </>
      )}

      {/* ─── LIBRARY TAB ────────────────────────────────────────────── */}
      {activeTab === 'library' && (
        <div style={{ marginBottom: 44, marginTop: 8 }}>
          <SectionHead
            eyebrow="Library"
            title="All tagged creatives."
            italicWord="creatives"
            tagline={`${(filteredPerf || []).length} creatives in the current window. Search, filter, sort. Click any row to edit attributes — auto-saves on change.`}
          />
          <CreativeGrid
            rows={filteredPerf || []}
            loading={loading}
            onClickRow={r => setEditingAd(r)}
            pinnedTopN={3}
          />
        </div>
      )}

      {/* ─── ATTRIBUTES TAB ─────────────────────────────────────────── */}
      {activeTab === 'attributes' && (
        <div style={{ marginBottom: 44, marginTop: 8 }}>
          <SectionHead
            eyebrow="Attributes"
            title="Win rate by attribute."
            italicWord="attribute"
            tagline="Bars beating the dashed baseline are pulling weight. The yellow bar is the per-attribute leader. Each chart drills one dimension."
          />
          <SmallMultiples stats={attrStats} baseline={summary.winRate} />
        </div>
      )}

      {/* ─── EXPLORATIONS TAB ───────────────────────────────────────── */}
      {activeTab === 'explorations' && (
        <div style={{ marginBottom: 44, marginTop: 8 }}>
          <SectionHead
            eyebrow="Explorations"
            title="Cross-attribute interactions."
            italicWord="interactions"
            tagline="Pick two attributes — the heatmap surfaces where combinations beat the baseline. Yellow = wins above baseline, scaled by intensity. Faded cells have <2 ads."
          />
          <AttributeHeatmap since={since} until={until} baseline={summary.winRate / 100} />
        </div>
      )}

      {/* 9. Footer */}
      <div style={{
        marginTop: 56, paddingTop: 24, borderTop: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          OPT · Creative testing · v22 · {summary.totalAds} ads in scope
        </span>
        <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 13,
                      color: 'var(--ink-3)' }}>
          Data refreshed continuously via lib_ad_performance(since, until).
        </span>
      </div>

      {/* Drawers */}
      <AddOrLinkCreativeDrawer
        open={addOrLinkOpen}
        onClose={() => setAddOrLinkOpen(false)}
        onSaved={() => { setAddOrLinkOpen(false); loadEverything() }} />
      <CreativeEditDrawer
        open={!!editingAd}
        ad={editingAd}
        onClose={() => { setEditingAd(null); loadEverything() }} />
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// SubTabNav — Overview · Library · Attributes · Explorations
// ═════════════════════════════════════════════════════════════════════
const SUB_TABS = [
  { id: 'overview',     label: 'Overview' },
  { id: 'library',      label: 'Library' },
  { id: 'attributes',   label: 'Attributes' },
  { id: 'explorations', label: 'Explorations' },
]

function SubTabNav({ active, onChange, counts = {} }) {
  return (
    <div style={{
      display: 'flex', gap: 0, marginTop: 26, marginBottom: 32,
      borderBottom: '1px solid var(--rule)',
    }}>
      {SUB_TABS.map((t, i) => {
        const on = active === t.id
        const count = counts[t.id]
        return (
          <button key={t.id} onClick={() => onChange(t.id)}
            style={{
              padding: '12px 18px',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: on ? 'var(--ink)' : 'var(--ink-4)',
              background: 'transparent', border: 'none',
              borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              transition: 'color 0.12s cubic-bezier(0.2,0.7,0.2,1)',
            }}>
            <span style={{ opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span>{t.label}</span>
            {count != null && (
              <span style={{
                opacity: 0.55, fontSize: 9.5,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// TopPerformersTable — compact 10-row preview for the Overview tab
// (links to the full Library tab for everything else)
// ═════════════════════════════════════════════════════════════════════
function TopPerformersTable({ rows, loading, onClickRow, limit = 10 }) {
  const sorted = useMemo(() => {
    return [...(rows || [])]
      .filter(r => (Number(r.booked) || 0) > 0)
      .sort((a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0))
      .slice(0, limit)
  }, [rows, limit])

  if (loading) {
    return (
      <div style={{ padding: 48, background: 'white', border: '1px solid var(--rule)',
                    textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    color: 'var(--ink-4)' }}>
        Loading top performers…
      </div>
    )
  }
  if (sorted.length === 0) {
    return (
      <div style={{ padding: 48, background: 'white', border: '1px solid var(--rule)',
                    textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    color: 'var(--ink-4)' }}>
        No booked-call activity in this window yet.
      </div>
    )
  }

  return (
    <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '40px 72px minmax(260px, 2fr) minmax(220px, 1.6fr) 84px 84px 88px',
        alignItems: 'center', gap: 14,
        padding: '10px 18px',
        background: 'var(--paper-2)',
        borderBottom: '1px solid var(--rule)',
      }}>
        <Eyebrow>#</Eyebrow>
        <Eyebrow>Creative</Eyebrow>
        <Eyebrow>Ad · campaign</Eyebrow>
        <Eyebrow>Tags</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>Booked</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>CPB</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>State</Eyebrow>
      </div>
      {/* Rows — reuse the editorial CreativeRow */}
      {sorted.map((c, i) => {
        const isPodium = i < 3 && c.effective_winner
        return (
          <TopPerformerRow key={c.ad_id} c={c} rank={i + 1} isPodium={isPodium}
            onClick={() => onClickRow?.(c)}
            isLast={i === sorted.length - 1} />
        )
      })}
    </div>
  )
}

function TopPerformerRow({ c, rank, isPodium, onClick, isLast }) {
  const isWinner = !!c.effective_winner
  return (
    <div onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 72px minmax(260px, 2fr) minmax(220px, 1.6fr) 84px 84px 88px',
        alignItems: 'center', gap: 14,
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        cursor: 'pointer',
        transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
      }}>
      <div>
        {isPodium ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26,
            background: 'var(--accent)', color: 'var(--ink)',
            fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500, fontStyle: 'italic',
            fontVariantNumeric: 'tabular-nums', border: '1px solid var(--accent-2)',
          }}>{rank}</span>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                        fontSize: 12, color: 'var(--ink-4)' }}>
            {String(rank).padStart(2, '0')}
          </span>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <AdThumbnail ad={c} size="md" />
        {c.message_frame && (
          <span style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 3,
            background: frameColor(c.message_frame),
          }} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 17, lineHeight: 1.2, color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.ad_name || c.ad_id}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
          marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.campaign_name || '—'}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[c.hook_type, c.mechanism_reveal, c.pain_angle].filter(Boolean).slice(0, 3).map((v, i) => (
          <Pill key={i} tone="default" size="xs">{humanAttr(v)}</Pill>
        ))}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 22, lineHeight: 1, color: 'var(--ink)' }}>
          {fmtNum(c.booked)}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 22, lineHeight: 1, color: 'var(--ink)' }}>
          {c.cost_per_booked != null ? fmtMoney(Number(c.cost_per_booked)) : '—'}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        {isWinner ? (
          <span style={{
            display: 'inline-block', padding: '3px 9px',
            background: 'var(--accent)', color: 'var(--ink)',
            border: '1px solid var(--accent-2)',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            Winner
          </span>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                        letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            testing
          </span>
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// FilterBar — date presets + offer chip toggles + last-synced ticker
// ═════════════════════════════════════════════════════════════════════
function FilterBar({ date, dateOptions, onSetDate, offers, activeOffers, onToggleOffer, lastSyncedAt }) {
  const offerCounts = useMemo(() => {
    // We don't compute counts here without access to perf — leave blank
    return {}
  }, [])

  const liveOffers = offers.filter(o => !o.slug.includes('template'))

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '12px 16px', background: 'var(--paper-2)',
      border: '1px solid var(--rule)', flexWrap: 'wrap',
    }}>
      {/* Date segmented control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Eyebrow>Window</Eyebrow>
        <div style={{
          display: 'inline-flex',
          border: '1px solid var(--ink-3)',
          background: 'white',
          borderRadius: 2,
        }}>
          {dateOptions.map((opt, i) => {
            const active = date === opt.id
            return (
              <button key={opt.id} onClick={() => onSetDate(opt)}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                  letterSpacing: '0.04em', textTransform: 'uppercase',
                  padding: '6px 12px',
                  background: active ? 'var(--ink)' : 'transparent',
                  color: active ? 'var(--paper)' : 'var(--ink-2)',
                  border: 'none',
                  borderRight: i < dateOptions.length - 1 ? '1px solid var(--rule-2)' : 'none',
                  cursor: 'pointer',
                }}>
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--rule-2)' }} />

      {/* Offer chip toggles */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Eyebrow>Offers</Eyebrow>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {liveOffers.map(o => {
            const active = activeOffers.includes(o.slug)
            return (
              <button key={o.slug} onClick={() => onToggleOffer(o.slug)} style={{
                fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em',
                textTransform: 'uppercase', fontWeight: 500,
                padding: '4px 10px',
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--ink-2)',
                border: `1px solid ${active ? 'var(--ink)' : 'var(--rule-2)'}`,
                borderRadius: 2, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                transition: 'all 0.12s cubic-bezier(0.2,0.7,0.2,1)',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: 6, flexShrink: 0,
                  background: active ? 'var(--accent)' : offerColor(o.slug),
                }} />
                {o.name.replace('OPT ', '').replace(' (Direct Call Engine)', '').replace(' (placeholder)', '')}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Last-synced ticker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-4)' }}>
        <span style={{
          width: 6, height: 6, borderRadius: 6, background: 'var(--up, #3e8a5e)',
          boxShadow: '0 0 0 3px rgba(62,138,94,0.18)',
        }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em',
                      textTransform: 'uppercase' }}>
          {lastSyncedAt ? `Synced ${minutesAgo(lastSyncedAt)} ago` : 'Loading…'}
        </span>
      </div>
    </div>
  )
}

function minutesAgo(date) {
  const min = Math.max(0, Math.floor((Date.now() - date) / 60000))
  if (min < 1) return 'just now'
  if (min === 1) return '1 min'
  return `${min} min`
}

// ═════════════════════════════════════════════════════════════════════
// KPIDominant — hero win-rate + 3 secondary tiles
// ═════════════════════════════════════════════════════════════════════
function KPIDominant({ summary, spark }) {
  const isReal = summary.winners <= 2
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1.6fr 1fr 1fr 1fr',
      gap: 0,
      border: '1px solid var(--rule)',
      background: 'white',
    }}>
      {/* Hero — Win rate */}
      <div style={{
        padding: '28px 28px 24px',
        borderRight: '1px solid var(--rule)',
        background: 'white',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
          <Eyebrow>Win rate</Eyebrow>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                        letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {summary.weeksTracked}w tracked
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 4 }}>
          <BigNumber value={summary.winRate.toFixed(1)} suffix="%" size={88} weight={400} />
          {!isReal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
              <Sparkline values={spark} width={120} height={36}
                stroke="var(--ink)" fill="var(--paper-2)" accent="var(--accent)" />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                12 weeks
              </span>
            </div>
          )}
        </div>
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 14, color: 'var(--ink-3)' }}>
            {summary.winners} of {summary.taggedAds} tagged ads
          </span>
          {isReal && (
            <Pill tone="amber" size="sm">Below baseline — early window</Pill>
          )}
        </div>
      </div>

      <SecondaryKPI
        eyebrow="Avg CPB · winners"
        value={<BigNumber value={summary.avgCpbWinners} prefix="$" size={42} />}
        meta="winners only"
      />
      <SecondaryKPI
        eyebrow="Booked"
        value={<BigNumber value={summary.totalBooked} size={42} />}
        meta={`${fmtMoneyFull(summary.totalSpend)} spend`}
      />
      <SecondaryKPI
        eyebrow="Tag coverage"
        value={<BigNumber value={summary.tagCoverage} suffix="%" size={42} />}
        meta={`${summary.totalAds - summary.taggedAds} untagged`}
        last
      />
    </div>
  )
}

function SecondaryKPI({ eyebrow, value, meta, last }) {
  return (
    <div style={{
      padding: '28px 22px 24px',
      borderRight: last ? 'none' : '1px solid var(--rule)',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      minHeight: 168,
    }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 6 }}>
        {value}
      </div>
      <div style={{ marginTop: 12 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>{meta}</span>
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// VariablesLeaderboard — ranked list with lift bars
// ═════════════════════════════════════════════════════════════════════
function VariablesLeaderboard({ items, baseline }) {
  if (items.length === 0) {
    return (
      <div style={{ padding: 32, background: 'white', border: '1px solid var(--rule)',
                    color: 'var(--ink-4)', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    fontSize: 14, textAlign: 'center' }}>
        Not enough tagged data yet. Tag more ads (button top-right) to reveal which
        attribute values are pulling ahead.
      </div>
    )
  }
  const maxLift = Math.max(...items.map(i => Math.abs(i.lift)), 0.1)
  return (
    <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
      {items.map((item, i) => {
        const isTop = i === 0 && item.lift > 0
        const barColor = isTop ? 'var(--accent)' : item.lift > 0 ? 'var(--ink)' : 'var(--ink-5)'
        const widthPct = Math.max((Math.abs(item.lift) / maxLift) * 100, 4)
        return (
          <div key={item.attr} style={{
            display: 'grid',
            gridTemplateColumns: '36px 1.2fr 1fr 1.4fr 100px 80px',
            alignItems: 'center', gap: 16,
            padding: '16px 20px',
            borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
            transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-5)',
                          letterSpacing: '0.04em' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <Eyebrow style={{ marginBottom: 3 }}>{item.label}</Eyebrow>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.1,
                            letterSpacing: '-0.01em', color: 'var(--ink)' }}>
                {humanAttr(item.value)}
              </div>
            </div>
            <div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                next best
              </span>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-2)', marginTop: 2 }}>
                {item.runnerUpValue ? humanAttr(item.runnerUpValue) : '—'}
                {item.runnerUpValue != null && (
                  <span style={{ color: 'var(--ink-4)', marginLeft: 8 }}>
                    {fmtPct(item.runnerUpWinRate)}
                  </span>
                )}
              </div>
            </div>
            {/* Lift bar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                              fontSize: 20, fontWeight: 400, color: 'var(--ink)',
                              letterSpacing: '-0.01em' }}>
                  {fmtLift(item.lift)}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                              letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  lift vs {baseline.toFixed(1)}%
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--paper-2)', position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${widthPct}%`, background: barColor,
                  transition: 'width 0.5s cubic-bezier(0.2,0.7,0.2,1)',
                }} />
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 16, color: 'var(--ink)' }}>
                {item.winners}<span style={{ color: 'var(--ink-4)' }}>/{item.ads}</span>
              </span>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                wins / ads
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 16, color: 'var(--ink)' }}>
                {item.cpb != null ? `$${item.cpb}` : '—'}
              </span>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                avg CPB
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// SmallMultiples — 6 mini bar charts in a grid
// ═════════════════════════════════════════════════════════════════════
function SmallMultiples({ stats, baseline }) {
  return (
    <div style={{
      display: 'grid', gap: 1,
      gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
      background: 'var(--rule)', border: '1px solid var(--rule)',
    }}>
      {PIVOTS.map(p => (
        <MiniBarChart key={p.attr} attr={p.attr} label={p.label}
          values={stats[p.attr] || []} baseline={baseline} />
      ))}
    </div>
  )
}

function MiniBarChart({ attr, label, values, baseline }) {
  const rows = values
    .map(v => ({ ...v, winRate: v.ads > 0 ? (v.winners / v.ads) * 100 : 0 }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 8)
  if (rows.length === 0) {
    return (
      <div style={{ padding: '18px 20px', background: 'white' }}>
        <Eyebrow>{label}</Eyebrow>
        <div style={{ marginTop: 16, padding: 24, color: 'var(--ink-4)',
                      fontFamily: 'var(--serif)', fontStyle: 'italic',
                      fontSize: 13, textAlign: 'center' }}>
          No data.
        </div>
      </div>
    )
  }
  const max = Math.max(...rows.map(r => r.winRate), baseline * 1.5, 0.5)
  const baselinePct = (baseline / max) * 100
  return (
    <div style={{ padding: '18px 20px', background: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <Eyebrow>{label}</Eyebrow>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          baseline {fmtPct(baseline)}
        </span>
      </div>
      <div>
        {rows.map((r, i) => {
          const widthPct = (r.winRate / max) * 100
          const beats = r.winRate > baseline
          const color = beats && i === 0 ? 'var(--accent)' : beats ? 'var(--ink)' : 'var(--ink-5)'
          return (
            <div key={r.value} style={{
              display: 'grid', gridTemplateColumns: '110px 1fr 56px',
              alignItems: 'center', gap: 10, padding: '5px 0',
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11,
                            color: beats ? 'var(--ink-2)' : 'var(--ink-4)',
                            textAlign: 'right',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {humanAttr(r.value)}
              </span>
              <div style={{ height: 14, background: 'var(--paper-2)', position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${Math.max(widthPct, 1.5)}%`,
                  background: color,
                  transition: 'width 0.5s cubic-bezier(0.2,0.7,0.2,1)',
                }} />
                <div style={{
                  position: 'absolute', top: -2, bottom: -2, left: `${baselinePct}%`,
                  width: 1, borderLeft: '1px dashed var(--ink-4)',
                }} />
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 11, color: beats ? 'var(--ink)' : 'var(--ink-4)',
                            textAlign: 'right' }}>
                {fmtPct(r.winRate)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// ProofDonut — SVG donut + legend
// ═════════════════════════════════════════════════════════════════════
function ProofDonut({ data }) {
  const filtered = data.filter(d => d.attribute_value !== 'none' && Number(d.booked) > 0)
  const total = filtered.reduce((s, d) => s + Number(d.booked), 0)
  if (total === 0) return null

  const palette = ['var(--accent)', '#b53e3e', '#3e8a5e', '#5b3a8f', '#0e7c86', '#b86a0c', '#e0a93e', 'var(--ink-4)']
  let acc = 0
  const arcs = filtered.map((d, i) => {
    const start = acc
    const end = acc + Number(d.booked)
    acc = end
    const startA = (start / total) * 2 * Math.PI - Math.PI / 2
    const endA = (end / total) * 2 * Math.PI - Math.PI / 2
    return { name: d.attribute_value, ads: d.ads_count, booked: Number(d.booked), startA, endA, color: palette[i % palette.length] }
  })

  const r = 70, R = 100, cx = 110, cy = 110
  function arcPath(a) {
    const large = a.endA - a.startA > Math.PI ? 1 : 0
    const sx = cx + R * Math.cos(a.startA), sy = cy + R * Math.sin(a.startA)
    const ex = cx + R * Math.cos(a.endA), ey = cy + R * Math.sin(a.endA)
    const sxi = cx + r * Math.cos(a.endA), syi = cy + r * Math.sin(a.endA)
    const exi = cx + r * Math.cos(a.startA), eyi = cy + r * Math.sin(a.startA)
    return `M${sx},${sy} A${R},${R} 0 ${large} 1 ${ex},${ey} L${sxi},${syi} A${r},${r} 0 ${large} 0 ${exi},${eyi} Z`
  }

  const topShare = (arcs[0].booked / total * 100).toFixed(0)

  return (
    <Card padding={24} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center' }}>
      <svg width={220} height={220}>
        {arcs.map((a, i) => (
          <path key={i} d={arcPath(a)} fill={a.color} stroke="white" strokeWidth={1.5} />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fontFamily="var(--serif)" fontSize="32" fill="var(--ink)">
          {total}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontFamily="var(--mono)" fontSize="10" fill="var(--ink-4)" letterSpacing="0.06em">
          BOOKED
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ marginBottom: 6 }}>
          <Eyebrow>Booked by proof character</Eyebrow>
          <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontSize: 16,
                        fontStyle: 'italic', color: 'var(--ink-3)' }}>
            {humanAttr(arcs[0].name)} carries {topShare}% of bookings.
          </div>
        </div>
        {arcs.map((a, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10,
            alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--rule)',
          }}>
            <span style={{ width: 10, height: 10, background: a.color }} />
            <span style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>{humanAttr(a.name)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                          fontSize: 11, color: 'var(--ink-4)' }}>{a.ads} ads</span>
            <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums', fontSize: 16 }}>{a.booked}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
