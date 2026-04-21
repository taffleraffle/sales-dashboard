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
}

const SYNC_LABELS = {
  stripe: 'Stripe payments',
  fanbasis: 'Fanbasis payments',
  ghlAppointments: 'GHL appointments',
  emailFlows: 'Email flows',
  marketingTracker: 'Marketing (EOD)',
  meta: 'Marketing (Meta + GHL)',
}

function lastRun(key) {
  try { return parseInt(localStorage.getItem(`autosync_${key}`) || '0') } catch { return 0 }
}

function markRun(key) {
  try { localStorage.setItem(`autosync_${key}`, String(Date.now())) } catch {}
}

function shouldRun(key, force = false) {
  if (force) return true
  return Date.now() - lastRun(key) > SYNC_INTERVALS[key]
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
    const today = toLocalDateStr(new Date())
    const past = new Date()
    past.setDate(past.getDate() - 30)
    await syncGHLAppointments(toLocalDateStr(past), today)
    console.log('[auto-sync] GHL appointments done')
    clearError('ghlAppointments')
  } catch (e) {
    console.warn('[auto-sync] GHL appointments failed:', e.message)
    markError('ghlAppointments', e)
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
  } catch (e) {
    console.warn('[auto-sync] Email flows failed:', e.message)
    markError('emailFlows', e)
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
  } catch (e) {
    console.warn('[auto-sync] Meta+GHL pipeline failed:', e.message)
    markError('meta', e)
  } finally { notify() }
}

/**
 * Run all stale syncs. Safe to call repeatedly — each sync internally
 * checks its own interval and skips if not due. Pass { force: true } to
 * bypass the interval check (used by the "Sync now" button).
 */
export async function runAutoSync({ force = false } = {}) {
  // Run in parallel but don't block — fire and forget
  syncStripe(force)
  syncFanbasis(force)
  syncGHL(force)
  syncEmails(force)
  syncMarketingTracker(force)
  syncMeta(force)
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
