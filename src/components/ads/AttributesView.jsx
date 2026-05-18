import { useMemo, useState } from 'react'
import {
  Eyebrow, SectionHead, Sparkline, BigNumber,
  fmtMoney, fmtMoneyFull, fmtNum, fmtPct, fmtLift,
  ValueChip, LiftBadge, WinnerBadge, PodiumRank,
  attrColor, displayValue, tint, PALETTE,
} from '../editorial/atoms'

/*
  Attributes drill-down — left rail (ranked attrs) + right pane (hero + value breakdown).
  Implements the design from /tmp/design-pkg2/ad-performance/project/attributes-page.jsx.

  Data source: filteredPerf (the same array AdsInsights uses for everything else),
  so offer-filter + date-range honor the page-level filters automatically.
*/

const ALL_ATTRS = [
  { id: 'hook_type',        label: 'Hook type',         sub: 'Opening seconds — question, scene, diagnostic…' },
  { id: 'message_frame',    label: 'Message frame',     sub: 'Problem · Circumstance · Outcome' },
  { id: 'mechanism_reveal', label: 'Mechanism reveal',  sub: 'Gated · Explicit · Hidden' },
  { id: 'pain_angle',       label: 'Pain angle',        sub: 'The specific operator wound the ad presses on' },
  { id: 'funnel_stage',     label: 'Funnel stage',      sub: 'TOF · MOF · BOF · Cross' },
  { id: 'awareness_level',  label: 'Awareness level',   sub: 'Schwartz’s 5 stages of buyer awareness' },
  { id: 'length_bucket',    label: 'Length',            sub: '<60s / 60–75s / 75s+' },
  { id: 'format',           label: 'Format',            sub: 'Talking head · UGC · Comparative · Voiceover' },
  { id: 'proof_character',  label: 'Proof character',   sub: 'Named on-camera client or actor' },
  { id: 'actor',            label: 'Actor',             sub: 'Who filmed — Ben, Austin, client, voiceover' },
  { id: 'vertical',         label: 'Vertical',          sub: 'Restoration · Plumbing · Roofing (pilot)' },
]

// Minimum ad sample for a value to be considered "in play" (filters noise)
const MIN_SAMPLE = 5

export default function AttributesView({ filteredPerf, baseline, loading }) {
  const [active, setActive] = useState('pain_angle')

  // Build per-attribute summaries
  const attrSummaries = useMemo(() => {
    const rows = filteredPerf || []
    return ALL_ATTRS.map(a => {
      const groups = {}
      rows.forEach(r => {
        const v = r[a.id]
        if (!v) return
        if (!groups[v]) {
          groups[v] = { value: v, ads: 0, winners: 0, spend: 0, booked: 0, winnerSpend: 0, winnerBooked: 0 }
        }
        groups[v].ads++
        groups[v].spend += Number(r.spend) || 0
        groups[v].booked += Number(r.booked) || 0
        if (r.effective_winner) {
          groups[v].winners++
          groups[v].winnerSpend += Number(r.spend) || 0
          groups[v].winnerBooked += Number(r.booked) || 0
        }
      })
      const enriched = Object.values(groups)
        .map(g => ({
          ...g,
          winRate: g.ads > 0 ? (g.winners / g.ads) * 100 : 0,
          cpb: g.winnerBooked > 0 ? Math.round(g.winnerSpend / g.winnerBooked)
             : g.booked > 0 ? Math.round(g.spend / g.booked) : null,
        }))
        .filter(g => g.ads >= MIN_SAMPLE)
        .sort((a, b) => b.winRate - a.winRate)
      if (!enriched.length) return { ...a, leader: null, all: [], n: 0, lift: 0, spread: 0, totalWinners: 0 }
      const leader = enriched[0]
      const worst = enriched[enriched.length - 1]
      const total = enriched.reduce((s, v) => s + v.ads, 0)
      const totalWinners = enriched.reduce((s, v) => s + v.winners, 0)
      return {
        ...a,
        leader,
        runner: enriched[1] || null,
        worst,
        all: enriched,
        spread: leader.winRate - worst.winRate,
        n: total,
        totalWinners,
        lift: leader.winRate - baseline,
      }
    })
  }, [filteredPerf, baseline])

  // Ensure active attr has data; if not, pick the highest-lift one that does
  const withData = attrSummaries.filter(s => s.leader)
  const activeSummary = withData.find(s => s.id === active) || withData[0]

  if (loading) {
    return (
      <div style={{ padding: 64, textAlign: 'center', color: 'var(--ink-4)',
                    fontFamily: 'var(--serif)', fontStyle: 'italic',
                    background: 'white', border: '1px solid var(--rule)' }}>
        Loading attribute data…
      </div>
    )
  }

  if (!activeSummary) {
    return (
      <div style={{ padding: 64, textAlign: 'center', color: 'var(--ink-4)',
                    fontFamily: 'var(--serif)', fontStyle: 'italic',
                    background: 'white', border: '1px dashed var(--rule)' }}>
        No attribute has at least {MIN_SAMPLE} tagged ads in this window yet. Tag more ads to see the breakdown.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24, marginTop: 8 }}>
      <AttributeRail summaries={attrSummaries} active={active} setActive={setActive} baseline={baseline} />
      <AttributeDetail summary={activeSummary} baseline={baseline} />
    </div>
  )
}

// ─── Left rail — ranked attribute list ────────────────────────────────
function AttributeRail({ summaries, active, setActive, baseline }) {
  const withData = summaries.filter(s => s.leader).sort((a, b) => b.lift - a.lift)
  const noData = summaries.filter(s => !s.leader)
  return (
    <div style={{
      background: 'white', border: '1px solid var(--rule)',
      height: 'fit-content', position: 'sticky', top: 110,
    }}>
      <div style={{
        padding: '12px 14px', borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <Eyebrow>Attribute</Eyebrow>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          ranked · lift
        </span>
      </div>
      {withData.map((s, i) => {
        const isActive = s.id === active
        const color = attrColor(s.id, s.leader.value)
        return (
          <button key={s.id} onClick={() => setActive(s.id)} style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            width: '100%', textAlign: 'left',
            padding: '14px 14px 12px',
            paddingLeft: 11,
            background: isActive ? 'var(--paper-2)' : 'transparent',
            border: 'none',
            borderTop: '1px solid var(--rule)',
            borderLeft: isActive ? `3px solid ${color}` : '3px solid transparent',
            cursor: 'pointer',
            transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <span style={{
                fontFamily: 'var(--serif)', fontSize: 14.5, lineHeight: 1.2,
                color: isActive ? 'var(--ink)' : 'var(--ink-2)',
                fontWeight: isActive ? 500 : 400,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0, flex: 1,
              }}>{s.label}</span>
              <LiftBadge lift={s.lift} size="sm" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: color, flexShrink: 0 }} />
              <span style={{
                fontFamily: 'var(--mono)', letterSpacing: '0.02em',
                fontSize: 11, color: 'var(--ink-3)', fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0, flex: 1,
              }}>
                {displayValue(s.leader.value)}
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                flexShrink: 0, fontSize: 11, color: 'var(--ink-3)',
              }}>{fmtPct(s.leader.winRate)}</span>
            </div>
            <div style={{ height: 4, background: 'var(--paper-2)', position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${Math.min((s.leader.winRate / 8) * 100, 100)}%`,
                background: color,
              }} />
            </div>
          </button>
        )
      })}
      {noData.map(s => (
        <div key={s.id} style={{
          width: '100%', textAlign: 'left',
          padding: '12px 14px',
          borderTop: '1px solid var(--rule)',
          color: 'var(--ink-5)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <span style={{
            fontFamily: 'var(--serif)', fontSize: 13,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0,
          }}>{s.label}</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9.5,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            flexShrink: 0,
          }}>no data</span>
        </div>
      ))}
    </div>
  )
}

// ─── Right pane — hero + value breakdown ──────────────────────────────
function AttributeDetail({ summary, baseline }) {
  const leader = summary.leader
  const color = attrColor(summary.id, leader.value)
  const isLeading = summary.lift > 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
      {/* Hero */}
      <div style={{
        padding: '32px 36px',
        paddingLeft: 32,
        background: isLeading ? 'var(--accent-soft, #fdf6c5)' : 'white',
        border: '1px solid var(--rule)',
        borderLeft: `4px solid ${color}`,
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 24, marginBottom: 12,
        }}>
          <div>
            <Eyebrow style={{ marginBottom: 8 }}>{summary.label}</Eyebrow>
            <h2 style={{
              margin: 0, fontFamily: 'var(--serif)', fontSize: 42, lineHeight: 1.02,
              letterSpacing: '-0.025em', fontWeight: 400,
            }}>
              <span style={{ color }}>{displayValue(leader.value)}</span>
              {' '}<em style={{ color: 'var(--ink-3)' }}>is leading.</em>
            </h2>
          </div>
          {isLeading && <WinnerBadge size="lg" />}
        </div>
        <p style={{
          margin: '12px 0 0', fontFamily: 'var(--serif)', fontStyle: 'italic',
          color: 'var(--ink-3)', fontSize: 16, lineHeight: 1.45, maxWidth: 680,
        }}>
          {summary.sub}. {summary.totalWinners} winner{summary.totalWinners === 1 ? '' : 's'} across {summary.n} ads
          tagged this dimension — a {summary.spread.toFixed(1)}pt spread between best and worst value.
        </p>

        <div style={{
          marginTop: 26,
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24,
        }}>
          <HeroStat label="Win rate" value={fmtPct(leader.winRate)} sub={`vs ${fmtPct(baseline)} baseline`} />
          <HeroStat label="Sample"   value={`${leader.winners}/${leader.ads}`} sub="wins / ads" />
          <HeroStat label="Avg CPB"  value={leader.cpb != null ? `$${leader.cpb}` : '—'} sub="winners only" />
          <div>
            <Eyebrow>Lift</Eyebrow>
            <div style={{ marginTop: 4 }}>
              <LiftBadge lift={summary.lift} size="lg" />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                          marginTop: 4, letterSpacing: '0.02em' }}>
              over baseline
            </div>
          </div>
        </div>
      </div>

      {/* All values bar chart */}
      <ValueBreakdown summary={summary} baseline={baseline} />
    </div>
  )
}

function HeroStat({ label, value, sub }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{
        fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
        fontSize: 32, lineHeight: 1, marginTop: 4, color: 'var(--ink)',
      }}>{value}</div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
        marginTop: 4, letterSpacing: '0.02em',
      }}>{sub}</div>
    </div>
  )
}

// ─── All values ranked — bar chart with dashed baseline ──────────────
function ValueBreakdown({ summary, baseline }) {
  const rows = summary.all
  const max = Math.max(...rows.map(r => r.winRate), baseline * 1.5, 0.5)
  const baselinePct = (baseline / max) * 100
  const maxAds = Math.max(...rows.map(r => r.ads))

  // 5-col grid: value | bar | wins/ads | cpb | vs baseline
  const GRID = '180px 1fr 90px 70px 80px'

  return (
    <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
      <div style={{
        padding: '14px 22px',
        borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      }}>
        <div>
          <Eyebrow>All values · ranked</Eyebrow>
          <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontSize: 18 }}>
            {rows.length} values <em>tagged</em>, max sample{' '}
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{maxAds}</span> ads
          </div>
        </div>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>
          baseline {fmtPct(baseline)}
        </span>
      </div>
      <div style={{ padding: '4px 22px 16px' }}>
        {/* Column headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: GRID,
          alignItems: 'center', gap: 14,
          padding: '12px 0', borderBottom: '1px solid var(--rule)',
        }}>
          <Eyebrow>Value</Eyebrow>
          <Eyebrow>Win rate</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Wins / ads</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>Avg CPB</Eyebrow>
          <Eyebrow style={{ textAlign: 'right' }}>vs baseline</Eyebrow>
        </div>
        {rows.map((r, i) => {
          const widthPct = (r.winRate / max) * 100
          const beats = r.winRate > baseline
          const valColor = attrColor(summary.id, r.value)
          const barColor = beats ? valColor : tint(valColor, 0.35)
          return (
            <div key={r.value} style={{
              display: 'grid', gridTemplateColumns: GRID,
              alignItems: 'center', gap: 14,
              padding: '12px 0',
              borderBottom: i < rows.length - 1 ? '1px solid var(--rule)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 9, height: 9, borderRadius: 9, background: valColor, flexShrink: 0,
                }} />
                <span style={{
                  fontFamily: 'var(--serif)', fontSize: 16,
                  color: beats ? 'var(--ink)' : 'var(--ink-3)',
                  fontWeight: beats ? 500 : 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{displayValue(r.value)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, height: 18, background: 'var(--paper-2)', position: 'relative' }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${Math.max(widthPct, 1.5)}%`,
                    background: barColor,
                    transition: 'width 0.5s cubic-bezier(0.2,0.7,0.2,1)',
                  }} />
                  <div style={{
                    position: 'absolute', top: -3, bottom: -3, left: `${baselinePct}%`,
                    width: 1, borderLeft: '1px dashed var(--ink-4)',
                  }} />
                </div>
                <span style={{
                  fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 18, minWidth: 56, textAlign: 'right', fontWeight: 500,
                }}>{fmtPct(r.winRate)}</span>
              </div>
              <span style={{
                fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: 12, color: 'var(--ink-3)', textAlign: 'right',
              }}>
                {r.winners}/{r.ads}
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: 12, color: 'var(--ink-3)', textAlign: 'right',
              }}>
                {r.cpb != null && r.cpb > 0 ? `$${r.cpb}` : '—'}
              </span>
              <span style={{ textAlign: 'right' }}>
                <LiftBadge lift={r.winRate - baseline} size="sm" />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
