import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Loader, AlertCircle, ExternalLink, Send, Copy, FileText,
  Lock, MessageCircle, Plus,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'
import ContractPreview from './ContractPreview'

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
  const [newOriginal, setNewOriginal]   = useState('')
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
        original_excerpt: newOriginal.trim() || null,
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
    setNewRequest(''); setNewClauseRef(''); setNewOriginal('')

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
    <div className="max-w-[1640px] mx-auto px-2">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All reviews
      </Link>

      {/* Contract header — compact. Identity on the left, single
          "Document ▾" dropdown on the right collapses the three PDF
          actions (Original / Amended / Regenerate) into one button.
          Fee / period / PandaDoc moved inline on a single row to
          collapse vertical space. */}
      <div className="tile tile-feedback p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="eyebrow eyebrow-accent">
              {contract.contract_type === 'retainer' ? 'Retainer template' : 'Trial template'}
              {' · v'}{contract.version || 1}
            </span>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', margin: '4px 0 0', lineHeight: 1.1 }}>
              {contract.client_name}
            </h1>
            {contract.client_company && (
              <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '2px 0 0' }}>{contract.client_company}</p>
            )}
          </div>
          <DocumentMenu
            contract={contract}
            amendments={amendments}
            onRegenerated={async () => {
              const { data } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
              if (data) setContract(data)
            }}
          />
        </div>
        <div className="flex items-center gap-6 mt-4 pt-3" style={{ borderTop: '1px solid var(--rule)', fontFamily: 'var(--mono)', fontSize: 12 }}>
          <span><span style={{ color: 'var(--ink-3)' }}>Fee</span> <span style={{ color: 'var(--ink)', marginLeft: 6 }}>{contract.fee_amount_usd ? `$${Number(contract.fee_amount_usd).toLocaleString()}` : '—'}</span></span>
          <span><span style={{ color: 'var(--ink-3)' }}>Period</span> <span style={{ color: 'var(--ink)', marginLeft: 6 }}>{contract.project_period_days ? `${contract.project_period_days} days` : '—'}</span></span>
          <span className="flex-1 text-right">
            <span style={{ color: 'var(--ink-3)' }}>PandaDoc</span>{' '}
            {contract.pandadoc_view_url
              ? <a href={contract.pandadoc_view_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>Open <ExternalLink size={11} /></a>
              : <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}>Not linked</span>}
          </span>
        </div>
      </div>

      {/* Two-pane workspace: chat on the left, contract preview on the
          right. Each pane scrolls independently within the viewport so
          the closer can chat without losing sight of the document.
          Below 1100px the panes stack into the previous single-column
          layout (mobile / narrow desktop). */}
      <div className="contract-workspace">
        {/* LEFT PANE — amendment chat */}
        <div className="contract-workspace-chat">
          {amendments.length === 0 && (
            <div className="tile tile-feedback p-4 text-center" style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0 }}>
                No amendment threads on this contract yet. Raise one below.
              </p>
            </div>
          )}

          {amendments.map(a => (
            <AmendmentThread
              key={a.id}
              amendment={a}
              messages={messagesByAmendment[a.id] || []}
              contract={contract}
              onChange={() => refreshAmendment(a.id)}
              onContractChange={async () => {
                const { data } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
                if (data) setContract(data)
              }}
            />
          ))}

          {/* Only show the "start new" form when there's no amendment yet
              for this contract. One rolling conversation per contract —
              the judge handles multiple clauses inside a single thread
              (proven out by Eric1's IP + Direct Debit lock). After lock
              + generate, this form reappears only if the closer needs to
              raise a separate amendment round later — but for now we
              only show it on the empty state. */}
          {amendments.length === 0 && (
          <div className="tile tile-feedback p-6">
            <span className="eyebrow eyebrow-bare">Raise an amendment</span>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 16px' }}>
              Tell the judge what the client wants changed. You'll work through it in chat, then confirm to generate the amended document.
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
              <div>
                <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  Original clause text (optional)
                  <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--ink-3)', fontWeight: 400, marginLeft: 6, fontStyle: 'italic' }}>
                    — paste from the contract; the regenerated PDF will show it as "Previously read:" above the new language
                  </span>
                </label>
                <textarea
                  value={newOriginal}
                  onChange={e => setNewOriginal(e.target.value)}
                  placeholder='e.g. "This Agreement shall be governed by the laws of New Zealand."'
                  rows={2}
                  className="editorial-input w-full mt-1"
                  style={{ resize: 'vertical' }}
                />
              </div>
              {newErr && (
                <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{newErr}</p>
              )}
              <div className="flex items-center justify-end">
                <button type="submit" disabled={creatingNew || !newRequest.trim()} className="editorial-btn-primary">
                  {creatingNew ? <><Loader size={ICON.sm} className="animate-spin" /> Judging…</> : <><Plus size={ICON.sm} /> Start amendment</>}
                </button>
              </div>
            </form>
          </div>
          )}
        </div>

        {/* RIGHT PANE — contract preview */}
        <div className="contract-workspace-preview">
          <ContractPreviewPane contract={contract} amendments={amendments} />
        </div>
      </div>
    </div>
  )
}

// ─── ContractPreviewPane — right side of the workspace ────────────────────
// Renders the contract INLINE as HTML, walking the structured template
// for the contract_type and substituting locked amendments in their
// natural clause position with a yellow highlighted block. Replaces
// the iframe approach from Phase 1 — amended clauses sit IN PLACE
// inside the contract body, not on a separate page.
//
// Toolbar lets the closer toggle "With amendments" (default) vs "Original"
// to compare. "Download PDF" button renders the same structured source
// to PDF via the regenerate-amended-agreement Edge fn.
function ContractPreviewPane({ contract, amendments }) {
  const [view, setView] = useState('amended') // 'amended' | 'original'
  const [downloading, setDownloading] = useState(false)
  const [downloadErr, setDownloadErr] = useState(null)
  const lockedCount = amendments.filter(a => a.locked_at && (a.final_clause_text || a.ai_proposed_redline)).length

  // No amendments yet → default to original view (cleaner first impression)
  useEffect(() => {
    if (lockedCount === 0) setView('original')
  }, [lockedCount])

  async function downloadPdf() {
    if (downloading) return
    setDownloading(true); setDownloadErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('regenerate-amended-agreement', {
        body: { contract_id: contract.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      if (!data?.signed_url) throw new Error('No signed URL returned.')
      window.open(data.signed_url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setDownloadErr(e.message || String(e))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="tile tile-feedback" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)', flexShrink: 0 }}>
        <div className="flex items-center gap-1">
          <PreviewTab label="With amendments" active={view === 'amended'} disabled={lockedCount === 0} onClick={() => setView('amended')}>
            {lockedCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-3)', marginLeft: 6 }}>
                {lockedCount}
              </span>
            )}
          </PreviewTab>
          <PreviewTab label="Original" active={view === 'original'} onClick={() => setView('original')} />
        </div>
        <div className="flex items-center gap-2">
          {lockedCount > 0 && (
            <button
              type="button"
              onClick={downloadPdf}
              disabled={downloading}
              className="editorial-btn-ghost"
              style={{ fontSize: 11, padding: '4px 10px' }}
              title="Download the amended contract as PDF"
            >
              {downloading ? <Loader size={11} className="animate-spin" /> : <FileText size={11} />}
              Download PDF
            </button>
          )}
        </div>
      </div>

      {downloadErr && (
        <div style={{ padding: '6px 12px', background: 'rgba(181,62,62,0.08)', borderBottom: '1px solid var(--rule)' }}>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{downloadErr}</p>
        </div>
      )}

      {/* Body — scrollable contract */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 600, background: 'var(--paper)' }}>
        <ContractPreview
          contract={contract}
          amendments={view === 'amended' ? amendments : []}
        />
      </div>
    </div>
  )
}

function PreviewTab({ label, active, disabled, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        background: active ? 'var(--paper)' : 'transparent',
        border: '1px solid',
        borderColor: active ? 'var(--rule)' : 'transparent',
        borderBottom: active ? '1px solid var(--paper)' : '1px solid transparent',
        borderRadius: '3px 3px 0 0',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: disabled ? 'var(--ink-4)' : (active ? 'var(--ink)' : 'var(--ink-3)'),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        marginBottom: -1,
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {label}
      {children}
    </button>
  )
}

// ─── Amendment thread (chat) ──────────────────────────────────────────────
function AmendmentThread({ amendment, messages, contract, onChange, onContractChange }) {
  const { profile } = useAuth()
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState(null)
  const [generating, setGenerating] = useState(false)
  const [genErr, setGenErr]       = useState(null)
  const threadEndRef = useRef(null)
  const prevLengthRef = useRef(messages.length)

  // Latest verdict in the thread (judge messages can change it turn-by-turn)
  const lastJudgeVerdict = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.verdict)?.metadata?.verdict
    || amendment.ai_verdict

  // Latest proposed clause (most recent judge message that carried one)
  const lastProposedClause = [...messages].reverse().find(m => m.role === 'judge' && m.metadata?.proposed_clause)?.metadata?.proposed_clause
    || amendment.ai_proposed_redline

  // The Generate button is the SINGLE control that does lock + regen +
  // open + post download link. Gated tighter than the old "Lock in"
  // button so it only appears when the judge has actually proposed
  // final clause language with verdict=allow. The closer's job in chat
  // is to negotiate until this state is reached; then one click ships
  // the amended document.
  const isLocked = !!amendment.locked_at
  const canGenerate = !isLocked
    && lastJudgeVerdict === 'allow'
    && (lastProposedClause || '').trim().length > 0

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

  // generateAmendedDocument
  //   One click does everything the closer needs:
  //     1. Locks the thread (captures final_clause_text from the latest
  //        judge proposal so the PDF generator has authoritative text)
  //     2. Calls regenerate-amended-agreement (produces a fresh PDF)
  //     3. Opens the PDF in a new tab
  //     4. Inserts a 'judge' message in the thread with the download link
  //        so there's a permanent record of what was generated and when
  //     5. Refreshes the contract row so the contract header reflects the
  //        new amended_pdf_path + version
  //   If any step fails, the error is surfaced inline; the lock is not
  //   rolled back, but the closer can click again to retry the regen.
  async function generateAmendedDocument() {
    if (generating) return
    setGenerating(true); setGenErr(null)
    try {
      const finalClause = lastProposedClause || ''
      if (!finalClause.trim()) {
        throw new Error('No proposed clause language to lock in. Keep working with the judge until it surfaces a redline.')
      }

      // 1. Lock — idempotent if already locked (skipped)
      if (!isLocked) {
        const { data: updated, error: lockErr } = await supabase
          .from('contract_amendments')
          .update({
            locked_at: new Date().toISOString(),
            final_clause_text: finalClause,
            status: 'approved',
          })
          .eq('id', amendment.id)
          .is('locked_at', null)
          .select()
        if (lockErr) throw new Error(`Lock failed: ${lockErr.message}`)
        if (!updated || updated.length === 0) {
          throw new Error('Lock failed silently — another tab may have locked this already. Refresh to see latest state.')
        }
      }

      // 2. Regenerate
      const { data: regen, error: regenErr } = await supabase.functions.invoke('regenerate-amended-agreement', {
        body: { contract_id: amendment.contract_id || contract?.id },
      })
      if (regenErr) throw regenErr
      if (regen?.error) throw new Error(regen.error)
      if (!regen?.signed_url) throw new Error('Regen returned no signed URL.')

      // 3. Open the PDF
      window.open(regen.signed_url, '_blank', 'noopener,noreferrer')

      // 4. Record the generation as a judge message so the thread shows
      //    what shipped and when. The signed URL expires in 10 minutes
      //    so we don't store it; the closer can re-open from the
      //    "Open contract" button in the header any time after.
      await supabase.from('contract_amendment_messages').insert({
        amendment_id: amendment.id,
        role: 'judge',
        content: `Amended document generated. Version v${regen.version}. Opening now — you can re-open it any time from the "Open contract" button at the top of the page.`,
        metadata: { generated_version: regen.version, kind: 'generation_receipt' },
      })

      // 5. Refresh local state
      await onChange()
      if (onContractChange) await onContractChange()
    } catch (err) {
      setGenErr(err.message || String(err))
    } finally {
      setGenerating(false)
    }
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

      {/* Generate banner — only appears once the judge has actually
          proposed final clause language AND landed on 'allow'. This is
          the explicit confirmation step Ben asked for: the closer
          doesn't see a Lock button on every turn, only at the moment
          there's something concrete to lock. One click → lock + regen
          + open the PDF + post a receipt message in the thread. */}
      {canGenerate && (
        <div className="mb-4 p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
          <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, lineHeight: 1.4 }}>
            The judge has finalised the clause language above. Ready to lock it in and generate the amended document?
          </p>
          {genErr && (
            <p style={{ fontSize: 11, color: 'var(--down)', fontFamily: 'var(--mono)', margin: '6px 0 0' }}>{genErr}</p>
          )}
          <div className="flex items-center justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={generateAmendedDocument}
              disabled={generating}
              className="editorial-btn-primary"
              style={{ borderColor: 'var(--accent)' }}
            >
              {generating ? <><Loader size={ICON.sm} className="animate-spin" /> Generating…</> : <><FileText size={ICON.sm} /> Generate amended document</>}
            </button>
          </div>
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
              placeholder={canGenerate
                ? 'Keep negotiating, or hit Generate above when you\'re ready.'
                : 'Reply to the judge — push back, ask for counter-options, propose alternative wording…'}
              rows={2}
              className="editorial-input flex-1"
              style={{ resize: 'vertical' }}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !replyText.trim()} className="editorial-btn-primary" style={{ flexShrink: 0 }}>
              {sending ? <><Loader size={ICON.sm} className="animate-spin" /> Thinking…</> : <><Send size={ICON.sm} /> Send</>}
            </button>
          </div>
          <div className="mt-2">
            <span style={{ fontSize: 10, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              {sendErr ? <span style={{ color: 'var(--down)', fontFamily: 'var(--mono)' }}>{sendErr}</span> : 'Cmd/Ctrl + Enter to send'}
            </span>
          </div>
        </form>
      )}

      {isLocked && (
        <LockedPanel
          amendment={amendment}
          fallbackClause={lastProposedClause}
          contract={contract}
          onContractChange={onContractChange}
        />
      )}
    </div>
  )
}

// ─── Locked-in confirmation + DOCX regen status ───────────────────────────
// Shown when the amendment thread is locked. If a PDF hasn't been
// generated yet for this lock (or the contract's amended PDF is stale
// against a newer lock), a "Generate amended document" button is the
// primary action. Otherwise, just shows the agreed clause language —
// "Open contract" in the page header is the way to re-open the latest
// PDF after that.
function LockedPanel({ amendment, fallbackClause, contract, onContractChange }) {
  const clauseText = amendment.final_clause_text || fallbackClause || ''
  const lockedAt = amendment.locked_at ? new Date(amendment.locked_at) : null
  const [generating, setGenerating] = useState(false)
  const [genErr, setGenErr]         = useState(null)

  // If the contract has never been regenerated (no amended_pdf_path) OR
  // the lock happened AFTER the last regen, we still have work to do.
  const lockTime = lockedAt ? lockedAt.getTime() : 0
  const lastRegenTime = contract?.updated_at ? new Date(contract.updated_at).getTime() : 0
  const needsGenerate = !contract?.amended_pdf_path || lockTime > lastRegenTime

  async function generateAmendedDocument() {
    if (generating) return
    setGenerating(true); setGenErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('regenerate-amended-agreement', {
        body: { contract_id: amendment.contract_id || contract?.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      if (!data?.signed_url) throw new Error('Regen returned no signed URL.')
      window.open(data.signed_url, '_blank', 'noopener,noreferrer')
      await supabase.from('contract_amendment_messages').insert({
        amendment_id: amendment.id,
        role: 'judge',
        content: `Amended document generated. Version v${data.version}. Opening now — you can re-open it any time from the "Open contract" button at the top of the page.`,
        metadata: { generated_version: data.version, kind: 'generation_receipt' },
      })
      if (onContractChange) await onContractChange()
    } catch (e) {
      setGenErr(e.message || String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="mt-3 p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Lock size={10} /> Locked in
          </span>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', margin: '4px 0 0' }}>
            Agreed position frozen{lockedAt ? ` ${lockedAt.toLocaleString()}` : ''}
          </p>
        </div>
        {needsGenerate && (
          <button
            type="button"
            onClick={generateAmendedDocument}
            disabled={generating}
            className="editorial-btn-primary"
            style={{ flexShrink: 0, borderColor: 'var(--accent)' }}
          >
            {generating ? <><Loader size={ICON.sm} className="animate-spin" /> Generating…</> : <><FileText size={ICON.sm} /> Generate amended document</>}
          </button>
        )}
      </div>

      {clauseText ? (
        <div className="mt-2">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Final clause language captured
          </span>
          <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: '6px 0 0', padding: 10, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9 }}>
            {clauseText}
          </pre>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0, fontStyle: 'italic' }}>
          No specific clause text was committed in the thread. Reopen the conversation and ask the judge for a redline before generating.
        </p>
      )}

      {genErr && (
        <p style={{ fontSize: 11, color: 'var(--down)', fontFamily: 'var(--mono)', margin: '8px 0 0' }}>{genErr}</p>
      )}
      {!needsGenerate && (
        <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '10px 0 0', fontStyle: 'italic' }}>
          Amended document v{contract?.version} is current. Re-open any time from "Open contract" at the top of the page.
        </p>
      )}
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
          borderRadius: 9,
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}>
          {blocks.map((b, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{b}</p>
          ))}
        </div>
        {proposedClause && !isCloser && (
          <div className="mt-2 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
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

// DocumentMenu — one button that always opens the most current contract.
// Logic:
//   - No locked amendments  → open the original signed PDF
//   - Locked amendments exist + amended PDF is up to date → open amended
//   - Locked amendments exist + amended PDF is stale (a newer lock landed
//     after the last regen) → regenerate, then open the fresh one
// Closer doesn't need to think about versions or pick between original
// vs amended vs regenerate — there's just "the contract" and clicking it
// always gives them the latest authoritative document.
function DocumentMenu({ contract, amendments, onRegenerated }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState(null)

  const locked = amendments.filter(a => a.locked_at)
  const hasLocked = locked.length > 0
  // Amended PDF is "stale" if any locked amendment was locked AFTER the
  // current amended_pdf_path was generated. The amended PDF version bumps
  // each regen; we treat any locked amendment as "needs include" when
  // there's no amended PDF at all, OR when a lock timestamp is newer than
  // the contract's updated_at-derived regen time.
  const latestLockTime = locked.reduce((max, a) => {
    const t = new Date(a.locked_at).getTime()
    return t > max ? t : max
  }, 0)
  const lastRegenTime = contract.updated_at ? new Date(contract.updated_at).getTime() : 0
  const amendedStale = hasLocked && (!contract.amended_pdf_path || latestLockTime > lastRegenTime)

  async function openLatest() {
    setBusy(true); setErr(null)
    try {
      // Path 1: no locked amendments yet → open the original
      if (!hasLocked) {
        if (!contract.agreement_pdf_path) throw new Error('No contract on file. Upload one first.')
        const { data, error } = await supabase.storage.from('contract-uploads').createSignedUrl(contract.agreement_pdf_path, 300)
        if (error) throw error
        window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
        return
      }
      // Path 2: amended is current → open it
      if (!amendedStale && contract.amended_pdf_path) {
        const { data, error } = await supabase.storage.from('contract-uploads').createSignedUrl(contract.amended_pdf_path, 300)
        if (error) throw error
        window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
        return
      }
      // Path 3: amended is stale (or doesn't exist yet) → regen then open
      const { data: regenData, error: regenErr } = await supabase.functions.invoke('regenerate-amended-agreement', { body: { contract_id: contract.id } })
      if (regenErr) throw regenErr
      if (regenData?.error) throw new Error(regenData.error)
      if (!regenData?.signed_url) throw new Error('Regen returned no signed URL.')
      window.open(regenData.signed_url, '_blank', 'noopener,noreferrer')
      await onRegenerated()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // State-specific label so the closer knows exactly what clicking the
  // button will give them. The previous generic "Open contract" was
  // ambiguous — closers didn't realise it auto-opened the amended PDF
  // when one existed.
  const buttonLabel = !hasLocked
    ? 'Open contract'
    : amendedStale
      ? `Generate amended v${(contract.version || 1) + 1}`
      : `Open amended v${contract.version}`

  const busyLabel = amendedStale ? 'Generating…' : 'Opening…'

  return (
    <div style={{ flexShrink: 0, textAlign: 'right' }}>
      <button
        type="button"
        onClick={openLatest}
        disabled={busy || (!contract.agreement_pdf_path && !contract.amended_pdf_path)}
        className="editorial-btn-primary"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {busy ? <><Loader size={ICON.sm} className="animate-spin" /> {busyLabel}</> : <><FileText size={ICON.sm} /> {buttonLabel}</>}
      </button>
      {/* Secondary action: when an amended PDF exists, give a small link
          to view the original for comparison. Hidden when the contract
          has never been amended. Wrapped in a div with display:block to
          force it to stack BELOW the primary button (previously it was
          clipping inline-right of the primary button because the parent
          uses text-align:right and links render inline by default). */}
      {hasLocked && contract.amended_pdf_path && !amendedStale && contract.agreement_pdf_path && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={async () => {
              setBusy(true); setErr(null)
              try {
                const { data, error } = await supabase.storage.from('contract-uploads').createSignedUrl(contract.agreement_pdf_path, 300)
                if (error) throw error
                window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
              } catch (e) { setErr(e.message || String(e)) }
              finally { setBusy(false) }
            }}
            style={{
              background: 'transparent', border: 'none', padding: 0,
              fontSize: 11, color: 'var(--ink-3)',
              textDecoration: 'underline', cursor: 'pointer',
            }}
          >
            View original (v1)
          </button>
        </div>
      )}
      {hasLocked && (
        <p style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)', margin: '4px 0 0' }}>
          {amendedStale
            ? `${locked.length} amendment${locked.length === 1 ? '' : 's'} pending — click to ship`
            : `${locked.length} amendment${locked.length === 1 ? '' : 's'} applied`}
        </p>
      )}
      {err && (
        <p style={{ fontSize: 11, color: 'var(--down)', fontFamily: 'var(--mono)', margin: '4px 0 0', maxWidth: 260, textAlign: 'right' }}>{err}</p>
      )}
    </div>
  )
}

// SignedPdfLink (legacy — left for any out-of-page references; new code
// uses DocumentMenu). TODO: remove when nothing else imports it.
function SignedPdfLink({ path, label = 'Open agreement PDF', primary = false }) {
  const [opening, setOpening] = useState(false)
  if (!path) return null
  async function open() {
    setOpening(true)
    const { data, error } = await supabase.storage.from('contract-uploads').createSignedUrl(path, 300)
    setOpening(false)
    if (error) return alert(`Could not open PDF: ${error.message}`)
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }
  return (
    <button type="button" onClick={open} disabled={opening} className={primary ? 'editorial-btn-primary' : 'editorial-btn-ghost'} style={{ flexShrink: 0 }}>
      {opening ? <Loader size={ICON.sm} className="animate-spin" /> : <FileText size={ICON.sm} />}
      {label}
    </button>
  )
}

