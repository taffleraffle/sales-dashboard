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
import Select from '../../components/editorial/Select'
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

// Toggle-chip style matching the audience filter on the marketing/ads pages
// (active = ink fill / paper text; idle = paper fill / muted ink).
const offerChipStyle = (on) => ({
  padding: '5px 11px', borderRadius: 8,
  border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
  background: on ? 'var(--ink)' : 'var(--paper)',
  color: on ? 'var(--paper)' : 'var(--ink-3)',
  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  cursor: 'pointer', whiteSpace: 'nowrap',
})

// Picker to tie a run Meta ad to the library video creative it used.
function LinkCreativeModal({ ad, creatives, busy, currentId, onLink, onClose }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const list = useMemo(() => {
    const arr = ql
      ? creatives.filter(c => (c.canonical_name || c.name || '').toLowerCase().includes(ql))
      : creatives
    return arr.slice(0, 200)
  }, [creatives, ql])
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-sm max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Link a video creative</h2>
            <p className="text-[10px] text-text-400 truncate">Ad {ad.ad_id} · {ad.ad_name || ad.campaign_name || ''}</p>
          </div>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary shrink-0"><X size={18} /></button>
        </div>
        <div className="p-3 border-b border-border-default">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search creatives by name…"
            className="w-full px-3 py-2 text-xs bg-bg-primary border border-border-default rounded-sm outline-none" />
        </div>
        <div className="flex-1 overflow-auto">
          {currentId && (
            <button onClick={() => onLink(null)} disabled={busy}
              className="w-full text-left px-4 py-2 text-[11px] text-danger hover:bg-white/[0.03] border-b border-border-default/40">✕ Unlink current creative</button>
          )}
          {list.map(c => (
            <button key={c.id} onClick={() => onLink(c.id)} disabled={busy}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] border-b border-border-default/30 ${c.id === currentId ? 'bg-opt-yellow/10' : ''}`}>
              <div className="w-12 h-8 rounded overflow-hidden bg-bg-primary shrink-0">
                {c.thumbnail_url
                  ? <img src={c.thumbnail_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center text-text-400"><PlayCircle size={14} /></div>}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-text-primary truncate">{c.canonical_name || c.name || c.id}</div>
                <div className="text-[9px] text-text-400 uppercase tracking-wider">{c.type}</div>
              </div>
              {c.id === currentId && <Check size={13} className="text-opt-yellow ml-auto shrink-0" />}
            </button>
          ))}
          {list.length === 0 && <div className="p-6 text-center text-text-400 text-xs">No creatives match.</div>}
        </div>
      </div>
    </div>
  )
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
  const [typeFilter, setTypeFilter] = useState('all')   // all | video | static
  // Multi-select offers (Set of offer labels + '__none__' for untagged).
  // Empty set = all offers, matching the audience-chip filter on the ads pages.
  const [selectedOffers, setSelectedOffers] = useState(() => new Set())
  const [sortKey, setSortKey] = useState('cpa')
  const [sortDir, setSortDir] = useState('asc')
  const [preview, setPreview] = useState(null)
  const [outcomeFilter, setOutcomeFilter] = useState('all')
  const [linkPicker, setLinkPicker] = useState(null)   // the ad being linked, or null
  const [creatives, setCreatives] = useState([])       // library video creatives for the picker + linked-name lookup
  const [linkBusy, setLinkBusy] = useState(false)
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

  // Library video creatives — powers the link picker + resolves a linked ad's
  // creative name/thumbnail for the row. Loaded once; the library is small.
  useEffect(() => {
    supabase.from('lib_creative_library')
      .select('id, canonical_name, name, type, thumbnail_url')
      .in('type', ['Hook', 'Body', 'Joined', 'Full Video', 'Testimony', 'Retargeting'])
      .eq('exclude_from_library', false)
      .order('added_at', { ascending: false })
      .limit(2000)
      .then(({ data }) => setCreatives(data || []))
      .catch(() => {})
  }, [])
  const creativesById = useMemo(() => Object.fromEntries((creatives || []).map(c => [c.id, c])), [creatives])

  // Tie a run ad to a library video creative (or pass null to unlink).
  const linkCreative = useCallback(async (ad, creativeId) => {
    setLinkBusy(true)
    const { error: e } = await supabase.from('ads').update({ linked_creative_id: creativeId }).eq('ad_id', ad.ad_id)
    setLinkBusy(false)
    if (e) { setError(`Link failed: ${e.message}`); return }
    setAds(prev => prev.map(a => a.ad_id === ad.ad_id ? { ...a, linked_creative_id: creativeId } : a))
    setLinkPicker(null)
  }, [])

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
      // notEnoughSpend: under $250 USD spend = not enough data to grade a winner.
      // isVideo: drives the Video/Static type filter (static = anything not video).
      return { ...ad, spend, ctr, cpm, cpa, results: a.results, impressions: a.impressions, isActive, outcome, offer: inferOffer(ad), notEnoughSpend: spend < 250, isVideo: ad.asset_type === 'video' }
    })
  }, [ads, stats, outcomeOverride, fx.rate])

  const offerOptions = useMemo(() => {
    const set = new Set()
    let hasNone = false
    for (const r of rows) { if (r.offer) set.add(r.offer); else hasNone = true }
    return { offers: [...set].sort(), hasNone }
  }, [rows])

  const toggleOffer = (o) => setSelectedOffers(prev => {
    const next = new Set(prev)
    next.has(o) ? next.delete(o) : next.add(o)
    return next
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = rows.filter(r => {
      // Status scope
      if (statusFilter === 'active' && !r.isActive) return false
      if (statusFilter === 'ran' && !(r.isActive || (r.spend || 0) > 0)) return false
      // Offer (multi-select; empty set = all). '__none__' matches untagged ads.
      if (selectedOffers.size > 0 && !selectedOffers.has(r.offer || '__none__')) return false
      // Creative type
      if (typeFilter === 'video' && !r.isVideo) return false
      else if (typeFilter === 'static' && r.isVideo) return false
      // Win/loss + spend-readiness
      if (outcomeFilter === 'unmarked' && r.outcome) return false
      else if (outcomeFilter === 'lowspend' && !r.notEnoughSpend) return false
      else if (outcomeFilter === 'enough' && r.notEnoughSpend) return false
      else if (!['all', 'unmarked', 'lowspend', 'enough'].includes(outcomeFilter) && r.outcome !== outcomeFilter) return false
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
  }, [rows, search, statusFilter, typeFilter, selectedOffers, outcomeFilter, sortKey, sortDir])

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
        <Select value={statusFilter} onChange={setStatusFilter} minWidth={130}
          options={STATUS_OPTS.map(o => ({ value: o.v, label: o.label }))} />
        <Select value={outcomeFilter} onChange={setOutcomeFilter} minWidth={170}
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'winner', label: 'Winners' },
            { value: 'loser', label: 'Losers' },
            { value: 'unmarked', label: 'Unmarked' },
            { value: 'lowspend', label: 'Not enough spend (<$250)' },
            { value: 'enough', label: 'Enough spend (≥$250)' },
          ]} />
      </div>

      {/* Offer multi-select — chip row matching the audience filter on the ads pages.
          Empty selection = all offers; click to include one or several. */}
      <div className="mb-3 flex items-center gap-1.5 flex-wrap">
        <span className="text-[9px] uppercase tracking-wider text-text-400 mr-1">Offers</span>
        <button onClick={() => setSelectedOffers(new Set())} style={offerChipStyle(selectedOffers.size === 0)}>All</button>
        {offerOptions.offers.map(o => (
          <button key={o} onClick={() => toggleOffer(o)} style={offerChipStyle(selectedOffers.has(o))}>{o}</button>
        ))}
        {offerOptions.hasNone && (
          <button onClick={() => toggleOffer('__none__')} style={offerChipStyle(selectedOffers.has('__none__'))}>No offer</button>
        )}
        <span className="text-[9px] uppercase tracking-wider text-text-400 ml-4 mr-1">Type</span>
        <button onClick={() => setTypeFilter('all')} style={offerChipStyle(typeFilter === 'all')}>All</button>
        <button onClick={() => setTypeFilter('video')} style={offerChipStyle(typeFilter === 'video')}>Video</button>
        <button onClick={() => setTypeFilter('static')} style={offerChipStyle(typeFilter === 'static')}>Static</button>
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
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1 items-start">
                    <CreativeThumb ad={ad} onOpen={setPreview} />
                    {ad.linked_creative_id && creativesById[ad.linked_creative_id]
                      ? <button onClick={() => setLinkPicker(ad)} title="Linked video creative — click to change or unlink"
                          className="text-[9px] text-opt-yellow hover:underline truncate max-w-[64px] text-left">🔗 {creativesById[ad.linked_creative_id].canonical_name || creativesById[ad.linked_creative_id].name}</button>
                      : <button onClick={() => setLinkPicker(ad)} title="Link this ad to a library video creative"
                          className="text-[9px] text-text-400 hover:text-text-primary text-left">🔗 Link</button>}
                  </div>
                </td>
                <td className="px-3 py-2"><AdIdCell id={ad.ad_id} /></td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setOutcome(ad, 'winner')} title="Mark winner"
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border ${ad.outcome === 'winner' ? 'bg-success text-white border-success' : 'border-border-default text-text-400 hover:text-success'}`}>Win</button>
                    <button onClick={() => setOutcome(ad, 'loser')} title="Mark loser"
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border ${ad.outcome === 'loser' ? 'bg-danger text-white border-danger' : 'border-border-default text-text-400 hover:text-danger'}`}>Lose</button>
                    {ad.notEnoughSpend && (
                      <span title="Under $250 spend — not enough data to grade this creative yet"
                        className="px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border border-border-default bg-bg-primary text-text-400/70 whitespace-nowrap">Low spend</span>
                    )}
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
      {linkPicker && (
        <LinkCreativeModal
          ad={linkPicker}
          creatives={creatives}
          busy={linkBusy}
          currentId={linkPicker.linked_creative_id || null}
          onLink={(cid) => linkCreative(linkPicker, cid)}
          onClose={() => setLinkPicker(null)}
        />
      )}
    </div>
  )
}
