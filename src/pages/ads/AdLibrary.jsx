/* Ad Library — every currently-running (ACTIVE) Meta ad in one sortable table,
   keyed on the ad ID + creative so winners are easy to spot and scale. Ben
   2026-06-29: the ads are named "1, 2, 3…" on the account, useless for finding
   winners; here you sort by cost/result, copy the ad ID, and pull up the
   creative. Reuses the `ads` + `ad_daily_stats` tables (same as AdsList). */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { Loader, RefreshCw, AlertTriangle, PlayCircle, X, Copy, Check } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { pagedFetch } from '../../lib/pagedFetch'
import { runAutoSync, subscribeSyncStatus } from '../../services/autoSync'
import { syncMetaAdsAtAdLevel } from '../../services/metaAdsSync'
import { SectionHead } from '../../components/editorial/atoms'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')
const f$ = n => n == null || isNaN(n) ? '—' : (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)
const fNum = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString()
const fPct = n => n == null || isNaN(n) ? '—' : `${n.toFixed(2)}%`

// Copyable ad ID — the whole point (paste into a scaling campaign).
function AdIdCell({ id }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}
      title="Copy ad ID"
      className="flex items-center gap-1.5 font-mono text-[11px] text-text-secondary hover:text-text-primary">
      <span>{id}</span>
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} className="opacity-40" />}
    </button>
  )
}

function CreativeThumb({ ad, onOpen }) {
  const src = ad.thumbnail_url || ad.asset_url
  return (
    <button onClick={() => onOpen(ad)} title="View creative"
      className="relative w-16 h-10 rounded overflow-hidden bg-bg-primary shrink-0 group block">
      {src
        ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
        : <div className="w-full h-full flex items-center justify-center text-text-400"><PlayCircle size={16} /></div>}
      {ad.asset_type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
          <PlayCircle size={16} className="text-white" />
        </div>
      )}
    </button>
  )
}

function CreativeModal({ ad, onClose }) {
  useEffect(() => {
    if (!ad) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ad, onClose])
  if (!ad) return null
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-lg max-w-lg w-full overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-text-400 truncate">Ad {ad.ad_name} · {ad.campaign_name}</div>
            <AdIdCell id={ad.ad_id} />
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary shrink-0"><X size={18} /></button>
        </div>
        <div className="bg-black flex items-center justify-center">
          {ad.asset_type === 'video' && ad.asset_url
            ? <video src={ad.asset_url} poster={ad.thumbnail_url || undefined} controls autoPlay className="max-h-[70vh] w-auto" />
            : (ad.asset_url || ad.thumbnail_url)
              ? <img src={ad.asset_url || ad.thumbnail_url} alt="" className="max-h-[70vh] w-auto" />
              : <div className="p-16 text-text-400">No creative on file</div>}
        </div>
        {(ad.headline || ad.primary_text) && (
          <div className="px-4 py-3 text-xs text-text-secondary border-t border-border-default max-h-32 overflow-y-auto">
            {ad.headline && <div className="font-medium text-text-primary mb-1">{ad.headline}</div>}
            {ad.primary_text}
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdLibrary() {
  const [ads, setAds] = useState([])
  const [stats, setStats] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('cpa')   // cost per result — winners first
  const [sortDir, setSortDir] = useState('asc')
  const [preview, setPreview] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const adsData = await pagedFetch(() =>
        supabase.from('ads').select('*').eq('effective_status', 'ACTIVE'))
      const ids = adsData.map(a => a.ad_id)
      // Lifetime stats for just the active ads — small set, so the all-time
      // cost/result is a reliable winner signal without a date window.
      const statsData = ids.length
        ? await pagedFetch(() => supabase.from('ad_daily_stats').select('*').in('ad_id', ids))
        : []
      setAds(adsData); setStats(statsData)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    reload()
    runAutoSync().catch(() => {})
    const unsub = subscribeSyncStatus(() => reload().catch(() => {}))
    return () => unsub()
  }, [reload])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try { await syncMetaAdsAtAdLevel(90); await reload() }
    catch (e) { setError(`Sync failed: ${e.message}`) }
    finally { setSyncing(false) }
  }, [reload])

  const rows = useMemo(() => {
    const byAd = {}
    for (const s of stats) {
      const c = byAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0, v3: 0, vtp: 0 }
      c.spend += parseFloat(s.spend || 0)
      c.impressions += parseInt(s.impressions || 0)
      c.clicks += parseInt(s.clicks || 0)
      c.results += parseInt(s.results || 0)
      c.v3 += parseInt(s.video_3s_views || 0)
      c.vtp += parseInt(s.video_thruplays || 0)
      byAd[s.ad_id] = c
    }
    return ads.map(ad => {
      const a = byAd[ad.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
      const spend = a.spend * NZD_TO_USD
      const ctr = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : null
      const cpm = a.impressions > 0 ? (spend / a.impressions) * 1000 : null
      const cpa = a.results > 0 ? spend / a.results : null
      return { ...ad, spend, ctr, cpm, cpa, results: a.results, impressions: a.impressions }
    })
  }, [ads, stats])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = rows
    if (q) list = list.filter(r =>
      (r.ad_name || '').toLowerCase().includes(q) ||
      (r.campaign_name || '').toLowerCase().includes(q) ||
      (r.ad_id || '').includes(q))
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1       // nulls always last
      if (bv == null) return -1
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [rows, search, sortKey, sortDir])

  const setSort = (k) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'cpa' ? 'asc' : 'desc') }
  }

  // Body columns after Creative + Ad ID. Header order must match the <td>s.
  const COLS = [
    { k: 'ad_name', label: 'Ad', align: 'left' },
    { k: 'campaign_name', label: 'Campaign', align: 'left' },
    { k: 'spend', label: 'Spend', align: 'right' },
    { k: 'results', label: 'Results', align: 'right' },
    { k: 'cpa', label: 'Cost/Result', align: 'right' },
    { k: 'ctr', label: 'CTR', align: 'right' },
    { k: 'cpm', label: 'CPM', align: 'right' },
  ]

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-text-primary" /></div>

  const totalSpend = filtered.reduce((s, r) => s + (r.spend || 0), 0)
  const totalResults = filtered.reduce((s, r) => s + (r.results || 0), 0)

  return (
    <div>
      <SectionHead level="page" eyebrow="Ads · Library" title="The ad library." italicWord="ad"
        tagline={`${filtered.length} running ads · ${f$(totalSpend)} spend · ${fNum(totalResults)} results. Sort to find winners, copy the ad ID to scale.`}
        gap={20}
        right={
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs border border-border-default rounded-sm text-text-secondary hover:bg-bg-card-hover disabled:opacity-50">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Refresh now'}
          </button>
        }
      />

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-sm px-3 py-2">
          <AlertTriangle size={14} /><span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search ad name, campaign, or ad ID…"
          className="w-full max-w-md px-3 py-2 text-xs bg-bg-card border border-border-default rounded-sm outline-none" />
      </div>

      <div className="tile overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-default text-text-400 uppercase tracking-wider text-[9px]">
              <th className="text-left font-medium px-3 py-2">Creative</th>
              <th className="text-left font-medium px-3 py-2">Ad ID</th>
              {COLS.map(c => (
                <th key={c.k}
                  onClick={() => setSort(c.k)}
                  className={`px-3 py-2 font-medium cursor-pointer hover:text-text-primary ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  <span className="inline-flex items-center gap-1">{c.label}{sortKey === c.k && <span>{sortDir === 'asc' ? '▲' : '▼'}</span>}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(ad => (
              <tr key={ad.ad_id} className="border-b border-border-subtle hover:bg-bg-card-hover">
                <td className="px-3 py-2"><CreativeThumb ad={ad} onOpen={setPreview} /></td>
                <td className="px-3 py-2"><AdIdCell id={ad.ad_id} /></td>
                <td className="px-3 py-2 max-w-[90px] truncate text-text-primary" title={ad.ad_name}>{ad.ad_name || '—'}</td>
                <td className="px-3 py-2 max-w-[220px] truncate text-text-secondary" title={ad.campaign_name}>{ad.campaign_name || '—'}</td>
                <td className="px-3 py-2 text-right">{f$(ad.spend)}</td>
                <td className="px-3 py-2 text-right">{fNum(ad.results)}</td>
                <td className="px-3 py-2 text-right font-medium text-text-primary">{f$(ad.cpa)}</td>
                <td className="px-3 py-2 text-right">{fPct(ad.ctr)}</td>
                <td className="px-3 py-2 text-right">{f$(ad.cpm)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-12 text-center text-text-400">No running ads match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreativeModal ad={preview} onClose={() => setPreview(null)} />
    </div>
  )
}
