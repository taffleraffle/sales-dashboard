import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FileText, Plus, Loader, AlertCircle, ChevronRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

const STATUS_LABELS = {
  draft:      'Draft',
  sent:       'Sent',
  viewed:     'Viewed',
  signed:     'Signed',
  voided:     'Voided',
  superseded: 'Superseded',
}

export default function ContractsPage() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [contracts, setContracts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [hoveredRow, setHoveredRow] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data, error } = await supabase
        .from('contracts')
        .select('id, client_name, client_company, contract_type, status, version, fee_amount_usd, updated_at, pandadoc_view_url')
        .order('updated_at', { ascending: false })
      if (cancelled) return
      if (error) setError(error.message)
      else setContracts(data || [])
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
          <span className="eyebrow eyebrow-accent">OPT Digital · Contracts</span>
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', margin: '6px 0 0', lineHeight: 1.1 }}>
            Contract <em style={{ fontStyle: 'italic' }}>reviews</em>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4, maxWidth: 720 }}>
            Upload a signed agreement, raise amendment threads on specific clauses, and the judge tells you what we can lock in based on policy.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link to="/sales/contracts/add" className="editorial-btn-primary">
            <Plus size={ICON.sm} />
            New review
          </Link>
        </div>
      </div>

      {/* Loading / error / empty / list */}
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
              Could not load contracts
            </p>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 0', fontFamily: 'var(--mono)' }}>
              {error}
            </p>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '6px 0 0' }}>
              If this is your first time here, ask Sentinel to run migration 015_contracts.sql.
            </p>
          </div>
        </div>
      )}

      {!loading && !error && contracts.length === 0 && (
        <div className="tile tile-feedback flex flex-col items-center justify-center py-16 px-6 text-center">
          <FileText size={36} style={{ color: 'var(--ink-3)', marginBottom: 12 }} />
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 20, color: 'var(--ink)', margin: 0 }}>
            No contract reviews yet
          </h2>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, maxWidth: 460 }}>
            Upload an agreement to start. Once it's in, you can talk through a downsell to save a wobbling client, or push individual clause amendments through the judge.
          </p>
          <Link to="/sales/contracts/add" className="editorial-btn-primary" style={{ marginTop: 20 }}>
            <Plus size={ICON.sm} />
            Start first review
          </Link>
        </div>
      )}

      {!loading && !error && contracts.length > 0 && (
        <>
          {/* Hint line above the table — makes it explicit that rows open
              into the downsell + amendment workspace. Previously the table
              looked like a static list with no visible affordance. */}
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 0 8px', fontStyle: 'italic' }}>
            Click any row to open downsell options + contract negotiation for that client.
          </p>
          <div className="tile tile-feedback p-0 overflow-hidden">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                  <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Client</th>
                  <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Template</th>
                  <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Status</th>
                  <th className="text-right px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Fee</th>
                  <th className="text-right px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Updated</th>
                  <th className="px-2 py-2" style={{ width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {contracts.map(c => {
                  const isHover = hoveredRow === c.id
                  return (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/sales/contracts/${c.id}`)}
                      onMouseEnter={() => setHoveredRow(c.id)}
                      onMouseLeave={() => setHoveredRow(null)}
                      role="link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          navigate(`/sales/contracts/${c.id}`)
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
                          {c.client_name}
                          {c.version > 1 && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginLeft: 8 }}>v{c.version}</span>
                          )}
                        </span>
                        {c.client_company && (
                          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{c.client_company}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink)' }}>
                          {c.contract_type === 'retainer' ? 'Retainer' : c.contract_type === 'trial' ? 'Trial' : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                          {STATUS_LABELS[c.status] || c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)' }}>
                        {c.fee_amount_usd ? `$${Number(c.fee_amount_usd).toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
                        {new Date(c.updated_at).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <ChevronRight
                          size={14}
                          style={{
                            color: isHover ? 'var(--accent)' : 'var(--ink-3)',
                            transition: 'color 120ms ease',
                          }}
                        />
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
