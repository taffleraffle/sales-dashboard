import { useState, useEffect, useRef } from 'react'
import {
  Loader, AlertCircle, Send, Plus, Lock, TrendingDown, DollarSign, Flag,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// DownsellCoach
// ---------------
// A self-contained panel that lives at the bottom of ContractDetail.jsx and
// gives the closer a conversational coach (Claude) for downsell / churn-save
// negotiations on this contract. Mirrors the AmendmentThread UX deliberately
// so the page reads consistently, but the data model + Edge function are
// separate: contract_downsell_threads + contract_downsell_messages, fed by
// the contract-downsell-coach Edge function and the 'downsell' policy doc.

const STATUS_STYLES = {
  discovering:     { label: 'Discovering',     color: 'var(--ink-3)' },
  proposed_offer:  { label: 'Offer on table',  color: 'var(--accent)' },
  hard_floor_hit:  { label: 'Floor hit',       color: 'var(--down)' },
  needs_admin:     { label: 'Needs Ben',       color: 'var(--down)' },
  ready_to_lock:   { label: 'Ready to lock',   color: 'var(--up)' },
}

export default function DownsellCoach({ contractId, contract }) {
  const { profile } = useAuth()
  const [threads, setThreads] = useState([])
  const [messagesByThread, setMessagesByThread] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  // start-new-thread form
  const [opener, setOpener] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data: ts, error: tErr } = await supabase
        .from('contract_downsell_threads')
        .select('*')
        .eq('contract_id', contractId)
        .order('created_at', { ascending: false })
      if (cancelled) return
      if (tErr) { setError(tErr.message); setLoading(false); return }
      setThreads(ts || [])

      if (ts?.length) {
        const ids = ts.map(t => t.id)
        const { data: msgs, error: mErr } = await supabase
          .from('contract_downsell_messages')
          .select('*')
          .in('thread_id', ids)
          .order('created_at', { ascending: true })
        if (cancelled) return
        if (mErr) { setError(`Failed to load coach threads: ${mErr.message}`); setLoading(false); return }
        if (msgs) {
          const grouped = msgs.reduce((acc, m) => {
            (acc[m.thread_id] ||= []).push(m)
            return acc
          }, {})
          setMessagesByThread(grouped)
        }
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [contractId])

  async function refreshThread(threadId) {
    const [{ data: tData }, { data: msgs }] = await Promise.all([
      supabase.from('contract_downsell_threads').select('*').eq('id', threadId).maybeSingle(),
      supabase.from('contract_downsell_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true }),
    ])
    if (tData) setThreads(prev => prev.map(t => t.id === threadId ? tData : t))
    if (msgs) setMessagesByThread(prev => ({ ...prev, [threadId]: msgs }))
  }

  async function startThread(e) {
    e.preventDefault()
    if (!opener.trim()) return
    setCreating(true); setCreateErr(null)
    const { data: inserted, error: insertErr } = await supabase
      .from('contract_downsell_threads')
      .insert({
        contract_id: contractId,
        closer_id: profile?.teamMemberId || null,
        opening_context: opener.trim(),
        status: 'open',
      })
      .select()
      .single()
    if (insertErr) {
      setCreating(false)
      setCreateErr(insertErr.message)
      return
    }
    setThreads(prev => [inserted, ...prev])
    setOpener('')

    try {
      const { data, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: inserted.id },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await refreshThread(inserted.id)
    } catch (err) {
      setCreateErr(`Created, but coach failed: ${err.message || err}. Reload to retry.`)
    } finally {
      setCreating(false)
    }
  }

  // Anchor numbers — the closer should see the current contract fee while
  // talking through downsell options so the conversation has a starting
  // reference. Pulled from the contract row passed in from ContractDetail.
  const currentFeeLabel = contract?.fee_amount_usd
    ? `$${Number(contract.fee_amount_usd).toLocaleString()}`
    : null
  const currentPeriodLabel = contract?.project_period_days
    ? `${contract.project_period_days} days`
    : null

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-4 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-3">
          <TrendingDown size={18} style={{ color: 'var(--accent)' }} />
          <div>
            <span className="eyebrow eyebrow-accent">OPT Digital · Downsell options</span>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)', margin: '4px 0 0' }}>
              Save the <em style={{ fontStyle: 'italic' }}>deal</em>
            </h2>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, maxWidth: 640 }}>
              Talk through a downsell or churn-save. The coach reads your downsell policy + this contract's context and helps you land an offer that clears margin and meets the client.
            </p>
          </div>
        </div>
        {currentFeeLabel && (
          <div className="flex-shrink-0 text-right">
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              Current fee
            </span>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--ink)', margin: '4px 0 0' }}>
              {currentFeeLabel}
            </p>
            {currentPeriodLabel && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                over {currentPeriodLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader className="animate-spin" size={20} style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {error && (
        <div className="tile tile-feedback p-4 flex items-start gap-3 mb-4" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0 }}>{error}</p>
        </div>
      )}

      {!loading && !error && threads.length === 0 && (
        <div className="tile tile-feedback p-6 text-center mb-6">
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
            No coaching sessions on this contract yet. Open one below when a client wants to pause, downsell, or churn.
          </p>
        </div>
      )}

      {threads.map(t => (
        <CoachThread
          key={t.id}
          thread={t}
          messages={messagesByThread[t.id] || []}
          onChange={() => refreshThread(t.id)}
        />
      ))}

      {/* Start a new coaching session */}
      <div className="tile tile-feedback p-6">
        <span className="eyebrow eyebrow-bare">Open a coaching session</span>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 16px' }}>
          Set the scene — what is the client asking for, and what triggered it? The more the coach knows up front, the fewer discovery turns it needs.
        </p>
        <form onSubmit={startThread} className="space-y-3">
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>What's the situation</label>
            <textarea
              value={opener}
              onChange={e => setOpener(e.target.value)}
              placeholder={`e.g. Client said cash flow is tight this month and asked if we can pause the retainer for 30 days. They're 6 weeks into the 90-day. Website is launched, GBP rankings are climbing.`}
              rows={4}
              className="editorial-input w-full mt-1"
              style={{ resize: 'vertical' }}
              required
            />
          </div>
          {createErr && (
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{createErr}</p>
          )}
          <div className="flex items-center justify-end">
            <button type="submit" disabled={creating || !opener.trim()} className="editorial-btn-primary">
              {creating ? <><Loader size={ICON.sm} className="animate-spin" /> Coaching…</> : <><Plus size={ICON.sm} /> Open session</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── One coaching thread ──────────────────────────────────────────────────
function CoachThread({ thread, messages, onChange }) {
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState(null)
  const [locking, setLocking]     = useState(false)
  const [flagging, setFlagging]   = useState(false)
  const [retrying, setRetrying]   = useState(false)
  const [retryErr, setRetryErr]   = useState(null)
  const threadEndRef = useRef(null)
  const prevLengthRef = useRef(messages.length)

  // Initial-coach-call failed during startThread, OR the only message in
  // the thread is the closer's opening: there's no coach reply yet but
  // the thread row exists. Surface a "Retry coach" button instead of
  // leaving the closer stuck on a "Waiting for first response…" message
  // with no recovery path.
  const isAwaitingFirstCoach = !thread.locked_at
    && (messages.length === 0
        || (messages.length === 1 && messages[0].role === 'closer'))

  // Latest status_signal in the thread (coach can shift turn-by-turn)
  const lastStatusSignal = [...messages].reverse()
    .find(m => m.role === 'coach' && m.metadata?.status_signal)?.metadata?.status_signal

  const isLocked = !!thread.locked_at
  const canLock = !isLocked && (lastStatusSignal === 'ready_to_lock' || lastStatusSignal === 'proposed_offer')

  useEffect(() => {
    // Only scroll on new messages, not on mount — same rule as the
    // amendment thread to avoid yanking the page to the bottom of older
    // threads when a contract loads.
    if (messages.length > prevLengthRef.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevLengthRef.current = messages.length
  }, [messages.length])

  async function retryCoach() {
    if (retrying) return
    setRetrying(true); setRetryErr(null)
    try {
      const { data, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: thread.id },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await onChange()
    } catch (err) {
      setRetryErr(err.message || String(err))
    } finally {
      setRetrying(false)
    }
  }

  async function sendReply(e) {
    e?.preventDefault()
    if (!replyText.trim() || sending) return
    setSending(true); setSendErr(null)
    const message = replyText.trim()
    setReplyText('')
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: thread.id, new_message: message },
      })
      if (invokeErr) throw invokeErr
      if (data?.error) throw new Error(data.error)
      await onChange()
    } catch (err) {
      setSendErr(err.message || String(err))
      setReplyText(message) // restore so closer doesn't lose their text
    } finally {
      setSending(false)
    }
  }

  async function lockIn() {
    if (!confirm('Lock in this downsell offer? You can still see the recommendation, but the thread closes to new messages.')) return
    setLocking(true)
    const { data: updated, error: lockErr } = await supabase
      .from('contract_downsell_threads')
      .update({
        locked_at: new Date().toISOString(),
        status: 'locked',
      })
      .eq('id', thread.id)
      .is('locked_at', null)
      .select()
    setLocking(false)
    if (lockErr) { alert(`Lock failed: ${lockErr.message}`); return }
    if (!updated || updated.length === 0) {
      alert('Lock failed silently — your account may not have permission yet, or another tab already locked this thread. Refresh to see latest state.')
      await onChange()
      return
    }
    await onChange()
  }

  async function flagForAdmin() {
    if (thread.admin_review_requested) return
    setFlagging(true)
    const { error: flagErr } = await supabase
      .from('contract_downsell_threads')
      .update({ admin_review_requested: true })
      .eq('id', thread.id)
    setFlagging(false)
    if (flagErr) { alert(`Flag failed: ${flagErr.message}`); return }
    await onChange()
  }

  return (
    <div className="tile tile-feedback p-6 mb-6">
      {/* Slim header — clause-ref equivalent here is the open date + status */}
      <div className="flex items-center justify-between gap-3 mb-4 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <TrendingDown size={14} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            Coaching session · {new Date(thread.created_at).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {thread.admin_review_requested && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--down)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Flag size={10} /> Ben flagged
            </span>
          )}
          {isLocked && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Lock size={10} /> Locked
            </span>
          )}
          {lastStatusSignal && STATUS_STYLES[lastStatusSignal] && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: STATUS_STYLES[lastStatusSignal].color }}>
              {STATUS_STYLES[lastStatusSignal].label}
            </span>
          )}
        </div>
      </div>

      {/* Snapshot of the latest recommended offer (lives on the thread row,
          updated each turn the coach attaches a proposed_offer) */}
      {(thread.recommended_summary || thread.monthly_value_usd != null || thread.upfront_value_usd != null) && (
        <OfferSnapshot thread={thread} />
      )}

      {/* Message thread */}
      <div className="space-y-3 mb-4">
        {messages.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            Opening context saved. The coach hasn't replied yet — hit "Retry coach" below to kick it off.
          </p>
        )}
        {messages.map(m => <CoachMessageBubble key={m.id} message={m} />)}
        <div ref={threadEndRef} />
      </div>

      {/* Retry coach — for threads where the initial coach call failed or
          the closer sent the opening message but no coach reply landed yet.
          Without this, the thread is stranded with no recovery path
          (the policy not being seeded is the most common cause: 412). */}
      {isAwaitingFirstCoach && (
        <div className="mb-4 p-3 flex items-center justify-between gap-3" style={{ background: 'var(--paper-2)', border: '1px dashed var(--rule)', borderRadius: 3 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            {retryErr
              ? <span style={{ color: 'var(--down)', fontFamily: 'var(--mono)' }}>{retryErr}</span>
              : 'No coach reply yet. Usually means the downsell policy isn\'t seeded, or the first call failed.'}
          </span>
          <button
            type="button"
            onClick={retryCoach}
            disabled={retrying}
            className="editorial-btn-ghost"
            style={{ flexShrink: 0 }}
          >
            {retrying ? <><Loader size={ICON.sm} className="animate-spin" /> Retrying…</> : <><Send size={ICON.sm} /> Retry coach</>}
          </button>
        </div>
      )}

      {/* Reply form */}
      {!isLocked && (
        <form onSubmit={sendReply} className="pt-3" style={{ borderTop: '1px solid var(--rule)' }}>
          <div className="flex items-end gap-2">
            <textarea
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  sendReply()
                }
              }}
              placeholder="Reply to the coach — confirm the why, push back on the offer, ask for a counter…"
              rows={2}
              className="editorial-input flex-1"
              style={{ resize: 'vertical' }}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !replyText.trim()} className="editorial-btn-primary" style={{ flexShrink: 0 }}>
              {sending ? <><Loader size={ICON.sm} className="animate-spin" /> Thinking…</> : <><Send size={ICON.sm} /> Send</>}
            </button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span style={{ fontSize: 10, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              {sendErr ? <span style={{ color: 'var(--down)', fontFamily: 'var(--mono)' }}>{sendErr}</span> : 'Cmd/Ctrl + Enter to send'}
            </span>
            <div className="flex items-center gap-2">
              {!thread.admin_review_requested && (
                <button
                  type="button"
                  onClick={flagForAdmin}
                  disabled={flagging}
                  className="editorial-btn-ghost"
                  title="Mark this session for Ben's attention"
                >
                  {flagging ? <Loader size={ICON.sm} className="animate-spin" /> : <Flag size={ICON.sm} />}
                  Flag for Ben
                </button>
              )}
              {canLock && (
                <button
                  type="button"
                  onClick={lockIn}
                  disabled={locking}
                  className="editorial-btn-ghost"
                  style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
                  title="Freeze this thread — captures the final recommendation"
                >
                  {locking ? <><Loader size={ICON.sm} className="animate-spin" /> Locking…</> : <><Lock size={ICON.sm} /> Lock in offer</>}
                </button>
              )}
            </div>
          </div>
        </form>
      )}

      {isLocked && (
        <div className="mt-3 p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Lock size={10} /> Locked {thread.locked_at ? `· ${new Date(thread.locked_at).toLocaleString()}` : ''}
          </span>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '8px 0 0', fontStyle: 'italic' }}>
            Snapshot above captures the final recommendation. Apply it in PandaDoc / billing as the next step.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── At-a-glance offer snapshot (top of each thread) ──────────────────────
function OfferSnapshot({ thread }) {
  const hasHosting = thread.hosting_plan && thread.hosting_plan !== 'none'
  const hostingLabel = thread.hosting_plan === 'annual' ? 'Annual ($489/yr)'
                     : thread.hosting_plan === 'monthly' ? 'Monthly ($50/mo)'
                     : thread.hosting_plan === 'none' ? 'No hosting'
                     : null

  return (
    <div className="mb-4 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
      <div className="flex items-center gap-2 mb-2">
        <DollarSign size={12} style={{ color: 'var(--accent)' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          Latest recommendation
        </span>
      </div>
      {thread.recommended_summary && (
        <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)', margin: '0 0 8px', lineHeight: 1.4 }}>
          {thread.recommended_summary}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)' }}>
        {thread.monthly_value_usd != null && Number(thread.monthly_value_usd) > 0 && (
          <span>Monthly: ${Number(thread.monthly_value_usd).toLocaleString()}</span>
        )}
        {thread.upfront_value_usd != null && Number(thread.upfront_value_usd) > 0 && (
          <span>Upfront: ${Number(thread.upfront_value_usd).toLocaleString()}</span>
        )}
        {hasHosting && hostingLabel && <span>Hosting: {hostingLabel}</span>}
        {thread.payment_structure && <span>Pay: {thread.payment_structure}</span>}
        {thread.asset_handover_required === true && (
          <span style={{ color: 'var(--down)' }}>Asset handover required</span>
        )}
      </div>
    </div>
  )
}

// ─── Single chat bubble (coach + closer) ──────────────────────────────────
function CoachMessageBubble({ message }) {
  const isCloser = message.role === 'closer'
  const md = message.metadata || {}
  const blocks = isCloser ? [message.content] : formatCoachContent(message.content)

  return (
    <div className="flex" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
      <div style={{ maxWidth: '85%' }}>
        <div className="flex items-baseline gap-2 mb-1" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {isCloser ? 'Closer' : 'Coach'}
            {md.status_signal && !isCloser && STATUS_STYLES[md.status_signal] && (
              <span style={{ color: STATUS_STYLES[md.status_signal].color, marginLeft: 6 }}>
                · {STATUS_STYLES[md.status_signal].label}
              </span>
            )}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)' }}>
            {new Date(message.created_at).toLocaleString()}
          </span>
        </div>
        <div className="p-3" style={{
          background: isCloser ? 'var(--ink)' : 'var(--paper)',
          color: isCloser ? 'var(--paper)' : 'var(--ink)',
          border: isCloser ? '1px solid var(--ink)' : '1px solid var(--rule)',
          borderRadius: 3,
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}>
          {blocks.map((b, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{b}</p>
          ))}
        </div>
        {!isCloser && md.proposed_offer && (
          <ProposedOfferPanel offer={md.proposed_offer} />
        )}
      </div>
    </div>
  )
}

// Per-turn proposed_offer block — visible inline under the coach bubble so
// the closer can see the structured recommendation that landed THIS turn,
// not just the latest snapshot at the top.
function ProposedOfferPanel({ offer }) {
  const lines = []
  if (offer.summary)                            lines.push(['Summary', offer.summary])
  if (offer.monthly_value_usd != null)          lines.push(['Monthly', `$${Number(offer.monthly_value_usd).toLocaleString()}`])
  if (offer.upfront_value_usd != null)          lines.push(['Upfront', `$${Number(offer.upfront_value_usd).toLocaleString()}`])
  if (offer.hosting_plan)                       lines.push(['Hosting', offer.hosting_plan])
  if (offer.payment_structure)                  lines.push(['Payment', offer.payment_structure])
  if (offer.asset_handover_required != null)    lines.push(['Asset handover', offer.asset_handover_required ? 'required' : 'no'])

  return (
    <div className="mt-2 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        Proposed offer (this turn)
      </span>
      <table style={{ width: '100%', marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', borderCollapse: 'collapse' }}>
        <tbody>
          {lines.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: '2px 8px 2px 0', color: 'var(--ink-3)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
              <td style={{ padding: '2px 0' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Mirrors formatJudgeContent in ContractDetail.jsx: strip markdown the
// prompt forbade but Claude might still emit, force paragraph breaks
// around numbered list items.
function formatCoachContent(raw) {
  if (!raw) return []
  let txt = String(raw)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?\S?)\*/g, '$1$2')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '- ')
  txt = txt.replace(/([.?!])\s+(\(?\d+\)?[.:)]\s+|Ask\s+\d+:|Option\s+[A-Z]:)/g, '$1\n\n$2')
  return txt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
}
