import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Loader, AlertCircle, ExternalLink, Send, Copy, FileText,
  Lock, MessageCircle, Plus,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'
import DownsellCoach from './DownsellCoach'

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
        const { data: msgs, error: msgErr } = await supabase
          .from('contract_amendment_messages')
          .select('*')
          .in('amendment_id', ids)
          .order('created_at', { ascending: true })
        if (cancelled) return
        if (msgErr) { setError(`Failed to load amendment threads: ${msgErr.message}`); setLoading(false); return }
        if (msgs) {
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
      const { data, error: invErr } = await supabase.functions.invoke('contract-judge-amendment', {
        body: { amendment_id: inserted.id },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await refreshAmendment(inserted.id)
    } catch (err) {
      setNewErr(`Submitted, but judge failed: ${err.message || err}. Reload to retry.`)
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
              {' · v'}{contract.version || 1}
            </span>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
              {contract.client_name}
            </h1>
            {contract.client_company && (
              <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: '4px 0 0' }}>{contract.client_company}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <SignedPdfLink path={contract.agreement_pdf_path} label="Open original" />
            {contract.amended_pdf_path && (
              <SignedPdfLink path={contract.amended_pdf_path} label={`Open amended v${contract.version}`} primary />
            )}
            <RegenerateButton
              contract={contract}
              amendments={amendments}
              onRegenerated={async () => {
                // Refresh contract row so amended_pdf_path + version update
                const { data } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
                if (data) setContract(data)
              }}
            />
          </div>
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

      {/* Two-part contract review page:
            1. Downsell options  — save-the-deal coach (top, because save
               attempts are higher priority than clause tweaks)
            2. Contract negotiation  — amendment judge for clause changes
          Each gets its own clearly-labelled section. */}

      {/* ────────── Section 1: Downsell options ────────── */}
      <DownsellCoach contractId={id} contract={contract} />

      {/* ────────── Section 2: Contract negotiation ────────── */}
      <div style={{ marginTop: 48 }}>
        <div className="flex items-center gap-3 mb-4 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
          <MessageCircle size={18} style={{ color: 'var(--accent)' }} />
          <div>
            <span className="eyebrow eyebrow-accent">OPT Digital · Contract negotiation</span>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)', margin: '4px 0 0' }}>
              Amend the <em style={{ fontStyle: 'italic' }}>agreement</em>
            </h2>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, maxWidth: 640 }}>
              Client asking to change a specific clause? Open a thread per ask. The judge runs each through the amendment policy and tells you what you can lock in vs what needs Ben.
            </p>
          </div>
        </div>

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
  const prevLengthRef = useRef(messages.length)

  // Latest verdict in the thread (judge messages can change it turn-by-turn)
  const lastJudgeVerdict = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.verdict)?.metadata?.verdict
    || amendment.ai_verdict

  // Latest proposed clause (most recent judge message that carried one)
  const lastProposedClause = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.proposed_clause)?.metadata?.proposed_clause
    || amendment.ai_proposed_redline

  const isLocked = !!amendment.locked_at
  const canLock = !isLocked && lastJudgeVerdict && lastJudgeVerdict !== 'reject'

  useEffect(() => {
    // Only scroll when a NEW message lands (length grew). Skip mount so
    // opening a contract doesn't snap the viewport to the bottom of the
    // oldest thread on the page.
    if (messages.length > prevLengthRef.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevLengthRef.current = messages.length
  }, [messages.length])

  async function sendReply(e) {
    e?.preventDefault()
    if (!replyText.trim() || sending) return
    setSending(true); setSendErr(null)
    const message = replyText.trim()
    setReplyText('')
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('contract-judge-amendment', {
        body: { amendment_id: amendment.id, new_message: message },
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
    if (!confirm('Lock in this thread? You can\'t reply after this — but you can still regenerate the amended agreement.')) return
    setLocking(true)
    const finalClause = lastProposedClause || ''
    // Guard against double-click + race: only update if still unlocked.
    const { data: updated, error: lockErr } = await supabase
      .from('contract_amendments')
      .update({
        locked_at: new Date().toISOString(),
        final_clause_text: finalClause,
        status: lastJudgeVerdict === 'allow' ? 'approved' : 'judged',
      })
      .eq('id', amendment.id)
      .is('locked_at', null)
      .select()
    setLocking(false)
    if (lockErr) {
      alert(`Lock failed: ${lockErr.message}`)
      return
    }
    if (!updated || updated.length === 0) {
      // Either RLS blocked the update (non-admin closer with admin-only
      // update policy pre-020) or the row was already locked.
      alert('Lock failed silently — your account may not have permission to lock amendments yet, or another tab already locked this thread. Refresh to see latest state.')
      await onChange()
      return
    }
    await onChange()
  }

  return (
    <div className="tile tile-feedback p-6 mb-6">
      {/* Slim header — just clause ref + status, no duplicated request text */}
      <div className="flex items-center justify-between gap-3 mb-4 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <MessageCircle size={14} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            {amendment.clause_reference || 'Amendment thread'}
            {' · '}
            {new Date(amendment.created_at).toLocaleDateString()}
          </span>
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

      {isLocked && (
        <LockedPanel amendment={amendment} fallbackClause={lastProposedClause} />
      )}
    </div>
  )
}

// ─── Locked-in confirmation + DOCX regen status ───────────────────────────
function LockedPanel({ amendment, fallbackClause }) {
  const clauseText = amendment.final_clause_text || fallbackClause || ''
  const lockedAt = amendment.locked_at ? new Date(amendment.locked_at) : null

  return (
    <div className="mt-3 p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 3 }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Lock size={10} /> Locked in
          </span>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', margin: '4px 0 0' }}>
            Agreed position frozen{lockedAt ? ` ${lockedAt.toLocaleString()}` : ''}
          </p>
        </div>
      </div>

      {clauseText ? (
        <div className="mt-2">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Final clause language captured
          </span>
          <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: '6px 0 0', padding: 10, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3 }}>
            {clauseText}
          </pre>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0, fontStyle: 'italic' }}>
          No specific clause text was committed in the thread. The regenerated agreement will splice this in from the discussion's resolution.
        </p>
      )}

      <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '12px 0 0', fontStyle: 'italic' }}>
        Hit "Regenerate amended agreement" at the top of this page to produce the v{(amendment.contracts?.version || 1) + 1} PDF for PandaDoc.
      </p>
    </div>
  )
}

// Normalize judge content: strip stray markdown that the prompt forbade
// but Claude might still emit, and split into paragraph blocks for clean
// rendering. Numbered list items get explicit blank-line separation so
// each ask in a multi-part judge reply gets visual space.
function formatJudgeContent(raw) {
  if (!raw) return []
  let txt = String(raw)
    .replace(/\*\*(.+?)\*\*/g, '$1')     // **bold** -> bold
    .replace(/(^|\s)\*(\S[^*]*?\S?)\*/g, '$1$2')  // *italic* -> italic (preserve standalone *)
    .replace(/^#+\s+/gm, '')             // # headers -> plain
    .replace(/^\s*[-•]\s+/gm, '- ')      // normalize bullet glyphs

  // Force a paragraph break before "1." / "(1)" / "Ask 1:" style list items
  // when they're inline with prior text
  txt = txt.replace(/([.?!])\s+(\(?\d+\)?[.:)]\s+|Ask\s+\d+:|Option\s+[A-Z]:)/g, '$1\n\n$2')

  // Split on blank lines into paragraph blocks
  return txt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
}

// ─── Single chat message bubble ────────────────────────────────────────────
function MessageBubble({ message }) {
  const isCloser = message.role === 'closer'
  const verdict  = message.metadata?.verdict
  const proposedClause = message.metadata?.proposed_clause
  const blocks = isCloser
    ? [message.content]                  // closer text rendered raw
    : formatJudgeContent(message.content)

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
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}>
          {blocks.map((b, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{b}</p>
          ))}
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
function SignedPdfLink({ path, label = 'Open agreement PDF', primary = false }) {
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
      className={primary ? 'editorial-btn-primary' : 'editorial-btn-ghost'}
      style={{ flexShrink: 0 }}
    >
      {opening ? <Loader size={ICON.sm} className="animate-spin" /> : <FileText size={ICON.sm} />}
      {label}
    </button>
  )
}

// RegenerateButton — runs the regenerate-amended-agreement Edge fn.
// Enabled only when there's at least one locked amendment on the contract.
function RegenerateButton({ contract, amendments, onRegenerated }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState(null)
  const lockedCount = amendments.filter(a => a.locked_at).length

  if (lockedCount === 0) {
    return (
      <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontStyle: 'italic', textAlign: 'right', maxWidth: 220 }}>
        Lock in at least one amendment thread to enable agreement regeneration.
      </span>
    )
  }

  async function regen() {
    setBusy(true); setErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('regenerate-amended-agreement', {
        body: { contract_id: contract.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      if (data?.signed_url) {
        window.open(data.signed_url, '_blank', 'noopener,noreferrer')
      } else {
        throw new Error('Regen returned no signed URL — try again or check function logs.')
      }
      await onRegenerated()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={regen}
        disabled={busy}
        className="editorial-btn-primary"
        style={{ borderColor: 'var(--accent)', flexShrink: 0 }}
      >
        {busy ? <><Loader size={ICON.sm} className="animate-spin" /> Generating…</> : <><FileText size={ICON.sm} /> Regenerate amended agreement</>}
      </button>
      <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
        Will splice in {lockedCount} locked amendment{lockedCount === 1 ? '' : 's'}
      </span>
      {err && <span style={{ fontSize: 10, color: 'var(--down)', fontFamily: 'var(--mono)', maxWidth: 240, textAlign: 'right' }}>{err}</span>}
    </div>
  )
}
