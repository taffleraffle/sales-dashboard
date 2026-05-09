import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertTriangle, Search, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import AddComponentModal from './AddComponentModal'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtPctRatio(n) { return n == null || isNaN(n) ? '—' : `${(n * 100).toFixed(2)}%` }
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }

const STATUS_TONE = {
  concept:        'bg-bg-card-hover text-text-400 border-border-default',
  in_production:  'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30',
  ready:          'bg-success/15 text-success border-success/30',
  retired:        'bg-bg-card-hover text-text-400 border-border-default opacity-60',
}

// Renders a sortable table of components of a given type, joined to the
// library.component_performance materialized view for weighted rollup metrics.
//
// Used by all 4 library tabs (Hooks, Bodies, Scenes, Creators).
export default function ComponentTable({ type, title, emptyHint }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('total_spend_desc')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Read both views in parallel — component_performance gives weighted
      // rates but only includes components that have linked variants. We also
      // pull lib_components directly so newly-added rows appear immediately
      // (with zero stats) before any variants reference them.
      const [perfRes, compRes] = await Promise.all([
        supabase.from('lib_component_performance').select('*').eq('type', type),
        supabase.from('lib_components').select('*').eq('type', type),
      ])
      if (perfRes.error) throw new Error(perfRes.error.message)
      if (compRes.error) throw new Error(compRes.error.message)
      const perfMap = {}
      for (const p of perfRes.data || []) perfMap[p.component_id] = p
      const merged = (compRes.data || []).map(c => ({
        component_id: c.component_id,
        component_id_uuid: c.id,
        type: c.type,
        label: c.label,
        status: c.status,
        ...(perfMap[c.component_id] || {}),
        // Always overwrite these from lib_components in case a stale perf row exists
        component_id_uuid_canonical: c.id,
      }))
      setRows(merged)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [type])

  useEffect(() => {
    let cancelled = false
    load().catch(() => {})
    return () => { cancelled = true }
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .filter(r => !q || (r.label || '').toLowerCase().includes(q) || (r.component_id || '').toLowerCase().includes(q))
      .sort((a, b) => {
        switch (sortBy) {
          case 'total_spend_desc': return (b.total_spend || 0) - (a.total_spend || 0)
          case 'cpa_asc':          return (a.cpa ?? Infinity) - (b.cpa ?? Infinity)
          case 'hook_rate_desc':   return (b.weighted_hook_rate || 0) - (a.weighted_hook_rate || 0)
          case 'hold_rate_desc':   return (b.weighted_hold_rate || 0) - (a.weighted_hold_rate || 0)
          case 'ctr_desc':         return (b.weighted_ctr || 0) - (a.weighted_ctr || 0)
          case 'variants_desc':    return (b.variant_count || 0) - (a.variant_count || 0)
          case 'name_asc':         return (a.label || '').localeCompare(b.label || '')
          default: return 0
        }
      })
  }, [rows, statusFilter, search, sortBy])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div>
      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100">dismiss</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-text-secondary">{filtered.length} of {rows.length} {title.toLowerCase()}</p>
        <button
          onClick={() => { setEditing(null); setModalOpen(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-opt-yellow/15 border border-opt-yellow/40 text-opt-yellow rounded-lg hover:bg-opt-yellow/20"
        >
          <Plus size={13} /> Add {title.replace(/s$/, '').toLowerCase()}
        </button>
      </div>

      <div className="bg-bg-card border border-border-default rounded-2xl p-3 mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex gap-1">
          {['all', 'ready', 'in_production', 'concept', 'retired'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                statusFilter === s
                  ? 'bg-opt-yellow/15 border-opt-yellow/40 text-opt-yellow'
                  : 'border-border-default text-text-secondary hover:bg-bg-card-hover'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 bg-bg-primary border border-border-default rounded-lg px-2 py-1 sm:w-60 flex-1 sm:flex-none">
          <Search size={12} className="text-text-400" />
          <input
            type="search"
            placeholder={`Search ${title.toLowerCase()}…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-xs text-text-primary outline-none w-full"
          />
        </div>
        <div className="sm:ml-auto flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-400">Sort</span>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary"
          >
            <option value="total_spend_desc">Highest spend</option>
            <option value="cpa_asc">Lowest CPA</option>
            <option value="hook_rate_desc">Best hook rate</option>
            <option value="hold_rate_desc">Best hold rate</option>
            <option value="ctr_desc">Best CTR</option>
            <option value="variants_desc">Most variants</option>
            <option value="name_asc">A → Z</option>
          </select>
        </div>
      </div>

      {!filtered.length ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
          {rows.length === 0 ? (emptyHint || `No ${title.toLowerCase()} in the library yet.`) : `No ${title.toLowerCase()} match the current filter.`}
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border-default">
                <th className="text-left px-3 py-2 font-normal">ID</th>
                <th className="text-left px-3 py-2 font-normal">Label</th>
                <th className="text-left px-3 py-2 font-normal">Status</th>
                <th className="text-right px-3 py-2 font-normal">Variants</th>
                <th className="text-right px-3 py-2 font-normal">Live</th>
                <th className="text-right px-3 py-2 font-normal">Spend</th>
                <th className="text-right px-3 py-2 font-normal">Hook%</th>
                <th className="text-right px-3 py-2 font-normal">Hold%</th>
                <th className="text-right px-3 py-2 font-normal">CTR</th>
                <th className="text-right px-3 py-2 font-normal">CPA</th>
                <th className="text-right px-3 py-2 font-normal w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const tone = STATUS_TONE[r.status] || STATUS_TONE.concept
                return (
                  <tr key={r.component_id} className="border-b border-border-default/40 hover:bg-bg-card-hover transition-colors">
                    <td className="px-3 py-2">
                      <Link to={`/sales/ads/components/${encodeURIComponent(r.component_id)}`} className="text-opt-yellow font-mono text-[11px] hover:underline">
                        {r.component_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-text-primary">{r.label}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${tone}`}>
                        {r.status?.replace('_', ' ') || 'concept'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{fmtN(r.variant_count)}</td>
                    <td className="px-3 py-2 text-right">{fmtN(r.live_variant_count)}</td>
                    <td className="px-3 py-2 text-right">{fmt$((r.total_spend || 0) * NZD_TO_USD)}</td>
                    <td className="px-3 py-2 text-right">{fmtPctRatio(r.weighted_hook_rate)}</td>
                    <td className="px-3 py-2 text-right">{fmtPctRatio(r.weighted_hold_rate)}</td>
                    <td className="px-3 py-2 text-right">{fmtPctRatio(r.weighted_ctr)}</td>
                    <td className="px-3 py-2 text-right text-opt-yellow">{fmt$(r.cpa ? r.cpa * NZD_TO_USD : null)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => { setEditing(r); setModalOpen(true) }}
                        className="text-[10px] text-text-400 hover:text-opt-yellow uppercase tracking-wider"
                      >
                        edit
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-text-400 mt-2 px-1">
        Rates are weighted across every variant that uses the component (not avg-of-avgs)
      </p>

      <AddComponentModal
        open={modalOpen}
        type={type}
        existing={editing}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        onSaved={() => load()}
      />
    </div>
  )
}
