import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, FileText, Upload } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// "Add contract for amendment tracking" — NOT creating a new agreement.
// Closer drops the already-sent PandaDoc PDF + identifies which template
// (trial $997/14-day vs retainer $9K/90-day). The judge later reads this
// to know which clause structure to reason against.
//
// Flow: upload PDF → insert contract row referencing the storage path →
// navigate to detail page where the closer can request amendments.
export default function ContractAdd() {
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [contractType, setContractType]   = useState('')
  const [clientName, setClientName]       = useState('')
  const [clientCompany, setClientCompany] = useState('')
  const [clientEmail, setClientEmail]     = useState('')
  const [pandadocUrl, setPandadocUrl]     = useState('')
  const [pdfFile, setPdfFile]             = useState(null)
  const [notes, setNotes]                 = useState('')

  const [submitting, setSubmitting]       = useState(false)
  const [progress, setProgress]           = useState('')
  const [error, setError]                 = useState(null)

  const canSubmit = contractType && clientName.trim() && pdfFile && !submitting

  async function submit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setError(null); setProgress('Uploading PDF…')

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
      setProgress('Saving record…')
      const fees = contractType === 'trial' ? 997 : null  // retainer fee varies; leave blank
      const period = contractType === 'trial' ? 14 : 90

      const { data, error: insertErr } = await supabase
        .from('contracts')
        .insert({
          id: contractId,
          contract_type: contractType,
          client_name: clientName.trim(),
          client_company: clientCompany.trim() || null,
          client_email: clientEmail.trim() || null,
          closer_id: profile?.team_member_id || null,
          pandadoc_view_url: pandadocUrl.trim() || null,
          agreement_pdf_path: path,
          fee_amount_usd: fees,
          project_period_days: period,
          notes: notes.trim() || null,
          status: 'sent',     // assume it's already been sent if closer is tracking it
          version: 1,
        })
        .select()
        .single()
      if (insertErr) {
        // Best-effort cleanup so we don't orphan the uploaded file
        await supabase.storage.from('contract-uploads').remove([path]).catch(() => {})
        throw new Error(`Save failed: ${insertErr.message}`)
      }

      navigate(`/sales/contracts/${data.id}`)
    } catch (err) {
      setError(err.message || String(err))
      setProgress('')
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-[720px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · Add</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Add an <em style={{ fontStyle: 'italic' }}>existing contract</em> for amendment tracking
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 580 }}>
          This isn't for creating new contracts — keep doing that in PandaDoc. Use this when a client wants to amend an
          agreement you've already sent. Drop the signed PDF + identify the template, and the judge will know which
          clauses to reason against when you submit amendment requests.
        </p>
      </div>

      <form onSubmit={submit} className="tile tile-feedback p-6 space-y-5">

        {/* Template type — required */}
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Template type <span style={{ color: 'var(--down)' }}>*</span>
          </span>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <TemplateCard
              label="Trial"
              sub="$997 · 14 days · auto-renews"
              detail="Eric Campbell-style: Continuation Clause 4, Payment Authority irrevocable, 30-day cancellation."
              selected={contractType === 'trial'}
              onClick={() => setContractType('trial')}
            />
            <TemplateCard
              label="Retainer"
              sub="$9,000 · 90 days · with Guarantee"
              detail="AquaFlame-style: top-3 ranking guarantee, DBA + 10 photos/month + 2 reviews/week + OTO blast."
              selected={contractType === 'retainer'}
              onClick={() => setContractType('retainer')}
            />
          </div>
        </div>

        {/* Client */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client name" required>
            <input
              type="text"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              required
              className="editorial-input"
              placeholder="Eric Campbell"
            />
          </Field>
          <Field label="Company">
            <input
              type="text"
              value={clientCompany}
              onChange={e => setClientCompany(e.target.value)}
              className="editorial-input"
              placeholder="Camco TN"
            />
          </Field>
        </div>
        <Field label="Client email">
          <input
            type="email"
            value={clientEmail}
            onChange={e => setClientEmail(e.target.value)}
            className="editorial-input"
          />
        </Field>

        {/* PandaDoc link */}
        <Field label="PandaDoc document URL (optional)">
          <input
            type="url"
            value={pandadocUrl}
            onChange={e => setPandadocUrl(e.target.value)}
            className="editorial-input"
            placeholder="https://app.pandadoc.com/a/#/documents/..."
          />
        </Field>

        {/* PDF upload — required */}
        <div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Signed agreement PDF <span style={{ color: 'var(--down)' }}>*</span>
          </span>
          <div className="mt-1 p-4" style={{ background: 'var(--paper)', border: pdfFile ? '1px solid var(--ink)' : '1px dashed var(--rule)', borderRadius: 3 }}>
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
                <button type="button" onClick={() => setPdfFile(null)} className="editorial-btn-ghost" style={{ fontSize: 11 }}>
                  Replace
                </button>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center cursor-pointer text-center py-6">
                <Upload size={20} style={{ color: 'var(--ink-3)', marginBottom: 8 }} />
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Click to select a PDF</span>
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

        {/* Notes */}
        <Field label="Internal notes (optional)">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            className="editorial-input"
            style={{ resize: 'vertical' }}
            placeholder="Anything the judge or Ben should know about this deal."
          />
        </Field>

        {error && (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)', margin: 0 }}>{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--rule)' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            {progress || 'After adding, you can request amendments from the contract’s detail page.'}
          </span>
          <button type="submit" disabled={!canSubmit} className="editorial-btn-primary">
            {submitting ? <><Loader size={ICON.sm} className="animate-spin" /> Saving…</> : 'Add for tracking'}
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
