import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  Eyebrow, fmtMoney, fmtPct as fmtPctEd,
  ValueChip, attrColor, displayValue, tint, PALETTE,
} from '../editorial/atoms'

/*
  Cross-attribute heatmap — spreadsheet-style matrix.

  Operator picks two attributes; we call lib_perf_heatmap(attr_a, attr_b, since, until)
  and render a 2D grid. Rows = values of attr_a, cols = values of attr_b. Each cell
  shows win rate + n/N + (on hover) avg CPB.

  Color logic:
   - No data         → light paper, em-dash
   - Low N (<2 ads)  → grey, very faded
   - Below baseline  → light grey background, value in muted ink
   - Beats baseline  → tinted yellow scaled to intensity (rate / maxRate)
*/

const PIVOT_ATTRS = [
  { key: 'hook_type',        label: 'Hook type' },
  { key: 'message_frame',    label: 'Message frame' },
  { key: 'mechanism_reveal', label: 'Mechanism reveal' },
  { key: 'pain_angle',       label: 'Pain angle' },
  { key: 'funnel_stage',     label: 'Funnel stage' },
  { key: 'awareness_level',  label: 'Awareness level' },
  { key: 'proof_character',  label: 'Proof character' },
  { key: 'format',           label: 'Format' },
]

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export default function AttributeHeatmap({ since, until, baseline = 0 }) {
  const [attrA, setAttrA] = useState('hook_type')
  const [attrB, setAttrB] = useState('pain_angle')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (attrA === attrB) return
    let alive = true
    setLoading(true); setErr(null)
    supabase.rpc('lib_perf_heatmap', { attr_a: attrA, attr_b: attrB, since, until })
      .then(({ data, error }) => {
        if (!alive) return
        if (error) setErr(error.message)
        else setRows(data || [])
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [attrA, attrB, since, until])

  // Build 2D structure. Sort values by total ads (most-tested first).
  const { valuesA, valuesB, grid, maxWinRate, totalsA, totalsB } = useMemo(() => {
    const aTotals = {}, bTotals = {}
    const grid = {}
    let maxRate = 0
    rows.forEach(r => {
      const aN = Number(r.ads_count) || 0
      aTotals[r.value_a] = (aTotals[r.value_a] || 0) + aN
      bTotals[r.value_b] = (bTotals[r.value_b] || 0) + aN
      if (!grid[r.value_a]) grid[r.value_a] = {}
      const rate = aN > 0 ? (Number(r.winners) || 0) / aN : 0
      grid[r.value_a][r.value_b] = { ...r, win_rate: rate, ads_count: aN }
      if (rate > maxRate) maxRate = rate
    })
    const valuesA = Object.keys(aTotals).sort((a, b) => aTotals[b] - aTotals[a])
    const valuesB = Object.keys(bTotals).sort((a, b) => bTotals[b] - bTotals[a])
    return { valuesA, valuesB, grid, maxWinRate: maxRate, totalsA: aTotals, totalsB: bTotals }
  }, [rows])

  function cellStyle(cell) {
    const empty = !cell || cell.ads_count === 0
    if (empty) return { background: 'var(--paper-2)', color: 'var(--ink-5)' }
    const lowN = cell.ads_count < 2
    if (lowN) return { background: 'var(--paper)', color: 'var(--ink-4)', opacity: 0.55 }
    const beats = baseline > 0 && cell.win_rate > baseline
    if (beats) {
      const intensity = maxWinRate > 0 ? cell.win_rate / maxWinRate : 0
      const alpha = 0.25 + intensity * 0.7
      return {
        background: `rgba(244, 225, 74, ${alpha.toFixed(2)})`,
        color: 'var(--ink)',
        fontWeight: 600,
      }
    }
    return { background: 'var(--paper)', color: 'var(--ink-2)' }
  }

  return (
    <div>
      {/* Attribute pickers */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
        padding: '14px 18px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eyebrow>Rows</Eyebrow>
          <select value={attrA} onChange={e => setAttrA(e.target.value)}
            style={{
              padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 13,
              border: '1px solid var(--rule-2)', background: 'var(--paper)', borderRadius: 2,
            }}>
            {PIVOT_ATTRS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>×</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eyebrow>Columns</Eyebrow>
          <select value={attrB} onChange={e => setAttrB(e.target.value)}
            style={{
              padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 13,
              border: '1px solid var(--rule-2)', background: 'var(--paper)', borderRadius: 2,
            }}>
            {PIVOT_ATTRS.filter(a => a.key !== attrA).map(a => (
              <option key={a.key} value={a.key}>{a.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <Legend baseline={baseline} />
      </div>

      {err && (
        <div style={{
          padding: 12, background: tint(PALETTE.red, 0.08),
          border: `1px solid ${tint(PALETTE.red, 0.3)}`,
          color: PALETTE.red, fontSize: 13, marginBottom: 12,
        }}>{err}</div>
      )}

      {loading ? (
        <div style={{
          padding: 64, textAlign: 'center', color: 'var(--ink-4)',
          fontFamily: 'var(--serif)', fontStyle: 'italic',
          background: 'var(--paper)', border: '1px solid var(--rule)',
        }}>
          Loading heatmap…
        </div>
      ) : valuesA.length === 0 || valuesB.length === 0 ? (
        <div style={{
          padding: 64, textAlign: 'center', color: 'var(--ink-4)',
          fontFamily: 'var(--serif)', fontStyle: 'italic',
          background: 'var(--paper)', border: '1px dashed var(--rule)',
        }}>
          No data for this attribute combo in the selected window.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <table style={{
            borderCollapse: 'collapse',
            fontFamily: 'var(--sans)',
            width: '100%',
          }}>
            <thead>
              <tr>
                <th style={{
                  padding: '12px 14px',
                  background: 'var(--paper-2)',
                  borderBottom: '1px solid var(--rule)',
                  borderRight: '1px solid var(--rule)',
                  textAlign: 'left', position: 'sticky', left: 0, zIndex: 2,
                  minWidth: 180,
                }}>
                  <Eyebrow>
                    {PIVOT_ATTRS.find(a => a.key === attrA)?.label || attrA}
                    <span style={{ color: 'var(--ink-4)' }}> × </span>
                    {PIVOT_ATTRS.find(a => a.key === attrB)?.label || attrB}
                  </Eyebrow>
                </th>
                {valuesB.map(b => (
                  <th key={b} style={{
                    padding: '10px 8px',
                    background: 'var(--paper-2)',
                    borderBottom: '1px solid var(--rule)',
                    borderRight: '1px solid var(--rule)',
                    minWidth: 110, verticalAlign: 'bottom', textAlign: 'center',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: 8,
                        background: attrColor(attrB, b),
                      }} />
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                        color: 'var(--ink-2)', letterSpacing: '0.02em',
                        whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {displayValue(b)}
                      </span>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                        letterSpacing: '0.04em', textTransform: 'uppercase',
                      }}>
                        n={totalsB[b]}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {valuesA.map((a, rowIdx) => (
                <tr key={a}>
                  <th scope="row" style={{
                    padding: '12px 14px',
                    borderBottom: rowIdx < valuesA.length - 1 ? '1px solid var(--rule)' : 'none',
                    borderRight: '1px solid var(--rule)',
                    background: 'var(--paper-2)',
                    textAlign: 'left', position: 'sticky', left: 0, zIndex: 1,
                    verticalAlign: 'middle',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: 8,
                        background: attrColor(attrA, a),
                      }} />
                      <span style={{
                        fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)',
                        fontWeight: 500,
                      }}>{displayValue(a)}</span>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                        letterSpacing: '0.04em', marginLeft: 'auto',
                      }}>n={totalsA[a]}</span>
                    </div>
                  </th>
                  {valuesB.map((b, colIdx) => {
                    const cell = grid[a]?.[b]
                    const ads = cell?.ads_count || 0
                    const winners = Number(cell?.winners || 0)
                    const rate = cell?.win_rate || 0
                    const cs = cellStyle(cell)
                    const title = cell && ads > 0
                      ? `${displayValue(a)} × ${displayValue(b)}\n${winners}/${ads} wins (${fmtPct(rate)})${cell.cost_per_booked ? ` · CPB ${fmtMoney(Number(cell.cost_per_booked))}` : ''}`
                      : `${displayValue(a)} × ${displayValue(b)}: no data`
                    return (
                      <td key={b} title={title} style={{
                        ...cs,
                        padding: '10px 8px', textAlign: 'center',
                        borderBottom: rowIdx < valuesA.length - 1 ? '1px solid var(--rule)' : 'none',
                        borderRight: colIdx < valuesB.length - 1 ? '1px solid var(--rule)' : 'none',
                        minWidth: 110, height: 64,
                      }}>
                        {ads === 0 ? (
                          <span style={{ color: 'var(--ink-5)', fontSize: 12 }}>—</span>
                        ) : (
                          <>
                            <div style={{
                              fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
                              fontSize: 18, fontWeight: cs.fontWeight || 500, lineHeight: 1,
                            }}>
                              {fmtPct(rate)}
                            </div>
                            <div style={{
                              fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
                              fontSize: 10, color: 'var(--ink-4)', marginTop: 4,
                              letterSpacing: '0.02em',
                            }}>
                              {winners}/{ads}
                              {cell.cost_per_booked && (
                                <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>
                                  · ${Math.round(Number(cell.cost_per_booked))}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Legend({ baseline }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
      letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 14, height: 14, background: 'rgba(244,225,74,0.85)',
                       border: '1px solid var(--rule)' }} />
        Beats baseline
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 14, height: 14, background: 'var(--paper)',
                       border: '1px solid var(--rule)' }} />
        Below baseline
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 14, height: 14, background: 'var(--paper-2)',
                       border: '1px solid var(--rule)' }} />
        Low sample
      </span>
      <span style={{ color: 'var(--ink-3)' }}>
        baseline: {fmtPct(baseline)}
      </span>
    </div>
  )
}
