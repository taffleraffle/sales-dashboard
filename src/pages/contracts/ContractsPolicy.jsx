import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader, Check, AlertCircle, Save } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// Admin-only page. Lists the current active policy + lets you write a new
// version. A new version = an insert into contract_policy with active=true;
// the previous active row is set to active=false in the same call.
export default function ContractsPolicy() {
  const { profile, isAdmin } = useAuth()
  const [activePolicy, setActivePolicy] = useState(null)
  const [policyText, setPolicyText]     = useState('')
  const [history, setHistory]           = useState([])
  const [loading, setLoading]           = useState(true)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)
  const [saved, setSaved]               = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data, error } = await supabase
        .from('contract_policy')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)
      if (cancelled) return
      if (error) { setError(error.message); setLoading(false); return }
      const active = (data || []).find(r => r.active) || null
      setActivePolicy(active)
      setPolicyText(active?.policy_text || '')
      setHistory(data || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function savePolicy() {
    if (!policyText.trim()) return
    setSaving(true); setError(null); setSaved(false)
    // Deactivate previous active rows
    const deactivate = await supabase
      .from('contract_policy')
      .update({ active: false })
      .eq('active', true)
    if (deactivate.error) { setError(deactivate.error.message); setSaving(false); return }
    // Insert new active version
    const { data, error: insertErr } = await supabase
      .from('contract_policy')
      .insert({
        policy_text: policyText,
        active: true,
        updated_by: profile?.team_member_id || null,
      })
      .select()
      .single()
    setSaving(false)
    if (insertErr) { setError(insertErr.message); return }
    setActivePolicy(data)
    setHistory(prev => [data, ...prev.map(r => ({ ...r, active: false }))])
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  if (!isAdmin) {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center">
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>Admin only.</p>
      </div>
    )
  }

  return (
    <div className="max-w-[900px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · Policy</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Amendment <em style={{ fontStyle: 'italic' }}>policy</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 640 }}>
          This is the free-text rulebook the AI judge reads when a closer submits an amendment request.
          Be specific about what's allowed, what's grey-area, and what's hard-blacklisted.
          The judge will quote the policy back to you when it escalates.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
        </div>
      )}

      {!loading && (
        <>
          <div className="tile tile-feedback p-6 mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="eyebrow eyebrow-bare">Active policy</span>
              {activePolicy && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                  Last updated {new Date(activePolicy.created_at).toLocaleString()}
                </span>
              )}
            </div>
            <textarea
              value={policyText}
              onChange={e => setPolicyText(e.target.value)}
              rows={20}
              placeholder={`Examples:

ALLOW (auto-apply):
- Spelling and contact-info corrections
- Adding specific target keywords to scope
- Reducing dishonour fee to actual processor cost
- Adding a 3-5 business-day grace period before late-payment interest kicks in

GREY (escalate to Ben):
- Raising liability cap above 6 months of fees
- Shortening cancellation notice below 30 days
- Adding right of subcontractor approval

BLOCK (auto-reject):
- Removing Direct Debit / switching to manual invoicing
- IP vesting with client before completion + payment of outstanding invoices
- Indefinite work-for-free guarantees with no 90-day cap
- Disclosure of vendor lists, contractor identities, or backlink sources
- Satisfaction-based cancellation with refund
- Removal of auto-renewal entirely`}
              className="w-full font-mono"
              style={{
                fontSize: 13,
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                borderRadius: 3,
                color: 'var(--ink)',
                padding: 12,
                fontFamily: 'var(--mono)',
                resize: 'vertical',
                lineHeight: 1.6,
              }}
            />
            {error && (
              <div className="flex items-start gap-2 mt-3">
                <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
                <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)', margin: 0 }}>{error}</p>
              </div>
            )}
            <div className="flex items-center justify-between mt-4">
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                Saving creates a new version. Previous versions stay in history below — you can roll back any time.
              </span>
              <button onClick={savePolicy} disabled={saving || !policyText.trim()} className="editorial-btn-primary">
                {saving ? <Loader size={ICON.sm} className="animate-spin" /> : saved ? <Check size={ICON.sm} /> : <Save size={ICON.sm} />}
                {saved ? 'Saved' : 'Save new version'}
              </button>
            </div>
          </div>

          {history.length > 1 && (
            <div className="tile tile-feedback p-6">
              <span className="eyebrow eyebrow-bare">Version history</span>
              <div className="space-y-2 mt-3">
                {history.map(v => (
                  <div key={v.id} className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--rule)' }}>
                    <div>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)' }}>
                        {new Date(v.created_at).toLocaleString()}
                      </span>
                      {v.active && (
                        <span className="ml-2" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--up)' }}>
                          Active
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => setPolicyText(v.policy_text)}
                      className="editorial-btn-ghost"
                      style={{ fontSize: 11 }}
                    >
                      Load into editor
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
