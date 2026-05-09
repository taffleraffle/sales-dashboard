import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertTriangle, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

export default function AdsOrphans() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data, error: e } = await supabase
          .schema('library')
          .from('orphan_ads')
          .select('*')
          .order('last_seen', { ascending: false })
        if (e) throw new Error(e.message)
        if (!cancelled) setRows(data || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle size={16} className="text-danger" />
        <p className="text-xs text-text-secondary">
          Ads found in Meta sync that don't match the OPT-MetaAd-Naming-SOP. Surface here so they can be mapped to a variant or marked ignored. Component-library rollups exclude orphans.
        </p>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> <span>{error}</span>
        </div>
      )}

      {!rows.length ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
          No orphan ads. Every synced ad either matches a variant in the library or is mapped via legacy_ad_mapping.
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border-default">
                <th className="text-left px-3 py-2 font-normal">Ad ID</th>
                <th className="text-left px-3 py-2 font-normal">Ad name</th>
                <th className="text-left px-3 py-2 font-normal">Parser tried</th>
                <th className="text-left px-3 py-2 font-normal">First seen</th>
                <th className="text-left px-3 py-2 font-normal">Last seen</th>
                <th className="text-left px-3 py-2 font-normal">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-border-default/40 hover:bg-bg-card-hover">
                  <td className="px-3 py-2">
                    <Link to={`/sales/ads/ad/${r.meta_ad_id}`} className="text-opt-yellow font-mono text-[11px] hover:underline">{r.meta_ad_id}</Link>
                  </td>
                  <td className="px-3 py-2 text-text-secondary truncate max-w-md" title={r.meta_ad_name}>{r.meta_ad_name || '—'}</td>
                  <td className="px-3 py-2 text-text-400 font-mono text-[10px]">{r.parser_attempted || '—'}</td>
                  <td className="px-3 py-2 text-text-400">{r.first_seen ? new Date(r.first_seen).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-text-400">{r.last_seen ? new Date(r.last_seen).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2">
                    {r.resolved
                      ? <span className="text-success text-[10px]">resolved</span>
                      : <span className="text-text-400 text-[10px]">open</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-text-400 mt-2 px-1">
        {rows.length} orphan{rows.length === 1 ? '' : 's'} · resolution UI (map to variant / ignore) ships in Phase 3
      </p>
    </div>
  )
}
