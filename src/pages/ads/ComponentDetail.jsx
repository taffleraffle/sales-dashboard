import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader, ChevronLeft, AlertTriangle, Sparkles, MessageSquare, Camera, Users } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import VariantPill from '../../components/ads/VariantPill'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtPctRatio(n) { return n == null || isNaN(n) ? '—' : `${(n * 100).toFixed(2)}%` }
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }

const TYPE_META = {
  hook:        { label: 'Hook',       icon: Sparkles,        backTo: '/sales/ads/hooks' },
  body_angle:  { label: 'Body Angle', icon: MessageSquare,   backTo: '/sales/ads/bodies' },
  scene:       { label: 'Scene',      icon: Camera,          backTo: '/sales/ads/scenes' },
  creator:     { label: 'Creator',    icon: Users,           backTo: '/sales/ads/creators' },
}

const VARIANT_STATUS_TONE = {
  planned: 'bg-bg-card-hover text-text-400 border-border-default',
  editing: 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30',
  ready:   'bg-success/10 text-success border-success/30',
  live:    'bg-success/20 text-success border-success/40',
  paused:  'bg-opt-yellow/10 text-opt-yellow border-opt-yellow/20',
  killed:  'bg-danger/10 text-danger border-danger/30',
  winner:  'bg-opt-yellow/30 text-opt-yellow border-opt-yellow/60',
}

function StatTile({ label, value, sub }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-2xl p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-400">{label}</p>
      <p className="text-lg font-semibold text-text-primary mt-0.5">{value}</p>
      {sub && <p className="text-[10px] text-text-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function ComponentDetail() {
  const { id: componentId } = useParams()
  const [component, setComponent] = useState(null)
  const [perf, setPerf] = useState(null)
  const [variants, setVariants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const lib = supabase.schema('library')
        const [{ data: c, error: cErr }, { data: p, error: pErr }] = await Promise.all([
          lib.from('components').select('*').eq('component_id', componentId).maybeSingle(),
          lib.from('component_performance').select('*').eq('component_id', componentId).maybeSingle(),
        ])
        if (cErr) throw new Error(`Load component failed: ${cErr.message}`)
        if (pErr) throw new Error(`Load perf failed: ${pErr.message}`)
        if (cancelled) return
        if (!c) { setError(`Component ${componentId} not found in library`); setLoading(false); return }
        setComponent(c)
        setPerf(p || null)

        // Load variants — depends on which slot the component fills
        const slotCol = c.type === 'hook' ? 'hook_id'
          : c.type === 'body_angle' ? 'body_angle_id'
          : c.type === 'scene' ? 'scene_id'
          : 'creator_id'
        const { data: vs, error: vErr } = await lib
          .from('variants')
          .select('*')
          .eq(slotCol, c.id)
        if (vErr) throw new Error(`Load variants failed: ${vErr.message}`)
        if (!cancelled) setVariants(vs || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [componentId])

  const meta = component ? TYPE_META[component.type] : null
  const Icon = meta?.icon

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-opt-yellow" /></div>

  if (error || !component) {
    return (
      <div>
        <Link to="/sales/ads" className="text-xs text-text-400 hover:text-opt-yellow flex items-center gap-1 mb-3"><ChevronLeft size={14} /> Back</Link>
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-2xl p-4 flex items-center gap-2">
          <AlertTriangle size={16} /> <span>{error || `Component ${componentId} not found`}</span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <Link to={meta.backTo} className="text-xs text-text-400 hover:text-opt-yellow flex items-center gap-1 mb-3">
        <ChevronLeft size={14} /> Back to {meta.label}s
      </Link>

      <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-opt-yellow/15 text-opt-yellow flex items-center justify-center">
            {Icon && <Icon size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-text-primary font-mono">{component.component_id}</h2>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border-default text-text-400">
                {meta.label}
              </span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-opt-yellow/30 bg-opt-yellow/10 text-opt-yellow">
                {component.status?.replace('_', ' ')}
              </span>
            </div>
            <p className="text-sm text-text-primary mt-1">{component.label}</p>
            {component.description && <p className="text-xs text-text-400 mt-1">{component.description}</p>}
          </div>
        </div>

        {(component.script_text || component.duration_sec || component.asset_url) && (
          <div className="mt-3 pt-3 border-t border-border-default/40 grid sm:grid-cols-3 gap-3 text-xs">
            {component.duration_sec && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-text-400">Duration</p>
                <p className="text-text-primary">{component.duration_sec}s</p>
              </div>
            )}
            {component.script_text && (
              <div className="sm:col-span-2">
                <p className="text-[10px] uppercase tracking-wider text-text-400">Script</p>
                <p className="text-text-primary whitespace-pre-wrap">{component.script_text}</p>
              </div>
            )}
            {component.asset_url && (
              <div className="sm:col-span-3">
                <p className="text-[10px] uppercase tracking-wider text-text-400">Reference asset</p>
                {/\.(mp4|webm|mov)(\?|$)/i.test(component.asset_url) ? (
                  <video src={component.asset_url} controls className="mt-1 w-full max-w-md rounded-lg" />
                ) : (
                  <a href={component.asset_url} target="_blank" rel="noreferrer" className="text-opt-yellow hover:underline break-all">{component.asset_url}</a>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <h3 className="text-xs uppercase tracking-wider text-text-400 mb-2">Weighted performance · across {fmtN(perf?.variant_count || 0)} variant{(perf?.variant_count || 0) === 1 ? '' : 's'}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2 mb-1">
        <StatTile label="Spend" value={fmt$((perf?.total_spend || 0) * NZD_TO_USD)} sub="USD" />
        <StatTile label="Impressions" value={fmtN(perf?.total_impressions)} />
        <StatTile label="Hook%" value={fmtPctRatio(perf?.weighted_hook_rate)} />
        <StatTile label="Hold%" value={fmtPctRatio(perf?.weighted_hold_rate)} />
        <StatTile label="CTR" value={fmtPctRatio(perf?.weighted_ctr)} />
      </div>
      {((perf?.total_leads || 0) > 0 || (perf?.total_booked_calls || 0) > 0 || (perf?.total_closes || 0) > 0) ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <StatTile label="Leads" value={fmtN(perf?.total_leads)} sub={perf?.cpl ? fmt$(perf.cpl * NZD_TO_USD) + ' CPL' : null} />
          <StatTile label="Booked" value={fmtN(perf?.total_booked_calls)} />
          <StatTile label="Closes" value={fmtN(perf?.total_closes)} sub={perf?.cost_per_close ? fmt$(perf.cost_per_close * NZD_TO_USD) + ' / close' : null} />
          <StatTile label="CPA" value={fmt$(perf?.cpa ? perf.cpa * NZD_TO_USD : null)} />
        </div>
      ) : (
        <p className="text-[10px] text-text-400 px-1 mb-4">
          Funnel attribution (leads · bookings · closes · CPA) ships in Phase 4 once HYROS UTMs are wired up.
        </p>
      )}

      <h3 className="text-xs uppercase tracking-wider text-text-400 mb-2">Variants using this component · {variants.length}</h3>
      {variants.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-2xl p-6 text-center text-text-400 text-sm">
          No variants reference this component yet.
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border-default">
                <th className="text-left px-3 py-2 font-normal">Variant</th>
                <th className="text-left px-3 py-2 font-normal">Status</th>
                <th className="text-left px-3 py-2 font-normal">Iter</th>
                <th className="text-left px-3 py-2 font-normal">Meta ad</th>
                <th className="text-left px-3 py-2 font-normal">Launched</th>
              </tr>
            </thead>
            <tbody>
              {variants.map(v => (
                <tr key={v.id} className="border-b border-border-default/40 hover:bg-bg-card-hover">
                  <td className="px-3 py-2">
                    <Link to={`/sales/ads/variants/${encodeURIComponent(v.variant_id)}`} className="text-opt-yellow font-mono text-[11px] hover:underline">
                      {v.variant_id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${VARIANT_STATUS_TONE[v.status] || VARIANT_STATUS_TONE.planned}`}>
                      {v.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">v{v.iteration}</td>
                  <td className="px-3 py-2">
                    {v.meta_ad_id ? (
                      <Link to={`/sales/ads/ad/${v.meta_ad_id}`} className="text-text-secondary hover:text-opt-yellow truncate block max-w-xs" title={v.meta_ad_name || v.meta_ad_id}>
                        {v.meta_ad_name || v.meta_ad_id}
                      </Link>
                    ) : <span className="text-text-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-text-400">{v.launched_at ? new Date(v.launched_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
