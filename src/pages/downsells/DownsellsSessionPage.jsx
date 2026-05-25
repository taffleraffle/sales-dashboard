// /sales/downsells/:threadId — single coaching session view. Loads the
// thread + its parent contract for context, renders the chat thread
// using the shared CoachThread component.

import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'
import { CoachThread } from './CoachThread'

export default function DownsellsSessionPage() {
  const { id } = useParams()
  const [thread, setThread]     = useState(null)
  const [contract, setContract] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data: t, error: tErr } = await supabase
        .from('contract_downsell_threads')
        .select('*, contracts(id, client_name, client_company, fee_amount_usd, project_period_days, contract_type)')
        .eq('id', id)
        .maybeSingle()
      if (cancelled) return
      if (tErr) { setError(tErr.message); setLoading(false); return }
      if (!t) { setError('Coaching session not found'); setLoading(false); return }
      setThread(t)
      setContract(t.contracts || null)

      const { data: msgs, error: mErr } = await supabase
        .from('contract_downsell_messages')
        .select('*')
        .eq('thread_id', id)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (mErr) { setError(`Failed to load messages: ${mErr.message}`); setLoading(false); return }
      setMessages(msgs || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id])

  async function refresh() {
    const [{ data: t }, { data: msgs }] = await Promise.all([
      supabase.from('contract_downsell_threads').select('*, contracts(id, client_name, client_company, fee_amount_usd, project_period_days, contract_type)').eq('id', id).maybeSingle(),
      supabase.from('contract_downsell_messages').select('*').eq('thread_id', id).order('created_at', { ascending: true }),
    ])
    if (t) { setThread(t); setContract(t.contracts || null) }
    if (msgs) setMessages(msgs)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-[800px] mx-auto">
        <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
          <ArrowLeft size={ICON.sm} /> All sessions
        </Link>
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{error}</p>
        </div>
      </div>
    )
  }

  const feeLabel = contract?.fee_amount_usd ? `$${Number(contract.fee_amount_usd).toLocaleString()}` : null
  const periodLabel = contract?.project_period_days ? `${contract.project_period_days} days` : null

  return (
    <div className="max-w-[900px] mx-auto">
      <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All sessions
      </Link>

      {/* Compact contract-context header */}
      <div className="tile tile-feedback p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="eyebrow eyebrow-accent">Coaching for</span>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', margin: '4px 0 0' }}>
              {contract?.client_name || 'Unknown client'}
            </h1>
            {contract?.client_company && (
              <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '4px 0 0' }}>{contract.client_company}</p>
            )}
          </div>
          {feeLabel && (
            <div className="text-right flex-shrink-0">
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                Current fee
              </span>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--ink)', margin: '4px 0 0' }}>
                {feeLabel}
              </p>
              {periodLabel && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                  over {periodLabel}
                </span>
              )}
            </div>
          )}
        </div>
        {contract && (
          <div className="mt-3 pt-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--rule)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              {contract.contract_type === 'retainer' ? 'Retainer template' : 'Trial template'}
            </span>
            <Link to={`/sales/contracts/${contract.id}`} style={{ fontSize: 12, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FileText size={11} /> Open contract
            </Link>
          </div>
        )}
      </div>

      {/* Opening context that kicked off the session */}
      {thread?.opening_context && (
        <div className="mb-5">
          <span className="eyebrow eyebrow-bare" style={{ marginBottom: 6, display: 'inline-block' }}>Opening context</span>
          <div className="tile tile-feedback p-4" style={{ borderLeft: '3px solid var(--accent)' }}>
            <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {thread.opening_context}
            </p>
          </div>
        </div>
      )}

      {/* The chat thread itself */}
      <CoachThread thread={thread} messages={messages} onChange={refresh} />
    </div>
  )
}
