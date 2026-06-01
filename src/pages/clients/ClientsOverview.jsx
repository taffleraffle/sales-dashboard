import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Loader, Plus, Search, TrendingUp, TrendingDown, AlertCircle, Phone, MapPin } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  ClientsOverview — the agency-wide grid of every client.

  Powered by 100_client_management.sql. Each card surfaces the
  highest-signal metrics for an AM glancing at their portfolio:
  status (trial/active/needs-attention), recent lead volume,
  current Map Pack position, days into engagement.

  Click-through goes to /clients/<slug> for the per-client deep view.
*/

const STATUS_COLOR = {
  lead:        { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-400' },
  onboarding:  { bg: 'bg-blue-50',   text: 'text-blue-700',  dot: 'bg-blue-500' },
  trial:       { bg: 'bg-amber-50',  text: 'text-amber-700', dot: 'bg-amber-500' },
  active:      { bg: 'bg-emerald-50',text: 'text-emerald-700', dot: 'bg-emerald-500' },
  paused:      { bg: 'bg-zinc-100',  text: 'text-zinc-600',  dot: 'bg-zinc-400' },
  churned:     { bg: 'bg-rose-50',   text: 'text-rose-700',  dot: 'bg-rose-500' },
}

const VERTICAL_LABEL = {
  roofing: 'Roofing',
  hvac: 'HVAC',
  plumbing: 'Plumbing',
  landscaping: 'Landscaping',
  dental: 'Dental',
  legal: 'Legal',
  restoration: 'Restoration',
  other: 'Other',
}

function daysSince(d) {
  if (!d) return null
  const start = new Date(d).getTime()
  const now = Date.now()
  return Math.floor((now - start) / (1000 * 60 * 60 * 24))
}

function StatusPill({ status }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.lead
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  )
}

function ClientCard({ client }) {
  const days = daysSince(client.contract_start)
  const isTrial = client.status === 'trial'
  const trialDayCount = isTrial && client.contract_start ? daysSince(client.contract_start) : null

  return (
    <Link
      to={`/clients/${client.slug}`}
      className="group block p-5 bg-white rounded-lg border border-zinc-200 hover:border-emerald-700 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-zinc-900 truncate group-hover:text-emerald-700">
            {client.business_name}
          </h3>
          <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
            <MapPin size={12} />
            <span>{client.primary_city}, {client.state_abbr}</span>
            <span className="text-zinc-300">·</span>
            <span>{VERTICAL_LABEL[client.vertical] || client.vertical}</span>
          </div>
        </div>
        <StatusPill status={client.status} />
      </div>

      <div className="grid grid-cols-3 gap-3 pt-3 border-t border-zinc-100">
        <div>
          <div className="text-xs text-zinc-500">Leads (30d)</div>
          <div className="font-semibold text-zinc-900">{client._lead_count_30d ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Fee/mo</div>
          <div className="font-semibold text-zinc-900">
            {client.monthly_fee ? `$${Number(client.monthly_fee).toLocaleString()}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">
            {isTrial ? 'Trial day' : 'Days in'}
          </div>
          <div className="font-semibold text-zinc-900">
            {isTrial && trialDayCount != null ? `${trialDayCount}/14` : (days != null ? days : '—')}
          </div>
        </div>
      </div>

      {client._flag_count > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-100 flex items-center gap-1.5 text-xs text-amber-700">
          <AlertCircle size={14} />
          <span>{client._flag_count} {client._flag_count === 1 ? 'flag' : 'flags'} need attention</span>
        </div>
      )}
    </Link>
  )
}

export default function ClientsOverview() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterVertical, setFilterVertical] = useState('all')

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: clientsData, error: clientsErr } = await supabase
          .from('clients')
          .select('id, slug, business_name, vertical, status, primary_city, state_abbr, monthly_fee, contract_start, trial_ends_at, primary_am')
          .order('created_at', { ascending: false })

        if (clientsErr) throw clientsErr

        // Best-effort enrichment — lead counts last 30 days
        const since = new Date()
        since.setDate(since.getDate() - 30)
        const enriched = await Promise.all(
          (clientsData || []).map(async (c) => {
            const [{ count: leadCount }, { count: flagCount }] = await Promise.all([
              supabase
                .from('client_leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', c.id)
                .gte('created_at', since.toISOString()),
              supabase
                .from('client_communications')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', c.id)
                .eq('direction', 'inbound')
                .is('acknowledged_at', null),
            ])
            return { ...c, _lead_count_30d: leadCount ?? 0, _flag_count: flagCount ?? 0 }
          })
        )

        if (mounted) setClients(enriched)
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [])

  const filtered = clients.filter(c => {
    if (filterStatus !== 'all' && c.status !== filterStatus) return false
    if (filterVertical !== 'all' && c.vertical !== filterVertical) return false
    if (search) {
      const s = search.toLowerCase()
      if (!c.business_name.toLowerCase().includes(s)
          && !(c.primary_city || '').toLowerCase().includes(s)
          && !(c.slug || '').toLowerCase().includes(s)) return false
    }
    return true
  })

  const counts = clients.reduce((acc, c) => {
    acc.total += 1
    acc[c.status] = (acc[c.status] || 0) + 1
    return acc
  }, { total: 0 })

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Clients</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {counts.total} total · {counts.active || 0} active · {counts.trial || 0} on trial · {counts.onboarding || 0} onboarding
          </p>
        </div>
        <Link
          to="/clients/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 transition-colors font-medium text-sm"
        >
          <Plus size={16} />
          New client
        </Link>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search clients, cities, slugs..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-3 py-2 border border-zinc-200 rounded-lg focus:outline-none focus:border-emerald-700 text-sm"
          />
        </div>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:border-emerald-700"
        >
          <option value="all">All statuses</option>
          <option value="lead">Lead</option>
          <option value="onboarding">Onboarding</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="churned">Churned</option>
        </select>
        <select
          value={filterVertical}
          onChange={e => setFilterVertical(e.target.value)}
          className="px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:border-emerald-700"
        >
          <option value="all">All verticals</option>
          <option value="roofing">Roofing</option>
          <option value="hvac">HVAC</option>
          <option value="plumbing">Plumbing</option>
          <option value="landscaping">Landscaping</option>
          <option value="dental">Dental</option>
          <option value="legal">Legal</option>
          <option value="restoration">Restoration</option>
          <option value="other">Other</option>
        </select>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader className="animate-spin" size={32} />
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-sm">
          Failed to load clients: {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-20 text-zinc-500">
          {clients.length === 0
            ? <div>
                <p className="font-medium mb-2">No clients yet.</p>
                <p className="text-sm">Click "New client" to create your first record, or import from GHL.</p>
              </div>
            : <p>No clients match your filters.</p>}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(c => <ClientCard key={c.id} client={c} />)}
        </div>
      )}
    </div>
  )
}
