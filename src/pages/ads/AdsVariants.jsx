import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertTriangle, GitBranch, Search, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import AddVariantModal from '../../components/ads/AddVariantModal'

const STATUS_TONE = {
  planned: 'bg-bg-card-hover text-text-400 border-border-default',
  editing: 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30',
  ready:   'bg-success/10 text-success border-success/30',
  live:    'bg-success/20 text-success border-success/40',
  paused:  'bg-opt-yellow/10 text-opt-yellow border-opt-yellow/20',
  killed:  'bg-danger/10 text-danger border-danger/30',
  winner:  'bg-opt-yellow/30 text-opt-yellow border-opt-yellow/60',
}

export default function AdsVariants() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('lib_variants')
        .select('*')
        .order('created_at', { ascending: false })
      if (e) throw new Error(e.message)
      setRows(data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows
      .filter(v => statusFilter === 'all' || v.status === statusFilter)
      .filter(v => !q || (v.variant_id || '').toLowerCase().includes(q) || (v.notes || '').toLowerCase().includes(q))
  }, [rows, statusFilter, search])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 flex-1">
          <GitBranch size={16} className="text-text-400" />
          <p className="text-xs text-text-secondary">
            Every assembled variant. A variant is one specific (hook, body angle, scene, creator) combination at a given iteration.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setModalOpen(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-opt-yellow/15 border border-opt-yellow/40 text-opt-yellow rounded-lg hover:bg-opt-yellow/20 whitespace-nowrap"
        >
          <Plus size={13} /> Add variant
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> <span>{error}</span>
        </div>
      )}

      <div className="bg-bg-card border border-border-default rounded-2xl p-3 mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex gap-1 flex-wrap">
          {['all', 'live', 'ready', 'editing', 'planned', 'paused', 'killed', 'winner'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                statusFilter === s
                  ? 'bg-opt-yellow/15 border-opt-yellow/40 text-opt-yellow'
                  : 'border-border-default text-text-secondary hover:bg-bg-card-hover'
              }`}
            >{s}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 bg-bg-primary border border-border-default rounded-lg px-2 py-1 sm:w-60 sm:ml-auto flex-1 sm:flex-none">
          <Search size={12} className="text-text-400" />
          <input
            type="search"
            placeholder="Search variants…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-xs text-text-primary outline-none w-full"
          />
        </div>
      </div>

      {!filtered.length ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
          {rows.length === 0 ? 'No variants in the library yet. Add rows to library.variants.' : 'No variants match the filter.'}
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border-default">
                <th className="text-left px-3 py-2 font-normal">Variant ID</th>
                <th className="text-left px-3 py-2 font-normal">Status</th>
                <th className="text-left px-3 py-2 font-normal">Iter</th>
                <th className="text-left px-3 py-2 font-normal">Meta ad</th>
                <th className="text-left px-3 py-2 font-normal">Launched</th>
                <th className="text-left px-3 py-2 font-normal">Created</th>
                <th className="text-right px-3 py-2 font-normal w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(v => (
                <tr key={v.id} className="border-b border-border-default/40 hover:bg-bg-card-hover">
                  <td className="px-3 py-2">
                    <Link to={`/sales/ads/variants/${encodeURIComponent(v.variant_id)}`} className="text-opt-yellow font-mono text-[11px] hover:underline">
                      {v.variant_id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${STATUS_TONE[v.status] || STATUS_TONE.planned}`}>
                      {v.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">v{v.iteration}</td>
                  <td className="px-3 py-2 text-text-secondary truncate max-w-md" title={v.meta_ad_name || v.meta_ad_id}>
                    {v.meta_ad_id
                      ? <Link to={`/sales/ads/ad/${v.meta_ad_id}`} className="hover:text-opt-yellow">{v.meta_ad_name || v.meta_ad_id}</Link>
                      : <span className="text-text-400">—</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-text-400">{v.launched_at ? new Date(v.launched_at).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-text-400">{v.created_at ? new Date(v.created_at).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => { setEditing(v); setModalOpen(true) }}
                      className="text-[10px] text-text-400 hover:text-opt-yellow uppercase tracking-wider"
                    >edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-text-400 mt-2 px-1">
        {filtered.length} of {rows.length} variants
      </p>

      <AddVariantModal
        open={modalOpen}
        existing={editing}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        onSaved={() => load()}
      />
    </div>
  )
}
