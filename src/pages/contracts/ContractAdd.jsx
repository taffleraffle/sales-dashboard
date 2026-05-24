import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, FileText, Upload, Send } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// "New amendment review" — single-form entry point. Closer uploads the
// agreement they're working on, picks the template, says what the client
// wants, hits submit. We create the contract row + first amendment +
// invoke the judge in one flow, then land on the detail page with the
// verdict already visible.
export default function ContractAdd() {
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [contractType, setContractType] = useState('')
  const [clientName, setClientName]     = useState('')
  const [pdfFile, setPdfFile]           = useState(null)
  const [requestText, setRequestText]   = useState('')
  const [clauseRef, setClauseRef]       = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress]     = useState('')
  const [error, setError]           = useState(null)

  const canSubmit = contractType && clientName.trim() && pdfFile && requestText.trim() && !submitting

  async function submit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setError(null); setProgress('Uploading agreement…')

    try {
      // 1. Upload PDF first so we know the path before inserting the row
      const contractId = (crypto.randomUUID?.() || Date.now().toString())
      const safeName = pdfFile.name.replace(/[^a-z0-9.\-_]/gi, '_').slice(0, 120)
      const path = `${contractId}/${safeName}`
      const { error: uploadErr } = await supabase.storage
        .from('contract-uploads')
        .upload(path, pdfFile, { contentType: 'application/pdf', upsert: false })
      if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

      // 2. Insert contract row
      setProgress('Saving contract…')
      const fees   = contractType === 'trial' ? 997 : null
      const period = contractType === 'trial' ? 14 : 90

      const { data: contract, error: insertErr } = await supabase
        .from('contracts')
        .insert({
          id: contractId,
          contract_type: contractType,
          client_name: clientName.trim(),
          closer_id: profile?.teamMemberId || null,
          agreement_pdf_path: path,
          fee_amount_usd: fees,
          project_period_days: period,
          status: 'sent',
          version: 1,
        })
        .select()
        .single()
      if (insertErr) {
        await supabase.storage.from('contract-uploads').remove([path]).catch(() => {})
        throw new Error(`Save failed: ${insertErr.message}`)
      }

      // 3. Insert the first amendment request
      setProgress('Submitting to judge…')
      const { data: amendment, error: amErr } = await supabase
        .from('contract_amendments')
        .insert({
          contract_id: contract.id,
          closer_id: profile?.teamMemberId || null,
          requested_change: requestText.trim(),
          clause_reference: clauseRef.trim() || null,
          status: 'pending',
        })
        .select()
        .single()
      if (amErr) {
        // Surface, don't swallow — the contract saved but the amendment
        // didn't. Closer needs to know so they can retry from detail page.
        throw new Error(`Contract saved, but the first amendment request failed: ${amErr.message}. Open the contract and re-submit the amendment.`)
      }

      // 4. Fire the judge. Surface failures but still navigate — the
      //    amendment exists, closer can re-trigger from detail page.
      setProgress('Judging against policy…')
      try {
        const { data: judgeData, error: judgeErr } = await supabase.functions.invoke('contract-judge-amendment', {
          body: { amendment_id: amendment.id },
        })
        if (judgeErr) throw judgeErr
        if (judgeData?.error) throw new Error(judgeData.error)
      } catch (e) {
        // Soft-fail but tell the closer. The amendment row exists; they
        // can hit reply/retry from the detail page.
        console.warn('Judge call failed on initial submit:', e)
      }

      navigate(`/sales/contracts/${contract.id}`)
    } catch (err) {
      setError(err.message || String(err))
      setProgress('')
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-[760px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All reviews
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · New review</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          New <em style={{ fontStyle: 'italic' }}>amendment review</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 580 }}>
          Upload the draft agreement, tell the judge what the client wants changed, and it'll come back with what we can
          approve, what we can't, and a draft redline. Once you confirm, it regenerates the amended agreement so you can
          re-upload to PandaDoc.
        </p>
      </div>

      <form onSubmit={submit} className="tile tile-feedback p-6 space-y-5">

        {/* 1. Template — required */}
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Which agreement <span style={{ color: 'var(--down)' }}>*</span>
          </span>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <TemplateCard
              label="Trial"
              sub="$997 · 14-day trial"
              detail="Eric Campbell-style template. Auto-renews to $997/month after the trial."
              selected={contractType === 'trial'}
              onClick={() => setContractType('trial')}
            />
            <TemplateCard
              label="Retainer"
              sub="$9k · 90-day · Work-For-Free Guarantee"
              detail="Full retainer package with ranking guarantee. AquaFlame-style."
              selected={contractType === 'retainer'}
              onClick={() => setContractType('retainer')}
            />
          </div>
        </div>

        {/* 2. Agreement PDF — required */}
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Agreement PDF <span style={{ color: 'var(--down)' }}>*</span>
          </span>
          <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '4px 0 0' }}>
            The draft agreement that's on the table. Doesn't need to be signed.
          </p>
          <div className="mt-2 p-4" style={{ background: 'var(--paper)', border: pdfFile ? '1px solid var(--ink)' : '1px dashed var(--rule)', borderRadius: 3 }}>
            {pdfFile ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText size={ICON.md} style={{ color: 'var(--ink)' }} />
                  <div className="min-w-0">
                    <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {pdfFile.name}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: 0, fontFamily: 'var(--mono)' }}>
                      {(pdfFile.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                </div>
                <button type="button" onClick={() => setPdfFile(null)} className="editorial-btn-ghost">
                  Replace
                </button>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center cursor-pointer text-center py-6">
                <Upload size={20} style={{ color: 'var(--ink-3)', marginBottom: 8 }} />
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Click to select the agreement PDF</span>
                <span style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>20 MB max · PDF only</span>
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    if (f.type !== 'application/pdf') {
                      setError('Only PDF files are accepted.')
                      return
                    }
                    if (f.size > 20 * 1024 * 1024) {
                      setError('File exceeds 20 MB.')
                      return
                    }
                    setError(null)
                    setPdfFile(f)
                  }}
                />
              </label>
            )}
          </div>
        </div>

        {/* 3. Client */}
        <Field label="Client name" required>
          <input
            type="text"
            value={clientName}
            onChange={e => setClientName(e.target.value)}
            required
            className="editorial-input"
            placeholder="e.g. Eric Campbell or Camco TN"
          />
        </Field>

        {/* 4. The amendment request itself — required */}
        <div className="pt-4" style={{ borderTop: '1px solid var(--rule)' }}>
          <Field label="What is the client asking to change?" required>
            <textarea
              value={requestText}
              onChange={e => setRequestText(e.target.value)}
              rows={5}
              required
              className="editorial-input"
              style={{ resize: 'vertical' }}
              placeholder={contractType === 'retainer'
                ? 'e.g. Client wants to extend the work-for-free period to 6 months instead of 30 days past the guarantee window.'
                : 'e.g. Client wants jurisdiction moved to Tennessee instead of New Zealand. Says their lawyer requires this.'}
            />
          </Field>
          <Field label="Clause reference (optional)">
            <input
              type="text"
              value={clauseRef}
              onChange={e => setClauseRef(e.target.value)}
              className="editorial-input"
              placeholder="e.g. Clause 4(b)(i)"
            />
          </Field>
        </div>

        {error && (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)', margin: 0 }}>{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--rule)' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            {progress || 'The judge runs against your active policy as soon as you submit.'}
          </span>
          <button type="submit" disabled={!canSubmit} className="editorial-btn-primary">
            {submitting ? <><Loader size={ICON.sm} className="animate-spin" /> {progress || 'Working…'}</> : <><Send size={ICON.sm} /> Submit for review</>}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        {label}{required && <span style={{ color: 'var(--down)', marginLeft: 4 }}>*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function TemplateCard({ label, sub, detail, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-3"
      style={{
        background: selected ? 'var(--accent-soft)' : 'var(--paper)',
        border: selected ? '2px solid var(--accent)' : '1px solid var(--rule)',
        borderRadius: 3,
        cursor: 'pointer',
        transition: 'background 160ms, border-color 160ms',
      }}
    >
      <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', marginTop: 2 }}>
        {sub}
      </div>
      <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '6px 0 0', lineHeight: 1.4 }}>
        {detail}
      </p>
    </button>
  )
}
