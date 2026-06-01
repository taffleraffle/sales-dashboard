import { useState, useEffect } from 'react'
import { useParams, Link, NavLink, Outlet, Routes, Route, Navigate } from 'react-router-dom'
import { Loader, ChevronLeft, ExternalLink, Phone, MapPin, Users, Calendar, DollarSign } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { buildValueReceipt, formatValueReceiptForSlack, ROI_TIER } from '../../lib/roi'
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

      <ClientHeader client={client} />

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

function ClientHeader({ client }) {
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
        </div>
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
