// /sales/downsells — list of all coaching sessions.
// Stripped to the minimum: client, last activity, click row to open.

import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Plus, Loader, AlertCircle, TrendingDown, ChevronRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'

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
        .select('id, client_name, client_company, status, updated_at, opening_context, contracts(client_name, client_company)')
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
    <div className="max-w-[960px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Digital · Sales · Downsells</span>
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', margin: '6px 0 0', lineHeight: 1.1 }}>
            Save the <em style={{ fontStyle: 'italic' }}>deal</em>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
            Chat with the coach about any client who's wobbling. It asks questions then gives you options.
          </p>
        </div>
        <Link to="/sales/downsells/new" className="editorial-btn-primary">
          <Plus size={ICON.sm} />
          New chat
        </Link>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {error && (
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, fontFamily: 'var(--mono)' }}>{error}</p>
        </div>
      )}

      {!loading && !error && threads.length === 0 && (
        <div className="tile tile-feedback flex flex-col items-center justify-center py-12 px-6 text-center">
          <TrendingDown size={28} style={{ color: 'var(--ink-3)', marginBottom: 10 }} />
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)', margin: 0 }}>
            No chats yet
          </h2>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6, maxWidth: 360 }}>
            When a client wobbles, open a chat. Tell the coach what's going on; it'll come back with options.
          </p>
          <Link to="/sales/downsells/new" className="editorial-btn-primary" style={{ marginTop: 14 }}>
            <Plus size={ICON.sm} />
            New chat
          </Link>
        </div>
      )}

      {!loading && !error && threads.length > 0 && (
        <div className="tile tile-feedback p-0 overflow-hidden">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                <th className="text-left px-4 py-2" style={th}>Client</th>
                <th className="text-left px-4 py-2" style={th}>Situation</th>
                <th className="text-right px-4 py-2" style={th}>Last activity</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {threads.map(t => {
                const isHover = hoveredRow === t.id
                const name = t.client_name || t.contracts?.client_name || '—'
                const co   = t.client_company || t.contracts?.client_company || null
                const preview = (t.opening_context || '').slice(0, 140).replace(/\s+/g, ' ').trim()
                const truncated = (t.opening_context || '').length > 140
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
                    <td className="px-4 py-3" style={{ verticalAlign: 'top', minWidth: 180 }}>
                      <span style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>{name}</span>
                      {co && (
                        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{co}</div>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ verticalAlign: 'top', maxWidth: 460 }}>
                      <span style={{ fontSize: 13, color: 'var(--ink-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {preview}{truncated ? '…' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {new Date(t.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-2 py-3 text-right" style={{ verticalAlign: 'top' }}>
                      <ChevronRight size={14} style={{ color: isHover ? 'var(--accent)' : 'var(--ink-3)', transition: 'color 120ms ease' }} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const th = { fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }
