import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  SectionHead, Eyebrow, Pill, Card, Button, BigNumber, Icon,
  fmtMoneyFull, fmtNum, fmtPct, PALETTE,
} from '../components/editorial/atoms'
import Modal from '../components/editorial/Modal'

// Per-stage explanatory caption. Renders under each row in the funnel
// table so it's clear what each metric measures and how to move it.
const STAGE_HELP = {
  spend_total:      'Total Meta spend in the window. Source of truth: ad_daily_stats.',
  spend_with_lead:  'Of all spend, how much went to ads that had at least one Typeform submit with the ad_id resolved. Low % = ad URLs aren\'t carrying {{ad.id}} — fix is account-level URL params on Meta, then re-sync. Classifying audiences in the list below does NOT move this number.',
  submits:          'Total Typeform submissions in the window.',
  submits_utms:     'Of submits, how many arrived with a utm_campaign set. Missing UTMs usually mean direct nav, refresh, or a bookmark.',
  submits_ad_id:    'Of submits, how many resolved to a specific Meta ad_id (the strongest attribution). This is the # that fixing the URL macros will lift.',
  ghl_matched:      'Of submits, how many we found in GHL by email match — means the contact actually entered the CRM.',
  booked:           'Of submits, how many booked a call (matched_event_id or closer_call linked).',
  showed:           'Of submits, how many actually showed up on the call.',
  closed:           'Of submits, how many became closed sales.',
  paid:             'Of submits, how many produced a payment in Stripe/Fanbasis.',
}

// Canonical audience slugs Ben uses. The picker lets him add new ones too.
const KNOWN_AUDIENCES = [
  'restoration', 'electrician', 'accounting', 'bookkeeping',
  'pool_builders', 'real_estate', 'roofing', 'plumbing', 'hvac',
]

// Heuristic that mirrors the SQL parser in lib_typeform_audience_resolved.
// Returns null when the campaign string doesn't match any known audience.
function parseAudienceFromCampaign(utm_campaign) {
  if (!utm_campaign) return null
  const s = utm_campaign.toLowerCase()
  if (s.includes('restoration'))                 return 'restoration'
  if (s.includes('electrician'))                 return 'electrician'
  if (s.includes('accounting') || s.includes('bookkeep')) return 'accounting'
  if (s.includes('pool'))                        return 'pool_builders'
  if (s.includes('real estate') || s.includes('realtor')) return 'real_estate'
  if (s.includes('roofing') || s.includes('roofer'))     return 'roofing'
  if (s.includes('plumb'))                       return 'plumbing'
  if (s.includes('hvac'))                        return 'hvac'
  return null
}

/*
  Attribution Coverage Report (Ben 2026-05-31).

  Single-pane-of-glass view of "how bulletproof is our attribution chain
  right now". Shipped FIRST so every later fix (Meta URL macros, VSL UTM
  forwarding, Lead-Form mirror) moves a visible number here.

  Backend: migration 111 — public.attribution_coverage(date,date) function +
  lib_attribution_gap_ads / lib_attribution_unresolved_typeform /
  lib_attribution_freshness views.

  Architecture notes: see memory/bulletproof-attribution-architecture.md.
*/

const WINDOW_OPTIONS = [
  { key: '7d',  label: 'Last 7 days',  days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
]

// Color a coverage % cell so eyes go straight to the leaks.
function covTone(pct) {
  if (pct == null) return 'default'
  if (pct >= 90) return 'green'
  if (pct >= 70) return 'amber'
  return 'red'
}

function isoDaysAgo(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export default function AttributionCoverage() {
  const [windowKey, setWindowKey] = useState('90d')
  const [stages, setStages] = useState([])
  const [gapAds, setGapAds] = useState([])
  const [unresolved, setUnresolved] = useState([])
  const [freshness, setFreshness] = useState([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)

  // QA queue (Ben 2026-06-01): rows the resolver flagged as low_confidence /
  // orphan / missing_audience. Ben reviews and clicks to assign correct
  // attribution. Writes go to close_attribution_overrides which the resolver
  // honors as the highest-priority match.
  const [qaQueue, setQaQueue] = useState([])
  const [qaSaveBusy, setQaSaveBusy] = useState({})  // { closer_call_id: true }

  // Ad list — top-spending active ads with thumbnails. Each row gets an
  // inline audience picker. Default filter hides anything already overridden
  // (Ben 2026-05-31: "once I've assigned it, just see it as hidden").
  const [kanbanAds, setKanbanAds] = useState([])
  // Optimistic vertical-by-ad map; supabase round-trip writes the truth back.
  const [pendingVertical, setPendingVertical] = useState({}) // { ad_id: 'restoration' }
  // Triage queue (creative-grouped) kept for the bottom-of-page "still unresolved" sliver
  const [unresolvedCreatives, setUnresolvedCreatives] = useState([])

  // Per-creative multi-select. Stores the row's stable key `${utm_campaign}|${utm_content}`.
  const [selectedKeys, setSelectedKeys] = useState(new Set())
  // The audience the user picked in the bulk action bar.
  const [bulkAudience, setBulkAudience] = useState('')
  // Bulk save busy.
  const [bulkBusy, setBulkBusy] = useState(false)
  // Auto-classify-by-utm action busy (separate from bulk).
  const [autoBusy, setAutoBusy] = useState(false)

  // Assign-audience edit modal state. editTarget is the row being edited
  // (an object from `unresolved`) or null when closed.
  const [editTarget, setEditTarget] = useState(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)   // bump to force a re-fetch
  // Audience slugs we already have on file — feeds the picker as quick-pick chips.
  const [existingAudiences, setExistingAudiences] = useState([])

  const windowDays = useMemo(
    () => WINDOW_OPTIONS.find(w => w.key === windowKey)?.days ?? 90,
    [windowKey],
  )

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
      supabase.from('lib_attribution_unresolved_creatives').select('*').limit(100),
      supabase.from('lib_attribution_ad_kanban').select('*').limit(300),
      supabase.from('lib_attribution_qa_queue').select('*').gte('d', from).limit(200),
    ]).then(([s, g, u, f, c, k, qa]) => {
      if (!alive) return
      if (s.error) throw new Error(`coverage: ${s.error.message}`)
      if (g.error) throw new Error(`gap_ads: ${g.error.message}`)
      if (u.error) throw new Error(`unresolved: ${u.error.message}`)
      if (f.error) throw new Error(`freshness: ${f.error.message}`)
      if (c.error) throw new Error(`creatives: ${c.error.message}`)
      if (k.error) throw new Error(`kanban: ${k.error.message}`)
      if (qa.error) throw new Error(`qa_queue: ${qa.error.message}`)
      setStages(s.data || [])
      setGapAds(g.data || [])
      setUnresolved(u.data || [])
      setFreshness(f.data || [])
      setUnresolvedCreatives(c.data || [])
      setKanbanAds(k.data || [])
      setQaQueue(qa.data || [])
      setPendingVertical({})
    }).catch(e => { if (alive) setErr(e.message) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [windowDays, reloadKey])

  // Build the union of known + previously-used audience slugs for the picker.
  useEffect(() => {
    let alive = true
    supabase.from('typeform_response_overrides').select('audience_slug')
      .then(({ data }) => {
        if (!alive) return
        const seen = new Set(KNOWN_AUDIENCES)
        ;(data || []).forEach(r => r.audience_slug && seen.add(r.audience_slug))
        setExistingAudiences(Array.from(seen).sort())
      })
    return () => { alive = false }
  }, [reloadKey])

  // Save one row's override (audience_slug required, ad_id + notes optional).
  async function saveOverride({ response_id, audience_slug, ad_id, notes }) {
    if (!response_id || !audience_slug) return
    setSaveBusy(true); setErr(null)
    try {
      const payload = {
        response_id,
        audience_slug: audience_slug.trim().toLowerCase().replace(/\s+/g, '_'),
        ad_id: (ad_id || '').trim() || null,
        notes: (notes || '').trim() || null,
        set_at: new Date().toISOString(),
      }
      const { error } = await supabase
        .from('typeform_response_overrides')
        .upsert(payload, { onConflict: 'response_id' })
      if (error) throw new Error(error.message)
      setEditTarget(null)
      setReloadKey(k => k + 1)
    } catch (e) {
      setErr(`Save failed: ${e.message}`)
    } finally {
      setSaveBusy(false)
    }
  }

  // Auto-classify every unresolved row whose utm_campaign matches a known
  // audience pattern AND that doesn't already have an override. One click,
  // no selection needed.
  async function autoClassifyByUtm() {
    const rows = unresolved
      .filter(r => !r.override_audience_slug)
      .map(r => ({ r, slug: parseAudienceFromCampaign(r.utm_campaign) }))
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
      setReloadKey(k => k + 1)
    } catch (e) {
      setErr(`Auto-classify failed: ${e.message}`)
    } finally {
      setAutoBusy(false)
    }
  }

  // Set audience for one QA queue row. Maps the audience to a known
  // campaign string (so the marketing rollup buckets it correctly) and
  // writes close_attribution_overrides.utm_campaign.
  async function setQaAudience(closer_call_id, audience) {
    if (!closer_call_id || !audience) return
    setQaSaveBusy(prev => ({ ...prev, [closer_call_id]: true }))
    setErr(null)
    try {
      // Map audience label to a representative campaign string that the
      // marketing rollup parser will bucket. REFERRAL means no ad source.
      const utmMap = {
        'Restoration':  'SCIO -Restoration - Application - 4/22 - New Videos',
        'Electricians': 'SCIO - Electricians - VSL - 5/4 images - Relaunch',
        'Accounting':   'SCIO - Accounting - VSL',
        'Plumbing':     'SCIO - Plumbing - VSL',
        'HVAC':         'SCIO - HVAC - VSL',
        'Roofing':      'SCIO - Roofing - VSL',
        'REFERRAL':     'REFERRAL',
      }
      const utm_campaign = utmMap[audience] || audience
      const { error } = await supabase
        .from('close_attribution_overrides')
        .upsert(
          { closer_call_id, utm_campaign, note: `QA-assigned ${audience} on ${new Date().toISOString().slice(0,10)}`, updated_at: new Date().toISOString() },
          { onConflict: 'closer_call_id' }
        )
      if (error) throw new Error(error.message)
      setReloadKey(k => k + 1)
    } catch (e) {
      setErr(`QA save failed: ${e.message}`)
    } finally {
      setQaSaveBusy(prev => {
        const next = { ...prev }
        delete next[closer_call_id]
        return next
      })
    }
  }

  // Bulk-assign all visible low-confidence rows to one audience.
  async function bulkQa(audience) {
    if (!audience || qaQueue.length === 0) return
    const targets = qaQueue.filter(r => r.qa_flag === 'low_confidence' || r.qa_flag === 'orphan')
    if (targets.length === 0) return
    setBulkBusy(true); setErr(null)
    try {
      const utmMap = {
        'Restoration':  'SCIO -Restoration - Application - 4/22 - New Videos',
        'Electricians': 'SCIO - Electricians - VSL - 5/4 images - Relaunch',
        'REFERRAL':     'REFERRAL',
      }
      const utm_campaign = utmMap[audience] || audience
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
      setReloadKey(k => k + 1)
    } catch (e) {
      setErr(`Bulk QA failed: ${e.message}`)
    } finally {
      setBulkBusy(false)
    }
  }

  // Bulk-assign the picked audience to every typeform row tied to every
  // selected creative. One upsert. selectedKeys holds the row keys
  // (utm_campaign|utm_content); we look up response_ids[] from the matching
  // creative row and flatten.
  async function bulkAssignToSelected() {
    if (selectedKeys.size === 0 || !bulkAudience) return
    const slug = bulkAudience.trim().toLowerCase().replace(/\s+/g, '_')
    const responseIds = []
    for (const c of unresolvedCreatives) {
      const key = `${c.utm_campaign}|${c.utm_content}`
      if (selectedKeys.has(key) && Array.isArray(c.response_ids)) {
        responseIds.push(...c.response_ids)
      }
    }
    if (responseIds.length === 0) return
    setBulkBusy(true); setErr(null)
    try {
      const now = new Date().toISOString()
      const payload = responseIds.map(rid => ({
        response_id: rid,
        audience_slug: slug,
        notes: `bulk-assigned via creative picker on ${now.slice(0, 10)}`,
        set_at: now,
      }))
      const { error } = await supabase
        .from('typeform_response_overrides')
        .upsert(payload, { onConflict: 'response_id' })
      if (error) throw new Error(error.message)
      setSelectedKeys(new Set())
      setBulkAudience('')
      setReloadKey(k => k + 1)
    } catch (e) {
      setErr(`Bulk assign failed: ${e.message}`)
    } finally {
      setBulkBusy(false)
    }
  }

  // Write creative_attributes.vertical for one ad. Called from the kanban
  // drop handler. Optimistic — we set pendingVertical immediately so the
  // card jumps to the new column, then reconcile on round-trip.
  async function updateAdVertical(ad_id, vertical) {
    if (!ad_id) return
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
      // Don't reload everything — the optimistic state is already correct.
      // Patch the kanban row in place so vertical_source flips to 'override'.
      setKanbanAds(prev => prev.map(a =>
        a.ad_id === ad_id
          ? { ...a, current_vertical: vertical, vertical_source: 'override', override_vertical: vertical }
          : a
      ))
      setPendingVertical(prev => {
        const next = { ...prev }
        delete next[ad_id]
        return next
      })
    } catch (e) {
      // Roll back the optimistic write.
      setPendingVertical(prev => {
        const next = { ...prev }
        delete next[ad_id]
        return next
      })
      setErr(`Reassign failed: ${e.message}`)
    }
  }

  function toggleSelected(key) {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function selectAllVisible() {
    setSelectedKeys(new Set(unresolvedCreatives.map(c => `${c.utm_campaign}|${c.utm_content}`)))
  }

  function clearSelection() {
    setSelectedKeys(new Set())
  }

  // How many leads the bulk action will write to (sum of leads_count across
  // selected creatives). Surfaced in the action bar.
  const selectedLeadCount = useMemo(() => {
    let n = 0
    for (const c of unresolvedCreatives) {
      const key = `${c.utm_campaign}|${c.utm_content}`
      if (selectedKeys.has(key)) n += (c.leads_count || 0)
    }
    return n
  }, [unresolvedCreatives, selectedKeys])

  // Count of rows the auto-classify button would touch.
  const autoClassifiableCount = useMemo(
    () => unresolved.filter(
      r => !r.override_audience_slug && parseAudienceFromCampaign(r.utm_campaign)
    ).length,
    [unresolved],
  )

  const headline = useMemo(() => {
    const stage = stages.find(s => s.stage_key === 'spend_with_lead')
    if (!stage) return null
    return {
      pct: Number(stage.coverage_pct),
      traced: Number(stage.traced),
      total: Number(stage.total),
      gap: Number(stage.gap),
    }
  }, [stages])

  const staleSources = useMemo(
    () => freshness.filter(f => f.days_behind != null && f.days_behind > 1),
    [freshness],
  )

  return (
    <div style={{
      width: '100%', padding: '32px 32px 64px',
      background: 'var(--paper)', minHeight: '100vh',
    }}>
      <SectionHead
        level="page"
        eyebrow="Sales · Marketing"
        title="Attribution coverage"
        italicWord="coverage"
        tagline="One pane of glass for how much of our ad chain is actually traced end-to-end. Every leak shows you exactly where to fix it next."
        right={
          <div style={{ display: 'flex', gap: 6 }}>
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

      {/* Stale-data warning */}
      {staleSources.length > 0 && (
        <Card accent={PALETTE.amber} accentSide="left" style={{ marginTop: 16 }}>
          <Eyebrow>Data freshness</Eyebrow>
          <div style={{ marginTop: 6, fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-2)' }}>
            {staleSources.map((s, i) => (
              <span key={s.source} style={{ marginRight: 16 }}>
                {i > 0 && <span style={{ color: 'var(--ink-3)', margin: '0 8px' }}>·</span>}
                <strong>{s.source}</strong> <span style={{ color: 'var(--ink-3)' }}>·</span> <span style={{ color: PALETTE.amber }}>{s.days_behind} day{s.days_behind === 1 ? '' : 's'} behind</span>
              </span>
            ))}
            <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>
              Coverage numbers below are only as accurate as the freshest sync.
            </div>
          </div>
        </Card>
      )}

      {/* HEADLINE */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 24 }}>
        <Card padding={24}>
          <Eyebrow>Spend traced end-to-end</Eyebrow>
          <div style={{ marginTop: 8 }}>
            <BigNumber
              value={busy ? '—' : (headline ? `${headline.pct.toFixed(1)}` : '—')}
              suffix="%"
              size={56}
              color={headline ? (
                headline.pct >= 90 ? PALETTE.green :
                headline.pct >= 70 ? PALETTE.amber : PALETTE.red
              ) : 'var(--ink)'}
            />
          </div>
          {headline && (
            <div style={{ marginTop: 6, fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
              {fmtMoneyFull(headline.traced)} <span style={{ margin: '0 4px' }}>·</span> of {fmtMoneyFull(headline.total)} traced to a typeform lead
            </div>
          )}
        </Card>
        <Card padding={24}>
          <Eyebrow>Unattributed spend</Eyebrow>
          <div style={{ marginTop: 8 }}>
            <BigNumber
              value={busy ? '—' : (headline ? fmtMoneyFull(headline.gap).replace('$', '') : '—')}
              prefix="$"
              size={56}
              color={PALETTE.red}
            />
          </div>
          <div style={{ marginTop: 6, fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
            Spent on ads that produced zero traceable leads
          </div>
        </Card>
        <Card padding={24}>
          <Eyebrow>Unresolved submits</Eyebrow>
          <div style={{ marginTop: 8 }}>
            <BigNumber
              value={busy ? '—' : fmtNum(unresolved.length)}
              size={56}
              color={unresolved.length > 0 ? PALETTE.amber : PALETTE.green}
            />
          </div>
          <div style={{ marginTop: 6, fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
            Typeform rows in last 90d with no ad_id match
          </div>
        </Card>
      </div>

      {/* THE CHAIN — funnel table */}
      <div style={{ marginTop: 32 }}>
        <SectionHead
          eyebrow="The chain"
          title="Where the funnel leaks"
          tagline="Each row is one stage of the chain. Coverage is `traced ÷ total` for that stage. Red rows are the biggest fixes."
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
                const tone = covTone(Number(s.coverage_pct))
                const help = STAGE_HELP[s.stage_key]
                return (
                  <tr key={s.stage_key} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                        }}>{String(s.stage_order).padStart(2, '0')}</span>
                        <div style={{ minWidth: 0 }}>
                          <div>{s.stage_label}</div>
                          {help && (
                            <div style={{
                              marginTop: 3, fontSize: 11, color: 'var(--ink-3)',
                              fontStyle: 'italic', lineHeight: 1.4, maxWidth: 540,
                            }}>{help}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(Number(s.total))}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(Number(s.traced))}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: Number(s.gap) > 0 ? PALETTE.red : 'var(--ink-3)' }}>
                      {Number(s.gap) === 0 ? '—' : fmt(Number(s.gap))}
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

      {/* GAP ADS */}
      <div style={{ marginTop: 32 }}>
        <SectionHead
          eyebrow="Where to attack first"
          title="Top ads with attribution gaps"
          tagline="Ads with the most spend in the last 30 days. Sort by spend ÷ traced leads to find what's leaking."
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
              {gapAds.slice(0, 20).map(ad => {
                const spend = Number(ad.spend_30d) || 0
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
          {!busy && gapAds.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
              No spend in the last 30 days.
            </div>
          )}
        </Card>
      </div>

      {/* AD LIST — flat list of active ads, default = ones that still need classification */}
      <AdList
        ads={kanbanAds}
        pendingVertical={pendingVertical}
        existingAudiences={existingAudiences}
        onAssign={updateAdVertical}
        autoClassifiableCount={autoClassifiableCount}
        onAutoClassify={autoClassifyByUtm}
        autoBusy={autoBusy}
        busy={busy}
      />

      {/* QA QUEUE (Ben 2026-06-01) — flagged calls that need your eyes */}
      {qaQueue.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <SectionHead
            eyebrow="QA queue"
            title={`${qaQueue.length} call${qaQueue.length === 1 ? '' : 's'} flagged for review`}
            tagline="Calls the resolver isn't fully confident about. Click an audience chip to set the correct attribution — writes to close_attribution_overrides which the resolver respects as the highest-priority match."
            right={
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="secondary" size="sm" onClick={() => bulkQa('Restoration')} disabled={bulkBusy}>
                  {bulkBusy ? 'Saving…' : 'Bulk → Restoration'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => bulkQa('REFERRAL')} disabled={bulkBusy}>
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
                {qaQueue.map(r => {
                  const flagTone = r.qa_flag === 'orphan' ? 'red'
                    : r.qa_flag === 'low_confidence' ? 'amber' : 'default'
                  const saving = !!qaSaveBusy[r.closer_call_id]
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
                              onClick={() => setQaAudience(r.closer_call_id, aud)}
                              style={{
                                fontFamily: 'var(--mono)', fontSize: 10,
                                letterSpacing: '0.06em', textTransform: 'uppercase',
                                padding: '4px 8px',
                                background: 'var(--paper)',
                                border: '1px solid var(--rule)',
                                color: aud === 'REFERRAL' ? 'var(--ink-3)' : 'var(--ink)',
                                cursor: saving ? 'wait' : 'pointer',
                                borderRadius: 2,
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
      )}

      {/* WHAT TO DO NEXT */}
      <div style={{ marginTop: 32 }}>
        <SectionHead eyebrow="What this means" title="Closing the gap" />
        <Card padding={20}>
          <ol style={{ margin: 0, paddingLeft: 20, fontFamily: 'var(--sans)', fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)' }}>
            <li><strong>Fix Meta URL macros (Fix A).</strong> Set account-level URL params on the ad account so every new ad inherits <code style={code}>utm_content={'{{'}ad.id{'}}'}</code>, <code style={code}>utm_term={'{{'}adset.id{'}}'}</code>, <code style={code}>utm_campaign={'{{'}campaign.id{'}}'}</code>. Then backfill the 28 active ads via Meta API (we have <code style={code}>ads_management</code> scope).</li>
            <li><strong>VSL pages forward UTMs (Fix C).</strong> Add a tiny JS snippet on <code style={code}>optdigital.io/vsl-restoration</code> and <code style={code}>/electrician-vsl</code> that reads <code style={code}>window.location.search</code> and rewrites the embedded Typeform iframe <code style={code}>src</code>. Typeform hidden fields then carry the IDs through.</li>
            <li><strong>Re-run the resolver.</strong> After Fix A + C, run <code style={code}>sync-typeform</code> for the last 90 days. Coverage on stage 5 (ad_id resolved) should jump from 57% to 95%+.</li>
            <li><strong>Mirror Lead Forms (Fix B).</strong> Only needed if the 688 <code style={code}>fb.me/</code> ads come back into rotation. Right now most traffic goes to Typeform so this is deferred.</li>
          </ol>
        </Card>
      </div>

      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <Link to="/sales/marketing" style={{
          fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
          textDecoration: 'underline', textUnderlineOffset: 4,
        }}>← Back to Marketing Performance</Link>
      </div>

      <AssignAudienceModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={saveOverride}
        busy={saveBusy}
        audiences={existingAudiences}
      />
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// AdList (Ben 2026-05-31, replaces the kanban)
//
// Flat list of top-spending active ads. Default filter: only show ads that
// haven't been explicitly classified (vertical_source != 'override') so the
// page shrinks as you work through it. Toggle "Show all" to see the ones
// you already classified — useful when you assigned the wrong audience by
// accident.
//
// Per-row controls:
//  - Small thumbnail (52×52 image, no decorative color blocks)
//  - Ad name + campaign + spend / leads / CPL
//  - Inline audience picker (chip group): click a chip → writes
//    creative_attributes.vertical for that ad → row hides under the
//    default filter.
//
// No drag-and-drop. No kanban columns. Just a list.
// ───────────────────────────────────────────────────────────────────────────

const AUDIENCE_OPTIONS = [
  'restoration', 'electrician', 'accounting',
  'pool_builders', 'real_estate', 'roofing', 'plumbing', 'hvac',
]

function AdList({
  ads, pendingVertical, existingAudiences, onAssign,
  autoClassifiableCount, onAutoClassify, autoBusy, busy,
}) {
  const [showAssigned, setShowAssigned] = useState(false)
  const [search, setSearch] = useState('')

  // Effective vertical for a row (optimistic > view).
  function effective(ad) {
    const v = pendingVertical[ad.ad_id] ?? ad.current_vertical
    const source = pendingVertical[ad.ad_id] ? 'override' : ad.vertical_source
    return { vertical: v, source }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ads.filter(a => {
      if (q) {
        const blob = `${a.ad_name || ''} ${a.campaign_name || ''} ${a.adset_name || ''}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      if (showAssigned) return true
      // Default filter: hide rows whose vertical was explicitly set
      // (override). Keep auto-parsed + unknown — those still need a human eye.
      const { source } = effective(a)
      return source !== 'override'
    })
  }, [ads, search, showAssigned, pendingVertical])

  const overrideCount = useMemo(
    () => ads.filter(a => effective(a).source === 'override').length,
    [ads, pendingVertical],
  )

  // Union of canonical + previously-used audiences (the picker shows both).
  const audienceChips = useMemo(() => {
    const seen = new Set(AUDIENCE_OPTIONS)
    for (const a of existingAudiences || []) seen.add(a)
    return Array.from(seen)
  }, [existingAudiences])

  return (
    <div style={{ marginTop: 32 }}>
      <SectionHead
        eyebrow="Active ads · last 30 days"
        title="Classify each ad once"
        tagline="Pick the audience for every ad that's still unclassified. Every current and future lead from that ad inherits the audience. Rows you've already classified hide automatically — toggle 'Show all' if you need to fix a wrong assignment."
        right={
          autoClassifiableCount > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onAutoClassify}
              disabled={autoBusy}
            >
              {autoBusy ? 'Classifying…' : `Auto-classify ${autoClassifiableCount} lead${autoClassifiableCount === 1 ? '' : 's'}`}
            </Button>
          ) : null
        }
      />

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 14px', marginBottom: 12,
        background: 'var(--paper-2)', border: '1px solid var(--rule)',
      }}>
        <button
          type="button"
          onClick={() => setShowAssigned(false)}
          style={{
            ...chipBtn,
            background: !showAssigned ? 'var(--ink)' : 'var(--paper)',
            color: !showAssigned ? 'var(--paper)' : 'var(--ink-2)',
            borderColor: !showAssigned ? 'var(--ink)' : 'var(--rule)',
          }}>
          Needs classification ({ads.length - overrideCount})
        </button>
        <button
          type="button"
          onClick={() => setShowAssigned(true)}
          style={{
            ...chipBtn,
            background: showAssigned ? 'var(--ink)' : 'var(--paper)',
            color: showAssigned ? 'var(--paper)' : 'var(--ink-2)',
            borderColor: showAssigned ? 'var(--ink)' : 'var(--rule)',
          }}>
          Show all ({ads.length})
        </button>

        <span style={{ color: 'var(--ink-3)', margin: '0 4px' }}>·</span>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search ad name or campaign…"
          style={{
            flex: 1, minWidth: 240, padding: '7px 12px',
            fontFamily: 'var(--sans)', fontSize: 13,
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', outline: 'none', borderRadius: 2,
          }} />

        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>
          {filtered.length} of {ads.length} ads
        </span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Card padding={24}>
          <div style={{ textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            {busy ? 'Loading…'
             : ads.length === 0 ? 'No active ads with spend in the last 30 days.'
             : !showAssigned ? 'Every active ad is classified. Toggle "Show all" to review.'
             : 'No ads match your search.'}
          </div>
        </Card>
      ) : (
        <Card padding={0}>
          {filtered.map((ad, i) => (
            <AdListRow
              key={ad.ad_id}
              ad={ad}
              effective={effective(ad)}
              audienceChips={audienceChips}
              onAssign={onAssign}
              isLast={i === filtered.length - 1}
            />
          ))}
        </Card>
      )}
    </div>
  )
}

function AdListRow({ ad, effective: eff, audienceChips, onAssign, isLast }) {
  const cpl = ad.cpl_30d != null ? Number(ad.cpl_30d) : null
  const cplTone = cpl == null ? 'default'
    : cpl > 200 ? 'red'
    : cpl > 100 ? 'amber'
    : 'green'
  const audTone = eff.source === 'override' ? 'green'
                : eff.source === 'parsed'   ? 'amber'
                : 'red'

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '56px minmax(220px, 1.4fr) minmax(220px, 1.6fr) 110px 80px 100px 1.4fr',
      gap: 14, alignItems: 'center',
      padding: '12px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--rule)',
      fontFamily: 'var(--sans)', fontSize: 13,
    }}>
      {/* Thumbnail */}
      <div style={{
        width: 52, height: 52,
        background: ad.thumbnail_url ? `url(${ad.thumbnail_url}) center/cover` : 'var(--paper-2)',
        border: '1px solid var(--rule)',
        flexShrink: 0,
      }} />

      {/* Ad name + ad_id */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontWeight: 500, color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ad.ad_name || '—'}</div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
          marginTop: 2,
        }}>{ad.ad_id}</div>
      </div>

      {/* Campaign + adset */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: 'var(--ink-2)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ad.campaign_name || '—'}</div>
        <div style={{
          fontSize: 11, color: 'var(--ink-3)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ad.adset_name || ''}</div>
      </div>

      {/* Spend */}
      <div style={{
        fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
        fontSize: 17, color: 'var(--ink)', textAlign: 'right',
      }}>
        {fmtMoneyFull(Number(ad.spend_30d))}
      </div>

      {/* Leads */}
      <div style={{
        fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
        fontSize: 15, color: 'var(--ink-2)', textAlign: 'right',
      }}>
        {ad.leads_30d}
      </div>

      {/* CPL pill */}
      <div style={{ textAlign: 'right' }}>
        <Pill tone={cplTone}>{cpl != null ? `${fmtMoneyFull(cpl)}/lead` : '∞'}</Pill>
      </div>

      {/* Audience picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Pill tone={audTone} uppercase>
          {eff.vertical ? eff.vertical.replace(/_/g, ' ') : 'unclassified'}
        </Pill>
        <select
          value={eff.vertical || ''}
          onChange={(e) => onAssign(ad.ad_id, e.target.value)}
          style={{
            fontFamily: 'var(--sans)', fontSize: 12,
            padding: '5px 8px',
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', outline: 'none', borderRadius: 2,
            cursor: 'pointer',
            minWidth: 140,
          }}>
          <option value="" disabled>Set audience…</option>
          {audienceChips.map(slug => (
            <option key={slug} value={slug}>{slug.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────────────────
// AssignAudienceModal
// Lets Ben tag any unresolved typeform row with an audience and (optionally)
// a specific ad_id. Saves to public.typeform_response_overrides. Suggests the
// parser's inferred audience as a quick-pick when utm_campaign already names
// one (so the common case is two clicks: Suggested chip → Save).
// ───────────────────────────────────────────────────────────────────────────

function AssignAudienceModal({ target, onClose, onSave, busy, audiences }) {
  const [audience, setAudience] = useState('')
  const [customAudience, setCustomAudience] = useState('')
  const [adId, setAdId] = useState('')
  const [notes, setNotes] = useState('')

  // Reset when opening for a new target.
  useEffect(() => {
    if (!target) return
    setAudience(target.override_audience_slug || target.current_audience_slug || '')
    setCustomAudience('')
    setAdId(target.override_ad_id || '')
    setNotes(target.override_notes || '')
  }, [target?.response_id])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null

  const suggested = parseAudienceFromCampaign(target.utm_campaign)
  const finalAudience = (customAudience || audience).trim().toLowerCase().replace(/\s+/g, '_')
  const canSave = !!finalAudience && !busy

  function handleSave() {
    onSave({
      response_id: target.response_id,
      audience_slug: finalAudience,
      ad_id: adId,
      notes,
    })
  }

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      eyebrow="Assign attribution"
      title={`${target.first_name || ''} ${target.last_name || target.email || target.response_id}`.trim()}
      subtitle={`Submitted ${target.submitted_at?.slice(0, 10)} · ${target.form_name || target.utm_campaign || ''}`}
      size="lg"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>
            {busy ? 'Saving…' : 'Save assignment'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '24px 28px' }}>
        {/* Raw UTMs — context */}
        <div style={{
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          padding: 12, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-2)',
          lineHeight: 1.65,
        }}>
          <div><span style={{ color: 'var(--ink-3)' }}>utm_campaign:</span> {target.utm_campaign || '—'}</div>
          <div><span style={{ color: 'var(--ink-3)' }}>utm_content:</span> {target.utm_content || '—'}</div>
          <div><span style={{ color: 'var(--ink-3)' }}>utm_term:</span> {target.utm_term || '—'}</div>
          <div><span style={{ color: 'var(--ink-3)' }}>utm_source / medium:</span> {target.utm_source || '—'} / {target.utm_medium || '—'}</div>
        </div>

        {/* Audience picker */}
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>Audience *</Eyebrow>
          {suggested && (
            <div style={{ marginBottom: 10, fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
              Suggested from utm_campaign:{' '}
              <button
                type="button"
                onClick={() => { setAudience(suggested); setCustomAudience('') }}
                style={{
                  ...chipBtn,
                  background: audience === suggested && !customAudience ? 'var(--ink)' : 'var(--paper-2)',
                  color: audience === suggested && !customAudience ? 'var(--paper)' : 'var(--ink)',
                  borderColor: 'var(--ink)',
                }}>
                {suggested.replace(/_/g, ' ')}
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {audiences.map(slug => (
              <button
                key={slug}
                type="button"
                onClick={() => { setAudience(slug); setCustomAudience('') }}
                style={{
                  ...chipBtn,
                  background: audience === slug && !customAudience ? 'var(--ink)' : 'transparent',
                  color: audience === slug && !customAudience ? 'var(--paper)' : 'var(--ink-2)',
                  borderColor: audience === slug && !customAudience ? 'var(--ink)' : 'var(--rule)',
                }}>
                {slug.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <input
            value={customAudience}
            onChange={e => setCustomAudience(e.target.value)}
            placeholder="Or type a new audience slug (e.g. dentists)"
            style={textInput}
          />
        </div>

        {/* Optional ad_id */}
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>Pin to ad_id (optional)</Eyebrow>
          <p style={{ margin: '0 0 8px', fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
            Leave blank unless you know exactly which ad this lead came from. Format: Meta numeric ad_id like <code style={{ fontFamily: 'var(--mono)' }}>120245092538750530</code>.
          </p>
          <input
            value={adId}
            onChange={e => setAdId(e.target.value)}
            placeholder="120245…"
            style={{ ...textInput, fontFamily: 'var(--mono)' }}
          />
        </div>

        {/* Notes */}
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>Notes (optional)</Eyebrow>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Why you classified it this way — useful for the audit trail."
            style={{ ...textInput, resize: 'vertical' }}
          />
        </div>
      </div>
    </Modal>
  )
}

const chipBtn = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '6px 12px',
  border: '1px solid var(--rule)',
  borderRadius: 2,
  cursor: 'pointer',
  background: 'transparent',
}

const textInput = {
  width: '100%',
  padding: '9px 12px',
  fontFamily: 'var(--sans)',
  fontSize: 13,
  border: '1px solid var(--rule)',
  borderRadius: 2,
  background: 'white',
  color: 'var(--ink)',
  outline: 'none',
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
  borderRadius: 2,
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

function causeTone(cause) {
  return ({
    no_utms_at_all: 'red',
    utm_content_is_creative_name: 'amber',
    looks_like_ad_id_but_no_match: 'red',
    test_traffic: 'default',
    other: 'default',
  })[cause] || 'default'
}
