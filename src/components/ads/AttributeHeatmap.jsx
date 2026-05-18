import { useEffect, useMemo, useState } from 'react'
import { Grid3x3, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Cross-attribute heatmap. Operator picks two attributes; the page calls
  the lib_perf_heatmap(attr_a, attr_b, since, until) RPC and renders a
  2D matrix of win rate per cell.

  Cells are color-encoded by win rate:
   - Yellow (accent) when the cell beats the overall baseline
   - Grey scale below baseline
   - Empty (low opacity) when ads_count is 0 or 1 (too noisy)

  Reveals interactions like "diagnostic hook + capacity_mismatch pain
  is doing 4x better than either alone."
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

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
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
    // Cancellation guard — if operator changes dropdowns rapidly, only the
    // latest dispatched request writes to state. Previous (stale) RPCs that
    // happen to resolve later are ignored.
    let current = true
    setLoading(true); setErr(null)
    supabase.rpc('lib_perf_heatmap', { attr_a: attrA, attr_b: attrB, since, until })
      .then(({ data, error }) => {
        if (!current) return
        if (error) setErr(error.message)
        else setRows(data || [])
      })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [attrA, attrB, since, until])

  // Build 2D structure: { [value_a]: { [value_b]: row } }
  const { valuesA, valuesB, grid, maxWinRate } = useMemo(() => {
    const aSet = new Set()
    const bSet = new Set()
    const grid = {}
    let maxRate = 0
    rows.forEach(r => {
      aSet.add(r.value_a); bSet.add(r.value_b)
      if (!grid[r.value_a]) grid[r.value_a] = {}
      const rate = r.ads_count > 0 ? r.winners / r.ads_count : 0
      grid[r.value_a][r.value_b] = { ...r, win_rate: rate }
      if (rate > maxRate) maxRate = rate
    })
    return {
      valuesA: Array.from(aSet).sort(),
      valuesB: Array.from(bSet).sort(),
      grid, maxWinRate: maxRate,
    }
  }, [rows])

  function cellColor(rate, adsCount) {
    if (!adsCount || adsCount < 2) return { background: 'var(--paper)', color: 'var(--ink-4)', opacity: 0.4 }
    if (rate <= 0) return { background: 'var(--paper)', color: 'var(--ink-4)' }
    if (baseline > 0 && rate > baseline) {
      // Yellow scale by intensity vs max
      const intensity = maxWinRate > 0 ? rate / maxWinRate : 0
      const opacity = 0.3 + intensity * 0.7  // 0.3 to 1.0
      return { background: `rgba(244, 225, 74, ${opacity})`, color: 'var(--ink)', fontWeight: 600 }
    }
    return { background: 'var(--paper)', color: 'var(--ink-3)' }
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="eyebrow eyebrow-accent" style={{ marginBottom: 8 }}>
        <Grid3x3 size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
        Cross-attribute <em>heatmap</em>
      </div>
      <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)',
                  fontSize: 13, margin: '0 0 16px', maxWidth: 720 }}>
        Find interactions. Pick two attributes — each cell shows the win rate of ads with that
        combo. Yellow cells beat the overall baseline ({fmtPct(baseline)}). Faded cells have
        fewer than 2 ads (too noisy to trust).
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
                    padding: '14px 18px', background: 'var(--paper)',
                    border: '1px solid var(--rule)', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: 'var(--ink-4)' }}>Rows:</span>
          <select value={attrA} onChange={e => setAttrA(e.target.value)}
            style={{ padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 13,
                    border: '1px solid var(--rule)', background: 'white', borderRadius: 2 }}>
            {PIVOT_ATTRS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>×</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                        textTransform: 'uppercase', color: 'var(--ink-4)' }}>Columns:</span>
          <select value={attrB} onChange={e => setAttrB(e.target.value)}
            style={{ padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 13,
                    border: '1px solid var(--rule)', background: 'white', borderRadius: 2 }}>
            {PIVOT_ATTRS.filter(a => a.key !== attrA).map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </div>
      </div>

      {err && (
        <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, borderRadius: 2, marginBottom: 12 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                      fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          Loading heatmap…
        </div>
      ) : valuesA.length === 0 || valuesB.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                      fontStyle: 'italic', fontFamily: 'var(--serif)',
                      border: '1px dashed var(--rule)', borderRadius: 2 }}>
          No data for this attribute combo in the selected window.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', background: 'white', border: '1px solid var(--rule)',
                      borderRadius: 2, padding: 8 }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: 11,
                          fontFamily: 'var(--mono)' }}>
            <thead>
              <tr>
                <th style={{ padding: '6px 8px', textAlign: 'left', minWidth: 120,
                            color: 'var(--ink-4)', fontWeight: 500, letterSpacing: '0.06em' }}>
                  {/* Empty corner */}
                </th>
                {valuesB.map(b => (
                  <th key={b} style={{
                    padding: '6px 8px', textAlign: 'center',
                    fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
                    letterSpacing: '0.06em', color: 'var(--ink-3)',
                    writingMode: 'vertical-rl', transform: 'rotate(180deg)',
                    minWidth: 50, height: 80,
                    borderBottom: '2px solid var(--ink)',
                  }}>{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {valuesA.map(a => (
                <tr key={a}>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)',
                              fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.04em',
                              textAlign: 'right', borderRight: '2px solid var(--ink)' }}>
                    {a}
                  </td>
                  {valuesB.map(b => {
                    const cell = grid[a]?.[b]
                    const winRate = cell?.win_rate || 0
                    const ads = cell?.ads_count || 0
                    const style = cellColor(winRate, ads)
                    return (
                      <td key={b}
                        title={cell
                          ? `${a} × ${b}: ${cell.winners}/${cell.ads_count} wins (${fmtPct(winRate)}) · avg CPB ${fmt$(cell.cost_per_booked)}`
                          : 'no data'}
                        style={{
                          ...style,
                          padding: '8px 6px', textAlign: 'center',
                          minWidth: 60, height: 50,
                          borderRadius: 2, cursor: 'help',
                          fontFamily: 'var(--mono)', fontSize: 11,
                          transition: 'transform 120ms ease',
                        }}>
                        {cell && ads >= 1 ? (
                          <>
                            <div style={{ fontWeight: style.fontWeight || 500, fontSize: 12 }}>
                              {fmtPct(winRate)}
                            </div>
                            <div style={{ fontSize: 9, opacity: 0.7, marginTop: 2 }}>
                              {cell.winners}/{ads}
                            </div>
                          </>
                        ) : (
                          <span style={{ opacity: 0.3 }}>·</span>
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
