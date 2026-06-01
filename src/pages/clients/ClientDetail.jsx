import { useState, useEffect } from 'react'
import { useParams, Link, NavLink, Outlet, Routes, Route, Navigate } from 'react-router-dom'
import { Loader, ChevronLeft, ExternalLink, Phone, MapPin, Users, Calendar, DollarSign, X, ArrowRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { buildValueReceipt, formatValueReceiptForSlack, ROI_TIER } from '../../lib/roi'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../hooks/useToast'
import ConveyorView from './ConveyorView'
import TouchpointsQueue from './TouchpointsQueue'

/*
  ClientDetail — the single-client deep view.

  Tabs:
    Overview      — hero metrics, status, latest activity, ROI receipt
    Conveyor      — lifecycle stages (onboarding → steady_state → renewal)
    Comms         — unified inbox: slack + email + sms + calls
    Touchpoints   — scheduled / queued / sent cadence items
    ROI           — full ROI calc with tier explanation
    Authority     — citations + profiles + entity signal
    Content       — blog + GBP + YouTube planner
    Reviews       — across all platforms

  This file ships the Overview + ROI tabs as MVP. The other tabs are
  stubbed with "Coming next" cards so the navigation is in place.
*/

const TIER_OPTIONS = [
  { value: 'maps_only',     label: 'Maps only' },
  { value: 'full_stack',    label: 'Full stack' },
  { value: 'custom',        label: 'Custom' },
  { value: 'retainer_only', label: 'Retainer only' },
]

function isDowngrade(fromTier, toTier) {
  // downgrade: moving to maps_only from full_stack or custom
  if (toTier !== 'maps_only') return false
  return fromTier === 'full_stack' || fromTier === 'custom'
}

const TABS = [
  { key: 'overview',    label: 'Overview',    path: '' },
  { key: 'conveyor',    label: 'Conveyor',    path: 'conveyor' },
  { key: 'comms',       label: 'Comms',       path: 'comms' },
  { key: 'touchpoints', label: 'Touchpoints', path: 'touchpoints' },
  { key: 'roi',         label: 'ROI',         path: 'roi' },
  { key: 'authority',   label: 'Authority',   path: 'authority' },
  { key: 'content',     label: 'Content',     path: 'content' },
  { key: 'reviews',     label: 'Reviews',     path: 'reviews' },
]

export default function ClientDetail() {
  const { slug } = useParams()
  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function refetch() {
    const { data, error: err } = await supabase
      .from('clients')
      .select('*')
      .eq('slug', slug)
      .single()
    if (err) { setError(err.message); return }
    setClient(data)
  }

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(null)
      const { data, error: err } = await supabase
        .from('clients')
        .select('*')
        .eq('slug', slug)
        .single()
      if (!mounted) return
      if (err) { setError(err.message); setLoading(false); return }
      setClient(data)
      setLoading(false)
    }
    load()
    return () => { mounted = false }
  }, [slug])

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader className="animate-spin text-zinc-400" /></div>
  }
  if (error || !client) {
    return (
      <div className="p-6">
        <Link to="/clients" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700">
          <ChevronLeft size={16} /> Back to all clients
        </Link>
        <div className="mt-6 p-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-700">
          {error || `Client "${slug}" not found.`}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="px-6 pt-6">
        <Link to="/clients" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700">
          <ChevronLeft size={16} /> All clients
        </Link>
      </div>

      <ClientHeader client={client} onConverted={refetch} onTierChanged={refetch} />

      <div className="border-b border-zinc-200">
        <div className="px-6 flex gap-1 overflow-x-auto">
          {TABS.map(tab => (
            <NavLink
              key={tab.key}
              end={tab.path === ''}
              to={`/clients/${client.slug}${tab.path ? '/' + tab.path : ''}`}
              className={({ isActive }) =>
                `px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  isActive
                    ? 'border-emerald-700 text-emerald-700'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </div>

      <Routes>
        <Route index element={<OverviewTab client={client} />} />
        <Route path="conveyor" element={<ConveyorTab client={client} />} />
        <Route path="comms" element={<CommsTab client={client} />} />
        <Route path="touchpoints" element={<TouchpointsTab client={client} />} />
        <Route path="roi" element={<ROITab client={client} />} />
        <Route path="authority" element={<AuthorityTab client={client} />} />
        <Route path="content" element={<ContentTab client={client} />} />
        <Route path="reviews" element={<ReviewsTab client={client} />} />
        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </div>
  )
}

function ClientHeader({ client, onConverted, onTierChanged }) {
  const [convertOpen, setConvertOpen] = useState(false)
  const [tierOpen, setTierOpen] = useState(false)

  const showConvert = client.status === 'trial'
  const showChangeTier = client.status === 'active' && !!client.tier

  return (
    <div className="px-6 pt-4 pb-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">{client.business_name}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-zinc-500">
            <span className="inline-flex items-center gap-1"><MapPin size={14} />{client.primary_city}, {client.state_abbr}</span>
            <span>·</span>
            <span className="capitalize">{client.vertical}</span>
            <span>·</span>
            <span className="capitalize">{client.status}</span>
            {client.tier && <>
              <span>·</span>
              <span className="capitalize">{String(client.tier).replace(/_/g, ' ')}</span>
            </>}
            {client.custom_domain && <>
              <span>·</span>
              <a href={`https://${client.custom_domain}`} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                {client.custom_domain} <ExternalLink size={12} />
              </a>
            </>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {client.primary_am && (
            <span className="px-3 py-1.5 bg-zinc-100 rounded-md text-xs font-medium text-zinc-700">
              AM: {client.primary_am}
            </span>
          )}
          {showConvert && (
            <button
              type="button"
              onClick={() => setConvertOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-md text-xs font-medium transition-colors"
            >
              <ArrowRight size={14} /> Convert to active
            </button>
          )}
          {showChangeTier && (
            <button
              type="button"
              onClick={() => setTierOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-zinc-300 hover:border-emerald-700 hover:text-emerald-700 text-zinc-700 rounded-md text-xs font-medium transition-colors"
            >
              <ArrowRight size={14} /> Change tier
            </button>
          )}
        </div>
      </div>

      {convertOpen && (
        <ConvertClientModal
          client={client}
          onClose={() => setConvertOpen(false)}
          onSuccess={() => { setConvertOpen(false); onConverted && onConverted() }}
        />
      )}
      {tierOpen && (
        <ChangeTierModal
          client={client}
          onClose={() => setTierOpen(false)}
          onSuccess={() => { setTierOpen(false); onTierChanged && onTierChanged() }}
        />
      )}
    </div>
  )
}

function ChangeTierModal({ client, onClose, onSuccess }) {
  const toast = useToast()
  const { profile } = useAuth()
  const [toTier, setToTier] = useState('')
  const [reason, setReason] = useState('')
  const [triggeredBy, setTriggeredBy] = useState(profile?.name || profile?.email || '')
  const [submitting, setSubmitting] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const fromTier = client.tier
  const tierOptions = TIER_OPTIONS.filter(t => t.value !== fromTier)
  const downgrade = toTier && isDowngrade(fromTier, toTier)

  function fmtTier(t) {
    const found = TIER_OPTIONS.find(x => x.value === t)
    return found ? found.label : (t || '—')
  }

  async function doSubmit() {
    setSubmitting(true)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/client-tier-transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          client_id: client.id,
          to_tier: toTier,
          reason,
          triggered_by: triggeredBy,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        toast.error(`Tier change failed: ${data.error || res.statusText}`)
        return
      }
      const sideEffects = data.side_effects_fired ?? data.side_effects?.length ?? data.fired ?? 0
      toast.success(`Tier changed: ${fmtTier(fromTier)} → ${fmtTier(toTier)} · ${sideEffects} side effects fired`)
      onSuccess && onSuccess()
    } catch (e) {
      toast.error(`Tier change failed: ${e.message}`)
    } finally {
      setSubmitting(false)
      setConfirming(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    if (!toTier) { toast.error('Pick a target tier'); return }
    if (!reason.trim()) { toast.error('Reason is required'); return }
    if (!triggeredBy.trim()) { toast.error('Triggered by is required'); return }
    if (downgrade) {
      setConfirming(true)
      return
    }
    doSubmit()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200">
          <h2 className="text-lg font-semibold text-zinc-900">Change tier</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {confirming ? (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
              <div className="flex-1">
                <div className="text-sm font-semibold text-amber-900">Downgrade confirmation</div>
                <div className="text-sm text-amber-800 mt-1">
                  Moving {client.business_name} from {fmtTier(fromTier)} to {fmtTier(toTier)} is a downgrade.
                  Side effects will fire (paused services, refund prorations, Slack notifications).
                  This cannot be undone in one click.
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={submitting}
                className="px-3 py-1.5 text-sm text-zinc-700 hover:text-zinc-900"
              >
                Back
              </button>
              <button
                type="button"
                onClick={doSubmit}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-md text-sm font-medium disabled:opacity-60"
              >
                {submitting && <Loader size={14} className="animate-spin" />}
                Confirm downgrade
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Current tier</div>
              <div className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-md text-sm text-zinc-700">
                {fmtTier(fromTier)}
              </div>
            </div>

            <label className="block">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Move to tier</div>
              <select
                value={toTier}
                onChange={e => setToTier(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
                required
              >
                <option value="">Select a tier</option>
                {tierOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Reason</div>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                required
                placeholder="why this tier change, in plain words"
                className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
              />
            </label>

            <label className="block">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Triggered by</div>
              <input
                type="text"
                value={triggeredBy}
                onChange={e => setTriggeredBy(e.target.value)}
                required
                className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
              />
            </label>

            {downgrade && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                This is a downgrade. You will be asked to confirm before it fires.
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-zinc-700 hover:text-zinc-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-md text-sm font-medium disabled:opacity-60"
              >
                {submitting && <Loader size={14} className="animate-spin" />}
                {downgrade ? 'Review downgrade' : 'Change tier'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ConvertClientModal — trial to active conversion.
// Calls client-conversion edge fn, auto-detects latest handoff_briefs row,
// then refetches the client on success so the header re-renders without the Convert button.
function ConvertClientModal({ client, onClose, onSuccess }) {
  const { profile, session } = useAuth()
  const toast = useToast()
  const today = new Date().toISOString().slice(0, 10)
  const defaultConvertedBy = profile?.name || profile?.email || session?.user?.email || ''

  const [form, setForm] = useState({
    to_tier: 'full_stack',
    monthly_fee: '',
    contract_start: today,
    contract_end: '',
    converted_by: defaultConvertedBy,
    notes: '',
  })
  const [handoffBrief, setHandoffBrief] = useState(null)
  const [handoffLoading, setHandoffLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // auto-detect latest handoff_briefs row for this client
  useEffect(() => {
    let mounted = true
    async function loadHandoff() {
      const { data, error } = await supabase
        .from('handoff_briefs')
        .select('id, created_at, source')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!mounted) return
      if (!error && data) setHandoffBrief(data)
      setHandoffLoading(false)
    }
    loadHandoff()
    return () => { mounted = false }
  }, [client.id])

  function update(key, value) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)

    try {
      const body = {
        client_id: client.id,
        to_tier: form.to_tier,
        monthly_fee: form.monthly_fee === '' ? null : Number(form.monthly_fee),
        contract_start: form.contract_start || null,
        contract_end: form.contract_end || null,
        converted_by: form.converted_by || null,
        notes: form.notes || null,
        handoff_brief_id: handoffBrief?.id || null,
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const accessToken = session?.access_token

      const res = await fetch(`${supabaseUrl}/functions/v1/client-conversion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken || anonKey}`,
          'apikey': anonKey,
        },
        body: JSON.stringify(body),
      })

      const json = await res.json().catch(() => ({}))

      if (!res.ok || json?.error) {
        throw new Error(json?.error || json?.message || `Conversion failed (${res.status})`)
      }

      const sideEffectCount =
        json?.side_effects_count ??
        json?.side_effects_fired ??
        (Array.isArray(json?.side_effects) ? json.side_effects.length : null) ??
        (Array.isArray(json?.fired) ? json.fired.length : null) ??
        0

      toast.success(`Converted to active · ${sideEffectCount} side effects fired`, {
        title: client.business_name,
      })
      onSuccess && onSuccess()
    } catch (err) {
      toast.error(err?.message || 'Conversion failed', { title: 'Could not convert' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border border-zinc-200 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-zinc-200">
          <div>
            <div
              className="text-[11px] uppercase tracking-wider text-zinc-500"
              style={{ fontFamily: 'var(--mono, "JetBrains Mono"), ui-monospace, monospace' }}
            >
              Trial to active
            </div>
            <h2
              className="text-lg font-semibold text-zinc-900 mt-0.5"
              style={{ fontFamily: 'var(--display, "Inter Tight"), system-ui, sans-serif', fontWeight: 900, letterSpacing: '-0.01em' }}
            >
              Convert {client.business_name}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <label className="block">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Tier</div>
            <select
              value={form.to_tier}
              onChange={e => update('to_tier', e.target.value)}
              className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700 bg-white"
            >
              <option value="maps_only">maps_only</option>
              <option value="full_stack">full_stack</option>
              <option value="custom">custom</option>
              <option value="retainer_only">retainer_only</option>
            </select>
          </label>

          <label className="block">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Monthly fee ($)</div>
            <input
              type="number"
              min="0"
              step="1"
              value={form.monthly_fee}
              onChange={e => update('monthly_fee', e.target.value)}
              placeholder="optional"
              className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
              style={{ fontFamily: 'var(--mono, "JetBrains Mono"), ui-monospace, monospace' }}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Contract start</div>
              <input
                type="date"
                value={form.contract_start}
                onChange={e => update('contract_start', e.target.value)}
                className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
              />
            </label>
            <label className="block">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Contract end</div>
              <input
                type="date"
                value={form.contract_end}
                onChange={e => update('contract_end', e.target.value)}
                className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
              />
            </label>
          </div>

          <label className="block">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Converted by</div>
            <input
              type="text"
              value={form.converted_by}
              onChange={e => update('converted_by', e.target.value)}
              className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
            />
          </label>

          <label className="block">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Notes</div>
            <textarea
              value={form.notes}
              onChange={e => update('notes', e.target.value)}
              rows={3}
              placeholder="optional context for the conveyor log"
              className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700 resize-y"
            />
          </label>

          <div className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-md">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Handoff brief</div>
            <div
              className="text-sm text-zinc-700"
              style={{ fontFamily: 'var(--mono, "JetBrains Mono"), ui-monospace, monospace' }}
            >
              {handoffLoading
                ? 'looking up latest...'
                : handoffBrief
                  ? `${handoffBrief.id} · ${new Date(handoffBrief.created_at).toLocaleDateString()}${handoffBrief.source ? ' · ' + handoffBrief.source : ''}`
                  : 'none found · conversion will run without it'}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? <><Loader size={14} className="animate-spin" /> Converting...</> : <>Convert to active <ArrowRight size={14} /></>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function OverviewTab({ client }) {
  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
      <MetricCard label="Monthly fee" value={client.monthly_fee ? `$${Number(client.monthly_fee).toLocaleString()}` : '—'} />
      <MetricCard label="Tier" value={client.tier || '—'} />
      <MetricCard label="Path" value={client.path} />
      <MetricCard label="Started" value={client.contract_start ? new Date(client.contract_start).toLocaleDateString() : '—'} />
      <MetricCard label="Comms freq" value={client.communication_frequency} />
      <MetricCard label="Cloudflare project" value={client.cf_project_name || '—'} />
      <div className="md:col-span-3 p-4 bg-white border border-zinc-200 rounded-lg">
        <h3 className="font-semibold text-zinc-900 mb-2">Next steps</h3>
        <p className="text-sm text-zinc-500">Touchpoints, recent activity, and the value receipt land here in the next build step.</p>
      </div>
    </div>
  )
}

function ROITab({ client }) {
  const [inputs, setInputs] = useState({
    organic_sessions: 0,
    organic_cpc_avg: 0,
    qualified_leads: 0,
    close_rate: 0,
    avg_job_value: 0,
    closed_jobs_reported: 0,
    avg_value_reported: 0,
    monthly_fee: client.monthly_fee || 0,
    period_label: 'this week',
  })

  useEffect(() => {
    setInputs(prev => ({ ...prev, monthly_fee: client.monthly_fee || 0 }))
  }, [client.monthly_fee])

  const receipt = buildValueReceipt(inputs)

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <h3 className="font-semibold text-zinc-900">Inputs</h3>
        <Field label="Period" type="text" value={inputs.period_label} onChange={v => setInputs({ ...inputs, period_label: v })} />
        <Field label="Monthly fee ($)" type="number" value={inputs.monthly_fee} onChange={v => setInputs({ ...inputs, monthly_fee: +v })} />
        <hr className="border-zinc-200" />
        <Field label="Organic sessions" type="number" value={inputs.organic_sessions} onChange={v => setInputs({ ...inputs, organic_sessions: +v })} />
        <Field label="Avg organic CPC ($)" type="number" value={inputs.organic_cpc_avg} onChange={v => setInputs({ ...inputs, organic_cpc_avg: +v })} />
        <hr className="border-zinc-200" />
        <Field label="Qualified leads" type="number" value={inputs.qualified_leads} onChange={v => setInputs({ ...inputs, qualified_leads: +v })} />
        <Field label="Close rate (0-1)" type="number" step="0.01" value={inputs.close_rate} onChange={v => setInputs({ ...inputs, close_rate: +v })} />
        <Field label="Avg job value ($)" type="number" value={inputs.avg_job_value} onChange={v => setInputs({ ...inputs, avg_job_value: +v })} />
        <hr className="border-zinc-200" />
        <Field label="Closed jobs reported" type="number" value={inputs.closed_jobs_reported} onChange={v => setInputs({ ...inputs, closed_jobs_reported: +v })} />
        <Field label="Avg value reported ($)" type="number" value={inputs.avg_value_reported} onChange={v => setInputs({ ...inputs, avg_value_reported: +v })} />
      </div>

      <div className="bg-white border border-zinc-200 rounded-lg p-6">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Value receipt</div>
        <div className="text-xl font-semibold text-zinc-900 mb-4">{receipt.headline}</div>
        {receipt.tier && (
          <>
            <div className="flex items-baseline gap-3 mb-4">
              <div className="text-4xl font-bold text-emerald-700">
                ${receipt.value.toLocaleString()}
              </div>
              {receipt.roi_pct != null && (
                <div className="text-sm text-zinc-500">
                  ROI {receipt.roi_multiplier >= 10 ? `${receipt.roi_multiplier.toFixed(1)}x` : `${receipt.roi_pct}%`}
                </div>
              )}
            </div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">How we got there</div>
            <ul className="space-y-1 text-sm text-zinc-700">
              {receipt.basis.map((b, i) => <li key={i}>• {b}</li>)}
            </ul>
            <div className="mt-6 pt-4 border-t border-zinc-100">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Tier</div>
              <div className="text-sm text-zinc-700 capitalize">{receipt.tier_label}</div>
            </div>
            <div className="mt-4 pt-4 border-t border-zinc-100">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Slack-ready text</div>
              <pre className="text-xs text-zinc-700 whitespace-pre-wrap bg-zinc-50 p-3 rounded border border-zinc-100">{formatValueReceiptForSlack(receipt)}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', step }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{label}</div>
      <input
        type={type}
        step={step}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
      />
    </label>
  )
}

function MetricCard({ label, value }) {
  return (
    <div className="p-4 bg-white border border-zinc-200 rounded-lg">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-zinc-900">{value}</div>
    </div>
  )
}

function StubTab({ title, children }) {
  return (
    <div className="p-6">
      <h3 className="font-semibold text-zinc-900 mb-2">{title}</h3>
      <p className="text-sm text-zinc-500">{children}</p>
    </div>
  )
}

function ConveyorTab({ client }) {
  return <ConveyorView client={client} />
}
function CommsTab({ client }) {
  return <StubTab title="Comms">Unified timeline of Slack + email + SMS + calls. Reads from client_communications. Acknowledgment agent posts here. Wired next session once OpenPhone + Slack tokens are in place.</StubTab>
}
function TouchpointsTab({ client }) {
  return <TouchpointsQueue client={client} />
}
function AuthorityTab({ client }) {
  return <StubTab title="Authority">Citation health + profile network (LinkedIn, Apple Business, Bing Places, etc.) + entity signal score.</StubTab>
}
function ContentTab({ client }) {
  return <StubTab title="Content">Blog calendar + GBP post planner + YouTube content brief generator.</StubTab>
}
function ReviewsTab({ client }) {
  const [stats, setStats] = useState(null)
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      try {
        const { pulseAdmin, pulseSlugForClient } = await import('../../lib/pulse')
        const slug = pulseSlugForClient(client.slug)
        const ws = await pulseAdmin.getWorkspaceBySlug(slug).catch(() => null)
        if (!ws) {
          if (mounted) { setError('No Pulse workspace yet — created automatically on next client onboarding.'); setLoading(false) }
          return
        }
        const [s, r] = await Promise.all([
          pulseAdmin.getReviewStats(ws.id, { period_days: 30 }).catch(() => null),
          pulseAdmin.listReviews(ws.id, { limit: 20 }).catch(() => []),
        ])
        if (!mounted) return
        setStats(s); setReviews(Array.isArray(r) ? r : (r?.data || []))
      } catch (e) {
        if (mounted) setError(e.message)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [client.slug])

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-zinc-900">Reviews</h3>
          <p className="text-sm text-zinc-500 mt-0.5">Powered by Pulse (pulse.rankonmaps.io). 4-5★ route to Google review, 1-3★ route to private feedback.</p>
        </div>
      </div>
      {loading && <Loader className="animate-spin text-zinc-400" />}
      {error && <div className="p-3 bg-zinc-50 border border-zinc-200 rounded text-sm text-zinc-500">{error}</div>}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <MetricCard label="Total reviews" value={stats.total_reviews ?? '—'} />
          <MetricCard label="Avg rating" value={stats.avg_rating ? stats.avg_rating.toFixed(1) : '—'} />
          <MetricCard label="New (30d)" value={stats.new_30d ?? '—'} />
          <MetricCard label="Funnel rate" value={stats.gating_funnel_pct ? `${stats.gating_funnel_pct}%` : '—'} />
        </div>
      )}
      {reviews.length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-lg">
          <div className="px-4 py-2 border-b border-zinc-100 font-medium text-sm">Recent reviews</div>
          <ul className="divide-y divide-zinc-100">
            {reviews.slice(0, 10).map((r, i) => (
              <li key={r.id || i} className="px-4 py-3 text-sm">
                <div className="font-medium text-zinc-900">{'★'.repeat(r.rating || 0)} <span className="text-zinc-500">{r.reviewer_name || 'Anonymous'}</span></div>
                {r.review_text && <div className="text-zinc-600 mt-0.5 line-clamp-2">{r.review_text}</div>}
                <div className="text-xs text-zinc-400 mt-0.5">{r.platform} · {r.reviewed_at}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
