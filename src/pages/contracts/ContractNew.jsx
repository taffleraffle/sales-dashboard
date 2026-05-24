import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// Phase-1 stub: creates a contract row without PandaDoc. Phase 2 will swap
// this for a call to the pandadoc-create-contract Edge Function that posts
// a new document from the template and stores the returned pandadoc_id +
// view URL.
export default function ContractNew() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [clientName, setClientName]       = useState('')
  const [clientCompany, setClientCompany] = useState('')
  const [clientEmail, setClientEmail]     = useState('')
  const [feeAmount, setFeeAmount]         = useState('')
  const [periodDays, setPeriodDays]       = useState('14')
  const [scopeSummary, setScopeSummary]   = useState('')
  const [creating, setCreating]           = useState(false)
  const [error, setError]                 = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!clientName.trim()) return
    setCreating(true); setError(null)
    const { data, error } = await supabase
      .from('contracts')
      .insert({
        client_name: clientName.trim(),
        client_company: clientCompany.trim() || null,
        client_email: clientEmail.trim() || null,
        closer_id: profile?.team_member_id || null,
        fee_amount_usd: feeAmount ? parseFloat(feeAmount) : null,
        project_period_days: periodDays ? parseInt(periodDays, 10) : null,
        scope_summary: scopeSummary.trim() || null,
        status: 'draft',
        version: 1,
      })
      .select()
      .single()
    setCreating(false)
    if (error) { setError(error.message); return }
    navigate(`/sales/contracts/${data.id}`)
  }

  return (
    <div className="max-w-[720px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · New</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          New <em style={{ fontStyle: 'italic' }}>contract</em>
        </h1>
      </div>

      <div className="tile tile-feedback p-3 mb-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--accent)' }}>
        <FileText size={ICON.md} style={{ color: 'var(--ink-3)', flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0 }}>
          Phase 1 stub. PandaDoc auto-creation from your master template ships in phase 2 — for now this records the deal in the dashboard so the amendment flow has something to attach to.
        </p>
      </div>

      <form onSubmit={submit} className="tile tile-feedback p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client name" required>
            <input
              type="text"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              required
              className="editorial-input"
            />
          </Field>
          <Field label="Company">
            <input
              type="text"
              value={clientCompany}
              onChange={e => setClientCompany(e.target.value)}
              className="editorial-input"
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fee (USD)">
            <input
              type="number"
              step="0.01"
              value={feeAmount}
              onChange={e => setFeeAmount(e.target.value)}
              className="editorial-input"
              placeholder="997"
            />
          </Field>
          <Field label="Project period (days)">
            <input
              type="number"
              value={periodDays}
              onChange={e => setPeriodDays(e.target.value)}
              className="editorial-input"
              placeholder="14"
            />
          </Field>
        </div>
        <Field label="Scope summary (optional)">
          <textarea
            value={scopeSummary}
            onChange={e => setScopeSummary(e.target.value)}
            rows={3}
            className="editorial-input"
            style={{ resize: 'vertical' }}
            placeholder="Local SEO, GMB management, reputation, lead tracking"
          />
        </Field>

        {error && (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)', margin: 0 }}>{error}</p>
          </div>
        )}

        <div className="flex items-center justify-end">
          <button type="submit" disabled={creating || !clientName.trim()} className="editorial-btn-primary">
            {creating ? <Loader size={ICON.sm} className="animate-spin" /> : null}
            Create contract
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
