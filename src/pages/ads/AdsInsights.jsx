import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trophy, AlertCircle, RefreshCw } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { tagMissing, listOffers, getAttributeCoverage } from '../../services/creativeTagger'

/*
  Creative Insights — the analytics dashboard.

  Reads:
    - lib_ad_performance(since, until) — one row per ad with metrics + attrs
    - lib_perf_by_attribute(attr, since, until) — per-attribute pivot rollup
    - lib_winning_attributes(since, until) — most consistent winning attrs
    - lib_attribute_coverage — data-health (how many ads have each attribute)

  Renders:
    - Top filter bar (date range, offer multi-select, funnel stage)
    - Coverage pill row
    - 6 pivot widgets (hook_type, message_frame, mechanism_reveal,
      proof_character, pain_angle, format)
    - Winners table
    - Most-consistent-winning-attributes callout

  Cross-attribute heatmap is TODO — defer until pivots ship.
*/

const PIVOTS = [
  { attr: 'hook_type',        label: 'Hook type' },
  { attr: 'message_frame',    label: 'Message frame' },
  { attr: 'mechanism_reveal', label: 'Mechanism reveal' },
  { attr: 'proof_character',  label: 'Proof character' },
  { attr: 'pain_angle',       label: 'Pain angle' },
  { attr: 'format',           label: 'Format' },
]

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10)

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtN(n) {
  if (n == null || isNaN(n)) return '—'
  return Math.round(n).toLocaleString()
}

export default function AdsInsights() {
  const [since, setSince] = useState(daysAgo(30))
  const [until, setUntil] = useState(today())
  const [offerFilter, setOfferFilter] = useState([])  // [] = all
  const [offers, setOffers] = useState([])
  const [perf, setPerf] = useState(null)
  const [pivots, setPivots] = useState({})
  const [winners, setWinners] = useState([])
  const [coverage, setCoverage] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [tagging, setTagging] = useState(false)

  async function loadEverything() {
    setLoading(true); setErr(null)
    try {
      const [offersData, perfData, winnersData, coverageData] = await Promise.all([
        listOffers(),
        supabase.rpc('lib_ad_performance', { since, until }),
        supabase.rpc('lib_winning_attributes', { since, until }),
        getAttributeCoverage(),
      ])
      if (perfData.error) throw new Error(`perf: ${perfData.error.message}`)
      if (winnersData.error) throw new Error(`winners: ${winnersData.error.message}`)
      setOffers(offersData)
      setPerf(perfData.data || [])
      setWinners(winnersData.data || [])
      setCoverage(coverageData)

      // Pivots — fire all 6 in parallel
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
  }

  useEffect(() => { loadEverything() }, [since, until])

  // Client-side filter (offerFilter)
  const filteredPerf = useMemo(() => {
    if (!perf) return null
    if (!offerFilter.length) return perf
    return perf.filter(r => offerFilter.includes(r.offer_slug))
  }, [perf, offerFilter])

  async function handleTagMissing() {
    setTagging(true)
    try { await tagMissing(50); await loadEverything() }
    catch (e) { setErr(e.message) }
    finally { setTagging(false) }
  }

  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div className="eyebrow eyebrow-accent">OPT Sales · Creative <em>insights</em></div>
          <h1 className="h2" style={{ marginTop: 4 }}>What's <em>winning</em>, by attribute.</h1>
        </div>
        <button
          onClick={handleTagMissing}
          disabled={tagging}
          style={{
            padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 11,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            border: '1px solid var(--ink)', background: 'transparent',
            color: 'var(--ink)', cursor: tagging ? 'wait' : 'pointer', opacity: tagging ? 0.5 : 1,
          }}>
          <RefreshCw size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
          {tagging ? 'Tagging…' : 'Tag missing ads'}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap',
                    padding: 16, background: 'var(--paper)', border: '1px solid var(--rule)',
                    marginBottom: 24 }}>
        <div>
          <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
                         letterSpacing: '0.12em', textTransform: 'uppercase',
                         color: 'var(--ink-3)', marginBottom: 4 }}>Since</label>
          <input type="date" value={since} onChange={e => setSince(e.target.value)}
            style={{ padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 12,
                    border: '1px solid var(--rule)' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
                         letterSpacing: '0.12em', textTransform: 'uppercase',
                         color: 'var(--ink-3)', marginBottom: 4 }}>Until</label>
          <input type="date" value={until} onChange={e => setUntil(e.target.value)}
            style={{ padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 12,
                    border: '1px solid var(--rule)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
                         letterSpacing: '0.12em', textTransform: 'uppercase',
                         color: 'var(--ink-3)', marginBottom: 4 }}>Offer (multi)</label>
          <select multiple value={offerFilter} onChange={e =>
              setOfferFilter(Array.from(e.target.selectedOptions).map(o => o.value))}
            style={{ width: '100%', padding: '6px 8px', fontFamily: 'var(--sans)', fontSize: 12,
                    border: '1px solid var(--rule)', minHeight: 60 }}>
            {offers.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
        </div>
        <button onClick={loadEverything} disabled={loading || tagging}
          style={{ padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  border: '1px solid var(--ink)', background: 'var(--ink)',
                  color: 'var(--paper)', cursor: (loading || tagging) ? 'wait' : 'pointer',
                  opacity: (loading || tagging) ? 0.5 : 1 }}>
          {loading ? 'Loading…' : tagging ? 'Tagging…' : 'Refresh'}
        </button>
      </div>

      {err && (
        <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, marginBottom: 16 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6 }} />{err}
        </div>
      )}

      {/* Coverage pills */}
      <div style={{ marginBottom: 24 }}>
        <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--ink-3)' }}>Data health · attribute coverage</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {coverage.map(c => {
            const pct = (parseFloat(c.coverage_pct) || 0) * 100
            const color = pct >= 80 ? 'var(--accent)' : pct >= 50 ? '#e0a93e' : '#d97847'
            return (
              <div key={c.attribute_name} style={{
                padding: '6px 12px', border: '1px solid var(--rule)', background: 'white',
                fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em',
              }}>
                <span style={{ color: 'var(--ink-4)', textTransform: 'uppercase' }}>{c.attribute_name}</span>
                <span style={{ marginLeft: 8, color, fontWeight: 600 }}>{pct.toFixed(0)}%</span>
                <span style={{ marginLeft: 4, color: 'var(--ink-4)' }}>({c.covered}/{c.total})</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Most consistent winning attributes */}
      {winners.length > 0 && (
        <div style={{ marginBottom: 24, padding: 20, background: 'var(--paper)',
                      border: '1px solid var(--rule)' }}>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 8 }}>
            <Trophy size={13} style={{ display: 'inline', marginRight: 6 }} />
            Most consistent winning <em>attributes</em>
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                       color: 'var(--ink-4)', marginBottom: 12 }}>
            Attributes appearing in 2+ winners over this window. Lower CPA + more winners = stronger signal.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {winners.slice(0, 12).map((w, i) => (
              <div key={i} style={{ padding: 12, background: 'white', border: '1px solid var(--rule)' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                              letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
                  {w.attribute_name}
                </div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink)', marginBottom: 4 }}>
                  {w.attribute_value}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                  {w.winners} winners · avg CPB {fmt$(w.avg_cost_per_booked)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pivot widgets — 6 widgets in a 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 24, marginBottom: 24 }}>
        {PIVOTS.map(p => (
          <PivotWidget key={p.attr} label={p.label} rows={pivots[p.attr] || []} loading={loading} />
        ))}
      </div>

      {/* Winners table */}
      <WinnersTable rows={(filteredPerf || []).filter(r => r.effective_winner)} />
    </div>
  )
}

function PivotWidget({ label, rows, loading }) {
  const sorted = [...rows].sort((a, b) => (b.booked || 0) - (a.booked || 0))
  const maxBooked = Math.max(...sorted.map(r => r.booked || 0), 1)

  return (
    <div style={{ padding: 16, background: 'white', border: '1px solid var(--rule)' }}>
      <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>{label}</div>
      {loading ? (
        <div style={{ padding: 24, color: 'var(--ink-4)', fontStyle: 'italic' }}>Loading…</div>
      ) : sorted.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          No tagged data in this window.
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 13, fontFamily: 'var(--sans)' }}>
          <thead>
            <tr style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
                         textTransform: 'uppercase', color: 'var(--ink-4)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '4px 0' }}>Value</th>
              <th>Ads</th>
              <th>Spend</th>
              <th>Booked</th>
              <th>CPB</th>
              <th>🏆</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.attribute_value} style={{ borderTop: '1px solid var(--rule)' }}>
                <td style={{ padding: '6px 0', position: 'relative' }}>
                  {r.attribute_value}
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, height: 2,
                    width: `${(r.booked / maxBooked) * 100}%`,
                    background: 'var(--accent)', opacity: 0.6,
                  }} />
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtN(r.ads_count)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt$(r.spend)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtN(r.booked)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt$(r.cost_per_booked)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.winners > 0 ? r.winners : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function WinnersTable({ rows }) {
  return (
    <div style={{ padding: 16, background: 'white', border: '1px solid var(--rule)' }}>
      <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
        <Trophy size={13} style={{ display: 'inline', marginRight: 6 }} />
        Current <em>winners</em> ({rows.length})
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--ink-4)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
          No ads meet the winner threshold yet (spend ≥ $1k AND ≥2 booked AND CPB ≤ $300).
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 12, fontFamily: 'var(--sans)' }}>
          <thead>
            <tr style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
                         textTransform: 'uppercase', color: 'var(--ink-4)' }}>
              <th style={{ textAlign: 'left', padding: '6px 0' }}>Ad name</th>
              <th style={{ textAlign: 'left' }}>Hook</th>
              <th style={{ textAlign: 'left' }}>Frame</th>
              <th style={{ textAlign: 'left' }}>Pain</th>
              <th style={{ textAlign: 'left' }}>Proof</th>
              <th style={{ textAlign: 'right' }}>Spend</th>
              <th style={{ textAlign: 'right' }}>Booked</th>
              <th style={{ textAlign: 'right' }}>CPB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.ad_id} style={{ borderTop: '1px solid var(--rule)' }}>
                <td style={{ padding: '6px 4px 6px 0' }}>
                  <Link to={`/sales/ads/ad/${r.ad_id}`} style={{ color: 'var(--ink)', textDecoration: 'none' }}>
                    {r.ad_name || r.ad_id}
                  </Link>
                </td>
                <td>{r.hook_type || '—'}</td>
                <td>{r.message_frame || '—'}</td>
                <td>{r.pain_angle || '—'}</td>
                <td>{r.proof_character || '—'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt$(r.spend)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtN(r.booked)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt$(r.cost_per_booked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
