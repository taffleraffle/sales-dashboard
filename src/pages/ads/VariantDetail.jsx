import { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Loader, ChevronLeft, AlertTriangle, Sparkles, MessageSquare, Camera, Users } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtPct(n, denom) {
  if (!n || !denom) return '—'
  return `${((n / denom) * 100).toFixed(2)}%`
}
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }

const COMPONENT_ICON = { hook: Sparkles, body_angle: MessageSquare, scene: Camera, creator: Users }

function ComponentSlot({ slot, component }) {
  const Icon = COMPONENT_ICON[slot]
  if (!component) return (
    <div className="bg-bg-card border border-dashed border-border-default rounded-sm p-3">
      <p className="text-[9px] uppercase tracking-wider text-text-400">{slot.replace('_', ' ')}</p>
      <p className="text-sm text-text-400 mt-1">Not set</p>
    </div>
  )
  return (
    <Link to={`/sales/ads/components/${encodeURIComponent(component.component_id)}`} className="bg-bg-card border border-border-default rounded-sm p-3 hover:border-opt-yellow/40 transition-colors block">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-text-400">
        <Icon size={10} /> {slot.replace('_', ' ')}
      </div>
      <p className="text-sm font-mono text-text-primary mt-1">{component.component_id}</p>
      <p className="text-xs text-text-secondary truncate">{component.label}</p>
    </Link>
  )
}

export default function VariantDetail() {
  const { variantId } = useParams()
  const navigate = useNavigate()
  // One bundle for all variant-derived state — avoids three separate re-renders
  // and keeps related fields atomic.
  const [data, setData] = useState({ variant: null, components: {}, perf: [], linkedAds: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const { variant, components, perf, linkedAds } = data

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: v, error: vErr } = await supabase
          .from('lib_variants')
          .select('*')
          .eq('variant_id', variantId)
          .maybeSingle()
        if (vErr) throw new Error(`Load variant failed: ${vErr.message}`)
        if (!v) { if (!cancelled) { setError(`Variant ${variantId} not found`); setLoading(false) }; return }

        const ids = [v.hook_id, v.body_angle_id, v.scene_id, v.creator_id].filter(Boolean)
        const [compsRes, perfRes, adsRes] = await Promise.all([
          ids.length ? supabase.from('lib_components').select('*').in('id', ids) : Promise.resolve({ data: [], error: null }),
          supabase.from('lib_performance_daily').select('*').eq('variant_id', v.id).order('date', { ascending: true }),
          supabase.from('ads').select('*').eq('variant_id', variantId),
        ])
        if (compsRes.error) throw new Error(`Load components failed: ${compsRes.error.message}`)
        if (perfRes.error) throw new Error(`Load performance failed: ${perfRes.error.message}`)
        if (adsRes.error) throw new Error(`Load linked ads failed: ${adsRes.error.message}`)
        if (cancelled) return

        const compMap = { hook: null, body_angle: null, scene: null, creator: null }
        for (const c of compsRes.data || []) {
          if (c.id === v.hook_id) compMap.hook = c
          if (c.id === v.body_angle_id) compMap.body_angle = c
          if (c.id === v.scene_id) compMap.scene = c
          if (c.id === v.creator_id) compMap.creator = c
        }

        setData({
          variant: v,
          components: compMap,
          perf: perfRes.data || [],
          linkedAds: adsRes.data || [],
        })
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [variantId])

  const totals = useMemo(() => {
    const t = perf.reduce((a, r) => ({
      spend: a.spend + parseFloat(r.spend || 0),
      impressions: a.impressions + parseInt(r.impressions || 0),
      clicks: a.clicks + parseInt(r.clicks || 0),
      three_sec: a.three_sec + parseInt(r.three_sec_views || 0),
      thru: a.thru + parseInt(r.thruplays || 0),
      leads: a.leads + parseInt(r.leads || 0),
      booked: a.booked + parseInt(r.booked_calls || 0),
      closes: a.closes + parseInt(r.closes || 0),
      revenue: a.revenue + parseFloat(r.revenue || 0),
    }), { spend: 0, impressions: 0, clicks: 0, three_sec: 0, thru: 0, leads: 0, booked: 0, closes: 0, revenue: 0 })
    return {
      ...t,
      spend_usd: t.spend * NZD_TO_USD,
      hook_rate: fmtPct(t.three_sec, t.impressions),
      hold_rate: fmtPct(t.thru, t.three_sec),
      ctr: fmtPct(t.clicks, t.impressions),
      cpa: t.booked > 0 ? (t.spend * NZD_TO_USD) / t.booked : null,
    }
  }, [perf])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-text-primary" /></div>

  if (error || !variant) {
    return (
      <div>
        <Link to="/sales/ads" className="text-xs text-text-400 hover:text-text-primary flex items-center gap-1 mb-3"><ChevronLeft size={14} /> Back</Link>
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-sm p-4 flex items-center gap-2">
          <AlertTriangle size={16} /> <span>{error || `Variant ${variantId} not found`}</span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => {
            // Use history if there's something to go back to, else fall through to the link.
            if (window.history.length > 1) navigate(-1)
            else navigate('/sales/ads/variants')
          }}
          className="text-xs text-text-400 hover:text-text-primary flex items-center gap-1"
        >
          <ChevronLeft size={14} /> Back
        </button>
        <Link to="/sales/ads/variants" className="text-[10px] text-text-400 hover:text-text-primary uppercase tracking-wider">
          All variants
        </Link>
      </div>

      <div className="bg-bg-card border border-border-default rounded-sm p-4 mb-4">
        <div className="flex items-start gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-text-primary font-mono">{variant.variant_id}</h2>
            <p className="text-xs text-text-400">Iteration v{variant.iteration} · status: {variant.status}</p>
          </div>
          {variant.launched_at && (
            <div className="ml-auto text-right">
              <p className="text-[10px] uppercase tracking-wider text-text-400">Launched</p>
              <p className="text-xs text-text-primary">{new Date(variant.launched_at).toLocaleDateString()}</p>
            </div>
          )}
        </div>
        {variant.notes && <p className="mt-2 text-xs text-text-secondary whitespace-pre-wrap">{variant.notes}</p>}
      </div>

      <h3 className="text-xs uppercase tracking-wider text-text-400 mb-2">Components</h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
        <ComponentSlot slot="hook" component={components.hook} />
        <ComponentSlot slot="body_angle" component={components.body_angle} />
        <ComponentSlot slot="scene" component={components.scene} />
        <ComponentSlot slot="creator" component={components.creator} />
      </div>

      {variant.asset_url && (
        <div className="bg-bg-card border border-border-default rounded-sm p-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider text-text-400 mb-1.5">Final asset</p>
          {/\.(mp4|webm|mov)(\?|$)/i.test(variant.asset_url) ? (
            <video src={variant.asset_url} controls className="w-full max-w-2xl rounded-lg" />
          ) : (
            <img src={variant.asset_url} alt={variant.variant_id} className="w-full max-w-2xl rounded-lg" />
          )}
        </div>
      )}

      <h3 className="text-xs uppercase tracking-wider text-text-400 mb-2">Performance · {perf.length} day{perf.length === 1 ? '' : 's'} on record</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-1">
        <Tile label="Spend" value={fmt$(totals.spend_usd)} />
        <Tile label="Impressions" value={fmtN(totals.impressions)} />
        <Tile label="Hook%" value={totals.hook_rate} />
        <Tile label="Hold%" value={totals.hold_rate} />
        <Tile label="CTR" value={totals.ctr} />
        <Tile label="Clicks" value={fmtN(totals.clicks)} />
      </div>
      {(totals.booked > 0 || totals.closes > 0 || totals.revenue > 0) ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <Tile label="Booked" value={fmtN(totals.booked)} />
          <Tile label="Closes" value={fmtN(totals.closes)} />
          <Tile label="Revenue" value={fmt$(totals.revenue * NZD_TO_USD)} />
          <Tile label="CPA" value={fmt$(totals.cpa)} highlight />
        </div>
      ) : (
        <p className="text-[10px] text-text-400 px-1 mb-4">
          Funnel attribution (bookings · closes · revenue · CPA) ships in Phase 4 once HYROS UTMs are wired up.
        </p>
      )}

      <h3 className="text-xs uppercase tracking-wider text-text-400 mb-2">Linked Meta ads · {linkedAds.length}</h3>
      {linkedAds.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-sm p-6 text-center text-text-400 text-sm">
          No Meta ads currently linked to this variant. Once a Meta ad with this variant_id in its name is synced, it will auto-link here.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {linkedAds.map(a => (
            <Link key={a.ad_id} to={`/sales/ads/ad/${a.ad_id}`} className="bg-bg-card border border-border-default rounded-sm p-3 hover:border-opt-yellow/40 transition-colors">
              {a.thumbnail_url && <img src={a.thumbnail_url} alt="" className="aspect-video object-cover rounded-lg mb-2" loading="lazy" />}
              <p className="text-xs text-text-primary truncate">{a.ad_name || a.ad_id}</p>
              <p className="text-[10px] text-text-400">{a.effective_status || a.status} · {a.campaign_name || '—'}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, highlight }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-sm p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-400">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 ${highlight ? 'text-text-primary' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}
