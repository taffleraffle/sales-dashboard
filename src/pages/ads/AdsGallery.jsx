import { useEffect, useMemo, useState } from 'react'
import { Sparkles, RefreshCw, AlertCircle, Search, Mic } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import AdCard from '../../components/ads/AdCard'
import AdAnalystPanel from '../../components/ads/AdAnalystPanel'
import { triggerTranscribeAds } from '../../services/adAnalyst'
import { useToast } from '../../hooks/useToast'

/*
  Live Ad Gallery — the Meta-Ads-Library-style internal surface.
  Reads public.ads + public.ad_daily_stats + lib_variant_state_history,
  presents a card grid with filters and an analyst panel docked right.

  When public.ads is empty (no Meta sync run yet), shows the empty state
  with a "Sync now" button that triggers `syncMetaAdsAtAdLevel` directly.
*/

const STATE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'winning', label: 'Winning' },
  { value: 'foundational', label: 'Foundational' },
  { value: 'bench', label: 'Bench' },
  { value: 'bad_pocket', label: 'Bad pocket' },
  { value: 'fatigued', label: 'Fatigued' },
  { value: 'concept', label: 'Concept' },
]

const SPEND_TIERS = [
  { value: 'all', label: 'Any spend' },
  { value: 'high', label: '$10k+' },
  { value: 'mid',  label: '$1k–$10k' },
  { value: 'low',  label: '$100–$1k' },
  { value: 'tiny', label: '<$100' },
]

const SORTS = [
  { value: 'spend_desc', label: 'Spend ↓' },
  { value: 'closes_desc', label: 'Closes ↓' },
  { value: 'cpa_asc', label: 'CPA ↑' },
  { value: 'recent', label: 'Most recent' },
]

const STATUS_FILTERS = [
  { value: 'all', label: 'All status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
]

export default function AdsGallery() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [stateFilter, setStateFilter] = useState('all')
  const [spendTier, setSpendTier] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState('spend_desc')
  const [search, setSearch] = useState('')
  const [analystOpen, setAnalystOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const adsRes = await supabase
        .from('ads')
        .select('ad_id, ad_name, status, variant_id, variant_match_status, thumbnail_url, asset_type, last_synced_at, first_seen_at')
        .order('first_seen_at', { ascending: false })
        .limit(500)
      if (adsRes.error) throw new Error(adsRes.error.message)
      const ads = adsRes.data || []
      const adIds = ads.map(a => a.ad_id)

      // Stats over last 30 days, aggregated per ad
      const perAd = {}
      if (adIds.length) {
        const since = new Date(); since.setDate(since.getDate() - 30)
        const sinceStr = since.toISOString().split('T')[0]
        const statsRes = await supabase
          .from('ad_daily_stats')
          .select('ad_id, spend, impressions, clicks, results')
          .in('ad_id', adIds)
          .gte('date', sinceStr)
        if (statsRes.error) throw new Error(statsRes.error.message)
        for (const s of statsRes.data || []) {
          const r = perAd[s.ad_id] || { spend: 0, impressions: 0, clicks: 0, leads: 0 }
          r.spend += parseFloat(s.spend || 0)
          r.impressions += parseInt(s.impressions || 0)
          r.clicks += parseInt(s.clicks || 0)
          // ad_daily_stats.results = platform conversion-event count (Meta lead actions).
          // Mapping it onto our local "leads" alias keeps the gallery card display consistent.
          r.leads += parseInt(s.results || 0)
          perAd[s.ad_id] = r
        }
      }

      // Fetch which ads already have a Whisper transcript so the upload
      // button can show "already transcribed" state.
      const transcriptsRes = await supabase
        .from('lib_creative_transcripts')
        .select('ad_id')
        .eq('source', 'whisper_api')
        .not('ad_id', 'is', null)
      const transcribedAds = new Set((transcriptsRes.data || []).map(r => r.ad_id))

      // TODO Phase E: join lib_variant_state_history to populate variant_state.
      const enriched = ads.map(a => {
        const st = perAd[a.ad_id] || {}
        const ctr = st.impressions > 0 ? (st.clicks / st.impressions) * 100 : null
        // asset_type comes from public.ads (image / video / carousel / unknown).
        // Pull it through so AdCard knows whether to show the upload button.
        return {
          ...a,
          asset_type: a.asset_type || null,
          has_whisper_transcript: transcribedAds.has(a.ad_id),
          stats: {
            spend: st.spend || 0,
            impressions: st.impressions || 0,
            clicks: st.clicks || 0,
            leads: st.leads || 0,
            booked: 0,    // populated when setter_leads.utm_content join lands
            closed: 0,
            revenue: 0,
            ctr,
            leadQualityPct: null,
          },
          variant_state: a.variant_id ? 'bench' : 'concept',
          duration_sec: null,
        }
      })
      setRows(enriched)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const triggerSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const { syncMetaAdsAtAdLevel } = await import('../../services/metaAdsSync')
      console.time('[gallery] manual sync')
      const result = await syncMetaAdsAtAdLevel(30)
      console.timeEnd('[gallery] manual sync')
      console.log('[gallery] manual sync result:', result)
      await load()
    } catch (e) {
      console.error('[gallery] sync failed:', e)
      setError(`Sync failed: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // Fire the transcribe-ads Edge Function. Runs server-side so OPENAI_API_KEY
  // stays out of the browser bundle. Processes up to 25 videos per click;
  // re-click to keep going through the backlog.
  const [transcribing, setTranscribing] = useState(false)
  const toast = useToast()
  const triggerTranscribe = async () => {
    setTranscribing(true)
    try {
      const result = await triggerTranscribeAds(25)
      toast.success(
        `Transcribed ${result.processed} videos · ${result.errors} errors · ${result.totalPending} pending. ` +
        (result.totalPending > 0 ? 'Click again to continue the backlog.' : 'All caught up.'),
        { duration: 6000 }
      )
    } catch (e) {
      console.error('[gallery] transcribe failed:', e)
      toast.error(`Transcribe failed: ${e.message}`)
    } finally {
      setTranscribing(false)
    }
  }

  const filtered = useMemo(() => {
    let out = rows
    if (statusFilter !== 'all') out = out.filter(r => r.status === statusFilter)
    if (stateFilter !== 'all') out = out.filter(r => r.variant_state === stateFilter)
    if (spendTier !== 'all') {
      out = out.filter(r => {
        const s = r.stats.spend
        if (spendTier === 'high') return s >= 10000
        if (spendTier === 'mid') return s >= 1000 && s < 10000
        if (spendTier === 'low') return s >= 100 && s < 1000
        if (spendTier === 'tiny') return s < 100
        return true
      })
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(r =>
        (r.ad_name || '').toLowerCase().includes(q) ||
        (r.variant_id || '').toLowerCase().includes(q)
      )
    }
    out = [...out].sort((a, b) => {
      if (sort === 'spend_desc') return b.stats.spend - a.stats.spend
      if (sort === 'closes_desc') return b.stats.closed - a.stats.closed
      if (sort === 'cpa_asc') {
        const aCpa = a.stats.closed > 0 ? a.stats.spend / a.stats.closed : Infinity
        const bCpa = b.stats.closed > 0 ? b.stats.spend / b.stats.closed : Infinity
        return aCpa - bCpa
      }
      return new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime()
    })
    return out
  }, [rows, statusFilter, stateFilter, spendTier, sort, search])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: analystOpen ? 'minmax(0, 1fr) 380px' : 'minmax(0, 1fr)', gap: 16 }} className="ads-gallery-grid">
      {/* Main column */}
      <div>
        {/* Page header for the gallery tab */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
          <div>
            <span className="eyebrow eyebrow-accent">Library · Live gallery</span>
            <h2 className="h3 mt-2" style={{ fontSize: 22 }}>Every ad, <em>at a glance</em>.</h2>
            <p
              className="mt-2"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--ink-3)',
              }}
            >
              {rows.length} ads loaded · {filtered.length} after filters
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={triggerTranscribe}
              disabled={transcribing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                background: 'var(--paper)',
                color: 'var(--ink)',
                border: '1px solid var(--rule)',
                borderRadius: 3,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 500,
                cursor: transcribing ? 'wait' : 'pointer',
                opacity: transcribing ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
              title="Whisper-transcribe up to 25 unprocessed video ads. Click again to continue the backlog."
            >
              <Mic size={12} className={transcribing ? 'animate-pulse' : ''} />
              {transcribing ? 'Transcribing…' : 'Transcribe videos'}
            </button>
            <button
              onClick={() => setAnalystOpen(v => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                background: analystOpen ? 'var(--ink)' : 'var(--accent)',
                color: analystOpen ? 'var(--paper)' : 'var(--ink)',
                border: '1px solid',
                borderColor: analystOpen ? 'var(--ink)' : 'var(--accent)',
                borderRadius: 3,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <Sparkles size={12} />
              {analystOpen ? 'Hide analyst' : 'Ask analyst'}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <FilterBar
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          stateFilter={stateFilter} setStateFilter={setStateFilter}
          spendTier={spendTier} setSpendTier={setSpendTier}
          sort={sort} setSort={setSort}
          search={search} setSearch={setSearch}
        />

        {/* Error banner */}
        {error && (
          <div
            style={{
              padding: '12px 14px',
              border: '1px solid var(--down)',
              borderLeftWidth: 3,
              borderRadius: '0 3px 3px 0',
              background: 'var(--down-soft)',
              color: 'var(--down)',
              marginBottom: 16,
              fontSize: 13,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Gallery error</div>
              {error}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && rows.length === 0 && !error && (
          <div
            style={{
              border: '1px dashed var(--rule)',
              borderRadius: 4,
              padding: 32,
              textAlign: 'center',
              background: 'var(--paper-2)',
            }}
          >
            <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 12 }}>No ads synced</span>
            <h3 className="h3" style={{ fontSize: 22, marginBottom: 10 }}>The <em>library</em> is empty.</h3>
            <p
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 14,
                color: 'var(--ink-2)',
                maxWidth: '46ch',
                margin: '0 auto 18px',
                lineHeight: 1.55,
              }}
            >
              Click sync to pull every ad from your Meta account into <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>public.ads</span>. The hourly autoSync will keep this fresh after the first run.
            </p>
            <button
              onClick={triggerSync}
              disabled={syncing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                background: 'var(--accent)',
                color: 'var(--ink)',
                border: '1px solid var(--accent)',
                borderRadius: 3,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                cursor: syncing ? 'wait' : 'pointer',
                opacity: syncing ? 0.6 : 1,
              }}
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync Meta ads now'}
            </button>
          </div>
        )}

        {loading && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                style={{
                  background: 'var(--paper-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  height: 360,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))}
          </div>
        )}

        {/* Card grid */}
        {!loading && filtered.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {filtered.map(ad => <AdCard key={ad.ad_id} ad={ad} />)}
          </div>
        )}
      </div>

      {/* Analyst panel */}
      {analystOpen && (
        <div style={{ position: 'sticky', top: 0, alignSelf: 'flex-start', height: 'calc(100vh - 80px)' }}>
          <AdAnalystPanel open={analystOpen} onClose={() => setAnalystOpen(false)} />
        </div>
      )}
    </div>
  )
}

function FilterBar({
  statusFilter, setStatusFilter,
  stateFilter, setStateFilter,
  spendTier, setSpendTier,
  sort, setSort,
  search, setSearch,
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 16,
        padding: '10px 12px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      <ChipGroup label="Status"  value={statusFilter} setValue={setStatusFilter} options={STATUS_FILTERS} />
      <ChipGroup label="State"   value={stateFilter}  setValue={setStateFilter}  options={STATE_FILTERS} />
      <ChipGroup label="Spend"   value={spendTier}    setValue={setSpendTier}    options={SPEND_TIERS} />
      <ChipGroup label="Sort"    value={sort}         setValue={setSort}         options={SORTS} />
      <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={12} style={{ color: 'var(--ink-3)', flexShrink: 0, marginLeft: 4 }} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search variant or ad name…"
          style={{
            flex: 1,
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            borderRadius: 2,
            padding: '5px 8px',
            fontSize: 12,
            color: 'var(--ink)',
            outline: 'none',
          }}
        />
      </div>
    </div>
  )
}

function ChipGroup({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          fontWeight: 500,
          marginRight: 4,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'inline-flex',
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          borderRadius: 2,
          padding: 2,
        }}
      >
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setValue(opt.value)}
              style={{
                padding: '4px 9px',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 500,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--ink-3)',
                borderRadius: 2,
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
