import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader, Check, AlertCircle, Save, EyeOff } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

// Admin-only page. Two policies live side-by-side:
//   - kind='amendment' — the AI judge for clause-change requests
//   - kind='downsell'  — the AI coach for churn / downsell conversations
//
// Each tab is its own insert-only history. Saving a new version of one kind
// only deactivates prior rows of THAT kind — they never interfere with each
// other. Migration 021 added the `kind` column and seeded an empty downsell
// row alongside the existing amendment policy.
const TABS = [
  {
    kind: 'amendment',
    label: 'Amendment',
    title: 'Amendment policy',
    blurb: 'The free-text rulebook the AI judge reads when a closer submits an amendment request. Be specific about what\'s allowed, what\'s grey-area, and what\'s hard-blacklisted. The judge will quote the policy back to you when it escalates.',
    placeholder: `Examples:

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
- Removal of auto-renewal entirely`,
  },
  {
    kind: 'downsell',
    label: 'Downsell',
    title: 'Downsell coach policy',
    blurb: 'The economic + leverage playbook the coach reads when a closer is trying to save a churning client. Encodes hard floors ($1,500 project, $500/mo monthly), mandatory items on churn (hosting, asset handover), financing terms, and the cash-collect leverage line.',
    placeholder: `Examples:

HARD FLOORS:
- Project floor: $1,500
- Monthly downsell floor: $500/mo (GBP + website mgmt + hosting)
- Hosting mandatory on churn: $50/mo or $489/yr upfront

CASH COLLECTION LEVERS:
- Upfront $2k = $2k. Split 2-pay = $2k + $2k. Monthly = $6k over time.
- Standard finance: $4,500 over 3 months ($1,500 × 3)
- Trial mandatory for new sign-ups, NOT for existing clients downselling

ON EXIT:
- Asset handover always (website, GBP, content, reports)
- If we built/host their site: hosting plan is mandatory or migrate off us`,
  },
]

export default function ContractsPolicy() {
  const { profile, isAdmin } = useAuth()
  const [activeTab, setActiveTab] = useState('amendment')
  // Per-tab state, keyed by kind, so switching tabs doesn't lose unsaved edits
  const [policies, setPolicies] = useState({ amendment: null, downsell: null })
  const [drafts, setDrafts]     = useState({ amendment: '', downsell: '' })
  const [histories, setHistories] = useState({ amendment: [], downsell: [] })
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [savedKind, setSavedKind] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data, error } = await supabase
        .from('contract_policy')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(40)
      if (cancelled) return
      if (error) { setError(error.message); setLoading(false); return }
      const rows = data || []
      const byKind = {
        amendment: rows.filter(r => (r.kind || 'amendment') === 'amendment'),
        downsell:  rows.filter(r => r.kind === 'downsell'),
      }
      const nextPolicies = {}
      const nextDrafts   = {}
      for (const kind of ['amendment','downsell']) {
        const active = byKind[kind].find(r => r.active) || null
        nextPolicies[kind] = active
        nextDrafts[kind]   = active?.policy_text || ''
      }
      setPolicies(nextPolicies)
      setDrafts(nextDrafts)
      setHistories(byKind)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function savePolicy() {
    const kind = activeTab
    const text = drafts[kind]
    if (!text.trim()) return
    setSaving(true); setError(null); setSavedKind(null)
    // Deactivate previous active rows OF THIS KIND ONLY. Without the .eq
    // on kind, saving a downsell version would silently flip the amendment
    // policy to inactive and break the judge function on the next request.
    const deactivate = await supabase
      .from('contract_policy')
      .update({ active: false })
      .eq('active', true)
      .eq('kind', kind)
    if (deactivate.error) { setError(deactivate.error.message); setSaving(false); return }
    // Insert new active version of this kind
    const { data, error: insertErr } = await supabase
      .from('contract_policy')
      .insert({
        policy_text: text,
        active: true,
        kind,
        updated_by: profile?.teamMemberId || null,
      })
      .select()
      .single()
    setSaving(false)
    if (insertErr) { setError(insertErr.message); return }
    setPolicies(prev => ({ ...prev, [kind]: data }))
    setHistories(prev => ({
      ...prev,
      [kind]: [data, ...prev[kind].map(r => ({ ...r, active: false }))],
    }))
    setSavedKind(kind)
    setTimeout(() => setSavedKind(null), 3000)
  }

  if (!isAdmin) {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center">
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>Admin only.</p>
      </div>
    )
  }

  const tab = TABS.find(t => t.kind === activeTab)
  const activePolicy = policies[activeTab]
  const draftText    = drafts[activeTab]
  const history      = histories[activeTab]

  return (
    <div className="max-w-[900px] mx-auto">
      <Link to="/sales/contracts" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All contracts
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Contracts · Policy</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          {tab.title.split(' ').slice(0, -1).join(' ')}{' '}
          <em style={{ fontStyle: 'italic' }}>{tab.title.split(' ').slice(-1)[0]}</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 640 }}>
          {tab.blurb}
        </p>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 mb-6" style={{ borderBottom: '1px solid var(--rule)' }}>
        {TABS.map(t => {
          const isActive = t.kind === activeTab
          return (
            <button
              key={t.kind}
              type="button"
              onClick={() => setActiveTab(t.kind)}
              style={{
                padding: '8px 14px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                background: 'transparent',
                color: isActive ? 'var(--ink)' : 'var(--ink-3)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Internal-data warning on the Downsell tab — this policy contains
          per-line COGS, margin formulas, and finance structure that should
          never be shared verbatim with closers or clients. Migration 022
          restricts API read to admin, but this is a visible reminder during
          any screen-share or pair-session. */}
      {activeTab === 'downsell' && (
        <div className="tile tile-feedback p-3 mb-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <EyeOff size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0, fontWeight: 500 }}>
              Internal — admin only.
            </p>
            <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '2px 0 0', lineHeight: 1.5 }}>
              Contains unit economics, COGS, and margin targets. The coach reads this to ground its
              recommendations; closers only see the coach's outputs in their chat. Don't share this verbatim or screen-share this tab.
            </p>
          </div>
        </div>
      )}

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
              value={draftText}
              onChange={e => setDrafts(prev => ({ ...prev, [activeTab]: e.target.value }))}
              rows={20}
              placeholder={tab.placeholder}
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
                Saving creates a new version of the <strong style={{ fontStyle: 'normal' }}>{tab.label.toLowerCase()}</strong> policy. Previous versions stay in history below.
              </span>
              <button onClick={savePolicy} disabled={saving || !draftText.trim()} className="editorial-btn-primary">
                {saving ? <Loader size={ICON.sm} className="animate-spin" /> : savedKind === activeTab ? <Check size={ICON.sm} /> : <Save size={ICON.sm} />}
                {savedKind === activeTab ? 'Saved' : 'Save new version'}
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
                      onClick={() => setDrafts(prev => ({ ...prev, [activeTab]: v.policy_text }))}
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
