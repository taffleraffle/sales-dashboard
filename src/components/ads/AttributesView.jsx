import { useMemo, useState } from 'react'
import AdThumbnail from './AdThumbnail'
import {
  Eyebrow, SectionHead, Sparkline, BigNumber,
  fmtMoney, fmtMoneyFull, fmtNum, fmtPct, fmtLift, frameColor,
  ValueChip, LiftBadge, WinnerBadge, PodiumRank,
  attrColor, displayValue, tint, PALETTE,
} from '../editorial/atoms'

/*
  Attributes drill-down — left rail (ranked attrs) + right pane (hero + value breakdown).
  Implements the design from /tmp/design-pkg2/ad-performance/project/attributes-page.jsx.

  Data source: filteredPerf (the same array AdsInsights uses for everything else),
  so offer-filter + date-range honor the page-level filters automatically.
*/

// Trimmed 2026-05-18 to the 5 attributes that actually drive testing.
const ALL_ATTRS = [
  { id: 'hook_type',        label: 'Hook type',         sub: 'Opening seconds — question, scene, diagnostic…' },
  { id: 'message_frame',    label: 'Message frame',     sub: 'Problem · Circumstance · Outcome' },
  { id: 'mechanism_reveal', label: 'Mechanism reveal',  sub: 'Gated · Explicit · Hidden' },
  { id: 'pain_angle',       label: 'Pain angle',        sub: 'The specific operator wound the ad presses on' },
  { id: 'awareness_level',  label: 'Awareness level',   sub: 'Schwartz’s 5 stages of buyer awareness' },
]

// Minimum ad sample for a value to be considered "in play" (filters noise)
const MIN_SAMPLE = 5

export default function AttributesView({ filteredPerf, baseline, loading, onClickCreative }) {
  const [active, setActive] = useState('pain_angle')
  const [comboAttr, setComboAttr] = useState('message_frame')
  // Selected value within the active attribute. Null = show the leader (default).
  // Click a row in the value breakdown to pin a different value into the
  // TopInValue + "View all in Creatives" link.
  const [selectedValue, setSelectedValue] = useState(null)

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

  // Setter that also clears the value drill-down (clicking a different
  // attribute should drop back to the leader, not stay on a now-invalid value)
  const setActiveAttr = (id) => { setActive(id); setSelectedValue(null) }

  // Only show the loading skeleton on first load (no attribute summaries yet).
  // Refetches keep the existing rail+detail visible to avoid the date-change flash.
  if (loading && withData.length === 0) {
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
      <AttributeRail summaries={attrSummaries} active={active} setActive={setActiveAttr} baseline={baseline} />
      <AttributeDetail
        summary={activeSummary}
        baseline={baseline}
        filteredPerf={filteredPerf}
        attrSummaries={attrSummaries}
        comboAttr={comboAttr}
        setComboAttr={setComboAttr}
        onClickCreative={onClickCreative}
        selectedValue={selectedValue}
        setSelectedValue={setSelectedValue}
      />
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

// ─── Right pane — hero + value breakdown + combo matrix + top creatives ────
function AttributeDetail({ summary, baseline, filteredPerf, attrSummaries, comboAttr, setComboAttr, onClickCreative, selectedValue, setSelectedValue }) {
  const leader = summary.leader
  const color = attrColor(summary.id, leader.value)
  const isLeading = summary.lift > 0
  // The value driving TopInValue + the "View all" link. Defaults to the leader.
  const focusValue = selectedValue || leader.value
  const focusRow = summary.all.find(v => v.value === focusValue) || leader
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

      {/* All values bar chart — rows clickable to drill into TopInValue */}
      <ValueBreakdown
        summary={summary}
        baseline={baseline}
        selectedValue={selectedValue}
        onSelectValue={(v) => setSelectedValue(v === selectedValue ? null : v)}
      />

      {/* Cross-tab combination matrix */}
      <CombinationMatrix
        summary={summary}
        attrSummaries={attrSummaries}
        comboAttr={comboAttr}
        setComboAttr={setComboAttr}
        filteredPerf={filteredPerf}
        baseline={baseline}
      />

      {/* Top creatives within the focused value (defaults to leader if not pinned) */}
      <TopInValue
        summary={summary}
        focusValue={focusValue}
        focusRow={focusRow}
        filteredPerf={filteredPerf}
        onClickCreative={onClickCreative}
      />
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
function ValueBreakdown({ summary, baseline, selectedValue, onSelectValue }) {
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
          const isSelected = selectedValue === r.value
          return (
            <div key={r.value}
              onClick={() => onSelectValue && onSelectValue(r.value)}
              title={`Click to see top ads with ${displayValue(r.value)}`}
              style={{
                display: 'grid', gridTemplateColumns: GRID,
                alignItems: 'center', gap: 14,
                padding: '12px 8px',
                margin: '0 -8px',
                borderBottom: i < rows.length - 1 ? '1px solid var(--rule)' : 'none',
                cursor: onSelectValue ? 'pointer' : 'default',
                background: isSelected ? tint(valColor, 0.08) : 'transparent',
                borderLeft: isSelected ? `3px solid ${valColor}` : '3px solid transparent',
                transition: 'background 0.12s ease, border-color 0.12s ease',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--paper-2)' }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
            >
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

// ─── Combination matrix — cross-tab of active attr × picked attr ──────
function CombinationMatrix({ summary, attrSummaries, comboAttr, setComboAttr, filteredPerf, baseline }) {
  const rowAttr = summary.id
  const rowValues = summary.all.map(v => v.value)

  // Available cross attrs: anything with data, that isn't the active attr
  const availableCombos = attrSummaries.filter(a => a.id !== rowAttr && a.leader)
  const effectiveCombo = (availableCombos.find(a => a.id === comboAttr)?.id) || availableCombos[0]?.id

  const colValues = useMemo(() => {
    if (!effectiveCombo) return []
    const c = attrSummaries.find(a => a.id === effectiveCombo)
    return c ? c.all.map(v => v.value) : []
  }, [effectiveCombo, attrSummaries])

  // Build 2D matrix from filteredPerf
  const { matrix, maxWR } = useMemo(() => {
    if (!effectiveCombo) return { matrix: {}, maxWR: 0 }
    const out = {}
    for (const r of rowValues) out[r] = {}
    for (const ad of (filteredPerf || [])) {
      const r = ad[rowAttr]
      const c = ad[effectiveCombo]
      if (!r || !c || !out[r]) continue
      if (!out[r][c]) out[r][c] = { ads: 0, winners: 0, spend: 0, booked: 0 }
      out[r][c].ads++
      out[r][c].spend += Number(ad.spend) || 0
      out[r][c].booked += Number(ad.booked) || 0
      if (ad.effective_winner) out[r][c].winners++
    }
    let max = 0
    for (const r in out) for (const c in out[r]) {
      const cell = out[r][c]
      if (cell.ads < 5) continue
      const wr = (cell.winners / cell.ads) * 100
      if (wr > max) max = wr
    }
    return { matrix: out, maxWR: max }
  }, [rowValues, effectiveCombo, filteredPerf, rowAttr])

  if (!effectiveCombo || colValues.length === 0) return null

  return (
    <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
      <div style={{
        padding: '14px 22px', borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <Eyebrow>Cross-tab</Eyebrow>
          <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontSize: 18 }}>
            {summary.label} <em>×</em>{' '}
            {attrSummaries.find(a => a.id === effectiveCombo)?.label || effectiveCombo}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>crosses with</span>
          <select value={effectiveCombo} onChange={e => setComboAttr(e.target.value)} style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '5px 10px',
            background: 'white', color: 'var(--ink)',
            border: '1px solid var(--ink-3)', outline: 'none',
          }}>
            {availableCombos.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ padding: '14px 22px 18px', overflowX: 'auto' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `160px repeat(${colValues.length}, minmax(92px, 1fr))`,
          gap: 6,
        }}>
          {/* Header row: empty corner + col labels */}
          <div />
          {colValues.map(c => (
            <div key={c} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              padding: '6px 4px', borderBottom: '1px solid var(--rule)',
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 7,
                background: attrColor(effectiveCombo, c),
              }} />
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                color: 'var(--ink-2)', letterSpacing: '0.02em', fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{displayValue(c)}</span>
            </div>
          ))}
          {/* Body rows */}
          {rowValues.map(r => (
            <Row key={r} r={r} rowAttr={rowAttr} colValues={colValues} matrix={matrix}
                 baseline={baseline} maxWR={maxWR} />
          ))}
        </div>
        <div style={{
          marginTop: 14, fontFamily: 'var(--serif)', fontSize: 13,
          fontStyle: 'italic', color: 'var(--ink-3)',
        }}>
          Cells need at least 5 ads to qualify for highlight. Darker shading = higher win rate.
          Yellow = peak combo across the matrix.
        </div>
      </div>
    </div>
  )
}

function Row({ r, rowAttr, colValues, matrix, baseline, maxWR }) {
  return (
    <>
      <div style={{
        padding: '8px 8px 8px 0',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 8,
          background: attrColor(rowAttr, r), flexShrink: 0,
        }} />
        <span style={{ fontFamily: 'var(--serif)', fontSize: 13.5, color: 'var(--ink-2)' }}>
          {displayValue(r)}
        </span>
      </div>
      {colValues.map(c => {
        const cell = matrix[r] && matrix[r][c]
        if (!cell || cell.ads === 0) {
          return (
            <div key={c} style={{
              background: 'var(--paper-2)', padding: '8px 6px',
              textAlign: 'center', color: 'var(--ink-5)',
              fontFamily: 'var(--mono)', fontSize: 10,
            }}>—</div>
          )
        }
        const wr = (cell.winners / cell.ads) * 100
        const beats = wr > baseline
        const isMax = wr === maxWR && cell.ads >= 5 && maxWR > 0
        const baseColor = attrColor(rowAttr, r)
        const intensity = Math.min(wr / Math.max(maxWR, 4), 1)
        const bg = isMax
          ? 'var(--accent)'
          : beats
            ? tint(baseColor, 0.08 + intensity * 0.28)
            : 'var(--paper-2)'
        return (
          <div key={c} style={{
            background: bg, padding: '10px 6px', textAlign: 'center',
            border: isMax ? '1.5px solid var(--accent-2)' : '1px solid transparent',
            position: 'relative',
          }}>
            {isMax && (
              <span style={{
                position: 'absolute', top: 2, right: 4, fontSize: 9, color: 'var(--ink)',
              }}>★</span>
            )}
            <div style={{
              fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
              fontSize: 16, lineHeight: 1,
              color: beats ? 'var(--ink)' : 'var(--ink-3)',
              fontWeight: beats ? 500 : 400,
            }}>
              {fmtPct(wr)}
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
              fontSize: 9.5, color: beats ? 'var(--ink-3)' : 'var(--ink-4)', marginTop: 3,
            }}>
              {cell.winners}/{cell.ads}
            </div>
          </div>
        )
      })}
    </>
  )
}

// ─── Top creatives within a focused value (defaults to leader) ────────
function TopInValue({ summary, focusValue, focusRow, filteredPerf, onClickCreative }) {
  const rowAttr = summary.id
  const value = focusValue || summary.leader.value
  // Pull every ad with this attribute=value (not just booked-only — when the
  // operator drills into a low-performer they want to see ALL ads to debug)
  const allMatching = useMemo(() => {
    return (filteredPerf || [])
      .filter(c => c[rowAttr] === value)
      .sort((a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0))
  }, [filteredPerf, rowAttr, value])

  const subset = allMatching.slice(0, 4)
  if (subset.length === 0) return null

  const valueColor = attrColor(rowAttr, value)
  const totalCount = allMatching.length
  const creativesLink = `/sales/ads/creative/creatives?${rowAttr}=${encodeURIComponent(value)}`
  return (
    <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
      <div style={{
        padding: '16px 22px', borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Eyebrow>{focusValue ? 'Top creatives · drilled' : 'Top creatives'}</Eyebrow>
          <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500 }}>
            Within <span style={{ color: valueColor }}>{displayValue(value)}</span>
            {focusRow && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)',
                marginLeft: 10, fontWeight: 400, letterSpacing: '0.04em',
              }}>
                {focusRow.winners}/{focusRow.ads} ads · {(focusRow.winRate || 0).toFixed(1)}% win rate
              </span>
            )}
          </div>
        </div>
        <a href={creativesLink} style={{
          fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
          color: 'var(--ink-2)', textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '6px 12px',
          border: '1px solid var(--rule-2)',
          background: 'white',
        }}>
          View all {totalCount} in Creatives →
        </a>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 1,
        background: 'var(--rule)',
      }}>
        {subset.map(c => {
          const isWinner = !!c.effective_winner
          const frame = c.message_frame ? frameColor(c.message_frame) : null
          return (
            <div key={c.ad_id}
              onClick={() => onClickCreative?.(c)}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'white'}
              style={{
                background: 'white', padding: '16px 18px',
                cursor: onClickCreative ? 'pointer' : 'default',
                display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: 14, alignItems: 'flex-start',
                transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1)',
              }}>
              <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
                <AdThumbnail ad={c} size="sm" style={{
                  outline: isWinner ? '2px solid var(--accent)' : 'none',
                  outlineOffset: isWinner ? -2 : 0,
                }} />
                {frame && (
                  <span style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                    background: frame, pointerEvents: 'none',
                  }} />
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--serif)', fontSize: 15, lineHeight: 1.2, fontWeight: 500,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{c.ad_name || c.ad_id}</div>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', marginTop: 4,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{c.campaign_name || '—'}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {c.hook_type && <ValueChip attr="hook_type" value={c.hook_type} size="xs" />}
                  {c.mechanism_reveal && <ValueChip attr="mechanism_reveal" value={c.mechanism_reveal} size="xs" />}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 10 }}>
                  <span>
                    <span style={{
                      fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 18, fontWeight: 500,
                    }}>{c.booked}</span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginLeft: 4,
                    }}>booked</span>
                  </span>
                  <span>
                    <span style={{
                      fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                      fontSize: 18, fontWeight: 500,
                    }}>{c.cost_per_booked != null ? fmtMoney(Number(c.cost_per_booked)) : '—'}</span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginLeft: 4,
                    }}>CPB</span>
                  </span>
                </div>
              </div>
              {isWinner && <WinnerBadge size="sm" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
