import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Loader, RefreshCw, AlertTriangle, Image as ImageIcon, Film, PlayCircle, Filter } from 'lucide-react'
import DateRangeSelector from '../../components/DateRangeSelector'
import VariantPill from '../../components/ads/VariantPill'
import { supabase } from '../../lib/supabase'
import { rangeToDays } from '../../lib/dateUtils'
import { syncMetaAdsAtAdLevel } from '../../services/metaAdsSync'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtPct(n) { return n == null || isNaN(n) ? '—' : `${n.toFixed(2)}%` }

function StatusPill({ status, effective }) {
  const s = (effective || status || 'UNKNOWN').toUpperCase()
  const tone =
    s === 'ACTIVE' ? 'bg-success/15 text-success border-success/30' :
    s === 'PAUSED' ? 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30' :
    s === 'DELETED' || s === 'ARCHIVED' ? 'bg-bg-card-hover text-text-400 border-border-default' :
    'bg-danger/15 text-danger border-danger/30'
  return <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${tone}`}>{s}</span>
}

function AssetPreview({ ad }) {
  if (ad.asset_type === 'video' && ad.asset_url) {
    return (
      <div className="relative aspect-video bg-bg-primary rounded-lg overflow-hidden">
        <video
          src={ad.asset_url}
          poster={ad.thumbnail_url || undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={e => e.currentTarget.play().catch(() => {})}
          onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
          className="w-full h-full object-cover"
        />
        <div className="absolute top-1.5 left-1.5"><Film size={12} className="text-white drop-shadow" /></div>
      </div>
    )
  }
  if (ad.thumbnail_url || ad.asset_url) {
    return (
      <div className="relative aspect-video bg-bg-primary rounded-lg overflow-hidden">
        <img src={ad.thumbnail_url || ad.asset_url} alt={ad.ad_name || ''} loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute top-1.5 left-1.5"><ImageIcon size={12} className="text-white drop-shadow" /></div>
      </div>
    )
  }
  return (
    <div className="aspect-video bg-bg-primary rounded-lg flex items-center justify-center text-text-400">
      <PlayCircle size={32} />
    </div>
  )
}

function Stat({ label, value, highlight }) {
  return (
    <div>
      <p className="uppercase tracking-wider text-text-400 text-[8px] mb-0.5">{label}</p>
      <p className={`font-medium ${highlight ? 'text-opt-yellow' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}

export default function AdsList() {
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' ? range : rangeToDays(range)

  const [ads, setAds] = useState([])
  const [stats, setStats] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(null)

  const [statusFilter, setStatusFilter] = useState('active')
  const [variantFilter, setVariantFilter] = useState('all')
  const [sortBy, setSortBy] = useState('spend')
  const [search, setSearch] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const since = new Date()
      since.setDate(since.getDate() - (typeof days === 'number' ? days : 30))
      const sinceStr = since.toISOString().split('T')[0]

      const [{ data: adsData, error: adsErr }, { data: statsData, error: statsErr }] = await Promise.all([
        supabase.from('ads').select('*').order('last_synced_at', { ascending: false }),
        supabase.from('ad_daily_stats').select('*').gte('date', sinceStr),
      ])
      if (adsErr) throw new Error(`Load ads failed: ${adsErr.message}`)
      if (statsErr) throw new Error(`Load stats failed: ${statsErr.message}`)
      setAds(adsData || [])
      setStats(statsData || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { reload() }, [reload])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    setSyncMessage('Pulling ad insights from Meta…')
    try {
      const result = await syncMetaAdsAtAdLevel(typeof days === 'number' ? days : 30)
      setSyncMessage(`Synced ${result.ads_seen} ads · ${result.daily_rows_upserted} daily rows · ${result.creatives_fetched} creatives refreshed`)
      await reload()
    } catch (err) {
      setSyncMessage(null)
      setError(`Sync failed: ${err.message}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMessage(null), 6000)
    }
  }, [days, reload])

  const adWithStats = useMemo(() => {
    const byAd = {}
    for (const s of stats) {
      const cur = byAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0, video_3s_views: 0, video_thruplays: 0 }
      cur.spend += parseFloat(s.spend || 0)
      cur.impressions += parseInt(s.impressions || 0)
      cur.clicks += parseInt(s.clicks || 0)
      cur.results += parseInt(s.results || 0)
      cur.video_3s_views += parseInt(s.video_3s_views || 0)
      cur.video_thruplays += parseInt(s.video_thruplays || 0)
      byAd[s.ad_id] = cur
    }
    return ads.map(ad => {
      const agg = byAd[ad.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0, video_3s_views: 0, video_thruplays: 0 }
      const spend_usd = agg.spend * NZD_TO_USD
      const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : null
      const cpm = agg.impressions > 0 ? (spend_usd / agg.impressions) * 1000 : null
      const cpa = agg.results > 0 ? spend_usd / agg.results : null
      const hook_rate = agg.impressions > 0 ? (agg.video_3s_views / agg.impressions) * 100 : null
      const hold_rate = agg.video_3s_views > 0 ? (agg.video_thruplays / agg.video_3s_views) * 100 : null
      return { ...ad, agg: { ...agg, spend_usd, ctr, cpm, cpa, hook_rate, hold_rate } }
    })
  }, [ads, stats])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return adWithStats
      .filter(ad => {
        if (statusFilter === 'active') {
          if ((ad.effective_status || ad.status || '').toUpperCase() !== 'ACTIVE') return false
        } else if (statusFilter === 'paused') {
          if ((ad.effective_status || ad.status || '').toUpperCase() !== 'PAUSED') return false
        } else if (statusFilter === 'spent') {
          if ((ad.agg.spend_usd || 0) <= 0) return false
        }
        if (variantFilter !== 'all' && ad.variant_match_status !== variantFilter) return false
        if (q && !(ad.ad_name || '').toLowerCase().includes(q) && !(ad.campaign_name || '').toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => {
        if (sortBy === 'spend') return (b.agg.spend_usd || 0) - (a.agg.spend_usd || 0)
        if (sortBy === 'ctr') return (b.agg.ctr || 0) - (a.agg.ctr || 0)
        if (sortBy === 'cpa_asc') return (a.agg.cpa || Infinity) - (b.agg.cpa || Infinity)
        if (sortBy === 'newest') return new Date(b.first_seen_at || 0) - new Date(a.first_seen_at || 0)
        return 0
      })
  }, [adWithStats, statusFilter, variantFilter, sortBy, search])

  const totals = useMemo(() => filtered.reduce((a, ad) => ({
    spend: a.spend + (ad.agg.spend_usd || 0),
    ads: a.ads + 1,
  }), { spend: 0, ads: 0 }), [filtered])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <p className="text-xs text-text-400">{filtered.length} of {ads.length} ads · {fmt$(totals.spend)} spend in window</p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs border border-border-default rounded-2xl text-text-secondary hover:bg-bg-card-hover disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync from Meta'}
          </button>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100">dismiss</button>
        </div>
      )}
      {syncMessage && (
        <div className="mb-3 bg-opt-yellow/10 border border-opt-yellow/30 text-opt-yellow text-xs rounded-xl px-3 py-2">
          {syncMessage}
        </div>
      )}

      <div className="bg-bg-card border border-border-default rounded-2xl p-3 mb-4 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-1 text-text-400 text-xs"><Filter size={12} /> Filter</div>
        <div className="flex gap-1">
          {[['active', 'Active'], ['paused', 'Paused'], ['spent', 'Spent'], ['all', 'All']].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setStatusFilter(k)}
              className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                statusFilter === k
                  ? 'bg-opt-yellow/15 border-opt-yellow/40 text-opt-yellow'
                  : 'border-border-default text-text-secondary hover:bg-bg-card-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2 text-text-400 text-[10px] uppercase tracking-wider">Variant</div>
        <select
          value={variantFilter}
          onChange={e => setVariantFilter(e.target.value)}
          className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary"
        >
          <option value="all">All</option>
          <option value="matched">Matched</option>
          <option value="orphan">Orphan</option>
          <option value="legacy">Legacy</option>
          <option value="unparsed">Unparsed</option>
          <option value="pending">Pending</option>
        </select>
        <input
          type="search"
          placeholder="Search ad or campaign…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-bg-primary border border-border-default rounded-lg px-2.5 py-1 text-xs text-text-primary w-full sm:w-60"
        />
        <div className="sm:ml-auto flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-400">Sort</span>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="bg-bg-primary border border-border-default rounded-lg px-2 py-1 text-xs text-text-primary"
          >
            <option value="spend">Highest spend</option>
            <option value="ctr">Best CTR</option>
            <option value="cpa_asc">Lowest CPA</option>
            <option value="newest">Newest</option>
          </select>
        </div>
      </div>

      {!filtered.length && (
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 text-center text-text-400">
          {ads.length === 0 ? (
            <div>
              <p className="text-sm mb-2">No ads synced yet.</p>
              <p className="text-xs">Click <span className="text-opt-yellow">Sync from Meta</span> to pull every ad and its insights. Read-only — nothing on Meta will be modified.</p>
            </div>
          ) : (
            <p className="text-sm">No ads match the current filter.</p>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map(ad => (
            <Link
              key={ad.ad_id}
              to={`/sales/ads/ad/${ad.ad_id}`}
              className="bg-bg-card border border-border-default rounded-2xl p-3 hover:border-opt-yellow/40 transition-colors group"
            >
              <AssetPreview ad={ad} />
              <div className="mt-2 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate group-hover:text-opt-yellow transition-colors">
                    {ad.ad_name || ad.ad_id}
                  </p>
                  <p className="text-[10px] text-text-400 truncate">{ad.campaign_name || '—'}</p>
                </div>
                <StatusPill status={ad.status} effective={ad.effective_status} />
              </div>
              <div className="mt-1.5">
                <VariantPill variantId={ad.variant_id} matchStatus={ad.variant_match_status} compact={true} />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
                <Stat label="Spend" value={fmt$(ad.agg.spend_usd)} />
                <Stat label="CTR" value={fmtPct(ad.agg.ctr)} />
                <Stat label="CPM" value={fmt$(ad.agg.cpm)} />
                <Stat label="Hook" value={fmtPct(ad.agg.hook_rate)} />
                <Stat label="Hold" value={fmtPct(ad.agg.hold_rate)} />
                <Stat label="CPA" value={fmt$(ad.agg.cpa)} highlight />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
