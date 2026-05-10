import { useEffect, useMemo, useState } from 'react'
import { X, Tag, Loader, AlertTriangle, Search } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Modal that lets the operator tag a Meta ad with an existing library variant.
// Used by the Orphans tab and the Ad Detail page. Calls public.tag_ad_with_variant
// which updates public.ads.variant_id and resolves the orphan_ads row.
export default function TagVariantModal({ open, adId, adName, currentVariantId, onClose, onTagged }) {
  const [variants, setVariants] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data, error: e } = await supabase
          .from('lib_variants')
          .select('variant_id, status, iteration, meta_ad_id')
          .order('variant_id', { ascending: true })
        if (e) throw new Error(e.message)
        if (!cancelled) setVariants(data || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    setPicked(currentVariantId || '')
    setSearch('')
    return () => { cancelled = true }
  }, [open, currentVariantId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return variants
    return variants.filter(v => v.variant_id.toLowerCase().includes(q))
  }, [variants, search])

  if (!open) return null

  async function handleTag() {
    if (!picked) { setError('Pick a variant first'); return }
    setError(null)
    setSaving(true)
    try {
      const { error: rpcErr } = await supabase.rpc('tag_ad_with_variant', {
        p_ad_id: adId,
        p_variant_id: picked,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      onTagged?.(picked)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleIgnore() {
    setError(null)
    setSaving(true)
    try {
      const { error: rpcErr } = await supabase.rpc('ignore_orphan_ad', { p_meta_ad_id: adId })
      if (rpcErr) throw new Error(rpcErr.message)
      onTagged?.(null)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-default rounded-sm w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Tag ad with variant</h2>
            <p className="text-[10px] text-text-400 mt-0.5 truncate max-w-xs" title={adName || adId}>{adName || adId}</p>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          {error && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-sm px-3 py-2">
              <AlertTriangle size={14} /> <span className="flex-1">{error}</span>
            </div>
          )}

          <div className="flex items-center gap-1.5 bg-bg-primary border border-border-default rounded-lg px-2 py-1">
            <Search size={12} className="text-text-400" />
            <input
              type="search"
              placeholder="Search variants…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-transparent text-xs text-text-primary outline-none w-full"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader size={16} className="animate-spin text-text-primary" /></div>
          ) : !filtered.length ? (
            <p className="text-xs text-text-400 text-center py-6">
              {variants.length === 0
                ? 'No variants exist yet. Create one in the Variants tab first.'
                : 'No variants match your search.'}
            </p>
          ) : (
            <div className="border border-border-default rounded-lg max-h-80 overflow-y-auto">
              {filtered.map(v => (
                <label
                  key={v.variant_id}
                  className={`flex items-center gap-2 px-3 py-2 border-b border-border-default/40 last:border-b-0 cursor-pointer hover:bg-bg-card-hover ${
                    picked === v.variant_id ? 'bg-opt-yellow/10' : ''
                  }`}
                >
                  <input
                    type="radio"
                    checked={picked === v.variant_id}
                    onChange={() => setPicked(v.variant_id)}
                    className="accent-opt-yellow"
                  />
                  <span className="text-xs font-mono text-text-primary flex-1 truncate" title={v.variant_id}>{v.variant_id}</span>
                  <span className="text-[9px] uppercase tracking-wider text-text-400">{v.status}</span>
                  {v.meta_ad_id && v.meta_ad_id !== adId && (
                    <span className="text-[9px] text-danger" title="Already linked to a different ad">⚠ in use</span>
                  )}
                </label>
              ))}
            </div>
          )}

          <p className="text-[10px] text-text-400">
            Tagging links this Meta ad to the picked variant. The variant's <span className="font-mono">meta_ad_id</span> is backfilled if empty, and any matching orphan record is marked resolved.
          </p>
        </div>

        <div className="px-4 py-3 border-t border-border-default flex items-center justify-between gap-2">
          <button
            onClick={handleIgnore}
            disabled={saving}
            className="text-xs text-text-400 hover:text-text-secondary px-2"
          >
            Ignore (mark orphan resolved)
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-xs text-text-400 hover:text-text-secondary px-2">Cancel</button>
            <button
              onClick={handleTag}
              disabled={saving || !picked}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-opt-yellow/15 border border-opt-yellow/40 text-text-primary rounded-lg hover:bg-opt-yellow/20 disabled:opacity-50"
            >
              {saving ? <Loader size={12} className="animate-spin" /> : <Tag size={12} />}
              Tag with variant
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
