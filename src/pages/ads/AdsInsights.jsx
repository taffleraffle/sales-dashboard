import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { tagMissing, getAttributeCoverage } from '../../services/creativeTagger'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import AdThumbnail from '../../components/ads/AdThumbnail'
import {
  Eyebrow, SectionHead, Button, Pill, Card, Sparkline, BigNumber, Icon,
  fmtMoney, fmtMoneyFull, fmtNum, fmtPct, fmtLift, humanAttr, frameColor,
  ValueChip, LiftBadge, TrendDelta, WinnerBadge, PodiumRank,
  attrColor, displayValue, tint, PALETTE,
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

// Attribute pivots powering the "Variables pulling ahead" leaderboard
// and the win-rate-by-attribute small-multiples chart.
// Trimmed 2026-05-18: dropped funnel_stage + format.
const PIVOTS = [
  { attr: 'hook_type',        label: 'Hook type' },
  { attr: 'message_frame',    label: 'Message frame' },
  { attr: 'mechanism_reveal', label: 'Mechanism reveal' },
  { attr: 'pain_angle',       label: 'Pain angle' },
  { attr: 'awareness_level',  label: 'Awareness level' },
]

export default function AdsInsights() {
  // Perf comes from AdsCreativeTestingLayout context — already filtered by
  // active offers + hide-inactive toggle (those controls now live in the
  // layout's AnalyticsToolbar). We only own the coverage side-fetch and the
  // local UI state (drawers, errors, tagging spinner).
  const layoutCtx = useOutletContext() || {}
  const {
    perf: filteredPerf, offers, loading: ctxLoading, err: ctxErr,
    since, until, refresh,
  } = layoutCtx

  const [coverage, setCoverage] = useState([])
  const [tagging, setTagging] = useState(false)
  const [addOrLinkOpen, setAddOrLinkOpen] = useState(false)
  const [editingAd, setEditingAd] = useState(null)
  const [localErr, setLocalErr] = useState(null)

  const loading = ctxLoading
  const err = ctxErr || localErr

  // Coverage is the only RPC Insights still owns — fast aggregate, only this page uses it
  useEffect(() => {
    let alive = true
    getAttributeCoverage()
      .then(d => { if (alive) setCoverage(d) })
      .catch(e => { if (alive) setLocalErr(e.message) })
    return () => { alive = false }
  }, [])

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

  // Sparkline data — winners per week over the last 12 weeks
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

  // Proof donut — booked + ad counts per proof character, computed
  // client-side from the same perf rows the layout fetched once.
  const proofPie = useMemo(() => {
    const rows = filteredPerf || []
    const groups = {}
    rows.forEach(r => {
      const v = r.proof_character || 'none'
      if (!groups[v]) groups[v] = { attribute_value: v, ads: 0, booked: 0, spend: 0, winners: 0 }
      groups[v].ads++
      groups[v].booked += Number(r.booked) || 0
      groups[v].spend += Number(r.spend) || 0
      if (r.effective_winner) groups[v].winners++
    })
    return Object.values(groups).sort((a, b) => b.booked - a.booked)
  }, [filteredPerf])

  async function handleTagMissing() {
    setTagging(true)
    try { await tagMissing(50); refresh && refresh() }
    catch (e) { setLocalErr(e.message) }
    finally { setTagging(false) }
  }

  return (
    <div>
      {/* Page header — toolbar (date + offers + hide-inactive) lives in layout */}
      <SectionHead
        level="page"
        eyebrow="Creative · Insights"
        title="Insights"
        tagline={`Win-rate signal across every Meta ad we've shipped. ${summary.winners} winners of ${summary.taggedAds} tagged ads.`}
        gap={20}
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

      {err && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#fef2f2',
                      border: '1px solid #fca5a5', color: '#b53e3e', fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Win rate hero — single number, no other KPIs. Ben said the other
          tiles (Booked / Avg CPB / Tag coverage) were noise on this surface. */}
      <div style={{ marginTop: 26, marginBottom: 32 }}>
        <WinRateHero summary={summary} spark={winnerSpark} />
      </div>

      {/* Variables pulling ahead — click any row to drill into that
          attribute=value on the Creatives library. */}
      <div style={{ marginBottom: 32 }}>
        <SectionHead
          title="Variables pulling ahead"
          tagline="For each attribute, the value beating baseline win rate by the largest margin. Click any row to see the creatives behind it."
        />
        <VariablesLeaderboard items={variablesAhead} baseline={summary.winRate} />
      </div>

      {/* Win rate by attribute — small multiples; bars are clickable
          and navigate to the Creatives library filtered to that value. */}
      <div style={{ marginBottom: 32 }}>
        <SectionHead
          title="Win rate by attribute"
          tagline="Bars above the dashed baseline are pulling weight. Click a bar to see those creatives. Deep dive in the Attributes tab."
          right={
            <Link to="/sales/ads/creative/attributes" style={{
              fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
              color: 'var(--ink-2)', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              Deep dive →
            </Link>
          }
        />
        <SmallMultiples stats={attrStats} baseline={summary.winRate} />
      </div>

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
        onSaved={() => { setAddOrLinkOpen(false); refresh && refresh() }} />
      <CreativeEditDrawer
        open={!!editingAd}
        ad={editingAd}
        onClose={() => { setEditingAd(null); refresh && refresh() }} />
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
      <div style={{ padding: 48, background: 'var(--paper)', border: '1px solid var(--rule)',
                    textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    color: 'var(--ink-4)' }}>
        Loading top performers…
      </div>
    )
  }
  if (sorted.length === 0) {
    return (
      <div style={{ padding: 48, background: 'var(--paper)', border: '1px solid var(--rule)',
                    textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    color: 'var(--ink-4)' }}>
        No booked-call activity in this window yet.
      </div>
    )
  }

  const cols = '52px 80px minmax(280px, 2fr) minmax(260px, 2.2fr) 96px 96px 108px'

  return (
    // overflow-x: the column template needs ~1030px; below that (split-
    // screen laptop, iPad) the right columns were hard-clipped because
    // the ≤768px CSS hides main overflow. Scroll beats clip.
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)', overflowX: 'auto' }}>
    <div style={{ minWidth: 1030 }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: cols,
        alignItems: 'center', gap: 16,
        padding: '12px 20px',
        background: 'var(--paper-2)',
        borderBottom: '1px solid var(--rule)',
      }}>
        <Eyebrow>Rank</Eyebrow>
        <Eyebrow>Creative</Eyebrow>
        <Eyebrow>Ad · campaign</Eyebrow>
        <Eyebrow>Tags</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>Booked</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>CPB</Eyebrow>
        <Eyebrow style={{ textAlign: 'right' }}>State</Eyebrow>
      </div>
      {/* Rows */}
      {sorted.map((c, i) => (
        <TopPerformerRow key={c.ad_id} c={c} rank={i + 1} cols={cols}
          onClick={() => onClickRow?.(c)}
          isLast={i === sorted.length - 1} />
      ))}
    </div>
    </div>
  )
}

function TopPerformerRow({ c, rank, cols, onClick, isLast }) {
  const isWinner = !!c.effective_winner
  const frameC = c.message_frame ? frameColor(c.message_frame) : null
  return (
    <div onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        alignItems: 'center', gap: 16,
        padding: '18px 20px',
        paddingLeft: 17,
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        borderLeft: isWinner ? '3px solid var(--accent)' : '3px solid transparent',
        cursor: 'pointer',
        transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
      }}>
      <div>
        <PodiumRank rank={rank} size="md" />
      </div>
      <div style={{
        position: 'relative', display: 'inline-block', lineHeight: 0,
      }}>
        <AdThumbnail ad={c} size="md" style={{
          outline: isWinner ? '2px solid var(--accent)' : 'none',
          outlineOffset: isWinner ? -2 : 0,
        }} />
        {frameC && (
          <span style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 4,
            background: frameC, pointerEvents: 'none', zIndex: 1,
          }} />
        )}
        {isWinner && (
          <span style={{
            position: 'absolute', top: -6, right: -6,
            width: 18, height: 18, background: 'var(--accent)',
            border: '1.5px solid var(--paper)',
            display: 'grid', placeItems: 'center',
            color: 'var(--ink)', fontSize: 10, fontWeight: 700,
            borderRadius: 18, zIndex: 2,
          }}>★</span>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 19, lineHeight: 1.18, color: 'var(--ink)',
          letterSpacing: '-0.005em', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.ad_name || c.ad_id}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
          marginTop: 4, letterSpacing: '0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {c.campaign_name || '—'} <span style={{ opacity: 0.6 }}>· {c.ad_id}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[
          { a: 'hook_type', v: c.hook_type },
          { a: 'message_frame', v: c.message_frame },
          { a: 'mechanism_reveal', v: c.mechanism_reveal },
          { a: 'pain_angle', v: c.pain_angle },
          { a: 'awareness_level', v: c.awareness_level },
        ].filter(p => p.v).slice(0, 5).map((p, i) => (
          <ValueChip key={i} attr={p.a} value={p.v} size="xs" />
        ))}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 26, lineHeight: 1, color: 'var(--ink)', fontWeight: 500 }}>
          {fmtNum(c.booked)}
        </div>
        {c.leads != null && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 4 }}>
            {fmtNum(c.leads)} leads
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 26, lineHeight: 1, color: 'var(--ink)', fontWeight: 500 }}>
          {c.cost_per_booked != null ? fmtMoney(Number(c.cost_per_booked)) : '—'}
        </div>
        {c.spend != null && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 4 }}>
            {fmtMoney(Number(c.spend))} spent
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        {isWinner ? (
          <WinnerBadge size="md" />
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                        letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Testing
          </span>
        )}
      </div>
    </div>
  )
}

// FilterBar + minutesAgo + DATE_PRESETS + offerColor were moved to
// AdsCreativeTestingLayout.jsx as the AnalyticsToolbar — one toolbar
// across all four analytics pages instead of duplicating per page.

// ═════════════════════════════════════════════════════════════════════
// WinRateHero — single big number. Ben asked to drop Avg CPB, Booked,
// and Tag coverage from this surface — they were noise on the overview.
function WinRateHero({ summary, spark }) {
  const isReal = summary.winners <= 2
  const showAccent = !isReal
  return (
    <div style={{
      padding: '20px 24px',
      borderLeft: showAccent ? '3px solid var(--accent)' : '1px solid var(--rule)',
      borderTop: '1px solid var(--rule)',
      borderRight: '1px solid var(--rule)',
      borderBottom: '1px solid var(--rule)',
      paddingLeft: showAccent ? 21 : 24,
      background: 'var(--paper)',
    }}>
      <Eyebrow>Win rate · {summary.weeksTracked}w</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 6 }}>
        <span style={{
          fontFamily: 'var(--sans)', fontVariantNumeric: 'tabular-nums',
          fontSize: 56, fontWeight: 600, lineHeight: 1,
          letterSpacing: '-0.02em', color: 'var(--ink)',
        }}>
          {summary.winRate.toFixed(1)}
          <span style={{ fontSize: 28, color: 'var(--ink-3)', marginLeft: 2 }}>%</span>
        </span>
        {!isReal && (
          <Sparkline values={spark} width={120} height={36}
            stroke={PALETTE.green}
            fill={tint(PALETTE.green, 0.08)}
            accent={showAccent ? 'var(--accent)' : PALETTE.green} />
        )}
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
          marginLeft: 'auto', alignSelf: 'flex-end',
        }}>
          <span style={{ color: 'var(--ink)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {summary.winners}
          </span>{' '}winner{summary.winners === 1 ? '' : 's'} of{' '}
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{summary.taggedAds}</span> tagged ads
        </span>
      </div>
      {isReal && (
        <div style={{ marginTop: 12 }}>
          <Pill tone="amber" size="sm">Below baseline — early window</Pill>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// VariablesLeaderboard — ranked list with lift bars
// ═════════════════════════════════════════════════════════════════════
function VariablesLeaderboard({ items, baseline }) {
  const navigate = useNavigate()
  if (items.length === 0) {
    return (
      <div style={{ padding: 32, background: 'var(--paper)', border: '1px solid var(--rule)',
                    color: 'var(--ink-4)', fontFamily: 'var(--serif)', fontStyle: 'italic',
                    fontSize: 14, textAlign: 'center' }}>
        Not enough tagged data yet. Tag more ads (button top-right) to reveal which
        attribute values are pulling ahead.
      </div>
    )
  }
  const maxLift = Math.max(...items.map(i => Math.abs(i.lift)), 0.1)
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      {items.map((item, i) => {
        const isTop = i === 0 && item.lift > 0
        const stripeColor = attrColor(item.attr, item.value)
        const barColor = isTop ? 'var(--accent)' : (item.lift > 0 ? stripeColor : 'var(--ink-5)')
        const widthPct = Math.max((Math.abs(item.lift) / maxLift) * 100, 4)
        return (
          <div key={item.attr}
            onClick={() => navigate(`/sales/ads/creative/creatives?${item.attr}=${encodeURIComponent(item.value)}`)}
            title={`Click to see the ${item.ads} creatives tagged ${item.attr}=${item.value}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1.2fr 1fr 1.4fr 100px 80px',
              alignItems: 'center', gap: 16,
              padding: '18px 20px',
              paddingLeft: 17,
              borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
              borderLeft: `3px solid ${isTop ? 'var(--accent)' : stripeColor}`,
              cursor: 'pointer',
              transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <PodiumRank rank={i + 1} size="sm" />
            <div>
              <Eyebrow style={{ marginBottom: 5 }}>{item.label}</Eyebrow>
              <ValueChip attr={item.attr} value={item.value} size="md" />
            </div>
            <div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                next best
              </span>
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                {item.runnerUpValue ? (
                  <ValueChip attr={item.attr} value={item.runnerUpValue} size="xs" />
                ) : (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-5)' }}>—</span>
                )}
                {item.runnerUpValue != null && (
                  <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                                fontSize: 11, color: 'var(--ink-4)' }}>
                    {fmtPct(item.runnerUpWinRate)}
                  </span>
                )}
              </div>
            </div>
            {/* Lift bar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <LiftBadge lift={item.lift} size="md" />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                              letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  vs {baseline.toFixed(1)}% baseline
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--paper-2)', position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${widthPct}%`, background: barColor,
                  transition: 'width 0.5s cubic-bezier(0.2,0.7,0.2,1)',
                }} />
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>
                {item.winners}<span style={{ color: 'var(--ink-4)' }}>/{item.ads}</span>
              </span>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: 2 }}>
                wins · ads
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                            fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>
                {item.cpb != null ? `$${item.cpb}` : '—'}
              </span>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                            letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: 2 }}>
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
  const navigate = useNavigate()
  const rows = values
    .map(v => ({ ...v, winRate: v.ads > 0 ? (v.winners / v.ads) * 100 : 0 }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 8)
  if (rows.length === 0) {
    return (
      <div style={{ padding: '18px 20px', background: 'var(--paper)' }}>
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
    <div style={{ padding: '18px 20px', background: 'var(--paper)' }}>
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
            <div key={r.value}
              onClick={() => navigate(`/sales/ads/creative/creatives?${attr}=${encodeURIComponent(r.value)}`)}
              title={`Click to see the ${r.ads} creatives tagged ${attr}=${r.value}`}
              style={{
                display: 'grid', gridTemplateColumns: '110px 1fr 56px',
                alignItems: 'center', gap: 10, padding: '5px 4px',
                margin: '0 -4px', cursor: 'pointer',
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
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
