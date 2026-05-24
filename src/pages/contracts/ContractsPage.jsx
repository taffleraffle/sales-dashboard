import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FileText, Plus, Loader, AlertCircle } from 'lucide-react'
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
  const [contracts, setContracts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

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
            Tracked <em style={{ fontStyle: 'italic' }}>contracts</em>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
            Sent contracts you're tracking for amendment management. Continue creating new contracts in PandaDoc — add them here when a client asks to amend.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Link to="/sales/contracts/pending" className="editorial-btn-ghost">
                Pending approvals
              </Link>
              <Link to="/sales/contracts/policy" className="editorial-btn-ghost">
                Policy
              </Link>
            </>
          )}
          <Link to="/sales/contracts/add" className="editorial-btn-primary">
            <Plus size={ICON.sm} />
            Add contract
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
            No contracts tracked yet
          </h2>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, maxWidth: 460 }}>
            When a client asks to amend a contract you've already sent, drop the signed PDF here so the AI judge has context. The judge then handles each amendment request against your active policy.
          </p>
          <Link to="/sales/contracts/add" className="editorial-btn-primary" style={{ marginTop: 20 }}>
            <Plus size={ICON.sm} />
            Add first contract
          </Link>
        </div>
      )}

      {!loading && !error && contracts.length > 0 && (
        <div className="tile tile-feedback p-0 overflow-hidden">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Client</th>
                <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Template</th>
                <th className="text-left px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Status</th>
                <th className="text-right px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Fee</th>
                <th className="text-right px-4 py-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600 }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td className="px-4 py-3">
                    <Link to={`/sales/contracts/${c.id}`} style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500, textDecoration: 'none' }}>
                      {c.client_name}
                      {c.version > 1 && (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginLeft: 8 }}>v{c.version}</span>
                      )}
                    </Link>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
