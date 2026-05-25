// /sales/downsells — top-level list of all coaching sessions across every
// contract. Replaces the per-contract DownsellCoach wrapper that used to
// live under /sales/contracts/:id. Downsells are a deal-level concern, not
// a contract-document concern, so they get their own home.

import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Plus, Loader, AlertCircle, TrendingDown, Lock, Flag, ChevronRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'
import { STATUS_STYLES } from './CoachThread'

const STATUS_LABEL = {
  open:      'Open',
  locked:    'Locked',
  applied:   'Applied',
  cancelled: 'Cancelled',
}

export default function DownsellsListPage() {
  const navigate = useNavigate()
  const [threads, setThreads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [hoveredRow, setHoveredRow] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data, error } = await supabase
        .from('contract_downsell_threads')
        .select('*, contracts(client_name, client_company, fee_amount_usd, contract_type)')
        .order('updated_at', { ascending: false })
      if (cancelled) return
      if (error) setError(error.message)
      else setThreads(data || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Digital · Sales · Downsells</span>
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', margin: '6px 0 0', lineHeight: 1.1 }}>
            Save the <em style={{ fontStyle: 'italic' }}>deal</em>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4, maxWidth: 720 }}>
            Coach yourself through any client who's wobbling on price or threatening to leave. Every session is grounded in your real unit economics — the coach proposes offers that hit margin and tells you when you've hit a floor.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link to="/sales/downsells/new" className="editorial-btn-primary">
            <Plus size={ICON.sm} />
            New downsell
          </Link>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {error && (
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
              Could not load downsell sessions
            </p>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 0', fontFamily: 'var(--mono)' }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {!loading && !error && threads.length === 0 && (
        <div className="tile tile-feedback flex flex-col items-center justify-center py-12 px-6 text-center">
          <TrendingDown size={28} style={{ color: 'var(--ink-3)', marginBottom: 10 }} />
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)', margin: 0 }}>
            No coaching sessions yet
          </h2>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6, maxWidth: 420 }}>
            When a client wobbles, open a session for them. The coach pulls their contract context and walks you through a margin-safe offer.
          </p>
          <Link to="/sales/downsells/new" className="editorial-btn-primary" style={{ marginTop: 14 }}>
            <Plus size={ICON.sm} />
            Start first session
          </Link>
        </div>
      )}

      {!loading && !error && threads.length > 0 && (
        <>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 0 8px', fontStyle: 'italic' }}>
            Click any row to open the coaching session.
          </p>
          <div className="tile tile-feedback p-0 overflow-hidden">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                  <th className="text-left px-4 py-2" style={th}>Client</th>
                  <th className="text-left px-4 py-2" style={th}>Status</th>
                  <th className="text-left px-4 py-2" style={th}>Latest offer</th>
                  <th className="text-right px-4 py-2" style={th}>Monthly</th>
                  <th className="text-right px-4 py-2" style={th}>Updated</th>
                  <th style={{ width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {threads.map(t => {
                  const isHover = hoveredRow === t.id
                  const sigKey = t.status === 'locked' ? 'locked'
                    : t.admin_review_requested ? 'needs_admin' : null
                  return (
                    <tr
                      key={t.id}
                      onClick={() => navigate(`/sales/downsells/${t.id}`)}
                      onMouseEnter={() => setHoveredRow(t.id)}
                      onMouseLeave={() => setHoveredRow(null)}
                      role="link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          navigate(`/sales/downsells/${t.id}`)
                        }
                      }}
                      style={{
                        borderBottom: '1px solid var(--rule)',
                        cursor: 'pointer',
                        background: isHover ? 'var(--paper-2)' : 'transparent',
                        transition: 'background 120ms ease',
                      }}
                    >
                      <td className="px-4 py-3">
                        <span style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>
                          {t.contracts?.client_name || '—'}
                        </span>
                        {t.contracts?.client_company && (
                          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{t.contracts.client_company}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.status === 'locked' ? 'var(--ink-3)' : 'var(--ink)' }}>
                            {STATUS_LABEL[t.status] || t.status}
                          </span>
                          {t.status === 'locked' && <Lock size={11} style={{ color: 'var(--ink-3)' }} />}
                          {t.admin_review_requested && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--down)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <Flag size={10} /> Ben
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" style={{ maxWidth: 360 }}>
                        <span style={{ fontSize: 12, color: 'var(--ink)', fontStyle: t.recommended_summary ? 'normal' : 'italic' }}>
                          {t.recommended_summary || <span style={{ color: 'var(--ink-3)' }}>No offer yet</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)' }}>
                        {t.monthly_value_usd ? `$${Number(t.monthly_value_usd).toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
                        {new Date(t.updated_at).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <ChevronRight size={14} style={{ color: isHover ? 'var(--accent)' : 'var(--ink-3)', transition: 'color 120ms ease' }} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

const th = { fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }
