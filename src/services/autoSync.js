// Global auto-sync service
// Runs data syncs in the background so nothing requires a manual button click.
// Triggered from Layout on mount + every 30 minutes via setInterval.
// Each sync has its own interval — only re-runs if enough time has passed.

import { syncGHLAppointments } from './ghlCalendar'
import { syncEmailMessages, refreshRecentEmailStatuses, fetchWorkflows } from './ghlEmailFlows'
import { toLocalDateStr } from '../lib/dateUtils'

const SYNC_INTERVALS = {
  stripe: 2 * 60 * 60 * 1000,       // 2 hours
  fanbasis: 2 * 60 * 60 * 1000,     // 2 hours
  ghlAppointments: 1 * 60 * 60 * 1000, // 1 hour
  emailFlows: 30 * 60 * 1000,        // 30 minutes
  marketingTracker: 1 * 60 * 60 * 1000, // 1 hour
  meta: 1 * 60 * 60 * 1000,          // 1 hour — Meta Ads spend + GHL pipeline leads/bookings
  metaAds: 1 * 60 * 60 * 1000,       // 1 hour — per-ad insights + creative metadata
  typeform: 1 * 60 * 60 * 1000,      // 1 hour — Typeform responses (h4il4Sla + WndFLJux)
  ghlContacts: 2 * 60 * 60 * 1000,   // 2 hours — full contact + attribution refresh
  hyrosBackfill: 6 * 60 * 60 * 1000, // 6 hours — wide-window HYROS pull (slow)
}

const SYNC_LABELS = {
  stripe: 'Stripe payments',
  fanbasis: 'Fanbasis payments',
  ghlAppointments: 'GHL appointments',
  emailFlows: 'Email flows',
  marketingTracker: 'Marketing (EOD)',
  meta: 'Marketing (Meta + GHL)',
  metaAds: 'Meta Ads (per-ad)',
  typeform: 'Typeform responses',
  ghlContacts: 'GHL contacts (attribution)',
  hyrosBackfill: 'HYROS (retroactive)',
}

function lastRun(key) {
  try { return parseInt(localStorage.getItem(`autosync_${key}`) || '0') } catch { return 0 }
}

function markRun(key) {
  try { localStorage.setItem(`autosync_${key}`, String(Date.now())) } catch {}
}

// When a sync fails with a rate-limit (429), cool it down for 5 minutes so
// the 15-minute auto-sync interval doesn't keep re-firing a sync that's
// already under API throttle. Without this, we'd retry every 15 min forever
// against the same 429 ceiling.
const cooldownUntil = {}
function shouldRun(key, force = false) {
  if (force) return true
  if (cooldownUntil[key] && Date.now() < cooldownUntil[key]) return false
  return Date.now() - lastRun(key) > SYNC_INTERVALS[key]
}
function markCooldown(key, ms = 5 * 60 * 1000) {
  cooldownUntil[key] = Date.now() + ms
}
function clearCooldown(key) {
  delete cooldownUntil[key]
}
function isRateLimitErr(err) {
  const msg = (err?.message || String(err || '')).toLowerCase()
  return msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')
}

// Per-sync last-error string so the UI can show "Marketing sync failed: …"
// instead of a green checkmark when the last attempt actually crashed.
const lastErrors = {}
function markError(key, err) {
  const msg = typeof err === 'string' ? err : (err?.message || 'Unknown error')
  lastErrors[key] = msg
}
function clearError(key) {
  delete lastErrors[key]
}

// Listener for UI subscribers so a "last synced" indicator can re-render
// whenever a sync finishes.
const subscribers = new Set()
function notify() {
  subscribers.forEach(fn => {
    try { fn() } catch (_e) { void _e }
  })
}

export function subscribeSyncStatus(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

async function syncStripe(force = false) {
  if (!shouldRun('stripe', force)) return
  markRun('stripe')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=14&limit=100&resync=false', {
      headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    console.log('[auto-sync] Stripe:', data.synced || 0, 'new,', data.matched || 0, 'matched')
    clearError('stripe')
  } catch (e) {
    console.warn('[auto-sync] Stripe failed:', e.message)
    markError('stripe', e)
  } finally { notify() }
}

async function syncFanbasis(force = false) {
  if (!shouldRun('fanbasis', force)) return
  markRun('fanbasis')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-fanbasis-payments?days=14&limit=100', {
      headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    console.log('[auto-sync] Fanbasis:', data.synced || 0, 'new,', data.matched || 0, 'matched')
    clearError('fanbasis')
  } catch (e) {
    console.warn('[auto-sync] Fanbasis failed:', e.message)
    markError('fanbasis', e)
  } finally { notify() }
}

async function syncGHL(force = false) {
  if (!shouldRun('ghlAppointments', force)) return
  markRun('ghlAppointments')
  try {
    // Pull a wide window: 1 year back for retroactive coverage (so historical
    // appointments tied to closer EOD entries can be matched) + 60 days
    // forward (for cost-per-booking + cohort show-rate math). Without the
    // forward window, calls booked today for next week never enter
    // ghl_appointments — they're filtered out by GHL's /calendars/events
    // endpoint, which queries by event time, not booked_at.
    const past = new Date()
    past.setDate(past.getDate() - 365)
    const future = new Date()
    future.setDate(future.getDate() + 60)
    await syncGHLAppointments(toLocalDateStr(past), toLocalDateStr(future))
    console.log('[auto-sync] GHL appointments done')
    clearError('ghlAppointments')
    clearCooldown('ghlAppointments')
  } catch (e) {
    console.warn('[auto-sync] GHL appointments failed:', e.message)
    markError('ghlAppointments', e)
    if (isRateLimitErr(e)) markCooldown('ghlAppointments')
  } finally { notify() }
}

async function syncEmails(force = false) {
  if (!shouldRun('emailFlows', force)) return
  markRun('emailFlows')
  try {
    await fetchWorkflows()
    const result = await syncEmailMessages(30)
    await refreshRecentEmailStatuses(7)
    console.log('[auto-sync] Email flows:', result.synced || 0, 'new emails')
    clearError('emailFlows')
    clearCooldown('emailFlows')
  } catch (e) {
    console.warn('[auto-sync] Email flows failed:', e.message)
    markError('emailFlows', e)
    if (isRateLimitErr(e)) markCooldown('emailFlows')
  } finally { notify() }
}

async function syncMarketingTracker(force = false) {
  if (!shouldRun('marketingTracker', force)) return
  markRun('marketingTracker')
  try {
    const { syncEODToTracker } = await import('../hooks/useMarketingTracker')
    await syncEODToTracker()
    console.log('[auto-sync] Marketing tracker (EOD) done')
    clearError('marketingTracker')
  } catch (e) {
    console.warn('[auto-sync] Marketing tracker failed:', e.message)
    markError('marketingTracker', e)
  } finally { notify() }
}

// Per-ad Meta sync — feeds public.ads + public.ad_daily_stats which the
// Creative Library page (/sales/ads) reads from. Triggers on each tick after
// the steady interval has elapsed. Caller doesn't need a manual button.
async function syncMetaAdLevel(force = false) {
  if (!shouldRun('metaAds', force)) return
  markRun('metaAds')
  try {
    const { syncMetaAdsAtAdLevel } = await import('./metaAdsSync')
    const result = await syncMetaAdsAtAdLevel(90)
    console.log('[auto-sync] Meta ad-level done:', result)
    clearError('metaAds')
    clearCooldown('metaAds')
  } catch (e) {
    console.warn('[auto-sync] Meta ad-level failed:', e.message)
    markError('metaAds', e)
    if (isRateLimitErr(e)) markCooldown('metaAds')
  } finally { notify() }
}

// Typeform responses — feeds public.typeform_responses, which the
// lib_typeform_*_attribution views join to public.ads + ghl_appointments
// to surface cost/lead, cost/booked, cost/qual_booked, cost/live, cost/close
// at the ad / ad-set / campaign level on /sales/ads/performance.
async function syncTypeform(force = false) {
  if (!shouldRun('typeform', force)) return
  markRun('typeform')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-typeform', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ days: 730 }),  // retroactive — every typeform submission, ever
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    const totalFetched = Object.values(data.forms || {}).reduce((sum, f) => sum + (f.fetched || 0), 0)
    console.log('[auto-sync] Typeform:', totalFetched, 'responses,', data.ad_resolved || 0, 'ad_ids resolved')
    clearError('typeform')
    clearCooldown('typeform')
  } catch (e) {
    console.warn('[auto-sync] Typeform failed:', e.message)
    markError('typeform', e)
    if (isRateLimitErr(e)) markCooldown('typeform')
  } finally { notify() }
}

// GHL contacts — pulls every contact + their Meta-lead attribution
// (adId, adSetId, campaignId, utmCampaign, utmContent, formName) stored
// on attributionSource / lastAttributionSource. Feeds the close-attribution
// resolver so paid-lead closes outside the typeform funnel still credit
// the exact ad creative.
async function syncGhlContacts(force = false) {
  if (!shouldRun('ghlContacts', force)) return
  markRun('ghlContacts')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-ghl-contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ days: 730 }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    console.log('[auto-sync] GHL contacts:', data.fetched || 0, 'fetched,', data.withAttribution || 0, 'with attribution')
    clearError('ghlContacts')
    clearCooldown('ghlContacts')
  } catch (e) {
    console.warn('[auto-sync] GHL contacts failed:', e.message)
    markError('ghlContacts', e)
    if (isRateLimitErr(e)) markCooldown('ghlContacts')
  } finally { notify() }
}

// HYROS retroactive — pulls a 365-day window so historical calls + leads
// stay reachable by the resolver. Slow because HYROS pagination is heavy
// at this depth, hence the 6-hour interval.
async function syncHyrosBackfill(force = false) {
  if (!shouldRun('hyrosBackfill', force)) return
  markRun('hyrosBackfill')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/hyros-sync', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ days: 365 }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    console.log('[auto-sync] HYROS retroactive:', data.calls || 0, 'calls,', data.leads || 0, 'leads')
    clearError('hyrosBackfill')
    clearCooldown('hyrosBackfill')
  } catch (e) {
    console.warn('[auto-sync] HYROS retroactive failed:', e.message)
    markError('hyrosBackfill', e)
    if (isRateLimitErr(e)) markCooldown('hyrosBackfill')
  } finally { notify() }
}

// Meta Ads spend + GHL pipeline leads + GHL calendar bookings — all in one call.
// This was previously ONLY triggered by a manual "Sync Data" button on the marketing page.
async function syncMeta(force = false) {
  if (!shouldRun('meta', force)) return
  markRun('meta')
  try {
    const { syncMetaToTracker } = await import('./metaAdsSync')
    const result = await syncMetaToTracker(30)
    console.log('[auto-sync] Meta+GHL pipeline done:', result || '(no summary returned)')
    clearError('meta')
    clearCooldown('meta')
  } catch (e) {
    console.warn('[auto-sync] Meta+GHL pipeline failed:', e.message)
    markError('meta', e)
    if (isRateLimitErr(e)) markCooldown('meta')
  } finally { notify() }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Run all stale syncs. Safe to call repeatedly — each sync internally
 * checks its own interval and skips if not due. Pass { force: true } to
 * bypass the interval check (used by the "Sync now" button).
 *
 * Syncs run SEQUENTIALLY with a 500ms gap between each. Running them in
 * parallel (the previous behavior) fired 6 network-heavy tasks at the same
 * moment the user was trying to interact with the page, which was a major
 * contributor to GHL rate-limit storms and perceived page-load slowness.
 * Since each sync short-circuits when its interval hasn't elapsed, the
 * steady-state cost of sequential execution is essentially zero.
 */
export async function runAutoSync({ force = false } = {}) {
  const tasks = [syncStripe, syncFanbasis, syncGHL, syncEmails, syncMarketingTracker, syncMeta, syncMetaAdLevel, syncTypeform, syncGhlContacts, syncHyrosBackfill]
  for (const task of tasks) {
    try { await task(force) } catch (_e) { void _e }
    await sleep(500)
  }
}

let intervalHandle = null

/**
 * Start the background auto-sync loop. Call once from the Layout component.
 * Runs on mount then every 30 minutes thereafter (individual syncs only
 * actually execute if their interval has elapsed).
 */
export function startAutoSync() {
  if (intervalHandle) return
  // Run immediately on first page load
  runAutoSync()
  // Re-check every 15 minutes (individual syncs skip if not due)
  intervalHandle = setInterval(runAutoSync, 15 * 60 * 1000)
}

export function stopAutoSync() {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

/**
 * Get the last time a specific sync ran (as ms timestamp).
 * Returns null if never run.
 */
export function getLastSyncTime(key) {
  const t = lastRun(key)
  return t > 0 ? t : null
}

/**
 * Snapshot of every tracked sync: last-run timestamp, age, interval, next-due time.
 * Used by the UI "last synced" indicator.
 */
export function getAllSyncStatus() {
  const now = Date.now()
  return Object.keys(SYNC_INTERVALS).map(key => {
    const last = lastRun(key)
    const interval = SYNC_INTERVALS[key]
    return {
      key,
      label: SYNC_LABELS[key] || key,
      lastRun: last > 0 ? last : null,
      ageMs: last > 0 ? now - last : null,
      interval,
      nextDue: last > 0 ? last + interval : now,
      overdue: last === 0 || (now - last > interval),
      error: lastErrors[key] || null,
    }
  })
}
