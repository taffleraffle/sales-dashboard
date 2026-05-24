import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader, Check, X, AlertCircle, MessageSquare } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// Admin queue: amendments the AI judge tagged 'review' or 'reject' that need
// Ben's call before they can be applied (or denied).
export default function ContractsPending() {
  const { isAdmin } = useAuth()
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [acting, setActing]   = useState(null)  // amendment id currently being decided
  const [notesById, setNotesById] = useState({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data, error } = await supabase
        .from('contract_amendments')
        .select('*, contracts(client_name, client_company)')
        .in('status', ['pending','judged'])
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (error) setError(error.message)
      else setItems(data || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function decide(amendment, decision) {
    setActing(amendment.id); setError(null)
    const { error } = await supabase
      .from('contract_amendments')
      .update({
        ben_decision: decision,
        ben_notes: notesById[amendment.id] || null,
        decided_at: new Date().toISOString(),
        status: decision === 'approve' ? 'approved' : 'rejected',
      })
      .eq('id', amendment.id)
    setActing(null)
    if (error) { setError(error.message); return }
    setItems(prev => prev.filter(i => i.id !== amendment.id))
    // TODO: if approved, trigger contract-apply-amendment Edge Function
  }

  if (!isAdmin) {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center">
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>Admin only.</p>
      </div>
    )
  }

  return (
    <div className="max-w-[1000px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · Pending</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Awaiting <em style={{ fontStyle: 'italic' }}>your call</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 640 }}>
          Amendments the judge couldn't auto-decide. Either approve to apply (regenerates a new versioned PandaDoc),
          or reject with a note back to the closer.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {error && (
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0 }}>{error}</p>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="tile tile-feedback flex flex-col items-center justify-center py-12 px-6 text-center">
          <Check size={28} style={{ color: 'var(--up)', marginBottom: 10 }} />
          <p style={{ fontSize: 14, color: 'var(--ink)', margin: 0 }}>Inbox zero.</p>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>Closers haven't escalated anything yet.</p>
        </div>
      )}

      <div className="space-y-4">
        {items.map(a => (
          <div key={a.id} className="tile tile-feedback p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Link to={`/sales/contracts/${a.contract_id}`} style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink)' }}>
                  {a.contracts?.client_name || 'Unknown client'}
                </Link>
                {a.clause_reference && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginLeft: 8 }}>
                    {a.clause_reference}
                  </span>
                )}
              </div>
              {a.ai_verdict && (
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: a.ai_verdict === 'reject' ? 'var(--down)' : 'var(--accent)',
                  flexShrink: 0,
                }}>
                  Judge: {a.ai_verdict}
                </span>
              )}
            </div>

            <div className="mt-3 p-3" style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                Closer's request
              </span>
              <p style={{ fontSize: 13, color: 'var(--ink)', margin: '4px 0 0' }}>{a.requested_change}</p>
            </div>

            {a.ai_reasoning && (
              <div className="mt-3 p-3" style={{ background: 'var(--paper-2)', borderLeft: '3px solid var(--accent)', borderRadius: 3 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  Judge reasoning
                </span>
                <p style={{ fontSize: 13, color: 'var(--ink)', margin: '4px 0 0', fontStyle: 'italic' }}>{a.ai_reasoning}</p>
              </div>
            )}

            <div className="mt-3">
              <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <MessageSquare size={11} /> Note to closer (optional)
              </label>
              <textarea
                value={notesById[a.id] || ''}
                onChange={e => setNotesById(prev => ({ ...prev, [a.id]: e.target.value }))}
                placeholder="Why you're approving or rejecting. This goes back to the closer."
                rows={2}
                className="w-full mt-1 px-3 py-2"
                style={{ fontSize: 13, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, color: 'var(--ink)', resize: 'vertical' }}
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => decide(a, 'reject')}
                disabled={acting === a.id}
                className="editorial-btn-ghost"
                style={{ color: 'var(--down)' }}
              >
                {acting === a.id ? <Loader size={ICON.sm} className="animate-spin" /> : <X size={ICON.sm} />}
                Reject
              </button>
              <button
                onClick={() => decide(a, 'approve')}
                disabled={acting === a.id}
                className="editorial-btn-primary"
              >
                {acting === a.id ? <Loader size={ICON.sm} className="animate-spin" /> : <Check size={ICON.sm} />}
                Approve & apply
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
