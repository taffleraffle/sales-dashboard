import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertTriangle, Archive } from 'lucide-react'
import { supabase } from '../../lib/supabase'

export default function AdsLegacy() {
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
          .from('legacy_ad_mapping')
          .select('*, variant:variants(variant_id, status)')
          .order('created_at', { ascending: false })
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
        <Archive size={16} className="text-text-400" />
        <p className="text-xs text-text-secondary">
          Pre-2026-05-09 ads manually mapped to variants in the library. After 2026-07-08, all unmapped legacy ads auto-archive from the active set.
        </p>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> <span>{error}</span>
        </div>
      )}

      {!rows.length ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400 text-sm">
          No legacy mappings. Add rows to library.legacy_ad_mapping to attribute pre-SOP ads.
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border-default">
                <th className="text-left px-3 py-2 font-normal">Meta ad</th>
                <th className="text-left px-3 py-2 font-normal">Mapped variant</th>
                <th className="text-left px-3 py-2 font-normal">Status</th>
                <th className="text-left px-3 py-2 font-normal">Notes</th>
                <th className="text-left px-3 py-2 font-normal">Retired</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-border-default/40 hover:bg-bg-card-hover">
                  <td className="px-3 py-2">
                    <Link to={`/sales/ads/ad/${r.meta_ad_id}`} className="text-opt-yellow font-mono text-[11px] hover:underline">{r.meta_ad_id}</Link>
                    {r.meta_ad_name && <p className="text-[10px] text-text-400 truncate max-w-xs">{r.meta_ad_name}</p>}
                  </td>
                  <td className="px-3 py-2">
                    {r.variant?.variant_id
                      ? <Link to={`/sales/ads/variants/${encodeURIComponent(r.variant.variant_id)}`} className="text-opt-yellow font-mono text-[11px] hover:underline">{r.variant.variant_id}</Link>
                      : <span className="text-text-400">—</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{r.variant?.status || '—'}</td>
                  <td className="px-3 py-2 text-text-secondary truncate max-w-sm" title={r.notes}>{r.notes || '—'}</td>
                  <td className="px-3 py-2">{r.retired ? <span className="text-text-400 text-[10px]">retired</span> : <span className="text-success text-[10px]">active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-text-400 mt-2 px-1">
        {rows.length} mapping{rows.length === 1 ? '' : 's'} · edit / add UI ships in Phase 3
      </p>
    </div>
  )
}
