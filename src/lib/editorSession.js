// editorSession — client-side persistence helper for editor sessions.
//
// Supabase already keeps sessions alive indefinitely (jwt rotates,
// refresh tokens never expire, no inactivity timeout). What this layer
// adds:
//   1. Default "stay signed in for 14 days" — auto-signOut after 14
//      days from first login so a forgotten session on a shared device
//      doesn't stay alive forever.
//   2. Opt-in "stay signed in indefinitely" — bypasses the 14-day
//      timeout. Editor only re-logs in if they explicitly sign out OR
//      the browser clears storage on its own (Safari ITP after 7 days
//      idle, private mode, etc.).
//   3. Request browser-persistent storage on first login so iOS Safari
//      can't garbage-collect the session under storage pressure.
//
// All state lives in localStorage; sessionStorage is too aggressive for
// the "14 days" behavior since browser-close would wipe it.

import { supabase } from './supabase'

const KEY_PREFERENCE   = 'editor_session.preference'    // '14d' | 'forever'
const KEY_SIGNED_IN_AT = 'editor_session.signed_in_at'  // ms epoch
const KEY_CHOICE_MADE  = 'editor_session.choice_made'   // '1' once editor has explicitly picked
const KEY_LAST_USER_ID = 'editor_session.last_user_id'  // supabase auth user id of the owner of these keys
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

// Cross-account guard. Two editors sharing a browser (or Ben testing
// followed by an editor logging in on the same machine) would
// otherwise inherit the previous user's preference / signed-in-at /
// choice-made state. Call this on every authenticated session detect
// — if the supabase user.id has changed since these keys were last
// written, wipe everything and start fresh.
export function syncSessionOwner(authUserId) {
  if (!authUserId) return
  try {
    const last = localStorage.getItem(KEY_LAST_USER_ID)
    if (last && last !== authUserId) {
      // Different user owns these keys — wipe before re-claiming.
      localStorage.removeItem(KEY_PREFERENCE)
      localStorage.removeItem(KEY_SIGNED_IN_AT)
      localStorage.removeItem(KEY_CHOICE_MADE)
    }
    localStorage.setItem(KEY_LAST_USER_ID, authUserId)
  } catch {}
}

// True once the editor has been shown the prompt + clicked a choice.
// Until then we don't enforce ANY lifetime — silently auto-logging an
// editor out 14 days after they got a magic link they never had a
// chance to opt out of is exactly the bug Ben flagged.
export function hasChosenLifetime() {
  try { return localStorage.getItem(KEY_CHOICE_MADE) === '1' } catch { return false }
}

export function markChoiceMade() {
  try { localStorage.setItem(KEY_CHOICE_MADE, '1') } catch {}
}

export function getPreference() {
  try {
    const v = localStorage.getItem(KEY_PREFERENCE)
    return v === 'forever' ? 'forever' : '14d'
  } catch {
    return '14d'
  }
}

export function setPreference(pref) {
  try {
    localStorage.setItem(KEY_PREFERENCE, pref === 'forever' ? 'forever' : '14d')
  } catch {}
}

// Stamp the start of an editor's session. Called once on first login
// detected by AuthContext. Idempotent — leaves an existing stamp alone
// so users who already logged in 5 days ago don't get the clock reset
// every page load.
export function ensureSignedInAt() {
  try {
    if (!localStorage.getItem(KEY_SIGNED_IN_AT)) {
      localStorage.setItem(KEY_SIGNED_IN_AT, String(Date.now()))
    }
  } catch {}
}

export function clearSessionState() {
  try {
    localStorage.removeItem(KEY_PREFERENCE)
    localStorage.removeItem(KEY_SIGNED_IN_AT)
    localStorage.removeItem(KEY_CHOICE_MADE)
    localStorage.removeItem(KEY_LAST_USER_ID)
  } catch {}
}

// Returns true if the user-selected lifetime has elapsed since their
// session started, false otherwise. 'forever' preference never expires.
// Also returns false if the editor hasn't made a choice yet — that
// case is handled by the on-mount prompt, not silent enforcement.
export function isLifetimeExpired() {
  try {
    if (!hasChosenLifetime()) return false
    const pref = getPreference()
    if (pref === 'forever') return false
    const at = parseInt(localStorage.getItem(KEY_SIGNED_IN_AT) || '0', 10)
    if (!at) return false  // never stamped — treat as fresh
    return Date.now() > at + FOURTEEN_DAYS_MS
  } catch {
    return false
  }
}

// Returns the absolute ms-epoch when the 14-day window expires, or
// `null` if preference is 'forever' / no stamp yet. Used by the
// EditorView header to render "expires Tue Jun 10" etc.
export function expiresAt() {
  try {
    if (getPreference() === 'forever') return null
    const at = parseInt(localStorage.getItem(KEY_SIGNED_IN_AT) || '0', 10)
    if (!at) return null
    return at + FOURTEEN_DAYS_MS
  } catch {
    return null
  }
}

// Ask the browser to keep our localStorage around even under storage
// pressure. Best-effort — Chrome/Firefox honour it; Safari ignores
// (their model is per-session for cross-site tracking prevention).
// Doesn't hurt to call. Permission requires a user gesture in some
// browsers, so we fire it when the user explicitly chose "remember me".
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const granted = await navigator.storage.persist()
      return granted
    }
  } catch {}
  return false
}

// Sign out + clear all our session state. Called by the EditorView
// header sign-out button OR automatically when the 14-day window
// expires (via the lifetime guard in AuthContext).
export async function signOutEditor() {
  clearSessionState()
  try { await supabase.auth.signOut() } catch {}
}
