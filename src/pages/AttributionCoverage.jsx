import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  SectionHead, Eyebrow, Pill, Card, Button, BigNumber, Icon,
  fmtMoneyFull, fmtNum, fmtPct, PALETTE, WinnerBadge, PodiumRank,
} from '../components/editorial/atoms'
import { useAudiences } from '../hooks/useAudiences'

// ad_daily_stats.spend is NZD (Meta bills the OPT account in NZD; the
// sync-meta-ads-full Edge Function writes raw spend without conversion).
// Every Ads page (AdsList, AdDetail, ComponentDetail) multiplies by this
// rate at display time. Do the same here so spend / CPL / coverage
// numbers are USD-consistent with the Marketing page and the Ads pages.
//
// The coverage / gap / attribution stage values (counts, percentages)
// are currency-agnostic so they don't need conversion.
const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')
const toUsd = (n) => (Number(n) || 0) * NZD_TO_USD

/*
  Attribution Coverage Report (rewritten Ben 2026-06-01, full-screen edit).

  Layout (top→bottom):
    1. KPI hero (3 tiles)              — traced %, untraced $, unresolved submits
    2. Top performers grid             — best-performing ads at a glance
    3. Kanban by audience              — every active ad bucketed by vertical
       └ row click opens side drawer for editing/attributing
    4. The chain                       — funnel coverage table
    5. Gap ads                         — ads producing zero traceable leads
    6. QA queue                        — flagged closer/lives calls
    7. What this means                 — action checklist

  Side drawer (right edge): full ad detail + audience picker + manual override
  notes. Replaces the old per-row inline dropdown which was a bad UX at scale.

  Cache: stages, gapAds, unresolved, freshness, kanbanAds, qaQueue all fetch
  in parallel on mount + on windowKey change + on a manual Refresh click.
*/

// ───────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────

const STAGE_HELP = {
  spend_total:      'Total Meta spend in the window. Source of truth: ad_daily_stats.',
  spend_with_lead:  'Spend on ads that produced at least one Typeform submit with ad_id resolved. Low % = ad URLs missing {{ad.id}}.',
  submits:          'Total Typeform submissions in the window.',
  submits_utms:     'Of submits, how many arrived with a utm_campaign set. Missing UTMs usually mean direct nav, refresh, or a bookmark.',
  submits_ad_id:    'Of submits, how many resolved to a specific Meta ad_id (the strongest attribution).',
  ghl_matched:      'Of submits, how many we found in GHL by email match — means the contact actually entered the CRM.',
  booked:           'Of submits, how many booked a call.',
  showed:           'Of submits, how many actually showed up on the call.',
  closed:           'Of submits, how many became closed sales.',
  paid:             'Of submits, how many produced a payment in Stripe/Fanbasis.',
}

// KNOWN_AUDIENCES is now derived from useAudiences() at render time
// (migration 131). The constant below is a fallback while the hook loads
// so chip pickers don't briefly render empty.
const FALLBACK_KNOWN_AUDIENCES = [
  'restoration', 'electrician', 'accounting', 'bookkeeping',
  'pool_builders', 'real_estate', 'roofing', 'plumbing', 'hvac',
]

// Two fixed columns wrap the data-driven middle: "Needs review" on the left
// (orphans), "Other verticals" on the right (anything not in the active
// audience_definitions list). The middle columns are generated from the hook.
const FIXED_LEFT_COLUMN = {
  slug: 'unclassified', label: 'Needs review',     color: PALETTE.red,
  hint: 'No vertical set yet — these are leaking.',
}
const FIXED_RIGHT_COLUMN = {
  slug: 'other', label: 'Other verticals',         color: PALETTE.ink3,
  hint: '',
}

const WINDOW_OPTIONS = [
  { key: '7d',  label: '7 days',  days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
]

// Audience → representative campaign string for the marketing rollup parser.
const UTM_CAMPAIGN_MAP = {
  Restoration:  'SCIO -Restoration - Application - 4/22 - New Videos',
  Electricians: 'SCIO - Electricians - VSL - 5/4 images - Relaunch',
  Accounting:   'SCIO - Accounting - VSL',
  Plumbing:     'SCIO - Plumbing - VSL',
  HVAC:         'SCIO - HVAC - VSL',
  Roofing:      'SCIO - Roofing - VSL',
  REFERRAL:     'REFERRAL',
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

// Client-side mirror of the SQL audience_from_campaign_name parser. Pass the
// hook's `audiences` array; lowest sort_order wins (matches SQL ORDER BY).
// Returns the audience slug or null.
function parseAudienceFromCampaign(utm_campaign, audiences) {
  if (!utm_campaign) return null
  const s = utm_campaign.toLowerCase()
  const sorted = [...(audiences || [])]
    .filter(a => a.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100))
  for (const a of sorted) {
    for (const kw of (a.keywords || [])) {
      if (s.includes(String(kw).toLowerCase())) return a.slug
    }
  }
  return null
}

function covTone(pct) {
  if (pct == null) return 'default'
  if (pct >= 90) return 'green'
  if (pct >= 70) return 'amber'
  return 'red'
}

function cplTone(cpl) {
  if (cpl == null) return 'default'
  if (cpl > 250) return 'red'
  if (cpl > 120) return 'amber'
  return 'green'
}

function leakTone(reason) {
  return ({
    no_url: 'red',
    no_utms: 'amber',
    missing_ad_id_macro: 'amber',
    lead_form: 'red',
    unknown: 'default',
  })[reason] || 'default'
}

function isoDaysAgo(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// Shared module-level ref-counted body scroll lock. Same pattern as
// `components/editorial/Modal.jsx` so a drawer + a modal don't strand
// `body.overflow='hidden'` when they close out of order.
let SCROLL_LOCK_COUNT = 0
let PRE_LOCK_OVERFLOW = ''
function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined
    if (SCROLL_LOCK_COUNT === 0) {
      PRE_LOCK_OVERFLOW = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    SCROLL_LOCK_COUNT++
    return () => {
      SCROLL_LOCK_COUNT--
      if (SCROLL_LOCK_COUNT === 0) {
        document.body.style.overflow = PRE_LOCK_OVERFLOW
      }
    }
  }, [active])
}

// Effective vertical for an ad — optimistic-write aware.
function effectiveVertical(ad, pending) {
  if (pending && pending[ad.ad_id]) {
    return { vertical: pending[ad.ad_id], source: 'override' }
  }
  return { vertical: ad.current_vertical, source: ad.vertical_source }
}

// Bucket an ad into a kanban column slug.
// `audienceSlugs` is the Set of slugs that have a dedicated kanban column.
// Anything not in the set lands in the catch-all 'other' column.
function bucketAdToColumn(ad, pending, audienceSlugs) {
  const { vertical, source } = effectiveVertical(ad, pending)
  if (source === 'unknown' || !vertical) return 'unclassified'
  if (audienceSlugs && audienceSlugs.has(vertical)) return vertical
  return 'other'
}

// ───────────────────────────────────────────────────────────────────────
// Page component
// ───────────────────────────────────────────────────────────────────────

export default function AttributionCoverage() {
  // Self-service audiences (migration 131). Every kanban column / chip /
  // override map flows from this hook — add an audience on the Settings
  // page and it appears here without a deploy.
  const { audiences, bySlug: audBySlug } = useAudiences()

  const [windowKey, setWindowKey] = useState('30d')
  const [stages, setStages] = useState([])
  const [gapAds, setGapAds] = useState([])
  const [unresolved, setUnresolved] = useState([])
  const [freshness, setFreshness] = useState([])
  const [kanbanAds, setKanbanAds] = useState([])
  const [qaQueue, setQaQueue] = useState([])
  const [existingAudiences, setExistingAudiences] = useState([])

  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)
  const [lastFetched, setLastFetched] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Optimistic write map: { ad_id: vertical_slug }
  const [pendingVertical, setPendingVertical] = useState({})

  // Right-side drawer state. Holds the ad being viewed/edited or null.
  const [drawerAd, setDrawerAd] = useState(null)

  // QA queue per-row busy + bulk busy.
  const [qaSaveBusy, setQaSaveBusy] = useState({})
  const [bulkBusy, setBulkBusy] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)

  const windowDays = useMemo(
    () => WINDOW_OPTIONS.find(w => w.key === windowKey)?.days ?? 30,
    [windowKey],
  )

  // ── Fetch everything in parallel ────────────────────────────────────
  const refresh = useCallback(() => setReloadKey(k => k + 1), [])

  useEffect(() => {
    let alive = true
    setBusy(true); setErr(null)
    const from = isoDaysAgo(windowDays)
    const to = todayISO()
    Promise.all([
      supabase.rpc('attribution_coverage', { p_from: from, p_to: to }),
      supabase.from('lib_attribution_gap_ads').select('*').limit(50),
      supabase.from('lib_attribution_unresolved_typeform').select('*').limit(200),
      supabase.from('lib_attribution_freshness').select('*'),
      supabase.from('lib_attribution_ad_kanban').select('*').limit(500),
      supabase.from('lib_attribution_qa_queue').select('*').gte('d', from).limit(200),
    ]).then(([s, g, u, f, k, qa]) => {
      if (!alive) return
      if (s.error)  throw new Error(`coverage: ${s.error.message}`)
      if (g.error)  throw new Error(`gap_ads: ${g.error.message}`)
      if (u.error)  throw new Error(`unresolved: ${u.error.message}`)
      if (f.error)  throw new Error(`freshness: ${f.error.message}`)
      if (k.error)  throw new Error(`kanban: ${k.error.message}`)
      if (qa.error) throw new Error(`qa_queue: ${qa.error.message}`)
      setStages(s.data || [])
      setGapAds(g.data || [])
      setUnresolved(u.data || [])
      setFreshness(f.data || [])
      setKanbanAds(k.data || [])
      setQaQueue(qa.data || [])
      setPendingVertical({})
      setLastFetched(new Date())
    }).catch(e => { if (alive) setErr(e.message) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [windowDays, reloadKey])

  useEffect(() => {
    let alive = true
    supabase.from('typeform_response_overrides').select('audience_slug')
      .then(({ data }) => {
        if (!alive) return
        // Union of audience_definitions slugs + any previously-used overrides.
        const seen = new Set(audiences.length ? audiences.map(a => a.slug) : FALLBACK_KNOWN_AUDIENCES)
        ;(data || []).forEach(r => r.audience_slug && seen.add(r.audience_slug))
        setExistingAudiences(Array.from(seen).sort())
      })
    return () => { alive = false }
  }, [reloadKey, audiences])

  // ── Mutations ───────────────────────────────────────────────────────

  async function updateAdVertical(ad_id, vertical) {
    if (!ad_id || !vertical) return
    setPendingVertical(prev => ({ ...prev, [ad_id]: vertical }))
    setErr(null)
    try {
      const { error } = await supabase
        .from('creative_attributes')
        .upsert(
          { ad_id, vertical, updated_at: new Date().toISOString() },
          { onConflict: 'ad_id' }
        )
      if (error) throw new Error(error.message)
      // Patch the kanban row in place — no full refetch needed.
      setKanbanAds(prev => prev.map(a =>
        a.ad_id === ad_id
          ? { ...a, current_vertical: vertical, vertical_source: 'override', override_vertical: vertical }
          : a
      ))
      // Update drawer ad too if it's open on this row.
      setDrawerAd(prev => prev && prev.ad_id === ad_id
        ? { ...prev, current_vertical: vertical, vertical_source: 'override' }
        : prev)
      setPendingVertical(prev => {
        const next = { ...prev }; delete next[ad_id]; return next
      })
    } catch (e) {
      setPendingVertical(prev => {
        const next = { ...prev }; delete next[ad_id]; return next
      })
      setErr(`Reassign failed: ${e.message}`)
    }
  }

  async function autoClassifyByUtm() {
    const rows = unresolved
      .filter(r => !r.override_audience_slug)
      .map(r => ({ r, slug: parseAudienceFromCampaign(r.utm_campaign, audiences) }))
      .filter(x => x.slug)
    if (rows.length === 0) return
    setAutoBusy(true); setErr(null)
    try {
      const payload = rows.map(({ r, slug }) => ({
        response_id: r.response_id,
        audience_slug: slug,
        notes: `auto-classified from utm_campaign on ${new Date().toISOString().slice(0,10)}`,
        set_at: new Date().toISOString(),
      }))
      const { error } = await supabase
        .from('typeform_response_overrides')
        .upsert(payload, { onConflict: 'response_id' })
      if (error) throw new Error(error.message)
      refresh()
    } catch (e) {
      setErr(`Auto-classify failed: ${e.message}`)
    } finally {
      setAutoBusy(false)
    }
  }

  async function setQaAudience(closer_call_id, audience) {
    if (!closer_call_id || !audience) return
    setQaSaveBusy(prev => ({ ...prev, [closer_call_id]: true }))
    setErr(null)
    try {
      const utm_campaign = UTM_CAMPAIGN_MAP[audience] || audience
      const { error } = await supabase
        .from('close_attribution_overrides')
        .upsert(
          { closer_call_id, utm_campaign, note: `QA-assigned ${audience} on ${new Date().toISOString().slice(0,10)}`, updated_at: new Date().toISOString() },
          { onConflict: 'closer_call_id' }
        )
      if (error) throw new Error(error.message)
      refresh()
    } catch (e) {
      setErr(`QA save failed: ${e.message}`)
    } finally {
      setQaSaveBusy(prev => {
        const next = { ...prev }; delete next[closer_call_id]; return next
      })
    }
  }

  async function bulkQa(audience) {
    if (!audience || qaQueue.length === 0) return
    const targets = qaQueue.filter(r => r.qa_flag === 'low_confidence' || r.qa_flag === 'orphan')
    if (targets.length === 0) return
    setBulkBusy(true); setErr(null)
    try {
      const utm_campaign = UTM_CAMPAIGN_MAP[audience] || audience
      const payload = targets.map(r => ({
        closer_call_id: r.closer_call_id,
        utm_campaign,
        note: `Bulk QA ${audience} on ${new Date().toISOString().slice(0,10)}`,
        updated_at: new Date().toISOString(),
      }))
      const { error } = await supabase
        .from('close_attribution_overrides')
        .upsert(payload, { onConflict: 'closer_call_id' })
      if (error) throw new Error(error.message)
      refresh()
    } catch (e) {
      setErr(`Bulk QA failed: ${e.message}`)
    } finally {
      setBulkBusy(false)
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────

  const headline = useMemo(() => {
    const stage = stages.find(s => s.stage_key === 'spend_with_lead')
    if (!stage) return null
    return {
      pct: Number(stage.coverage_pct),
      // attribution_coverage RPC sums ad_daily_stats.spend (NZD). Coverage
      // percentage is ratio so unaffected. Dollar values get converted to
      // USD so the headline reconciles with the Marketing page.
      traced: toUsd(stage.traced),
      total:  toUsd(stage.total),
      gap:    toUsd(stage.gap),
    }
  }, [stages])

  const staleSources = useMemo(
    () => freshness.filter(f => f.days_behind != null && f.days_behind > 1),
    [freshness],
  )

  const autoClassifiableCount = useMemo(
    () => unresolved.filter(
      r => !r.override_audience_slug && parseAudienceFromCampaign(r.utm_campaign, audiences)
    ).length,
    [unresolved, audiences],
  )

  // Top performers: ads with the most traced leads at the lowest CPL.
  // Sort: leads_30d DESC, then cpl_30d ASC. Take top 6.
  const topPerformers = useMemo(() => {
    return [...kanbanAds]
      .filter(a => (Number(a.leads_30d) || 0) > 0)
      .sort((a, b) => {
        const leadDiff = (Number(b.leads_30d) || 0) - (Number(a.leads_30d) || 0)
        if (leadDiff !== 0) return leadDiff
        const ca = Number(a.cpl_30d), cb = Number(b.cpl_30d)
        if (!isNaN(ca) && !isNaN(cb)) return ca - cb
        return 0
      })
      .slice(0, 6)
  }, [kanbanAds])

  // Kanban columns: [Needs review, …per-audience…, Other verticals].
  // Generated from useAudiences() so adding a vertical in Settings just
  // makes a new column appear here.
  const kanbanColumns = useMemo(() => {
    const middle = (audiences || []).map(a => ({
      slug: a.slug,
      label: a.display_name,
      color: a.color || PALETTE.ink3,
      hint: a.notes || '',
    }))
    return [FIXED_LEFT_COLUMN, ...middle, FIXED_RIGHT_COLUMN]
  }, [audiences])

  const audienceSlugSet = useMemo(
    () => new Set((audiences || []).map(a => a.slug)),
    [audiences],
  )

  const kanbanBuckets = useMemo(() => {
    const out = Object.fromEntries(kanbanColumns.map(c => [c.slug, []]))
    for (const ad of kanbanAds) {
      const slug = bucketAdToColumn(ad, pendingVertical, audienceSlugSet)
      ;(out[slug] || out.other).push(ad)
    }
    for (const slug of Object.keys(out)) {
      out[slug].sort((a, b) => Number(b.spend_30d || 0) - Number(a.spend_30d || 0))
    }
    return out
  }, [kanbanAds, pendingVertical, kanbanColumns, audienceSlugSet])

  const audienceChips = useMemo(() => {
    const seen = new Set(audiences.length ? audiences.map(a => a.slug) : FALLBACK_KNOWN_AUDIENCES)
    for (const a of existingAudiences || []) seen.add(a)
    return Array.from(seen)
  }, [audiences, existingAudiences])

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div style={{
      width: '100%', minHeight: '100vh',
      background: 'var(--paper)',
      padding: '32px 40px 80px',
      boxSizing: 'border-box',
    }}>
      <SectionHead
        level="page"
        eyebrow="Sales · Marketing"
        title="Attribution coverage"
        italicWord="coverage"
        tagline="One pane of glass for how much of our ad chain is actually traced end-to-end. Every leak shows you exactly where to fix it next."
        right={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
              letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: 8,
            }}>
              {lastFetched ? `synced ${lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={busy} leftIcon={Icon.refresh(12)}>
              {busy ? 'Loading…' : 'Refresh'}
            </Button>
            <span style={{ width: 1, height: 18, background: 'var(--rule)', margin: '0 8px' }} />
            {WINDOW_OPTIONS.map(w => (
              <Button
                key={w.key}
                variant={windowKey === w.key ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setWindowKey(w.key)}>
                {w.label}
              </Button>
            ))}
          </div>
        }
      />

      {err && (
        <Card accent={PALETTE.red} accentSide="left" style={{ marginTop: 16 }}>
          <Eyebrow>Error</Eyebrow>
          <div style={{ marginTop: 4, fontFamily: 'var(--sans)', fontSize: 13, color: PALETTE.red }}>{err}</div>
        </Card>
      )}

      {staleSources.length > 0 && (
        <Card accent={PALETTE.amber} accentSide="left" style={{ marginTop: 16 }}>
          <Eyebrow>Data freshness</Eyebrow>
          <div style={{ marginTop: 6, fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-2)' }}>
            {staleSources.map((s, i) => (
              <span key={s.source} style={{ marginRight: 16 }}>
                {i > 0 && <span style={{ color: 'var(--ink-3)', margin: '0 8px' }}>·</span>}
                <strong>{s.source}</strong>{' '}
                <span style={{ color: 'var(--ink-3)' }}>·</span>{' '}
                <span style={{ color: PALETTE.amber }}>
                  {s.days_behind} day{s.days_behind === 1 ? '' : 's'} behind
                </span>
              </span>
            ))}
            <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>
              Coverage numbers below are only as accurate as the freshest sync.
            </div>
          </div>
        </Card>
      )}

      {/* ── KPI hero ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, marginTop: 28 }}>
        <Card padding={28}>
          <Eyebrow>Spend traced end-to-end</Eyebrow>
          <div style={{ marginTop: 12 }}>
            <BigNumber
              value={busy ? '—' : (headline ? `${headline.pct.toFixed(1)}` : '—')}
              suffix="%"
              size={64}
              color={headline ? (
                headline.pct >= 90 ? PALETTE.green :
                headline.pct >= 70 ? PALETTE.amber : PALETTE.red
              ) : 'var(--ink)'}
            />
          </div>
          {headline && (
            <div style={{ marginTop: 10, fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)' }}>
              {fmtMoneyFull(headline.traced)}
              <span style={{ margin: '0 6px' }}>·</span>
              of {fmtMoneyFull(headline.total)} traced to a typeform lead
            </div>
          )}
        </Card>
        <Card padding={28}>
          <Eyebrow>Unattributed spend</Eyebrow>
          <div style={{ marginTop: 12 }}>
            <BigNumber
              value={busy ? '—' : (headline ? fmtMoneyFull(headline.gap).replace('$', '') : '—')}
              prefix="$"
              size={64}
              color={PALETTE.red}
            />
          </div>
          <div style={{ marginTop: 10, fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)' }}>
            Spent on ads that produced zero traceable leads
          </div>
        </Card>
        <Card padding={28}>
          <Eyebrow>Unresolved submits</Eyebrow>
          <div style={{ marginTop: 12 }}>
            <BigNumber
              value={busy ? '—' : fmtNum(unresolved.length)}
              size={64}
              color={unresolved.length > 0 ? PALETTE.amber : PALETTE.green}
            />
          </div>
          <div style={{ marginTop: 10, fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)' }}>
            Typeform rows with no ad_id match in window
          </div>
        </Card>
      </div>

      {/* ── Top performers ─────────────────────────────────────── */}
      <TopPerformersSection
        ads={topPerformers}
        onPick={setDrawerAd}
        pendingVertical={pendingVertical}
        windowLabel={WINDOW_OPTIONS.find(w => w.key === windowKey)?.label}
        busy={busy}
      />

      {/* ── Kanban by audience ─────────────────────────────────── */}
      <KanbanByAudience
        columns={kanbanColumns}
        buckets={kanbanBuckets}
        pendingVertical={pendingVertical}
        onPick={setDrawerAd}
        busy={busy}
        autoClassifiableCount={autoClassifiableCount}
        onAutoClassify={autoClassifyByUtm}
        autoBusy={autoBusy}
      />

      {/* ── The chain (funnel) ─────────────────────────────────── */}
      <FunnelSection stages={stages} />

      {/* ── Gap ads ────────────────────────────────────────────── */}
      {gapAds.length > 0 && <GapAdsSection ads={gapAds} busy={busy} />}

      {/* ── QA queue ───────────────────────────────────────────── */}
      {qaQueue.length > 0 && (
        <QAQueueSection
          queue={qaQueue}
          onSet={setQaAudience}
          onBulk={bulkQa}
          bulkBusy={bulkBusy}
          rowBusy={qaSaveBusy}
        />
      )}

      {/* ── What this means ────────────────────────────────────── */}
      <WhatThisMeansFooter />

      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <Link to="/sales/marketing" style={{
          fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
          textDecoration: 'underline', textUnderlineOffset: 4,
        }}>← Back to Marketing Performance</Link>
      </div>

      {/* Side drawer */}
      <AdDrawer
        ad={drawerAd}
        pendingVertical={pendingVertical}
        audiences={audienceChips}
        onClose={() => setDrawerAd(null)}
        onAssign={updateAdVertical}
      />
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Top performers section
// ───────────────────────────────────────────────────────────────────────

function TopPerformersSection({ ads, onPick, pendingVertical, windowLabel, busy }) {
  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead
        eyebrow="What's working"
        title={`Top-performing ads · ${windowLabel}`}
        tagline="Ads producing the most traced leads at the lowest CPL. Click any card to inspect and reattribute."
        right={
          <Pill tone="ink" uppercase>
            {ads.length} winner{ads.length === 1 ? '' : 's'}
          </Pill>
        }
      />
      {ads.length === 0 ? (
        <Card padding={32}>
          <div style={{ textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            {busy ? 'Loading…' : 'No traced leads in this window yet. Ship Fix A + C and rerun the sync.'}
          </div>
        </Card>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 16,
        }}>
          {ads.map((ad, i) => (
            <PerformerCard
              key={ad.ad_id}
              ad={ad}
              rank={i + 1}
              pending={pendingVertical[ad.ad_id]}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PerformerCard({ ad, rank, pending, onPick }) {
  const { vertical, source } = effectiveVertical(ad, { [ad.ad_id]: pending })
  // spend_30d / cpl_30d come from lib_attribution_ad_kanban which sums
  // ad_daily_stats.spend (NZD) — convert to USD for display.
  const spendUsd = toUsd(ad.spend_30d)
  const cpl = ad.cpl_30d != null ? toUsd(ad.cpl_30d) : null
  const audTone = source === 'override' ? 'green' : source === 'parsed' ? 'amber' : 'red'
  const [hover, setHover] = useState(false)

  return (
    <button
      type="button"
      onClick={() => onPick(ad)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        background: 'white',
        border: '1px solid var(--rule)',
        boxShadow: hover
          ? '0 2px 4px rgba(10,10,10,0.05), 0 8px 24px rgba(10,10,10,0.06)'
          : '0 1px 0 rgba(10,10,10,0.02), 0 1px 2px rgba(10,10,10,0.03)',
        transition: 'box-shadow 0.16s cubic-bezier(0.2,0.7,0.2,1)',
      }}
    >
      {/* Hero ribbon: rank + thumbnail */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', overflow: 'hidden', background: 'var(--paper-2)' }}>
        {ad.thumbnail_url ? (
          <img
            src={ad.thumbnail_url}
            alt={ad.ad_name || ''}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'grid', placeItems: 'center',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
            letterSpacing: '0.1em', textTransform: 'uppercase',
          }}>no thumbnail</div>
        )}
        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <PodiumRank rank={rank} size="md" />
        </div>
        {rank === 1 && (
          <div style={{ position: 'absolute', top: 10, right: 10 }}>
            <WinnerBadge size="sm" />
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 13.5, fontWeight: 500,
          color: 'var(--ink)', lineHeight: 1.35,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          minHeight: 36,
        }}>
          {ad.ad_name || '—'}
        </div>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {ad.campaign_name || '—'}
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8,
          padding: '10px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)',
        }}>
          <StatCell label="Leads" value={ad.leads_30d} />
          <StatCell label="Spend" value={fmtMoneyFull(spendUsd)} />
          <StatCell
            label="CPL"
            value={cpl != null ? fmtMoneyFull(cpl) : '∞'}
            color={cpl != null && cplTone(cpl) === 'green' ? PALETTE.green
                 : cpl != null && cplTone(cpl) === 'amber' ? PALETTE.amber
                 : PALETTE.red}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <Pill tone={audTone} uppercase size="sm">
            {vertical ? vertical.replace(/_/g, ' ') : 'unclassified'}
          </Pill>
          <span style={{
            fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-3)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            Edit {Icon.arrow(11)}
          </span>
        </div>
      </div>
    </button>
  )
}

function StatCell({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 500,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--ink-3)',
      }}>{label}</span>
      <span style={{
        fontFamily: 'var(--serif)', fontSize: 18,
        fontVariantNumeric: 'tabular-nums',
        color: color || 'var(--ink)',
      }}>{value ?? '—'}</span>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Kanban by audience
// ───────────────────────────────────────────────────────────────────────

function KanbanByAudience({
  columns, buckets, pendingVertical, onPick, busy,
  autoClassifiableCount, onAutoClassify, autoBusy,
}) {
  const totalAds = Object.values(buckets).reduce((a, b) => a + b.length, 0)
  const unclassifiedCount = (buckets.unclassified || []).length

  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead
        eyebrow="Classify once, attribute forever"
        title="Active ads by audience"
        tagline="Every active ad with spend in the last window, bucketed by current audience. Click any card to view full detail and reassign in the side drawer."
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill tone={unclassifiedCount > 0 ? 'red' : 'green'} uppercase>
              {unclassifiedCount} needs review
            </Pill>
            {autoClassifiableCount > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onAutoClassify}
                disabled={autoBusy}
              >
                {autoBusy ? 'Classifying…' : `Auto-classify ${autoClassifiableCount} lead${autoClassifiableCount === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        }
      />

      {totalAds === 0 ? (
        <Card padding={32}>
          <div style={{ textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            {busy ? 'Loading…' : 'No active ads with spend in the window.'}
          </div>
        </Card>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}>
          {columns.map(col => (
            <KanbanColumn
              key={col.slug}
              column={col}
              ads={buckets[col.slug] || []}
              pendingVertical={pendingVertical}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function KanbanColumn({ column, ads, pendingVertical, onPick }) {
  // Convert NZD → USD on the spend rollup (ad_daily_stats.spend is NZD).
  const totalSpend = ads.reduce((a, b) => a + toUsd(b.spend_30d), 0)
  const totalLeads = ads.reduce((a, b) => a + Number(b.leads_30d || 0), 0)
  return (
    <div style={{
      background: column.slug === 'unclassified' ? 'rgba(181,62,62,0.04)' : 'var(--paper-2)',
      border: `1px solid ${column.slug === 'unclassified' ? 'rgba(181,62,62,0.2)' : 'var(--rule)'}`,
      borderTop: `3px solid ${column.color}`,
      display: 'flex', flexDirection: 'column',
      maxHeight: 720,
    }}>
      {/* Column header */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--rule)',
        background: 'white',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            color: column.color,
          }}>{column.label}</div>
          <span style={{
            fontFamily: 'var(--serif)', fontSize: 20,
            fontVariantNumeric: 'tabular-nums', color: 'var(--ink)',
          }}>{ads.length}</span>
        </div>
        <div style={{
          marginTop: 4,
          fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-3)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{fmtMoneyFull(totalSpend)}</span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span>{totalLeads} lead{totalLeads === 1 ? '' : 's'}</span>
        </div>
        {column.hint && (
          <div style={{
            marginTop: 4, fontFamily: 'var(--sans)', fontSize: 11,
            color: 'var(--ink-3)', fontStyle: 'italic',
          }}>{column.hint}</div>
        )}
      </div>

      {/* Column body */}
      <div style={{
        flex: 1, overflow: 'auto', padding: 10,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {ads.length === 0 ? (
          <div style={{
            padding: '32px 12px', textAlign: 'center',
            fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
            fontStyle: 'italic',
          }}>
            No ads here.
          </div>
        ) : ads.map(ad => (
          <KanbanCard
            key={ad.ad_id}
            ad={ad}
            pending={pendingVertical[ad.ad_id]}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  )
}

function KanbanCard({ ad, pending, onPick }) {
  const spendUsd = toUsd(ad.spend_30d)
  const cpl = ad.cpl_30d != null ? toUsd(ad.cpl_30d) : null
  return (
    <button
      type="button"
      onClick={() => onPick(ad)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex', gap: 10, alignItems: 'stretch',
        padding: 10,
        background: 'white',
        border: '1px solid var(--rule)',
        borderRadius: 9,
        transition: 'border 0.12s, transform 0.12s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--ink-3)'
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--rule)'
        e.currentTarget.style.transform = 'none'
      }}
    >
      <div style={{
        width: 44, height: 44, flexShrink: 0,
        background: ad.thumbnail_url
          ? `url(${ad.thumbnail_url}) center/cover`
          : 'var(--paper-2)',
        border: '1px solid var(--rule)',
      }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500,
          color: 'var(--ink)', lineHeight: 1.3,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{ad.ad_name || '—'}</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-3)',
        }}>
          <span style={{
            fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
            fontSize: 13, color: 'var(--ink)',
          }}>{fmtMoneyFull(spendUsd)}</span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span>{ad.leads_30d || 0} leads</span>
          {cpl != null && (
            <>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span style={{ color: cplTone(cpl) === 'red' ? PALETTE.red
                                  : cplTone(cpl) === 'amber' ? PALETTE.amber
                                  : PALETTE.green }}>
                {fmtMoneyFull(cpl)}/lead
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Side drawer
// ───────────────────────────────────────────────────────────────────────

function AdDrawer({ ad, pendingVertical, audiences, onClose, onAssign }) {
  // Hooks must run unconditionally — guard their effects on `ad` instead of
  // returning early before declaring them. Returning early before hooks call
  // changes the hook order between renders and throws "rendered more hooks
  // than during the previous render" the second time the drawer closes.
  const open = !!ad

  // Use the shared Modal scroll-lock counter so we don't fight nested modals.
  // (`useBodyScrollLock` increments on mount; decrements on unmount or when
  // `open` flips false.)
  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Restore focus to the element that opened the drawer when it closes.
  const previouslyFocused = useRef(null)
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement
    } else if (previouslyFocused.current && typeof previouslyFocused.current.focus === 'function') {
      previouslyFocused.current.focus()
      previouslyFocused.current = null
    }
  }, [open])

  if (!ad) return null
  const pending = pendingVertical[ad.ad_id]
  const { vertical, source } = effectiveVertical(ad, pendingVertical)
  const spendUsd = toUsd(ad.spend_30d)
  const cpl = ad.cpl_30d != null ? toUsd(ad.cpl_30d) : null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(10,10,10,0.32)',
        display: 'flex', justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(540px, 100vw)', height: '100vh',
          background: 'var(--paper)', borderLeft: '1px solid var(--rule)',
          boxShadow: '-12px 0 40px rgba(10,10,10,0.12)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Drawer header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow style={{ marginBottom: 6 }}>Ad detail</Eyebrow>
            <div style={{
              fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.2,
              color: 'var(--ink)', letterSpacing: '-0.015em', fontWeight: 500,
            }}>{ad.ad_name || '—'}</div>
            <div style={{
              marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10.5,
              color: 'var(--ink-3)', letterSpacing: '0.04em',
            }}>{ad.ad_id}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              all: 'unset', cursor: 'pointer',
              padding: 6, borderRadius: 9, color: 'var(--ink-2)',
              display: 'inline-flex', alignItems: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {Icon.x(16)}
          </button>
        </div>

        {/* Drawer body — scrollable */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {/* Hero thumbnail */}
          <div style={{
            width: '100%', aspectRatio: '16/9',
            background: ad.thumbnail_url
              ? `url(${ad.thumbnail_url}) center/cover`
              : 'var(--paper-2)',
            border: '1px solid var(--rule)',
            marginBottom: 20,
          }}>
            {!ad.thumbnail_url && (
              <div style={{
                width: '100%', height: '100%',
                display: 'grid', placeItems: 'center',
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>no thumbnail</div>
            )}
          </div>

          {/* Metrics */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12,
            padding: '14px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)',
            marginBottom: 20,
          }}>
            <StatCell label="Spend 30d" value={fmtMoneyFull(spendUsd)} />
            <StatCell label="Traced leads" value={ad.leads_30d} />
            <StatCell
              label="Cost / lead"
              value={cpl != null ? fmtMoneyFull(cpl) : '∞'}
              color={cpl != null
                ? (cplTone(cpl) === 'green' ? PALETTE.green
                   : cplTone(cpl) === 'amber' ? PALETTE.amber : PALETTE.red)
                : PALETTE.red}
            />
          </div>

          {/* Campaign / adset */}
          <div style={{ marginBottom: 24 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Campaign</Eyebrow>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', lineHeight: 1.4 }}>
              {ad.campaign_name || '—'}
            </div>
            {ad.adset_name && (
              <div style={{ marginTop: 4, fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
                {ad.adset_name}
              </div>
            )}
          </div>

          {/* Current attribution */}
          <div style={{ marginBottom: 24 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Current attribution</Eyebrow>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill tone={source === 'override' ? 'green' : source === 'parsed' ? 'amber' : 'red'} uppercase>
                {vertical ? vertical.replace(/_/g, ' ') : 'unclassified'}
              </Pill>
              <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
                {source === 'override' ? 'Manually assigned'
                  : source === 'parsed' ? 'Auto-parsed from campaign name'
                  : 'Unknown — needs your eyes'}
              </span>
            </div>
          </div>

          {/* Audience picker */}
          <div>
            <Eyebrow style={{ marginBottom: 8 }}>Set audience</Eyebrow>
            <p style={{
              margin: '0 0 12px', fontFamily: 'var(--sans)', fontSize: 12,
              color: 'var(--ink-3)', lineHeight: 1.5, maxWidth: 440,
            }}>
              Every current and future lead from this ad inherits the audience you pick.
              Writes to <code style={code}>creative_attributes.vertical</code>.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {audiences.map(slug => {
                const isActive = vertical === slug
                return (
                  <button
                    key={slug}
                    type="button"
                    disabled={!!pending}
                    onClick={() => onAssign(ad.ad_id, slug)}
                    style={{
                      ...chipBtn,
                      background: isActive ? 'var(--ink)' : 'transparent',
                      color: isActive ? 'var(--paper)' : 'var(--ink-2)',
                      borderColor: isActive ? 'var(--ink)' : 'var(--rule)',
                      cursor: pending ? 'wait' : 'pointer',
                    }}>
                    {slug.replace(/_/g, ' ')}
                  </button>
                )
              })}
            </div>
            {pending && (
              <div style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Saving…
              </div>
            )}
          </div>

          {/* Open in Meta */}
          {ad.destination_url && (
            <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--rule)' }}>
              <Eyebrow style={{ marginBottom: 8 }}>Destination URL</Eyebrow>
              <a
                href={ad.destination_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                  textDecoration: 'underline', textUnderlineOffset: 3,
                  wordBreak: 'break-all',
                }}>{ad.destination_url}</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Funnel + gap ads + QA queue sections
// ───────────────────────────────────────────────────────────────────────

function FunnelSection({ stages }) {
  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead
        eyebrow="The chain"
        title="Where the funnel leaks"
        tagline="Each row is one stage of the chain. Coverage is `traced ÷ total`. Red rows are the biggest fixes."
      />
      <Card padding={0}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--sans)', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
              <th style={th}>Stage</th>
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
              <th style={{ ...th, textAlign: 'right' }}>Traced</th>
              <th style={{ ...th, textAlign: 'right' }}>Gap</th>
              <th style={{ ...th, textAlign: 'right', width: 120 }}>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(s => {
              const isUsd = s.unit === 'usd'
              const fmt = isUsd ? fmtMoneyFull : fmtNum
              // For USD stages, the RPC returned NZD-summed values; convert.
              const conv = (v) => isUsd ? toUsd(v) : Number(v)
              const tone = covTone(Number(s.coverage_pct))
              const help = STAGE_HELP[s.stage_key]
              return (
                <tr key={s.stage_key} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                        {String(s.stage_order).padStart(2, '0')}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div>{s.stage_label}</div>
                        {help && (
                          <div style={{
                            marginTop: 3, fontSize: 11, color: 'var(--ink-3)',
                            fontStyle: 'italic', lineHeight: 1.4, maxWidth: 600,
                          }}>{help}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(conv(s.total))}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(conv(s.traced))}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: Number(s.gap) > 0 ? PALETTE.red : 'var(--ink-3)' }}>
                    {Number(s.gap) === 0 ? '—' : fmt(conv(s.gap))}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <Pill tone={tone} uppercase>{fmtPct(Number(s.coverage_pct))}</Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function GapAdsSection({ ads, busy }) {
  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead
        eyebrow="Where to attack first"
        title="Top ads with attribution gaps"
        tagline="Ads spending money but producing fewer traced leads than expected. Sort by $/lead to find what's leaking."
      />
      <Card padding={0}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--sans)', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
              <th style={th}>Ad</th>
              <th style={th}>Campaign</th>
              <th style={{ ...th, textAlign: 'right' }}>Spend 30d</th>
              <th style={{ ...th, textAlign: 'right' }}>Traced leads</th>
              <th style={{ ...th, textAlign: 'right' }}>$ / lead</th>
              <th style={th}>Likely leak</th>
            </tr>
          </thead>
          <tbody>
            {ads.slice(0, 20).map(ad => {
              // spend_30d is NZD from ad_daily_stats — convert.
              const spend = toUsd(ad.spend_30d)
              const leads = Number(ad.traced_leads_30d) || 0
              const cpl = leads > 0 ? spend / leads : null
              const tone = leads === 0 ? 'red' : (cpl && cpl > 100 ? 'amber' : 'green')
              return (
                <tr key={ad.ad_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{ad.ad_name || '—'}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>{ad.ad_id}</div>
                  </td>
                  <td style={{ ...td, color: 'var(--ink-2)', fontSize: 12 }}>
                    <div>{ad.campaign_name || '—'}</div>
                    <div style={{ color: 'var(--ink-3)', fontSize: 11 }}>{ad.adset_name || ''}</div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMoneyFull(spend)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <Pill tone={tone}>{leads}</Pill>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {cpl != null ? fmtMoneyFull(cpl) : '∞'}
                  </td>
                  <td style={td}>
                    <Pill tone={leakTone(ad.leak_reason)} uppercase>{ad.leak_reason?.replace(/_/g, ' ') || '—'}</Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!busy && ads.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            No spend in the last 30 days.
          </div>
        )}
      </Card>
    </div>
  )
}

function QAQueueSection({ queue, onSet, onBulk, bulkBusy, rowBusy }) {
  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead
        eyebrow="QA queue"
        title={`${queue.length} call${queue.length === 1 ? '' : 's'} flagged for review`}
        tagline="Calls the resolver isn't fully confident about. Click a chip to set the correct audience — writes go to close_attribution_overrides which the resolver respects as the highest-priority match."
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="secondary" size="sm" onClick={() => onBulk('Restoration')} disabled={bulkBusy}>
              {bulkBusy ? 'Saving…' : 'Bulk → Restoration'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onBulk('REFERRAL')} disabled={bulkBusy}>
              Bulk → REFERRAL
            </Button>
          </div>
        }
      />
      <Card padding={0}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--sans)', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
              <th style={th}>Date</th>
              <th style={th}>Prospect</th>
              <th style={th}>Type</th>
              <th style={th}>Flag</th>
              <th style={th}>Current attribution</th>
              <th style={{ ...th, textAlign: 'right' }}>Set audience</th>
            </tr>
          </thead>
          <tbody>
            {queue.map(r => {
              const flagTone = r.qa_flag === 'orphan' ? 'red'
                : r.qa_flag === 'low_confidence' ? 'amber' : 'default'
              const saving = !!rowBusy[r.closer_call_id]
              return (
                <tr key={r.closer_call_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{r.d}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{r.prospect_name}</div>
                    {r.outcome && (
                      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.outcome}</div>
                    )}
                  </td>
                  <td style={td}>
                    <Pill tone={r.row_type === 'close' ? 'green' : 'default'} uppercase>{r.row_type}</Pill>
                  </td>
                  <td style={td}>
                    <Pill tone={flagTone} uppercase>{r.qa_flag.replace(/_/g, ' ')}</Pill>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)' }}>
                    <div>{r.current_audience}</div>
                    {r.utm_campaign && (
                      <div style={{ fontSize: 10, color: 'var(--ink-3)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.utm_campaign}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      {['Restoration', 'Electricians', 'REFERRAL'].map(aud => (
                        <button
                          key={aud}
                          type="button"
                          disabled={saving}
                          onClick={() => onSet(r.closer_call_id, aud)}
                          style={{
                            fontFamily: 'var(--mono)', fontSize: 10,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            padding: '4px 8px',
                            background: 'var(--paper)',
                            border: '1px solid var(--rule)',
                            color: aud === 'REFERRAL' ? 'var(--ink-3)' : 'var(--ink)',
                            cursor: saving ? 'wait' : 'pointer',
                            borderRadius: 9,
                          }}>
                          {saving ? '…' : aud === 'Restoration' ? 'Resto' : aud === 'Electricians' ? 'Elec' : 'Ref'}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function WhatThisMeansFooter() {
  return (
    <div style={{ marginTop: 48 }}>
      <SectionHead eyebrow="What this means" title="Closing the gap" />
      <Card padding={20} style={{
        borderLeft: `3px solid var(--accent, ${PALETTE.amber})`,
        background: '#fef9cc',
      }}>
        <ol style={{
          margin: 0, paddingLeft: 20,
          fontFamily: 'var(--serif)', fontSize: 14.5, lineHeight: 1.65, color: 'var(--ink)',
        }}>
          <li><strong>Fix Meta URL macros (Fix A).</strong> Set account-level URL params on the ad account so every new ad inherits <code style={code}>utm_content={'{{'}ad.id{'}}'}</code>, <code style={code}>utm_term={'{{'}adset.id{'}}'}</code>, <code style={code}>utm_campaign={'{{'}campaign.id{'}}'}</code>.</li>
          <li><strong>VSL pages forward UTMs (Fix C).</strong> Add the snippet at <code style={code}>scripts/vsl-utm-forwarder.html</code> to <code style={code}>optdigital.io/vsl-restoration</code> and <code style={code}>/electrician-vsl</code> so Typeform iframe carries the ad IDs through.</li>
          <li><strong>Re-run the resolver.</strong> After A + C, run <code style={code}>sync-typeform</code> for the last 90 days. Stage 5 (ad_id resolved) should jump from 79% to 95%+.</li>
          <li><strong>Mirror Lead Forms (Fix B).</strong> Only needed if the <code style={code}>fb.me/</code> ads come back into rotation.</li>
        </ol>
      </Card>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Shared inline styles
// ───────────────────────────────────────────────────────────────────────

const chipBtn = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '6px 12px',
  border: '1px solid var(--rule)',
  borderRadius: 9,
  cursor: 'pointer',
  background: 'transparent',
}

const th = {
  textAlign: 'left',
  padding: '10px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
}

const td = {
  padding: '12px 14px',
  color: 'var(--ink)',
  verticalAlign: 'top',
}

const code = {
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  background: 'var(--paper-2)',
  padding: '1px 5px',
  borderRadius: 9,
}
