import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, ExternalLink, Send, Check, Copy, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

const VERDICT_STYLES = {
  allow:  { label: 'Auto-approved', color: 'var(--up)' },
  review: { label: 'Pending Ben',   color: 'var(--accent)' },
  reject: { label: 'Blocked',       color: 'var(--down)' },
}

const STATUS_LABELS = {
  pending:   'Submitting',
  judged:    'Awaiting Ben',
  approved:  'Approved',
  rejected:  'Rejected',
  applied:   'Applied',
  cancelled: 'Cancelled',
}

export default function ContractDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const [contract, setContract]   = useState(null)
  const [amendments, setAmendments] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  // amendment request form
  const [requestText, setRequestText] = useState('')
  const [clauseRef, setClauseRef]     = useState('')
  const [excerpt, setExcerpt]         = useState('')
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState(null)

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
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id])

  async function submitAmendment(e) {
    e.preventDefault()
    if (!requestText.trim()) return
    setSubmitting(true); setSubmitError(null)
    // 1. Insert pending row so it shows up in the thread immediately
    const { data: inserted, error: insertErr } = await supabase
      .from('contract_amendments')
      .insert({
        contract_id: id,
        closer_id: profile?.team_member_id || null,
        requested_change: requestText.trim(),
        clause_reference: clauseRef.trim() || null,
        original_excerpt: excerpt.trim() || null,
        status: 'pending',
      })
      .select()
      .single()
    if (insertErr) {
      setSubmitting(false)
      setSubmitError(insertErr.message)
      return
    }
    setAmendments(prev => [inserted, ...prev])
    setRequestText(''); setClauseRef(''); setExcerpt('')

    // 2. Fire the judge function. We await so the closer sees the verdict
    //    inline rather than having to refresh. If it fails we surface the
    //    error but the amendment stays in 'pending' so Ben can sweep it up.
    try {
      const { data: judged, error: judgeErr } = await supabase.functions.invoke(
        'contract-judge-amendment',
        { body: { amendment_id: inserted.id } }
      )
      if (judgeErr) throw judgeErr
      // Refresh the amendment with the verdict
      const { data: fresh } = await supabase
        .from('contract_amendments')
        .select('*')
        .eq('id', inserted.id)
        .maybeSingle()
      if (fresh) {
        setAmendments(prev => prev.map(a => a.id === fresh.id ? fresh : a))
      }
    } catch (err) {
      setSubmitError(`Submitted, but judge failed: ${err.message || err}. Ben will sweep it manually.`)
    } finally {
      setSubmitting(false)
    }
  }

  async function markApplied(amendment) {
    const { error } = await supabase
      .from('contract_amendments')
      .update({ status: 'applied', applied_at: new Date().toISOString() })
      .eq('id', amendment.id)
    if (error) return alert(`Mark applied failed: ${error.message}`)
    setAmendments(prev => prev.map(a => a.id === amendment.id
      ? { ...a, status: 'applied', applied_at: new Date().toISOString() }
      : a
    ))
  }

  function copyRedline(text) {
    if (!text) return
    navigator.clipboard?.writeText(text)
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
          <ArrowLeft size={ICON.sm} /> All contracts
        </Link>
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[1100px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      {/* Contract header */}
      <div className="tile tile-feedback p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="eyebrow eyebrow-accent">
              {contract.contract_type === 'retainer' ? 'Retainer template' : 'Trial template'}
              {' · '}{contract.status?.toUpperCase()}{' · '}v{contract.version}
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
          <div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Fee</span>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--ink)', margin: '4px 0 0' }}>
              {contract.fee_amount_usd ? `$${Number(contract.fee_amount_usd).toLocaleString()}` : '—'}
            </p>
          </div>
          <div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Period</span>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--ink)', margin: '4px 0 0' }}>
              {contract.project_period_days ? `${contract.project_period_days} days` : '—'}
            </p>
          </div>
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

      {/* Request amendment form */}
      <div className="tile tile-feedback p-6 mb-6">
        <span className="eyebrow eyebrow-bare">Request an amendment</span>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 16px' }}>
          Describe what the client is asking for. The judge will check it against the policy and either auto-apply, escalate to Ben, or block it.
        </p>
        <form onSubmit={submitAmendment} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Clause reference</label>
              <input
                type="text"
                value={clauseRef}
                onChange={e => setClauseRef(e.target.value)}
                placeholder="e.g. Clause 4(b)(i)"
                className="w-full mt-1 px-3 py-2"
                style={{ fontSize: 13, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, color: 'var(--ink)' }}
              />
            </div>
            <div>
              <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Original clause excerpt (optional)</label>
              <input
                type="text"
                value={excerpt}
                onChange={e => setExcerpt(e.target.value)}
                placeholder="Paste the existing wording"
                className="w-full mt-1 px-3 py-2"
                style={{ fontSize: 13, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, color: 'var(--ink)' }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>What the client wants changed</label>
            <textarea
              value={requestText}
              onChange={e => setRequestText(e.target.value)}
              placeholder="e.g. Client wants jurisdiction moved to Tennessee instead of New Zealand. Says their lawyer requires this."
              rows={4}
              className="w-full mt-1 px-3 py-2"
              style={{ fontSize: 13, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, color: 'var(--ink)', resize: 'vertical' }}
              required
            />
          </div>
          {submitError && (
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{submitError}</p>
          )}
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              The judge will check this against your active policy and either auto-approve, escalate to Ben, or block it.
            </span>
            <button type="submit" disabled={submitting || !requestText.trim()} className="editorial-btn-primary">
              {submitting ? <><Loader size={ICON.sm} className="animate-spin" /> Judging…</> : <><Send size={ICON.sm} /> Submit request</>}
            </button>
          </div>
        </form>
      </div>

      {/* Amendment thread */}
      <div className="tile tile-feedback p-6">
        <span className="eyebrow eyebrow-bare">Amendment history</span>
        {amendments.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 12 }}>No amendments yet.</p>
        )}
        <div className="space-y-3 mt-4">
          {amendments.map(a => {
            const canMarkApplied = a.status === 'approved'
            return (
              <div key={a.id} className="p-3" style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3 }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {a.clause_reference && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>{a.clause_reference}</span>
                    )}
                    <p style={{ fontSize: 13, color: 'var(--ink)', margin: '4px 0 0' }}>{a.requested_change}</p>
                  </div>
                  {a.ai_verdict && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: VERDICT_STYLES[a.ai_verdict]?.color, flexShrink: 0 }}>
                      {VERDICT_STYLES[a.ai_verdict]?.label || a.ai_verdict}
                    </span>
                  )}
                </div>

                {a.ai_reasoning && (
                  <div className="mt-2 p-2" style={{ background: 'var(--paper-2)', borderLeft: `2px solid ${VERDICT_STYLES[a.ai_verdict]?.color || 'var(--rule)'}`, borderRadius: 2 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                      Judge reasoning
                    </span>
                    <p style={{ fontSize: 12, color: 'var(--ink)', margin: '2px 0 0' }}>{a.ai_reasoning}</p>
                  </div>
                )}

                {a.ai_proposed_redline && (
                  <div className="mt-2 p-2" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 2 }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                        Proposed redline
                      </span>
                      <button
                        type="button"
                        onClick={() => copyRedline(a.ai_proposed_redline)}
                        className="editorial-btn-ghost"
                        style={{ padding: '2px 6px', fontSize: 10 }}
                        title="Copy redline text"
                      >
                        <Copy size={10} /> Copy
                      </button>
                    </div>
                    <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: 0 }}>
                      {a.ai_proposed_redline}
                    </pre>
                  </div>
                )}

                {a.ben_notes && (
                  <div className="mt-2 p-2" style={{ background: 'var(--paper-2)', borderRadius: 2 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                      Ben's note
                    </span>
                    <p style={{ fontSize: 12, color: 'var(--ink)', margin: '2px 0 0' }}>{a.ben_notes}</p>
                  </div>
                )}

                <div className="flex items-center justify-between mt-2">
                  <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', margin: 0 }}>
                    {new Date(a.created_at).toLocaleString()} · {STATUS_LABELS[a.status] || a.status}
                    {a.applied_at && ` · applied ${new Date(a.applied_at).toLocaleDateString()}`}
                  </p>
                  {canMarkApplied && (
                    <button
                      onClick={() => markApplied(a)}
                      className="editorial-btn-primary"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                    >
                      <Check size={ICON.sm} /> Mark as applied in PandaDoc
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// SignedPdfLink — generates a 5-minute signed URL for the uploaded agreement
// PDF and opens it in a new tab. The bucket is private (see migration 016),
// so direct paths won't work; signed URLs are the only way to view.
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
      style={{ fontSize: 12, flexShrink: 0 }}
    >
      {opening ? <Loader size={ICON.sm} className="animate-spin" /> : <FileText size={ICON.sm} />}
      Open signed PDF
    </button>
  )
}
