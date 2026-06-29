/* Ad Library — running + recently-spent Meta ads in one sortable table, keyed
   on the ad ID + creative so winners are easy to spot and scale. Ben
   2026-06-29: ads are named "1, 2, 3…" on the account, useless for finding
   winners; here you sort by cost/result, copy the ad ID, see the inferred
   offer, filter by date range + status, and pull up the creative. Reuses the
   `ads` + `ad_daily_stats` tables (same as AdsList). */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { Loader, RefreshCw, AlertTriangle, PlayCircle, X, Copy, Check } from 'lucide-react'
import DateRangeSelector from '../../components/DateRangeSelector'
import { supabase } from '../../lib/supabase'
import { pagedFetch } from '../../lib/pagedFetch'
import { rangeToDays } from '../../lib/dateUtils'
import { runAutoSync, subscribeSyncStatus } from '../../services/autoSync'
import { syncMetaAdsAtAdLevel } from '../../services/metaAdsSync'
import { SectionHead } from '../../components/editorial/atoms'
import { getNzdToUsd } from '../../lib/fxRate'

// Spend in ad_daily_stats is stored in NZD; we display USD using a live FX rate
// (Ben 2026-06-29: USD values, but the rate must track reality, not 0.56).
const f$ = n => n == null || isNaN(n) ? '—' : (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)
const fNum = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString()
const fPct = n => n == null || isNaN(n) ? '—' : `${n.toFixed(2)}%`

// Offer inference — the campaign/adset name + ad copy reliably encode the niche
// (campaigns are named "…Restoration…", "…Electricians…"). This beats analysing
// pixels and is instant. First match wins; null = couldn't tell.
const OFFER_RULES = [
  { label: 'Electricians', re: /electric/i },
  { label: 'Restoration',  re: /restorat|water ?damage|mould|mold|fire ?damage|flood|water ?restor/i },
  { label: 'Remodeling',   re: /remodel|renovat/i },
  { label: 'Accounting',   re: /account|bookkeep|\bcpa\b|\btax\b/i },
  { label: 'Roofing',      re: /roof/i },
  { label: 'Plumbing',     re: /plumb|gasfit/i },
  { label: 'HVAC',         re: /\bhvac\b|heating|cooling|air ?con/i },
  { label: 'Dental',       re: /dental|dentist|ortho/i },
  { label: 'Legal',        re: /\blaw\b|lawyer|attorney|legal/i },
]
function inferOffer(ad) {
  const hay = `${ad.campaign_name || ''} ${ad.adset_name || ''} ${ad.ad_name || ''} ${ad.headline || ''} ${ad.primary_text || ''}`
  for (const r of OFFER_RULES) if (r.re.test(hay)) return r.label
  return null
}
function offerColor(offer) {
  switch (offer) {
    case 'Electricians': return { bg: 'rgba(62,126,186,0.15)', fg: '#3e7eba' }
    case 'Restoration':  return { bg: 'rgba(224,133,62,0.15)', fg: '#c4701a' }
    case 'Accounting':   return { bg: 'rgba(62,138,94,0.15)',  fg: '#3e8a5e' }
    default:             return { bg: 'var(--bg-primary, rgba(0,0,0,0.05))', fg: 'var(--text-400, #888)' }
  }
}

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

function OfferTag({ offer }) {
  if (!offer) return <span className="text-text-400 text-[10px]">—</span>
  const c = offerColor(offer)
  return <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded" style={{ background: c.bg, color: c.fg }}>{offer}</span>
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

const STATUS_OPTS = [
  { v: 'ran', label: 'Ran in range' },   // active OR had spend in the window
  { v: 'active', label: 'Active only' },
  { v: 'all', label: 'All ads' },
]

export default function AdLibrary() {
  // Default to all-time so every ad that has EVER run is gradeable here, not just
  // the last 30 days (Ben grades current + historical winners). null days = no
  // date floor on the stats fetch.
  const [range, setRange] = useState('all')
  const days = range === 'all' ? null : (typeof range === 'number' ? range : rangeToDays(range))

  const [ads, setAds] = useState([])
  const [stats, setStats] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('ran')
  const [offerFilter, setOfferFilter] = useState('all')
  const [sortKey, setSortKey] = useState('cpa')
  const [sortDir, setSortDir] = useState('asc')
  const [preview, setPreview] = useState(null)
  const [outcomeFilter, setOutcomeFilter] = useState('all')
  // Live NZD->USD rate (cached 12h). Starts at the static fallback so first paint
  // isn't blank, then upgrades to the live rate when it resolves.
  const [fx, setFx] = useState({ rate: parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56'), ts: null, live: false })
  useEffect(() => { getNzdToUsd().then(setFx).catch(() => {}) }, [])
  // Optimistic win/loss overrides (ad_id -> 'winner'|'loser'|null) so a click
  // reflects instantly without refetching.
  const [outcomeOverride, setOutcomeOverride] = useState({})
  const setOutcome = useCallback(async (ad, val) => {
    const next = ad.outcome === val ? null : val   // click the active one again to clear
    setOutcomeOverride(o => ({ ...o, [ad.ad_id]: next }))
    try {
      const { error: e } = await supabase.from('ads').update({ outcome: next }).eq('ad_id', ad.ad_id)
      if (e) throw e
    } catch (e) { setError(`Couldn't save win/loss: ${e.message}`) }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // ALL ads (not just active) + stats over the selected window. When days is
      // null (All time) we pull the full history so older ads carry real spend
      // and can be graded. pagedFetch handles the 1000-row cap; the account is large.
      const sinceStr = typeof days === 'number'
        ? (() => { const s = new Date(); s.setDate(s.getDate() - days); return s.toISOString().split('T')[0] })()
        : null
      const [adsData, statsData] = await Promise.all([
        pagedFetch(() => supabase.from('ads').select('*')),
        pagedFetch(() => {
          const q = supabase.from('ad_daily_stats').select('*')
          return sinceStr ? q.gte('date', sinceStr) : q
        }),
      ])
      setAds(adsData); setStats(statsData)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [days])

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
      const c = byAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
      c.spend += parseFloat(s.spend || 0)
      c.impressions += parseInt(s.impressions || 0)
      c.clicks += parseInt(s.clicks || 0)
      c.results += parseInt(s.results || 0)
      byAd[s.ad_id] = c
    }
    return ads.map(ad => {
      const a = byAd[ad.ad_id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
      const spend = a.spend * fx.rate   // NZD -> USD at the live rate
      const ctr = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : null
      const cpm = a.impressions > 0 ? (spend / a.impressions) * 1000 : null
      const cpa = a.results > 0 ? spend / a.results : null
      const isActive = (ad.effective_status || ad.status || '').toUpperCase() === 'ACTIVE'
      const outcome = outcomeOverride[ad.ad_id] !== undefined ? outcomeOverride[ad.ad_id] : (ad.outcome || null)
      return { ...ad, spend, ctr, cpm, cpa, results: a.results, impressions: a.impressions, isActive, outcome, offer: inferOffer(ad) }
    })
  }, [ads, stats, outcomeOverride, fx.rate])

  const offerOptions = useMemo(() => {
    const set = new Set()
    for (const r of rows) if (r.offer) set.add(r.offer)
    return ['all', ...[...set].sort(), '__none__']
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = rows.filter(r => {
      // Status scope
      if (statusFilter === 'active' && !r.isActive) return false
      if (statusFilter === 'ran' && !(r.isActive || (r.spend || 0) > 0)) return false
      // Offer
      if (offerFilter === '__none__' && r.offer) return false
      else if (offerFilter !== 'all' && offerFilter !== '__none__' && r.offer !== offerFilter) return false
      // Win/loss
      if (outcomeFilter === 'unmarked' && r.outcome) return false
      else if (outcomeFilter !== 'all' && outcomeFilter !== 'unmarked' && r.outcome !== outcomeFilter) return false
      if (q && !(r.ad_name || '').toLowerCase().includes(q) && !(r.campaign_name || '').toLowerCase().includes(q) && !(r.ad_id || '').includes(q)) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return list.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [rows, search, statusFilter, offerFilter, outcomeFilter, sortKey, sortDir])

  const setSort = (k) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'cpa' ? 'asc' : 'desc') }
  }

  const COLS = [
    { k: 'outcome', label: 'W/L', align: 'left' },
    { k: 'offer', label: 'Offer', align: 'left' },
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
  const selectCls = "px-2 py-1.5 text-[11px] bg-bg-card border border-border-default rounded-sm outline-none text-text-secondary"

  return (
    <div>
      <SectionHead level="page" eyebrow="Ads · Library" title="The ad library." italicWord="ad"
        tagline={`${filtered.length} ads · ${f$(totalSpend)} spend · ${fNum(totalResults)} results ${range === 'all' ? 'all-time' : 'in range'} (USD @ ${fx.rate.toFixed(4)} NZD→USD${fx.live ? ' · live' : ''}). Mark winners/losers, sort to find them, copy the ad ID to scale.`}
        gap={20}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-2 text-xs border border-border-default rounded-sm text-text-secondary hover:bg-bg-card-hover disabled:opacity-50">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Refresh now'}
            </button>
            <button onClick={() => setRange(range === 'all' ? 30 : 'all')}
              title="Show every ad that has ever run"
              style={range === 'all' ? { background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' } : {}}
              className="px-3 py-2 text-xs border border-border-default rounded-sm text-text-secondary hover:bg-bg-card-hover">
              All time
            </button>
            <DateRangeSelector selected={range} onChange={setRange} />
          </div>
        }
      />

      {error && (
        <div className="mb-3 flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-sm px-3 py-2">
          <AlertTriangle size={14} /><span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search ad name, campaign, or ad ID…"
          className="flex-1 min-w-[220px] max-w-md px-3 py-2 text-xs bg-bg-card border border-border-default rounded-sm outline-none" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={selectCls}>
          {STATUS_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <select value={offerFilter} onChange={e => setOfferFilter(e.target.value)} className={selectCls}>
          {offerOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All offers' : o === '__none__' ? 'No offer' : o}</option>)}
        </select>
        <select value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)} className={selectCls}>
          <option value="all">All outcomes</option>
          <option value="winner">Winners</option>
          <option value="loser">Losers</option>
          <option value="unmarked">Unmarked</option>
        </select>
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
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setOutcome(ad, 'winner')} title="Mark winner"
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border ${ad.outcome === 'winner' ? 'bg-success text-white border-success' : 'border-border-default text-text-400 hover:text-success'}`}>Win</button>
                    <button onClick={() => setOutcome(ad, 'loser')} title="Mark loser"
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border ${ad.outcome === 'loser' ? 'bg-danger text-white border-danger' : 'border-border-default text-text-400 hover:text-danger'}`}>Lose</button>
                  </div>
                </td>
                <td className="px-3 py-2"><OfferTag offer={ad.offer} /></td>
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
              <tr><td colSpan={11} className="px-3 py-12 text-center text-text-400">No ads match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreativeModal ad={preview} onClose={() => setPreview(null)} />
    </div>
  )
}
