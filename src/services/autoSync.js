// Global auto-sync service
// Runs data syncs in the background so nothing requires a manual button click.
// Triggered from Layout on mount + every 30 minutes via setInterval.
// Each sync has its own interval — only re-runs if enough time has passed.

import { syncGHLAppointments } from './ghlCalendar'
import { syncEmailMessages, refreshRecentEmailStatuses, fetchWorkflows } from './ghlEmailFlows'
import { toLocalDateStr } from '../lib/dateUtils'

const SYNC_INTERVALS = {
  stripe: 6 * 60 * 60 * 1000,      // 6 hours
  ghlAppointments: 2 * 60 * 60 * 1000, // 2 hours
  emailFlows: 4 * 60 * 60 * 1000,  // 4 hours
  marketingTracker: 6 * 60 * 60 * 1000, // 6 hours
}

function lastRun(key) {
  try { return parseInt(localStorage.getItem(`autosync_${key}`) || '0') } catch { return 0 }
}

function markRun(key) {
  try { localStorage.setItem(`autosync_${key}`, String(Date.now())) } catch {}
}

function shouldRun(key) {
  return Date.now() - lastRun(key) > SYNC_INTERVALS[key]
}

async function syncStripe() {
  if (!shouldRun('stripe')) return
  markRun('stripe')
  try {
    const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=14&limit=100&resync=false', {
      headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
    })
    const data = await r.json()
    console.log('[auto-sync] Stripe:', data.synced || 0, 'new,', data.matched || 0, 'matched')
  } catch (e) {
    console.warn('[auto-sync] Stripe failed:', e.message)
  }
}

async function syncGHL() {
  if (!shouldRun('ghlAppointments')) return
  markRun('ghlAppointments')
  try {
    const today = toLocalDateStr(new Date())
    const past = new Date()
    past.setDate(past.getDate() - 30)
    await syncGHLAppointments(toLocalDateStr(past), today)
    console.log('[auto-sync] GHL appointments done')
  } catch (e) {
    console.warn('[auto-sync] GHL appointments failed:', e.message)
  }
}

async function syncEmails() {
  if (!shouldRun('emailFlows')) return
  markRun('emailFlows')
  try {
    await fetchWorkflows()
    const result = await syncEmailMessages(30)
    await refreshRecentEmailStatuses(7)
    console.log('[auto-sync] Email flows:', result.synced || 0, 'new emails')
  } catch (e) {
    console.warn('[auto-sync] Email flows failed:', e.message)
  }
}

async function syncMarketingTracker() {
  if (!shouldRun('marketingTracker')) return
  markRun('marketingTracker')
  try {
    const { syncEODToTracker } = await import('../hooks/useMarketingTracker')
    await syncEODToTracker()
    console.log('[auto-sync] Marketing tracker done')
  } catch (e) {
    console.warn('[auto-sync] Marketing tracker failed:', e.message)
  }
}

/**
 * Run all stale syncs. Safe to call repeatedly — each sync internally
 * checks its own interval and skips if not due.
 */
export async function runAutoSync() {
  // Run in parallel but don't block — fire and forget
  syncStripe()
  syncGHL()
  syncEmails()
  syncMarketingTracker()
}

let intervalHandle = null

/**
 * Start the background auto-sync loop. Call once from the Layout component.
 * Runs on mount then every 30 minutes thereafter (individual syncs only
 * actually execute if their interval has elapsed).
 */
export function startAutoSync() {
  if (intervalHandle) return
  runAutoSync()
  intervalHandle = setInterval(runAutoSync, 30 * 60 * 1000)
}

export function stopAutoSync() {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
