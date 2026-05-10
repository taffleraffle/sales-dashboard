import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader, ChevronLeft, AlertTriangle, ExternalLink, Tag } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import VariantPill from '../../components/ads/VariantPill'
import TagVariantModal from '../../components/ads/TagVariantModal'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
function fmtPct(n) { return n == null || isNaN(n) ? '—' : `${n.toFixed(2)}%` }
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }

function StatTile({ label, value, sub }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-sm p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-400">{label}</p>
      <p className="text-lg font-semibold text-text-primary mt-0.5">{value}</p>
      {sub && <p className="text-[10px] text-text-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function AdDetail() {
  const { id } = useParams()
  const [ad, setAd] = useState(null)
  const [stats, setStats] = useState([])
  const [transcript, setTranscript] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tagOpen, setTagOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const [hyrosEvents, setHyrosEvents] = useState([])
  // Signed URL for the uploaded source MP4 (if one was uploaded via the
  // C3 upload button). Null when no MP4 has been dropped yet — in that
  // case AdDetail shows the poster image with a "View on Meta" link
  // rather than a broken <video> element pointing at the poster.
  const [videoUrl, setVideoUrl] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [{ data: a, error: aErr }, { data: s, error: sErr }, { data: t }, { data: he }] = await Promise.all([
          supabase.from('ads').select('*').eq('ad_id', id).single(),
          supabase.from('ad_daily_stats').select('*').eq('ad_id', id).order('date', { ascending: true }),
          supabase.from('lib_creative_transcripts').select('full_text, duration_sec, created_at, source').eq('ad_id', id).eq('source', 'whisper_api').order('created_at', { ascending: false }).limit(1),
          supabase.from('hyros_events').select('event_type, event_date, email, first_name, last_name, is_qualified, revenue, source, campaign_name, ad_name').or(`meta_ad_id.eq.${id},source_link_ad_id.eq.${id}`).order('event_date', { ascending: false }).limit(30),
        ])
        if (aErr) throw new Error(`Load ad failed: ${aErr.message}`)
        if (sErr) throw new Error(`Load stats failed: ${sErr.message}`)
        if (cancelled) return
        setAd(a)
        setStats(s || [])
        setTranscript((t && t[0]) || null)
        setHyrosEvents(he || [])

        // If a source MP4 was uploaded for this ad, mint a signed URL so the
        // <video> tag can stream it. Bucket is private; signed URL is the
        // only way to play. List by prefix because the extension may be
        // .mp4 / .mov / .webm depending on what was uploaded.
        if (a?.asset_type === 'video') {
          const { data: files } = await supabase.storage
            .from('ad-source-videos')
            .list('', { search: id, limit: 5 })
          const match = (files || []).find(f => f.name.startsWith(`${id}.`))
          if (match) {
            const { data: signed } = await supabase.storage
              .from('ad-source-videos')
              .createSignedUrl(match.name, 3600)
            if (signed?.signedUrl && !cancelled) setVideoUrl(signed.signedUrl)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, reloadKey])

  const totals = useMemo(() => {
    const t = stats.reduce((a, s) => ({
      spend: a.spend + parseFloat(s.spend || 0),
      impressions: a.impressions + parseInt(s.impressions || 0),
      clicks: a.clicks + parseInt(s.clicks || 0),
      results: a.results + parseInt(s.results || 0),
      v3s: a.v3s + parseInt(s.video_3s_views || 0),
      thru: a.thru + parseInt(s.video_thruplays || 0),
    }), { spend: 0, impressions: 0, clicks: 0, results: 0, v3s: 0, thru: 0 })
    const spend_usd = t.spend * NZD_TO_USD
    return {
      spend_usd,
      impressions: t.impressions,
      clicks: t.clicks,
      results: t.results,
      ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
      cpm: t.impressions > 0 ? (spend_usd / t.impressions) * 1000 : null,
      cpc: t.clicks > 0 ? spend_usd / t.clicks : null,
      cpa: t.results > 0 ? spend_usd / t.results : null,
      hook_rate: t.impressions > 0 ? (t.v3s / t.impressions) * 100 : null,
      hold_rate: t.v3s > 0 ? (t.thru / t.v3s) * 100 : null,
    }
  }, [stats])

  // Tiny SVG sparkline of daily spend
  const chartPath = useMemo(() => {
    if (!stats.length) return null
    const w = 600, h = 80, pad = 4
    const max = Math.max(...stats.map(s => parseFloat(s.spend || 0)), 1)
    const xStep = stats.length > 1 ? (w - 2 * pad) / (stats.length - 1) : 0
    const points = stats.map((s, i) => {
      const x = pad + i * xStep
      const y = h - pad - ((parseFloat(s.spend || 0) / max) * (h - 2 * pad))
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    return { path: `M ${points.join(' L ')}`, w, h }
  }, [stats])

  if (loading) return <div className="flex items-center justify-center h-64"><Loader className="animate-spin text-text-primary" /></div>

  if (error || !ad) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link to="/sales/ads/list" className="text-xs text-text-400 hover:text-text-primary flex items-center gap-1 mb-3"><ChevronLeft size={14} /> Back to Ad Performance</Link>
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-sm p-4 flex items-center gap-2">
          <AlertTriangle size={16} /> <span>{error || `Ad ${id} not found`}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[1400px] mx-auto">
      <Link to="/sales/ads/list" className="text-xs text-text-400 hover:text-text-primary flex items-center gap-1 mb-3">
        <ChevronLeft size={14} /> Back to Ad Performance
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Creative preview */}
        <div className="bg-bg-card border border-border-default rounded-sm p-3">
          {ad.asset_type === 'video' && videoUrl ? (
            // Uploaded MP4 — actually playable
            <video src={videoUrl} poster={ad.thumbnail_url || ad.asset_url || undefined} controls preload="metadata" className="w-full rounded-lg bg-bg-primary" />
          ) : ad.asset_type === 'video' ? (
            // Video ad without an uploaded source MP4: show the poster as an
            // image (NOT inside a <video> tag — Meta's poster URL is a still,
            // not a stream) and offer a public Meta Ads Library link as a
            // "view on Meta" path so the operator can still watch the ad.
            <div className="relative">
              <img src={ad.asset_url || ad.thumbnail_url} alt={ad.ad_name || ''} className="w-full rounded-lg" />
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 rounded-lg gap-2 text-paper">
                <span className="text-[10px] uppercase tracking-wider opacity-80">Poster only · no source MP4 uploaded</span>
                <a
                  href={`https://www.facebook.com/ads/library/?id=${ad.ad_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 bg-accent text-ink rounded-sm text-xs font-mono uppercase tracking-wider"
                  style={{ background: 'var(--accent)', color: 'var(--ink)' }}
                >
                  View on Meta Ads Library
                </a>
                <span className="text-[10px] opacity-70">Or upload source MP4 from gallery card to enable playback</span>
              </div>
            </div>
          ) : ad.thumbnail_url || ad.asset_url ? (
            <img src={ad.asset_url || ad.thumbnail_url} alt={ad.ad_name || ''} className="w-full rounded-lg" />
          ) : (
            <div className="aspect-video bg-bg-primary rounded-lg flex items-center justify-center text-text-400 text-sm">No creative asset on file</div>
          )}
        </div>

        {/* Meta */}
        <div className="bg-bg-card border border-border-default rounded-sm p-4 space-y-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-400">Ad</p>
            <p className="text-lg font-semibold text-text-primary">{ad.ad_name || ad.ad_id}</p>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <VariantPill variantId={ad.variant_id} matchStatus={ad.variant_match_status} />
              <button
                onClick={() => setTagOpen(true)}
                className="flex items-center gap-1 text-[10px] text-text-primary hover:underline uppercase tracking-wider"
              >
                <Tag size={10} /> {ad.variant_id ? 'Re-tag' : 'Tag with variant'}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Field label="Status" value={ad.effective_status || ad.status || '—'} />
            <Field label="Asset type" value={ad.asset_type || '—'} />
            <Field label="Campaign" value={ad.campaign_name || '—'} />
            <Field label="Adset" value={ad.adset_name || '—'} />
          </div>
          {ad.headline && <Field label="Headline" value={ad.headline} block />}
          {ad.primary_text && <Field label="Primary text" value={ad.primary_text} block />}
          {ad.description && <Field label="Description" value={ad.description} block />}
          {ad.cta_type && <Field label="CTA" value={ad.cta_type} />}
          {ad.destination_url && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-text-400">Destination</p>
              <a href={ad.destination_url} target="_blank" rel="noreferrer" className="text-xs text-text-primary hover:underline flex items-center gap-1 break-all">
                {ad.destination_url} <ExternalLink size={10} />
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Lifetime stats */}
      <h2 className="text-xs uppercase tracking-wider text-text-400 mb-2">Performance · last {stats.length} day{stats.length === 1 ? '' : 's'} on record</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        <StatTile label="Spend" value={fmt$(totals.spend_usd)} sub="USD" />
        <StatTile label="Impressions" value={fmtN(totals.impressions)} />
        <StatTile label="Clicks" value={fmtN(totals.clicks)} sub={fmtPct(totals.ctr) + ' CTR'} />
        <StatTile label="CPM" value={fmt$(totals.cpm)} />
        <StatTile label="Results" value={fmtN(totals.results)} sub={totals.cpa != null ? fmt$(totals.cpa) + ' CPA' : '—'} />
        <StatTile label="Hook · Hold" value={`${fmtPct(totals.hook_rate)} · ${fmtPct(totals.hold_rate)}`} />
      </div>

      {/* Transcript — only for video ads */}
      {ad.asset_type === 'video' && (
        <div className="bg-bg-card border border-border-default rounded-sm p-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider text-text-400 mb-2">
            Spoken transcript
            {transcript ? ` · ${Math.round(transcript.duration_sec || 0)}s · Whisper` : ''}
          </p>
          {transcript ? (
            <div className="whitespace-pre-wrap text-sm text-text-secondary leading-relaxed font-serif italic">
              "{transcript.full_text}"
            </div>
          ) : (
            <div className="text-xs text-text-400 leading-relaxed">
              No transcript on file for this ad yet. Meta's Graph API restricts the video source URL on ad-creative
              videos, so we can't auto-pull and transcribe. To get a transcript, drop the source MP4 via the upload
              button on this ad's card in the gallery — it runs Whisper server-side and links the transcript here.
            </div>
          )}
        </div>
      )}

      {/* HYROS attribution — calls + leads attributed to this exact ad */}
      <HyrosSection events={hyrosEvents} />

      {/* Spend sparkline */}
      {chartPath && (
        <div className="bg-bg-card border border-border-default rounded-sm p-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider text-text-400 mb-1.5">Daily spend ({stats[0].date} → {stats[stats.length - 1].date})</p>
          <svg viewBox={`0 0 ${chartPath.w} ${chartPath.h}`} className="w-full h-20">
            <path d={chartPath.path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-primary" />
          </svg>
        </div>
      )}

      {/* Daily table */}
      <div className="bg-bg-card border border-border-default rounded-sm p-3 overflow-x-auto">
        <p className="text-[10px] uppercase tracking-wider text-text-400 mb-2">Daily breakdown</p>
        <table className="w-full text-xs">
          <thead className="text-text-400 text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left py-1.5 font-normal">Date</th>
              <th className="text-right py-1.5 font-normal">Spend</th>
              <th className="text-right py-1.5 font-normal">Imps</th>
              <th className="text-right py-1.5 font-normal">Clicks</th>
              <th className="text-right py-1.5 font-normal">CTR</th>
              <th className="text-right py-1.5 font-normal">CPM</th>
              <th className="text-right py-1.5 font-normal">Hook%</th>
              <th className="text-right py-1.5 font-normal">Results</th>
              <th className="text-right py-1.5 font-normal">CPA</th>
            </tr>
          </thead>
          <tbody>
            {stats.slice().reverse().map(s => {
              const spend_usd = parseFloat(s.spend || 0) * NZD_TO_USD
              const ctr = s.impressions > 0 ? (s.clicks / s.impressions) * 100 : null
              const cpm = s.impressions > 0 ? (spend_usd / s.impressions) * 1000 : null
              const hook = s.impressions > 0 ? (s.video_3s_views / s.impressions) * 100 : null
              const cpa = s.results > 0 ? spend_usd / s.results : null
              return (
                <tr key={s.date} className="border-t border-border-default/40">
                  <td className="py-1.5 text-text-secondary">{s.date}</td>
                  <td className="py-1.5 text-right">{fmt$(spend_usd)}</td>
                  <td className="py-1.5 text-right">{fmtN(s.impressions)}</td>
                  <td className="py-1.5 text-right">{fmtN(s.clicks)}</td>
                  <td className="py-1.5 text-right">{fmtPct(ctr)}</td>
                  <td className="py-1.5 text-right">{fmt$(cpm)}</td>
                  <td className="py-1.5 text-right">{fmtPct(hook)}</td>
                  <td className="py-1.5 text-right">{fmtN(s.results)}</td>
                  <td className="py-1.5 text-right text-text-primary">{fmt$(cpa)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!stats.length && <p className="text-xs text-text-400 text-center py-4">No daily insights synced for this ad yet.</p>}
      </div>

      <TagVariantModal
        open={tagOpen}
        adId={ad.ad_id}
        adName={ad.ad_name}
        currentVariantId={ad.variant_id}
        onClose={() => setTagOpen(false)}
        onTagged={() => setReloadKey(k => k + 1)}
      />
    </div>
  )
}

function Field({ label, value, block }) {
  return (
    <div className={block ? 'col-span-2' : ''}>
      <p className="text-[10px] uppercase tracking-wider text-text-400">{label}</p>
      <p className={`text-text-secondary ${block ? 'text-xs whitespace-pre-wrap' : 'text-xs'}`}>{value}</p>
    </div>
  )
}

function HyrosSection({ events }) {
  const calls = events.filter(e => e.event_type === 'call.attributed')
  const leads = events.filter(e => e.event_type === 'lead.attributed')
  const sales = events.filter(e => e.event_type === 'sale.attributed')
  const qualifiedCalls = calls.filter(c => c.is_qualified === true).length
  const totalRevenue = sales.reduce((s, e) => s + parseFloat(e.revenue || 0), 0)

  return (
    <div className="bg-bg-card border border-border-default rounded-sm p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider text-text-400">
          HYROS attribution · last 90 days
        </p>
        <p className="text-[10px] text-text-400">{events.length} events</p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <StatTile label="Calls booked" value={fmtN(calls.length)} sub={qualifiedCalls > 0 ? `${qualifiedCalls} qualified` : null} />
        <StatTile label="Leads" value={fmtN(leads.length)} />
        <StatTile label="Sales" value={fmtN(sales.length)} sub={sales.length === 0 ? 'Stripe→HYROS not wired' : null} />
        <StatTile label="Revenue" value={fmt$(totalRevenue)} sub="HYROS-attributed" />
      </div>

      {/* Event list */}
      {events.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-400 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left py-1.5 font-normal">Date</th>
                <th className="text-left py-1.5 font-normal">Type</th>
                <th className="text-left py-1.5 font-normal">Lead</th>
                <th className="text-left py-1.5 font-normal">Source</th>
                <th className="text-right py-1.5 font-normal">Qualified</th>
                <th className="text-right py-1.5 font-normal">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i} className="border-t border-border-default/40">
                  <td className="py-1.5 text-text-secondary">{e.event_date}</td>
                  <td className="py-1.5 text-text-secondary">{e.event_type?.replace('.attributed', '')}</td>
                  <td className="py-1.5 text-text-secondary">{[e.first_name, e.last_name].filter(Boolean).join(' ') || e.email || '—'}</td>
                  <td className="py-1.5 text-text-secondary">{e.source || e.campaign_name || '—'}</td>
                  <td className="py-1.5 text-right">{e.is_qualified === true ? 'yes' : e.is_qualified === false ? 'no' : '—'}</td>
                  <td className="py-1.5 text-right">{parseFloat(e.revenue || 0) > 0 ? fmt$(parseFloat(e.revenue)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-text-400 leading-relaxed">
          No HYROS-attributed events for this ad yet. Webhook is live and the daily sync pulls /calls + /leads;
          events arrive within minutes of a Calendly booking or form fill.
        </p>
      )}
    </div>
  )
}
