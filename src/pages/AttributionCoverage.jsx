import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  SectionHead, Eyebrow, Pill, Card, Button, BigNumber,
  fmtMoneyFull, fmtNum, fmtPct, PALETTE,
} from '../components/editorial/atoms'

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
      supabase.from('lib_attribution_unresolved_typeform').select('*').limit(50),
      supabase.from('lib_attribution_freshness').select('*'),
    ]).then(([s, g, u, f]) => {
      if (!alive) return
      if (s.error) throw new Error(`coverage: ${s.error.message}`)
      if (g.error) throw new Error(`gap_ads: ${g.error.message}`)
      if (u.error) throw new Error(`unresolved: ${u.error.message}`)
      if (f.error) throw new Error(`freshness: ${f.error.message}`)
      setStages(s.data || [])
      setGapAds(g.data || [])
      setUnresolved(u.data || [])
      setFreshness(f.data || [])
    }).catch(e => { if (alive) setErr(e.message) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [windowDays])

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
            {staleSources.map(s => (
              <span key={s.source} style={{ marginRight: 16 }}>
                <strong>{s.source}</strong> is <span style={{ color: PALETTE.amber }}>{s.days_behind} day{s.days_behind === 1 ? '' : 's'} behind</span>
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
              {fmtMoneyFull(headline.traced)} of {fmtMoneyFull(headline.total)} traced to a typeform lead
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

      {/* UNRESOLVED TYPEFORM */}
      <div style={{ marginTop: 32 }}>
        <SectionHead
          eyebrow="Triage queue"
          title="Typeform submits without an ad_id"
          tagline="These rows didn't match any ad. The raw UTM fields tell you why — manually classify or fix the ad URL macro."
        />
        <Card padding={0}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--sans)', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)' }}>
                <th style={th}>Submitted</th>
                <th style={th}>Email</th>
                <th style={th}>utm_campaign</th>
                <th style={th}>utm_content</th>
                <th style={th}>Likely cause</th>
              </tr>
            </thead>
            <tbody>
              {unresolved.slice(0, 30).map(r => (
                <tr key={r.response_id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                    {r.submitted_at?.slice(0, 10)}
                  </td>
                  <td style={td}>
                    <div>{r.first_name} {r.last_name}</div>
                    <div style={{ color: 'var(--ink-3)', fontSize: 11 }}>{r.email}</div>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
                    {r.utm_campaign || <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
                    {r.utm_content || <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                  <td style={td}>
                    <Pill tone={causeTone(r.likely_cause)} uppercase>
                      {r.likely_cause?.replace(/_/g, ' ') || '—'}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && unresolved.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
              Every typeform submit in the last 90 days resolved to an ad. Bulletproof.
            </div>
          )}
        </Card>
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
    </div>
  )
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
