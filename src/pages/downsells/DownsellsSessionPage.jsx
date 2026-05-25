// /sales/downsells/:id — single coaching session.
// Two-pane workspace: chat on the left, client context + offer summary
// + cost reference on the right. Matches the contract page's editorial
// design system — same paper-cream background, same typography
// hierarchy, same yellow accent treatment, same sticky workspace grid.

import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, DollarSign, Calculator, TrendingDown, Flag, Lock } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'
import { CoachThread } from './CoachThread'

export default function DownsellsSessionPage() {
  const { id } = useParams()
  const [thread, setThread]     = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data: t, error: tErr } = await supabase
        .from('contract_downsell_threads')
        .select('*, contracts(client_name, client_company, fee_amount_usd, project_period_days, contract_type)')
        .eq('id', id)
        .maybeSingle()
      if (cancelled) return
      if (tErr) { setError(tErr.message); setLoading(false); return }
      if (!t) { setError('Session not found'); setLoading(false); return }
      setThread(t)

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
      supabase.from('contract_downsell_threads').select('*, contracts(client_name, client_company, fee_amount_usd, project_period_days, contract_type)').eq('id', id).maybeSingle(),
      supabase.from('contract_downsell_messages').select('*').eq('thread_id', id).order('created_at', { ascending: true }),
    ])
    if (t) setThread(t)
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
      <div className="max-w-[720px] mx-auto">
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

  const clientName    = thread.client_name    || thread.contracts?.client_name    || 'Unknown'
  const clientCompany = thread.client_company || thread.contracts?.client_company || null
  const isLocked = !!thread.locked_at

  return (
    <div className="max-w-[1640px] mx-auto px-2">
      <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All sessions
      </Link>

      {/* Session header — full width above the workspace, matches the
          contract detail page's compact header treatment */}
      <div className="tile tile-feedback p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="eyebrow eyebrow-accent">
              OPT Digital · Downsell chat
            </span>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', margin: '4px 0 0', lineHeight: 1.1 }}>
              {clientName}
            </h1>
            {clientCompany && (
              <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '2px 0 0' }}>{clientCompany}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isLocked && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', padding: '4px 10px', border: '1px solid var(--rule)', borderRadius: 2 }}>
                <Lock size={11} /> Locked
              </span>
            )}
            {thread.admin_review_requested && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--down)', padding: '4px 10px', border: '1px solid var(--down)', borderRadius: 2 }}>
                <Flag size={11} /> Needs Ben
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-6 mt-4 pt-3" style={{ borderTop: '1px solid var(--rule)', fontFamily: 'var(--mono)', fontSize: 12, flexWrap: 'wrap' }}>
          {thread.contracts?.fee_amount_usd && (
            <span><span style={{ color: 'var(--ink-3)' }}>Current fee</span> <span style={{ color: 'var(--ink)', marginLeft: 6 }}>${Number(thread.contracts.fee_amount_usd).toLocaleString()}</span></span>
          )}
          {thread.contracts?.project_period_days && (
            <span><span style={{ color: 'var(--ink-3)' }}>Period</span> <span style={{ color: 'var(--ink)', marginLeft: 6 }}>{thread.contracts.project_period_days} days</span></span>
          )}
          {thread.contracts?.contract_type && (
            <span><span style={{ color: 'var(--ink-3)' }}>Template</span> <span style={{ color: 'var(--ink)', marginLeft: 6, textTransform: 'capitalize' }}>{thread.contracts.contract_type}</span></span>
          )}
          <span><span style={{ color: 'var(--ink-3)' }}>Opened</span> <span style={{ color: 'var(--ink)', marginLeft: 6 }}>{new Date(thread.created_at).toLocaleDateString()}</span></span>
        </div>
      </div>

      {/* Two-pane workspace using the same grid as ContractDetail */}
      <div className="contract-workspace">
        <div className="contract-workspace-chat">
          <CoachThread thread={thread} messages={messages} onChange={refresh} />
        </div>
        <div className="contract-workspace-preview">
          <SessionContextPane thread={thread} messages={messages} />
        </div>
      </div>
    </div>
  )
}

// SessionContextPane — right side of the downsell workspace. Surfaces
// the things a closer needs at a glance while chatting: the opening
// context that kicked off the session, the latest extracted offer (if
// the coach has named one), and a quick-reference card with the cost
// floors so the closer can sanity-check what the coach proposes.
function SessionContextPane({ thread, messages }) {
  // Try to pull the latest "offer" line from the coach's most recent
  // reply by scanning for numbered options or dollar amounts. This is a
  // light surface — the canonical conversation is the chat itself.
  const latestCoachReply = useMemo(() => {
    return [...messages].reverse().find(m => m.role === 'coach')?.content || ''
  }, [messages])

  const numberedOptions = useMemo(() => extractNumberedOptions(latestCoachReply), [latestCoachReply])

  return (
    <div className="tile tile-feedback" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      {/* Header strip */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
        <span className="eyebrow eyebrow-bare" style={{ fontSize: 10 }}>Coaching context</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        {/* Opening context — sticky reference of what kicked this off */}
        <section style={{ marginBottom: 18 }}>
          <h3 style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 8px' }}>
            Opening situation
          </h3>
          <div className="tile tile-feedback p-3" style={{ borderLeft: '3px solid var(--accent)' }}>
            <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {thread.opening_context || <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>No opening context recorded.</span>}
            </p>
          </div>
        </section>

        {/* Latest coach options — extracted from the most recent reply */}
        {numberedOptions.length > 0 && (
          <section style={{ marginBottom: 18 }}>
            <h3 style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <DollarSign size={11} /> Latest options on the table
            </h3>
            <div className="space-y-2">
              {numberedOptions.map((opt, i) => (
                <div key={i} className="tile tile-feedback p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
                  <p style={{ fontSize: 12.5, color: 'var(--ink)', margin: 0, lineHeight: 1.5 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', marginRight: 6 }}>{opt.label}</span>
                    {opt.text}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Quick reference: floors + cost data for sanity check */}
        <section style={{ marginBottom: 6 }}>
          <h3 style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Calculator size={11} /> Margin reference (internal)
          </h3>
          <div className="tile tile-feedback p-3" style={{ background: 'var(--paper-2)' }}>
            <dl style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.7 }}>
              <Ref label="Monthly minimum" value="$1,500/mo (hard floor)" />
              <Ref label="Admin-review band" value="$1,500–$1,700/mo" />
              <Ref label="Margin floor" value="25% gross" />
              <Ref label="Margin aim" value="50% gross" />
              <Ref label="Baseline COGS" value="$1,018/mo" />
              <Ref label="Trim lever" value="–$150/mo (drop links)" />
              <Ref label="Finance fee" value="15% via external" />
              <Ref label="Hosting (mandatory on churn)" value="$50/mo or $489/yr" />
            </dl>
            <p style={{ margin: '8px 0 0', fontSize: 10, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              Do not show this card to the client. Margin math is for internal coaching context only.
            </p>
          </div>
        </section>

        {thread.locked_at && (
          <div style={{ marginTop: 18, padding: '10px 12px', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
            <Lock size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            Session locked {new Date(thread.locked_at).toLocaleDateString()} — chat is closed.
          </div>
        )}
      </div>
    </div>
  )
}

function Ref({ label, value }) {
  return (
    <>
      <dt style={{ display: 'inline', color: 'var(--ink-3)' }}>{label}</dt>
      <dd style={{ display: 'inline', color: 'var(--ink)', marginLeft: 6, marginRight: 0 }}>{value}</dd>
      <br />
    </>
  )
}

// Pull numbered "1. … 2. … 3. …" options out of a coach reply so we can
// surface them in the right pane without the closer having to re-read
// the whole reply. Best-effort: if the regex doesn't match the coach's
// formatting, this returns []. The chat thread is still the source of
// truth either way.
function extractNumberedOptions(text) {
  if (!text) return []
  const pattern = /^(\d+)[.)]\s+(.+?)(?=\n\s*\d+[.)]\s+|\n\s*\n|$)/gms
  const out = []
  let m
  while ((m = pattern.exec(text)) !== null) {
    const body = m[2].trim().replace(/\s+/g, ' ')
    if (body.length > 0 && body.length < 400) {
      out.push({ label: `Option ${m[1]}`, text: body })
    }
  }
  return out
}
