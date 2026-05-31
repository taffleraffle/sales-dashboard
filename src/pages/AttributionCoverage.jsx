import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  SectionHead, Eyebrow, Pill, Card, Button, BigNumber, Icon,
  fmtMoneyFull, fmtNum, fmtPct, PALETTE,
} from '../components/editorial/atoms'
import Modal from '../components/editorial/Modal'

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

  // Triage queue is now grouped by creative (lib_attribution_unresolved_creatives).
  // unresolvedCreatives = one row per (utm_campaign, utm_content) cluster with
  // a thumbnail (when ads sync has caught up), leads count, and the response_ids
  // of every lead behind that creative.
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
    ]).then(([s, g, u, f, c]) => {
      if (!alive) return
      if (s.error) throw new Error(`coverage: ${s.error.message}`)
      if (g.error) throw new Error(`gap_ads: ${g.error.message}`)
      if (u.error) throw new Error(`unresolved: ${u.error.message}`)
      if (f.error) throw new Error(`freshness: ${f.error.message}`)
      if (c.error) throw new Error(`creatives: ${c.error.message}`)
      setStages(s.data || [])
      setGapAds(g.data || [])
      setUnresolved(u.data || [])
      setFreshness(f.data || [])
      setUnresolvedCreatives(c.data || [])
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
      maxWidth: 1280, margin: '0 auto', padding: '32px 32px 64px',
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
                return (
                  <tr key={s.stage_key} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={td}>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                        marginRight: 10,
                      }}>{String(s.stage_order).padStart(2, '0')}</span>
                      {s.stage_label}
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

      {/* TRIAGE — grouped by creative */}
      <div style={{ marginTop: 32 }}>
        <SectionHead
          eyebrow="Triage queue"
          title="Unresolved leads, grouped by creative"
          tagline="Each card is one (campaign · creative) cluster — the leads tied to that ad. Tick a few, pick an audience, hit Assign. Auto-classify resolves anything whose campaign name already says 'Restoration' / 'Electricians' in one click."
          right={
            autoClassifiableCount > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={autoClassifyByUtm}
                disabled={autoBusy}
              >
                {autoBusy ? 'Classifying…' : `Auto-classify ${autoClassifiableCount} lead${autoClassifiableCount === 1 ? '' : 's'}`}
              </Button>
            ) : null
          }
        />

        {/* Bulk action bar — sticky-ish at top */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px', marginBottom: 12,
          background: selectedKeys.size > 0 ? 'var(--accent-soft, #fef9cc)' : 'var(--paper-2)',
          border: '1px solid var(--rule)',
          transition: 'background 0.16s',
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {selectedKeys.size === 0
              ? 'select creatives to bulk-assign'
              : `${selectedKeys.size} creative${selectedKeys.size === 1 ? '' : 's'} · ${selectedLeadCount} lead${selectedLeadCount === 1 ? '' : 's'}`}
          </span>

          {selectedKeys.size > 0 && (
            <>
              <span style={{ color: 'var(--ink-3)' }}>·</span>
              <button
                type="button"
                onClick={clearSelection}
                style={chipBtn}>
                Clear
              </button>

              <span style={{ color: 'var(--ink-3)' }}>·</span>

              <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-2)' }}>
                Set audience to:
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {existingAudiences.map(slug => (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => setBulkAudience(slug)}
                    style={{
                      ...chipBtn,
                      background: bulkAudience === slug ? 'var(--ink)' : 'var(--paper)',
                      color: bulkAudience === slug ? 'var(--paper)' : 'var(--ink-2)',
                      borderColor: bulkAudience === slug ? 'var(--ink)' : 'var(--rule)',
                    }}>
                    {slug.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>

              <Button
                variant="primary"
                size="sm"
                onClick={bulkAssignToSelected}
                disabled={!bulkAudience || bulkBusy}
              >
                {bulkBusy ? 'Assigning…' : `Assign ${selectedLeadCount} lead${selectedLeadCount === 1 ? '' : 's'}`}
              </Button>
            </>
          )}

          <div style={{ flex: 1 }} />

          <button type="button" onClick={selectAllVisible} style={chipBtn}>
            Select all {unresolvedCreatives.length}
          </button>
        </div>

        {/* Creative grid */}
        {unresolvedCreatives.length === 0 ? (
          <Card padding={24}>
            <div style={{ textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
              {busy ? 'Loading…' : 'No unresolved creatives. Every typeform submit in the last 90 days is classified.'}
            </div>
          </Card>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 14,
          }}>
            {unresolvedCreatives.map(c => {
              const key = `${c.utm_campaign}|${c.utm_content}`
              const isSelected = selectedKeys.has(key)
              const aud = c.current_audience_slug
              const source = c.audience_source
              return (
                <CreativeCard
                  key={key}
                  creative={c}
                  selected={isSelected}
                  onToggle={() => toggleSelected(key)}
                  audience={aud}
                  audienceSource={source}
                />
              )
            })}
          </div>
        )}
      </div>

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
// CreativeCard
// One card per (utm_campaign, utm_content) cluster. Shows the ad thumbnail
// when ads sync has caught up, otherwise a deterministic-color placeholder
// with the creative name overlaid. Checkbox in the corner for multi-select.
// Click anywhere on the card body to toggle selection.
// ───────────────────────────────────────────────────────────────────────────

function CreativeCard({ creative, selected, onToggle, audience, audienceSource }) {
  const c = creative
  const hasThumb = !!c.thumbnail_url
  const placeholderColor = colorFromString(`${c.utm_campaign}-${c.utm_content}`)
  const audTone = audienceSource === 'response_override' ? 'green'
                : audienceSource === 'campaign_override' ? 'teal'
                : audienceSource === 'parsed'            ? 'amber'
                : 'red'

  return (
    <div
      onClick={onToggle}
      style={{
        position: 'relative',
        background: 'var(--paper)',
        border: `1px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
        outline: selected ? '2px solid var(--accent, #f4e14a)' : 'none',
        outlineOffset: -1,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        transition: 'border 0.12s, outline 0.12s',
      }}>
      {/* Thumbnail / placeholder */}
      <div style={{
        position: 'relative',
        height: 160,
        background: hasThumb ? '#0a0a0a' : placeholderColor,
        backgroundImage: hasThumb ? `url(${c.thumbnail_url})` : 'none',
        backgroundSize: 'cover', backgroundPosition: 'center',
        display: 'flex', alignItems: 'flex-end',
        borderBottom: '1px solid var(--rule)',
      }}>
        {/* Checkbox */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          width: 22, height: 22,
          background: 'var(--paper)',
          border: `1px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)',
        }}>
          {selected ? '✓' : ''}
        </div>

        {/* Leads pill (right) */}
        <div style={{
          position: 'absolute', top: 8, right: 8,
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11,
          letterSpacing: '0.04em', padding: '4px 8px',
        }}>
          {c.leads_count} lead{c.leads_count === 1 ? '' : 's'}
        </div>

        {/* Creative name overlay (placeholder) */}
        {!hasThumb && (
          <div style={{
            padding: 14,
            color: 'var(--paper)',
            fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.15,
            textShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}>
            <em>{c.utm_content === '<no_content>' ? 'no creative' : c.utm_content}</em>
          </div>
        )}

        {/* Asset type pill (video / image) when known */}
        {hasThumb && c.asset_type && (
          <div style={{
            position: 'absolute', bottom: 8, left: 8,
            background: 'rgba(0,0,0,0.6)', color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9.5,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '3px 7px',
          }}>
            {c.asset_type}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          color: 'var(--ink-3)',
        }}>
          {c.utm_campaign === '<no_campaign>' ? 'no campaign · direct nav' : c.utm_campaign}
        </div>

        {hasThumb && (
          <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>
            {c.utm_content === '<no_content>' ? '—' : c.utm_content}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {audience ? (
            <Pill tone={audTone} uppercase>{audience.replace(/_/g, ' ')}</Pill>
          ) : (
            <Pill tone="red" uppercase>unknown</Pill>
          )}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-3)' }}>
            {audienceSource?.replace(/_/g, ' ')}
          </span>
        </div>

        {c.ad_id && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
            ad_id · {c.ad_id}
          </div>
        )}
      </div>
    </div>
  )
}

// Deterministic background color for placeholder thumbnails.
function colorFromString(s) {
  const palette = ['#2a4a5e', '#5b3a8f', '#b86a0c', '#3e5a4e', '#7a2c3e', '#2a3a55']
  const h = (s || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return palette[h % palette.length]
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
