import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Loader, AlertCircle, ExternalLink, Send, Copy, FileText,
  Lock, MessageCircle, Plus,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

const VERDICT_STYLES = {
  allow:  { label: 'Approvable',  color: 'var(--up)' },
  review: { label: 'Needs Ben',   color: 'var(--accent)' },
  reject: { label: 'Blocked',     color: 'var(--down)' },
}

export default function ContractDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const [contract, setContract]     = useState(null)
  const [amendments, setAmendments] = useState([])
  const [messagesByAmendment, setMessagesByAmendment] = useState({})
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  // form: start a new amendment thread
  const [newRequest, setNewRequest] = useState('')
  const [newClauseRef, setNewClauseRef] = useState('')
  const [creatingNew, setCreatingNew]   = useState(false)
  const [newErr, setNewErr]             = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const [c, a] = await Promise.all([
        supabase.from('contracts').select('*').eq('id', id).maybeSingle(),
        supabase.from('contract_amendments').select('*').eq('contract_id', id).order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      if (c.error) { setError(c.error.message); setLoading(false); return }
      if (!c.data) { setError('Contract not found'); setLoading(false); return }
      if (a.error) { setError(a.error.message); setLoading(false); return }
      setContract(c.data)
      setAmendments(a.data || [])

      // Fetch all messages for all amendments in one round-trip
      if (a.data?.length) {
        const ids = a.data.map(x => x.id)
        const { data: msgs } = await supabase
          .from('contract_amendment_messages')
          .select('*')
          .in('amendment_id', ids)
          .order('created_at', { ascending: true })
        if (!cancelled && msgs) {
          const grouped = msgs.reduce((acc, m) => {
            (acc[m.amendment_id] ||= []).push(m)
            return acc
          }, {})
          setMessagesByAmendment(grouped)
        }
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id])

  async function refreshAmendment(amendmentId) {
    const [{ data: amData }, { data: msgs }] = await Promise.all([
      supabase.from('contract_amendments').select('*').eq('id', amendmentId).maybeSingle(),
      supabase.from('contract_amendment_messages').select('*').eq('amendment_id', amendmentId).order('created_at', { ascending: true }),
    ])
    if (amData) {
      setAmendments(prev => prev.map(a => a.id === amendmentId ? amData : a))
    }
    if (msgs) {
      setMessagesByAmendment(prev => ({ ...prev, [amendmentId]: msgs }))
    }
  }

  async function startNewAmendment(e) {
    e.preventDefault()
    if (!newRequest.trim()) return
    setCreatingNew(true); setNewErr(null)
    const { data: inserted, error: insertErr } = await supabase
      .from('contract_amendments')
      .insert({
        contract_id: id,
        closer_id: profile?.teamMemberId || null,
        requested_change: newRequest.trim(),
        clause_reference: newClauseRef.trim() || null,
        status: 'pending',
      })
      .select()
      .single()
    if (insertErr) {
      setCreatingNew(false)
      setNewErr(insertErr.message)
      return
    }
    setAmendments(prev => [inserted, ...prev])
    setNewRequest(''); setNewClauseRef('')

    try {
      await supabase.functions.invoke('contract-judge-amendment', {
        body: { amendment_id: inserted.id },
      })
      await refreshAmendment(inserted.id)
    } catch (err) {
      setNewErr(`Submitted, but judge failed: ${err.message || err}.`)
    } finally {
      setCreatingNew(false)
    }
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
        <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
          <ArrowLeft size={ICON.sm} /> All reviews
        </Link>
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[900px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All reviews
      </Link>

      {/* Contract header */}
      <div className="tile tile-feedback p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="eyebrow eyebrow-accent">
              {contract.contract_type === 'retainer' ? 'Retainer template' : 'Trial template'}
            </span>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
              {contract.client_name}
            </h1>
            {contract.client_company && (
              <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: '4px 0 0' }}>{contract.client_company}</p>
            )}
          </div>
          <SignedPdfLink path={contract.agreement_pdf_path} />
        </div>
        <div className="grid grid-cols-3 gap-6 mt-6 pt-4" style={{ borderTop: '1px solid var(--rule)' }}>
          <Stat label="Fee" value={contract.fee_amount_usd ? `$${Number(contract.fee_amount_usd).toLocaleString()}` : '—'} />
          <Stat label="Period" value={contract.project_period_days ? `${contract.project_period_days} days` : '—'} />
          <div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>PandaDoc</span>
            <p style={{ margin: '4px 0 0' }}>
              {contract.pandadoc_view_url
                ? <a href={contract.pandadoc_view_url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Open document <ExternalLink size={12} />
                  </a>
                : <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)' }}>Not linked</span>}
            </p>
          </div>
        </div>
      </div>

      {/* Amendment threads */}
      {amendments.length === 0 && (
        <div className="tile tile-feedback p-6 text-center" style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
            No amendment threads on this contract yet. Open one below.
          </p>
        </div>
      )}

      {amendments.map(a => (
        <AmendmentThread
          key={a.id}
          amendment={a}
          messages={messagesByAmendment[a.id] || []}
          onChange={() => refreshAmendment(a.id)}
        />
      ))}

      {/* Start a new amendment thread */}
      <div className="tile tile-feedback p-6">
        <span className="eyebrow eyebrow-bare">Start a new amendment thread</span>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 16px' }}>
          For a different clause or a separate ask. Each thread gets its own back-and-forth with the judge.
        </p>
        <form onSubmit={startNewAmendment} className="space-y-3">
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>What the client wants changed</label>
            <textarea
              value={newRequest}
              onChange={e => setNewRequest(e.target.value)}
              placeholder="e.g. Client wants jurisdiction moved to Tennessee instead of New Zealand."
              rows={3}
              className="editorial-input w-full mt-1"
              style={{ resize: 'vertical' }}
              required
            />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Clause reference (optional)</label>
            <input
              type="text"
              value={newClauseRef}
              onChange={e => setNewClauseRef(e.target.value)}
              placeholder="e.g. Clause 19.1"
              className="editorial-input w-full mt-1"
            />
          </div>
          {newErr && (
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{newErr}</p>
          )}
          <div className="flex items-center justify-end">
            <button type="submit" disabled={creatingNew || !newRequest.trim()} className="editorial-btn-primary">
              {creatingNew ? <><Loader size={ICON.sm} className="animate-spin" /> Judging…</> : <><Plus size={ICON.sm} /> Start thread</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Amendment thread (chat) ──────────────────────────────────────────────
function AmendmentThread({ amendment, messages, onChange }) {
  const { profile } = useAuth()
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState(null)
  const [locking, setLocking]     = useState(false)
  const threadEndRef = useRef(null)

  // Latest verdict in the thread (judge messages can change it turn-by-turn)
  const lastJudgeVerdict = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.verdict)?.metadata?.verdict
    || amendment.ai_verdict

  // Latest proposed clause (most recent judge message that carried one)
  const lastProposedClause = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.proposed_clause)?.metadata?.proposed_clause
    || amendment.ai_proposed_redline

  const isLocked = !!amendment.locked_at
  const canLock = !isLocked && lastJudgeVerdict && lastJudgeVerdict !== 'reject'

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length])

  async function sendReply(e) {
    e?.preventDefault()
    if (!replyText.trim() || sending) return
    setSending(true); setSendErr(null)
    const message = replyText.trim()
    setReplyText('')
    try {
      const { error: invokeErr } = await supabase.functions.invoke('contract-judge-amendment', {
        body: { amendment_id: amendment.id, new_message: message },
      })
      if (invokeErr) throw invokeErr
      await onChange()
    } catch (err) {
      setSendErr(err.message || String(err))
      setReplyText(message) // restore so closer doesn't lose their text
    } finally {
      setSending(false)
    }
  }

  async function lockIn() {
    if (!confirm('Lock in this thread? You can\'t reply after this — but you can still regenerate the amended agreement.')) return
    setLocking(true)
    const finalClause = lastProposedClause || ''
    const { error: lockErr } = await supabase
      .from('contract_amendments')
      .update({
        locked_at: new Date().toISOString(),
        final_clause_text: finalClause,
        status: lastJudgeVerdict === 'allow' ? 'approved' : 'judged',
      })
      .eq('id', amendment.id)
    setLocking(false)
    if (lockErr) {
      alert(`Lock failed: ${lockErr.message}`)
      return
    }
    await onChange()
  }

  return (
    <div className="tile tile-feedback p-6 mb-6">
      <div className="flex items-start justify-between gap-3 mb-3 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="min-w-0 flex-1">
          {amendment.clause_reference && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {amendment.clause_reference}
            </span>
          )}
          <p style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)', margin: '2px 0 0', lineHeight: 1.3 }}>
            {amendment.requested_change}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isLocked && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Lock size={10} /> Locked
            </span>
          )}
          {lastJudgeVerdict && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: VERDICT_STYLES[lastJudgeVerdict]?.color }}>
              {VERDICT_STYLES[lastJudgeVerdict]?.label || lastJudgeVerdict}
            </span>
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className="space-y-3 mb-4">
        {messages.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            Waiting for the judge's first response…
          </p>
        )}
        {messages.map(m => <MessageBubble key={m.id} message={m} />)}
        <div ref={threadEndRef} />
      </div>

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
              placeholder="Reply to the judge — push back, ask for counter-options, propose alternative wording…"
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
            {canLock && (
              <button
                type="button"
                onClick={lockIn}
                disabled={locking}
                className="editorial-btn-ghost"
                style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
                title="Freeze this thread and trigger DOCX regeneration"
              >
                {locking ? <><Loader size={ICON.sm} className="animate-spin" /> Locking…</> : <><Lock size={ICON.sm} /> Lock in &amp; regenerate</>}
              </button>
            )}
          </div>
        </form>
      )}

      {isLocked && amendment.final_clause_text && (
        <div className="mt-3 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Locked-in clause language
          </span>
          <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
            {amendment.final_clause_text}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Single chat message bubble ────────────────────────────────────────────
function MessageBubble({ message }) {
  const isCloser = message.role === 'closer'
  const verdict  = message.metadata?.verdict
  const proposedClause = message.metadata?.proposed_clause

  return (
    <div className="flex" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
      <div style={{ maxWidth: '85%' }}>
        <div className="flex items-baseline gap-2 mb-1" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {isCloser ? 'Closer' : 'Judge'}
            {verdict && !isCloser && (
              <span style={{ color: VERDICT_STYLES[verdict]?.color, marginLeft: 6 }}>· {VERDICT_STYLES[verdict]?.label}</span>
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
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
        }}>
          {message.content}
        </div>
        {proposedClause && !isCloser && (
          <div className="mt-2 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
            <div className="flex items-start justify-between gap-2 mb-1">
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                Proposed clause language
              </span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(proposedClause)}
                className="editorial-btn-ghost"
                style={{ padding: '2px 6px', fontSize: 10, height: 'auto' }}
              >
                <Copy size={10} /> Copy
              </button>
            </div>
            <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: 0 }}>
              {proposedClause}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>{label}</span>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--ink)', margin: '4px 0 0' }}>{value}</p>
    </div>
  )
}

// SignedPdfLink — generates a 5-minute signed URL for the uploaded agreement
function SignedPdfLink({ path }) {
  const [opening, setOpening] = useState(false)
  if (!path) return null

  async function open() {
    setOpening(true)
    const { data, error } = await supabase.storage
      .from('contract-uploads')
      .createSignedUrl(path, 300)
    setOpening(false)
    if (error) return alert(`Could not open PDF: ${error.message}`)
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={opening}
      className="editorial-btn-ghost"
      style={{ flexShrink: 0 }}
    >
      {opening ? <Loader size={ICON.sm} className="animate-spin" /> : <FileText size={ICON.sm} />}
      Open agreement PDF
    </button>
  )
}
