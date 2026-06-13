/* Shared constants, helpers, and small presentational components for the
   creative-library surface (/sales/ads/creative/library). Split out of
   AdsCreativeLibrary.jsx mechanically — every symbol below moved verbatim
   from the page file; no logic changes. The page (and its siblings under
   src/pages/ads/library/) import everything from here so there is exactly
   one definition of each. */
import { supabase } from '../../../lib/supabase'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://kjfaqhmllagbxjdxlopm.supabase.co'

/* Insert a notification for an editor. Used everywhere a write happens
   that the editor needs to find out about: feedback saved on one of
   their submissions, task assigned/reassigned to them, source video
   replaced on a creative they're working on, submission approved.

   Fire-and-forget — never blocks the calling write path. If the
   notification fails to insert (RLS, network, etc.) we swallow it
   because the underlying action (the feedback save / approval / etc.)
   already succeeded and is the source of truth. The bell will catch up
   next time the editor refreshes.

   kind values (see migration 095):
     feedback         - admin left feedback on a submission
     reply            - editor replied to feedback (admin notification)
     assignment       - new task assigned
     reassignment     - existing task moved to this editor
     source_replaced  - source video for one of their tasks was replaced
     approved         - one of their submissions was approved

   The link_path is what the bell uses to deep-link the click. Format:
   '/editor-view?task=<task_id>' so the portal can pop the right task modal.

   We also fire the notify-editor-email Edge Function (best-effort) so
   the editor gets an email via Resend once that's configured. Skip
   silently if the function isn't deployed yet.
*/
export async function notifyEditor({ editor_id, kind, task_id, creative_id, submission_id, title, body, link_path }) {
  if (!editor_id) return
  try {
    const { data: inserted } = await supabase.from('lib_editor_notifications').insert({
      editor_id, kind, task_id, creative_id, submission_id, title, body, link_path,
    }).select('id').single()
    // Fire the email-dispatch edge function in the background. Best-effort.
    if (inserted?.id) {
      supabase.functions.invoke('notify-editor-email', {
        body: { notification_id: inserted.id },
      }).catch(() => { /* email is best-effort; in-app already saved */ })
    }
  } catch { /* in-app notification is best-effort */ }
}

// Display priority for a creative-library row. Reads the new display_name
// first (set by creative-library-describe post-migration 103), then falls
// back to the pre-overhaul canonical_name, then the upload filename. This
// is the SINGLE source of truth for what an operator or editor sees in
// any list, kanban card, modal title, timeline bar, or download filename.
//
// Pass the row whichever object shape you have; the helper handles both
// the lib_creative_library row shape and the lib_editing_queue task row
// shape (whose columns are prefixed with `creative_`).
export function rowDisplayName(r) {
  if (!r) return ''
  // INTENTIONAL: inline fallback chain, NOT a recursive call. An earlier
  // bulk replace_all of `r.canonical_name || r.name` -> `rowDisplayName(r)`
  // also rewrote this function body and produced infinite recursion. Keep
  // the chain literal here.
  return r.display_name || r.canonical_name || r.name || ''
}
export function taskDisplayName(t) {
  if (!t) return ''
  return t.creative_display_name || t.creative_canonical_name || t.creative_name || ''
}

export const TYPES = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']

// Task-status (lib_editing_tasks.status) is separate from creative-status.
// Friendly labels — no underscores in display — paired with colors used
// in pill buttons, timeline badges, and the queue's status filter.
export const TASK_STATUS_LABEL = {
  queued:          'Queued',
  in_progress:     'In progress',
  review:          'In review',
  needs_revision:  'Needs revision',
  done:            'Done',
  blocked:         'Blocked',
}
export const TASK_STATUS_COLOR = {
  queued:          'var(--ink-3)',
  in_progress:     '#e0853e',
  review:          '#3e7eba',
  // needs_revision = bright yellow/amber — visually distinct from
  // in_progress (orange) so admin can tell "editor is working" from
  // "editor needs to rework v_n based on my feedback" at a glance.
  needs_revision:  '#d09c08',
  done:            '#3e8a5e',
  blocked:         '#b53e3e',
}

// Known offer slugs surface as filter chips + pill colors. Source of truth
// is the `offers` table — we fetch the live list and merge with these
// colors. Anything unrecognised falls back to a neutral grey pill.
const OFFER_COLOR = {
  'opt-restoration':        { ink: '#1f4e8f', soft: 'rgba(31,78,143,0.10)',  border: 'rgba(31,78,143,0.35)' },
  'opt-roofing-stub':       { ink: '#a05810', soft: 'rgba(160,88,16,0.10)',  border: 'rgba(160,88,16,0.35)' },
  'opt-whitelabel-template':{ ink: '#7a3aa8', soft: 'rgba(122,58,168,0.10)', border: 'rgba(122,58,168,0.35)' },
}
export function offerColor(slug) {
  return OFFER_COLOR[slug] || { ink: 'var(--ink-3)', soft: 'var(--paper-2)', border: 'var(--rule)' }
}

// Distinct color per type — helps you scan a busy Matrix view and immediately
// see hooks vs bodies vs joined videos vs testimonials.
const TYPE_COLOR = {
  'Hook':       { ink: '#1f4e8f', soft: 'rgba(31,78,143,0.10)',  border: 'rgba(31,78,143,0.35)' },
  'Body':       { ink: '#a05810', soft: 'rgba(160,88,16,0.10)',  border: 'rgba(160,88,16,0.35)' },
  // Full Video = a whole script delivered as one raw clip (no edit needed)
  'Full Video': { ink: '#2e6e3f', soft: 'rgba(46,110,63,0.10)',  border: 'rgba(46,110,63,0.35)' },
  // Joined = a merged hook+body (post-edit composite)
  'Joined':     { ink: '#b86a0c', soft: 'rgba(184,106,12,0.10)', border: 'rgba(184,106,12,0.35)' },
  'Testimony':  { ink: '#7a3aa8', soft: 'rgba(122,58,168,0.10)', border: 'rgba(122,58,168,0.35)' },
  // Retargeting = a clip aimed at warm/lukewarm audiences (e.g. HAMMER recall content)
  'Retargeting':{ ink: '#c44b6e', soft: 'rgba(196,75,110,0.10)', border: 'rgba(196,75,110,0.35)' },
}
export function typeColor(t) {
  return TYPE_COLOR[t] || { ink: 'var(--ink-3)', soft: 'var(--paper-2)', border: 'var(--rule)' }
}

// Stable distinct color per editor (hash of slug → 10-color palette).
// Used everywhere the editor needs a visual identity (selector chips,
// queue cards, timeline bars, list-view dot).
export const EDITOR_COLORS = [
  '#3e7eba', '#e0853e', '#5fa55a', '#a05fa5', '#c44b6e',
  '#3eb2a8', '#b8893e', '#7e3eb8', '#5b8a3e', '#b83e3e',
]
export function editorColor(slugOrEditorOrTask) {
  // Accept any of:
  //   - a slug string ('ahmed') → hash fallback
  //   - an editor row { slug, color, ... } from lib_creative_editors
  //   - a task row { editor_slug, editor_color, ... } from lib_editing_queue
  // The override `color` (or `editor_color` from the view) always wins so
  // the operator's manual color choice from EditEditorModal is honoured
  // everywhere — chips, timeline bars, lane labels, queue cards, list dots.
  if (slugOrEditorOrTask && typeof slugOrEditorOrTask === 'object') {
    if (slugOrEditorOrTask.color) return slugOrEditorOrTask.color
    if (slugOrEditorOrTask.editor_color) return slugOrEditorOrTask.editor_color
    return editorColor(slugOrEditorOrTask.slug || slugOrEditorOrTask.editor_slug || '')
  }
  const slug = slugOrEditorOrTask
  if (!slug) return '#999'
  let h = 0
  for (let i = 0; i < slug.length; i++) h = ((h << 5) - h + slug.charCodeAt(i)) | 0
  return EDITOR_COLORS[Math.abs(h) % EDITOR_COLORS.length]
}

// Soft full-row background tint for library / queue rows so Ben can
// scan status at a glance:
//   green  = edited (creative is done)
//   yellow = raw + assigned to an editor (work in progress)
//   red    = raw + unassigned + still needs editing (i.e. not auto-used Hooks)
export function rowStatusTint(r, isUsed) {
  if (!r) return null
  if (r.status === 'edited') {
    return { base: 'rgba(62,138,94,0.06)', hover: 'rgba(62,138,94,0.14)' }
  }
  if (r.status === 'raw') {
    if (r.assigned_editor_id) {
      return { base: 'rgba(244,225,74,0.10)', hover: 'rgba(244,225,74,0.22)' }
    }
    // Skip the red tint for raw clips that are already in use (Hooks, etc.)
    if (!isUsed) {
      return { base: 'rgba(181,62,62,0.06)', hover: 'rgba(181,62,62,0.14)' }
    }
  }
  return null
}

// Same colour language for editing-queue task rows:
//   green  = done
//   yellow = in_progress or review
//   red    = blocked (or queued + overdue)
export function rowStatusTintForTask(t) {
  if (!t) return null
  if (t.status === 'done')                            return { base: 'rgba(62,138,94,0.06)' }
  if (t.status === 'in_progress' || t.status === 'review') return { base: 'rgba(244,225,74,0.10)' }
  if (t.status === 'blocked' || t.is_overdue)         return { base: 'rgba(181,62,62,0.08)' }
  return null
}

// Module-level cache — survives component unmount so tab switches
// (Library ↔ Editing Queue) don't show a blank "Loading…" state for
// 2+ seconds while the same data re-fetches. We hydrate the new tab
// instantly from this cache, then quietly refetch in the background to
// catch any updates. Stale-while-revalidate.
export const PAGE_CACHE = {
  rows: null,          // lib_creative_library (lean columns, no transcripts)
  rowsTime: 0,
  transcripts: null,   // Map of id → transcript text (loaded async)
  tasks: null,         // lib_editing_queue
  tasksTime: 0,
  editors: null,
  editorsTime: 0,
  offers: null,
  offersTime: 0,
  folders: null,       // lib_creative_folders (migration 146)
}

// Default scope = full admin permissions (when used inside the regular dashboard).
// EditorView passes a restricted scope for the public /editor-view/:token surface.
export const ADMIN_SCOPE = {
  isEditorView: false,
  editorId: null,
  editorName: null,
  canDelete: true,
  canUpload: true,
  canEditCreative: true,
  canAssignEditor: true,
  canEditTask: true,
  canAssignSelf: true,
  canDeleteTask: true,
  canManageEditors: true,
}

// badgeTone='alert' (default) = red — for "needs action" counts like
// untriaged uploads. badgeTone='ready' = yellow — for "ready to ship"
// counts where the number being big is a positive signal of inventory.
export function TabBtn({ active, onClick, children, badge, badgeTone = 'alert' }) {
  const inactiveBg = badgeTone === 'ready' ? '#f4e14a' : '#b53e3e'
  const inactiveColor = badgeTone === 'ready' ? 'var(--ink)' : 'white'
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px',
      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'transparent',
      color: active ? 'var(--paper)' : 'var(--ink-3)',
      border: 'none', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <span>{children}</span>
      {/* Badge for unread/untriaged/launch counts. Hidden at zero. When the
          parent tab is active, the badge flips to paper-on-ink for contrast
          against the dark active button. */}
      {badge != null && badge > 0 && (
        <span style={{
          minWidth: 18, height: 16, padding: '0 5px', borderRadius: 999,
          background: active ? 'var(--paper)' : inactiveBg,
          color: active ? 'var(--ink)' : inactiveColor,
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          letterSpacing: 0, lineHeight: 1,
        }}>{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  )
}

/* ─────────────────────────── Shared bits ─────────────────────────── */

export function KpiTile({ label, value, accent, onClick, active }) {
  // Tiles are click-to-filter when `onClick` is provided. `active` lights
  // the border in the accent color so it's visible at a glance which
  // status the queue is currently filtered to.
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      title={clickable ? (active ? `Showing only ${label} — click to clear` : `Filter to ${label}`) : undefined}
      style={{
        background: active ? 'var(--paper-2)' : 'var(--paper)',
        border: `1px solid ${active ? (accent || 'var(--ink)') : 'var(--rule)'}`,
        borderLeft: active ? `4px solid ${accent || 'var(--ink)'}` : '1px solid var(--rule)',
        padding: '14px 18px',
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 0.12s, border-color 0.12s',
      }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        {label}
      </div>
      {/* Numerals are serif per the OPT editorial design system — "Every
          number is serif + tabular-nums. Numbers in Inter sans are a bug." */}
      <div style={{
        fontFamily: 'var(--serif)', fontSize: 36, fontWeight: 400,
        letterSpacing: '-0.02em',
        color: accent || 'var(--ink)', marginTop: 4,
        lineHeight: 1, fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  )
}

export function Field({ label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 5, fontWeight: 600,
      }}>{label}</div>
      {children}
    </div>
  )
}

export function LoadingState() {
  return (
    <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
      Loading…
    </div>
  )
}

export function EmptyState() {
  return (
    <div style={{ padding: 60, textAlign: 'center', border: '1px dashed var(--rule)', background: 'var(--paper-2)' }}>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 6 }}>
        Nothing matches.
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Adjust filters or upload a new creative
      </div>
    </div>
  )
}

export function ErrorBanner({ msg, onRetry }) {
  return (
    <div style={{
      padding: '10px 14px', marginBottom: 14,
      background: 'rgba(181,62,62,0.08)', border: '1px solid #b53e3e', color: '#b53e3e',
      fontFamily: 'var(--mono)', fontSize: 12,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ flex: 1 }}>Error: {msg}</span>
      {onRetry && (
        <button onClick={onRetry}
          style={{
            padding: '4px 12px', fontFamily: 'var(--mono)', fontSize: 11,
            fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            background: '#b53e3e', color: 'white',
            border: 'none', borderRadius: 2, cursor: 'pointer',
          }}>Retry</button>
      )}
    </div>
  )
}

/* Shared button / input style tokens. Moved here from the page file in
   step 2 of the split because UploadModal (library/upload.jsx) uses
   primaryBtn / ghostBtn / selectStyle; the page imports them back. */
export const primaryBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
}
export const ghostBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule)', cursor: 'pointer',
}
export const inputStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--mono)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
}
export const selectStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--sans)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
  cursor: 'pointer',
}
