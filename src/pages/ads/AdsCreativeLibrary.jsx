import { useEffect, useMemo, useState, useCallback, useRef, memo, useDeferredValue, startTransition, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { SectionHead, Icon, PALETTE } from '../../components/editorial/atoms'
import Modal from '../../components/editorial/Modal'
import OfferConfigModal from '../../components/ads/OfferConfigModal'
import { FolderBar, FolderPickerModal, subtreeIds } from '../../components/ads/CreativeFolders'
import {
  SUPABASE_URL, notifyEditor, rowDisplayName, taskDisplayName,
  TYPES, TASK_STATUS_LABEL, TASK_STATUS_COLOR, offerColor, typeColor,
  EDITOR_COLORS, editorColor, rowStatusTint, rowStatusTintForTask,
  PAGE_CACHE, ADMIN_SCOPE, TabBtn, KpiTile, Field, LoadingState,
  EmptyState, ErrorBanner, primaryBtn, ghostBtn, inputStyle, selectStyle,
  chipLabelStyle,
} from './library/shared'
import {
  uploadQueue, useUploadQueue, uploadWithResume,
  captureVideoThumbnail, captureVideoThumbnailFromUrl,
  TopUploadProgressBar, RenameUnnamedButton, UploadModal,
  probeMediaDimensions,
} from './library/upload'
import {
  OptVideoPlayer, fmtTime, OPT_PLAYER_WRAP_360, OPT_PLAYER_WRAP_320,
} from '../../components/ads/OptVideoPlayer'
import {
  ManageEditorsModal, ShareLinksModal, EditEditorModal, AddEditorModal,
  AddTaskModal, DateEditPopover,
} from './library/editors'


/* Force a true binary download instead of an in-tab video stream.
   Supabase public-object URLs serve files with NO Content-Disposition
   header by default. When the browser sees that, it IGNORES the `<a
   download>` attribute on cross-origin links and just navigates to the
   URL — meaning the video opens in a tab and plays, instead of saving
   to disk. Operators then resort to right-clicking the playing video
   or screen-recording it, both of which murder the quality.

   Supabase storage accepts a `?download=<filename>` query param that
   makes the response include `Content-Disposition: attachment;
   filename=<filename>`. With that header present the browser saves
   the raw bytes to disk — the original full-quality file. Use this
   wrapper on every download link so the operator gets the actual
   uploaded bytes, never a screen-recorded re-encode. */
function toDownloadUrl(url, filename) {
  if (!url) return url
  // Only rewrite Supabase storage URLs — leave Drive / external links
  // alone (Drive has its own download UX).
  if (!url.includes('/storage/v1/object/public/')) return url
  const fname = (filename || 'creative.mp4').replace(/[^A-Za-z0-9._-]+/g, '_')
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}download=${encodeURIComponent(fname)}`
}

// Copy text to the clipboard with a legacy fallback (the async Clipboard API
// throws when the document isn't focused / context isn't secure / webview
// lacks it). Returns true on success.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'; ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

/* Copy a direct, shareable URL to a video to the clipboard — the link an
   editor pastes into their invoice or sends to review. Copies the plain
   public URL (plays in the browser when opened); falls back to a selectable
   prompt if the clipboard is blocked. */
function CopyLinkButton({ url, label = 'Copy link', title, style }) {
  const [copied, setCopied] = useState(false)
  if (!url) return null
  const onClick = async (e) => {
    e.preventDefault(); e.stopPropagation()
    const ok = await copyToClipboard(url)
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) }
    else { try { window.prompt('Copy this link:', url) } catch { /* no-op */ } }
  }
  return (
    <button type="button" onClick={onClick}
      title={title || 'Copy a shareable link to this video'}
      style={{
        padding: '4px 10px',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: copied ? 'var(--up)' : 'transparent',
        color: copied ? 'white' : 'var(--ink-2)',
        border: '1px solid ' + (copied ? 'var(--up)' : 'var(--rule)'),
        borderRadius: 9, cursor: 'pointer', textDecoration: 'none',
        whiteSpace: 'nowrap',
        ...(style || {}),
      }}>{copied ? '✓ Copied' : `🔗 ${label}`}</button>
  )
}

/*
  /sales/ads/creative/library — two-tab surface for the creative library:

    1. Library — every video clip (raw + edited), with thumbnails, filters,
       click-to-preview, drop-to-upload.
    2. Editing Queue — what each editor is working on, what's overdue,
       what's next in the pipeline.

  Data sources:
    - lib_creative_library  (114 backfilled rows from the May 2026 batch)
    - lib_creative_editors  (Ahmed, Mohamed, Dean, Unassigned)
    - lib_editing_tasks     (assignments + status)
    - lib_editing_queue (view)
*/

const STATUSES = ['raw', 'edited']
const STATUS_LABEL = {
  raw: 'Raw',
  review: 'Review',
  edited: 'Edited',
}
const STATUS_COLOR = {
  raw: 'var(--down)',      // red — needs attention / not yet edited
  review: '#d09c08',       // amber — an edit was submitted, awaiting review
  edited: 'var(--up)',   // green — done
}



// Per-stage indicator values for the Matrix view
const STAGE_VALUES = [
  { v: null,           label: '—',          color: '#ccc',   bg: 'transparent' },
  { v: 'done',         label: 'X',          color: 'white',  bg: 'var(--up)' },
  { v: 'in_progress',  label: 'In progress', color: '#7a4e08', bg: 'rgba(232,180,8,0.25)' },
  { v: 'blocked',      label: 'Blocked',    color: 'white',  bg: 'var(--down)' },
  { v: 'skip',         label: 'Skip',       color: 'var(--ink-3)', bg: 'rgba(0,0,0,0.05)' },
]
function stageStyle(value) {
  const v = STAGE_VALUES.find(s => s.v === value) || STAGE_VALUES[0]
  return v
}

/* Floating dock — bottom-right of the viewport whenever there's at
   least one upload in the queue. Compact pill by default; click to
   expand into a list. Auto-fires onRefresh when the queue empties so
   the parent library list picks up the new rows. */
function UploadDock({ onRefresh }) {
  const items = useUploadQueue()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const onIdle = () => onRefresh?.()
    window.addEventListener('upload-queue-idle', onIdle)
    return () => window.removeEventListener('upload-queue-idle', onIdle)
  }, [onRefresh])
  if (items.length === 0) return null

  const inFlight = items.filter((i) => i.status !== 'done' && i.status !== 'error' && i.status !== 'too-large')
  const failed   = items.filter((i) => i.status === 'error')
  const done     = items.filter((i) => i.status === 'done')
  const tooBig   = items.filter((i) => i.status === 'too-large')
  // Rename trouble = upload itself succeeded BUT the post-upload pipeline
  // (transcribe / identify-actor / describe) hit an error, so the row
  // probably landed without a canonical_name. Distinct from `failed` so
  // the operator can tell apart "didn't upload" vs "uploaded but blurry-
  // skipped naming". Surfaces as an amber warning instead of red.
  const renameTrouble = done.filter((i) => i.error)
  const totalProg = items.reduce((s, i) => s + (i.progress || 0), 0) / items.length

  // Compact summary pill
  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} title="Upload progress"
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 95,
          padding: '10px 14px', minWidth: 220,
          background: 'var(--paper)', border: '1px solid var(--rule)',
          borderLeft: failed.length > 0
            ? '3px solid var(--down)'
            : renameTrouble.length > 0
              ? '3px solid #d09c08'
              : '3px solid var(--accent, #e8b408)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.12)',
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink)',
          cursor: 'pointer', textAlign: 'left',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontWeight: 600 }}>
            {inFlight.length > 0
              ? `Uploading ${inFlight.length}/${items.length}`
              : failed.length > 0
                ? `${done.length} done · ${failed.length} failed`
                : renameTrouble.length > 0
                  ? `${done.length} uploaded · ${renameTrouble.length} need rename retry`
                  : `${done.length} uploaded`}
          </span>
          <span style={{ color: 'var(--ink-3)' }}>▴</span>
        </div>
        {/* Aggregate bar */}
        <div style={{ height: 3, background: 'var(--paper-2)', position: 'relative' }}>
          <div style={{
            position: 'absolute', inset: 0, right: 'auto',
            width: `${Math.round(totalProg * 100)}%`,
            background: failed.length > 0 ? 'var(--down)' : 'var(--ink)',
            transition: 'width 0.2s',
          }} />
        </div>
      </button>
    )
  }

  // Expanded list
  return createPortal(
    <>
      <div onClick={() => setExpanded(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(10,10,10,0.20)' }} />
      <div style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 201,
        width: 'min(440px, 92vw)', maxHeight: '70vh',
        background: 'var(--paper)', border: '1px solid var(--rule)',
        borderLeft: '3px solid var(--accent, #e8b408)',
        boxShadow: '0 12px 32px rgba(10,10,10,0.16)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--rule)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--paper-2)',
        }}>
          <div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
            }}>Upload queue</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 15, marginTop: 2 }}>
              {inFlight.length > 0
                ? `${inFlight.length} in flight · ${done.length} done${failed.length > 0 ? ` · ${failed.length} failed` : ''}`
                : `${done.length} uploaded${failed.length > 0 ? ` · ${failed.length} failed` : ''}`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {inFlight.length > 0 && (
              <button
                onClick={() => {
                  if (confirm(`Cancel ${inFlight.length} upload${inFlight.length === 1 ? '' : 's'} in flight? Partially-uploaded chunks will be discarded.`)) {
                    uploadQueue.cancelAll()
                  }
                }}
                style={{
                  background: 'transparent', border: '1px solid var(--down)', padding: '4px 8px',
                  fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', color: 'var(--down)',
                  textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600,
                }}
                title="Abort every upload in flight and clear the queue"
              >Cancel all</button>
            )}
            {(done.length + failed.length + tooBig.length) > 0 && inFlight.length === 0 && (
              <button onClick={() => uploadQueue.clearCompleted()} style={{
                background: 'transparent', border: '1px solid var(--rule)', padding: '4px 8px',
                fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', color: 'var(--ink-3)',
              }}>Clear done</button>
            )}
            <button onClick={() => setExpanded(false)} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 22, lineHeight: 1, padding: 4, color: 'var(--ink-3)',
            }}>×</button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {items.map((it) => {
            const isErr = it.status === 'error'
            const isDone = it.status === 'done'
            const color = isErr ? 'var(--down)' : isDone ? 'var(--up)' : 'var(--ink-3)'
            return (
              <div key={it.id} style={{
                padding: '10px 14px', borderBottom: '1px solid var(--rule)',
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={it.file.name}>{it.file.name}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color, marginTop: 2 }}>
                    {it.message}
                  </div>
                  {it.duplicateWarning && (
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, color: '#b8893e',
                      marginTop: 3, display: 'flex', alignItems: 'flex-start', gap: 4,
                    }} title={it.duplicateWarning}>
                      <span>⚠</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.duplicateWarning}</span>
                    </div>
                  )}
                  {it.status === 'uploading' && (
                    <div style={{ height: 2, background: 'var(--paper-2)', marginTop: 4, position: 'relative' }}>
                      <div style={{
                        position: 'absolute', inset: 0, right: 'auto',
                        width: `${Math.round((it.progress || 0) * 100)}%`,
                        background: 'var(--ink)',
                        transition: 'width 0.2s',
                      }} />
                    </div>
                  )}
                </div>
                {(isDone || isErr || it.status === 'too-large')
                  ? (
                    <button onClick={() => uploadQueue.dismiss(it.id)} title="Dismiss" style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--ink-4)', fontSize: 16, padding: 0,
                    }}>×</button>
                  ) : (
                    <button
                      onClick={() => {
                        // No confirm for a single item — the file is still
                        // here on disk and re-uploadable. Cancel-all gets a
                        // confirm because losing a whole batch hurts more.
                        uploadQueue.cancel(it.id)
                      }}
                      title={`Cancel upload of ${it.file.name}`}
                      style={{
                        background: 'transparent', border: '1px solid var(--rule)',
                        cursor: 'pointer', color: 'var(--down)', padding: '2px 6px',
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                      }}
                    >Cancel</button>
                  )}
              </div>
            )
          })}
        </div>
      </div>
    </>,
    document.body,
  )
}

// Status chip for the external-submission ingest pipeline. Editors who
// submit a Frame.io / Drive / Dropbox / direct URL kick off a DB trigger
// that hits the ingest-external-submission Edge Function; until that
// function finishes we render a "pulling…" pill, and if it fails we
// render a red chip with a Retry button. On success ingest_status flips
// to null (or 'success', briefly) and this component renders nothing —
// the submission becomes playable in-place via SubmissionPreviewModal
// just like a TUS-uploaded one.
function IngestStatusChip({ submission, onRetry, busy }) {
  const status = submission?.ingest_status
  if (status !== 'pending' && status !== 'failed') return null
  if (status === 'pending') {
    return (
      <span title="Pulling video from external host…"
        style={{
          padding: '2px 8px',
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          background: 'rgba(232,180,8,0.18)', color: '#7a5800',
          border: '1px solid rgba(232,180,8,0.45)', borderRadius: 9,
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: '#e8b408',
          animation: 'ingestPulse 1.4s ease-in-out infinite',
        }} />
        Pulling
        <style>{`@keyframes ingestPulse { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }`}</style>
      </span>
    )
  }
  // failed
  return (
    <span title={submission.ingest_error_text || 'Ingestion failed'}
      style={{
        padding: '2px 4px 2px 8px',
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        background: 'rgba(181,62,62,0.12)', color: '#8a2a2a',
        border: '1px solid rgba(181,62,62,0.4)', borderRadius: 9,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
      Ingest failed
      {onRetry && (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); if (!busy) onRetry(submission) }}
          disabled={busy}
          style={{
            padding: '1px 6px',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'var(--down)', color: 'var(--paper)',
            border: 'none', borderRadius: 9,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}>Retry</button>
      )}
    </span>
  )
}

// Resolve the current auth user → a comment-author identity. Used by
// the SubmissionPreviewModal comment composer so admin comments are
// attributed correctly (and so the editor's bell notification shows
// who left the feedback). Falls back to { kind: 'admin', name: 'Admin' }
// if the auth session can't be resolved — same convention the existing
// approveSubmission flow uses (approved_by_name: 'admin').
function useAdminIdentity() {
  const [identity, setIdentity] = useState({ kind: 'admin', id: null, name: 'Admin' })
  useEffect(() => {
    let mounted = true
    supabase.auth.getUser().then(({ data }) => {
      const user = data?.user
      if (!mounted || !user) return
      // Best-effort name: prefer the team_members row's display_name,
      // then user metadata, then the email local-part. We don't block
      // on this — the modal opens with 'Admin' and patches in once
      // the lookup resolves.
      const fallback = (user.email || '').split('@')[0] || 'Admin'
      setIdentity({ kind: 'admin', id: user.id, name: fallback })
      supabase.from('team_members')
        .select('name')
        .eq('auth_user_id', user.id)
        .maybeSingle()
        .then(({ data: tm }) => {
          if (mounted && tm?.name) {
            setIdentity({ kind: 'admin', id: user.id, name: tm.name })
          }
        })
    })
    return () => { mounted = false }
  }, [])
  return identity
}

// Fire the retry_external_ingest RPC. Idempotent: bumps ingest_attempt_count,
// resets ingest_status to 'pending', re-fires the edge function via pg_net.
// Returns { ok, error } so the caller can flash a toast on failure.
async function retryIngest(submissionId) {
  try {
    const { data, error } = await supabase.rpc('retry_external_ingest', {
      p_submission_id: submissionId,
    })
    if (error) return { ok: false, error: error.message }
    return { ok: !!data, error: null }
  } catch (e) {
    return { ok: false, error: e?.message || 'retry failed' }
  }
}

// Strip mangled control / replacement chars that occasionally land in
// notification bodies (the U+FFFD diamond from a cp1252-on-utf8 round-trip,
// or a stray bullet that got transliterated). Also rewrite the cosmetic
// trigger fallback "from unknown creator" into something less embarrassing
// — at INSERT time the creator/description are NULL because the
// identify-actor + describe Edge Functions haven't run yet. The body field
// is a snapshot from that moment; we shouldn't pretend to know more than
// we do, but we shouldn't shout "UNKNOWN" at the user either.
function sanitizeNotifText(s) {
  if (!s) return s
  return String(s)
    .replace(/�/g, '')
    .replace(/\s+from unknown creator\b\.?/i, ' — creator pending')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Small text under the modal title summarising what's in the list.
// Examples:
//   1 unread · 3 total
//   3 new uploads need an editor
//   2 unread · 5 total
// The summary is more useful than a flat "3 this month" because it
// answers what the operator actually wants to know on open: how much
// is waiting on me?
function notificationsSubtitle(notifications, unseenCount, _seenAt) {
  if (!notifications.length) return null
  const total = notifications.length
  const parts = []
  if (unseenCount > 0) parts.push(`${unseenCount} unread`)
  parts.push(`${total} total`)
  return parts.join(' · ')
}

// Cluster notifications by kind so the modal reads as
//   NEEDS EDITOR (2)        Feedback (1)         Approved (1)
// instead of a flat list where the operator has to mentally sort which
// rows are actionable. Preserves created_at order within each group.
// Order of groups themselves matches kind urgency (action items first).
function groupNotifications(notifications) {
  const KIND_ORDER = [
    'new_upload_needs_assignment',
    'ingest_failed',
    'revision_requested',
    'submission_comment',
    'feedback',
    'assignment',
    'reassignment',
    'source_replaced',
    'approved',
    'reply',
  ]
  const KIND_META = {
    new_upload_needs_assignment: { label: 'Needs editor',   color: 'var(--down)' },
    ingest_failed:               { label: 'Ingest failed',  color: 'var(--down)' },
    revision_requested:          { label: 'Revision asked', color: '#d09c08' },
    submission_comment:          { label: 'New comment',    color: '#3e7eba' },
    feedback:                    { label: 'Feedback',       color: '#e8b408' },
    assignment:                  { label: 'New tasks',      color: '#3e7eba' },
    reassignment:                { label: 'Reassigned',     color: '#3e7eba' },
    source_replaced:             { label: 'Source updated', color: '#a05810' },
    approved:                    { label: 'Approved',       color: 'var(--up)' },
    reply:                       { label: 'Replies',        color: '#3e7eba' },
  }
  const buckets = new Map()
  for (const n of notifications) {
    const k = n.kind || '__other'
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(n)
  }
  const out = []
  for (const k of KIND_ORDER) {
    if (!buckets.has(k)) continue
    const meta = KIND_META[k] || { label: 'Update', color: 'var(--ink-3)' }
    out.push({ kind: k, label: meta.label, color: meta.color, items: buckets.get(k) })
    buckets.delete(k)
  }
  // Any unknown kinds — surface at the bottom under a generic header rather
  // than dropping them silently.
  for (const [k, items] of buckets) {
    out.push({ kind: k, label: 'Other', color: 'var(--ink-3)', items })
  }
  return out
}

/* Editor-side notification bell. Distinct from the admin
   NotificationBell which reads from lib_task_submissions. This one
   reads from lib_editor_notifications (migration 095) — the editor
   sees their personal feed: "Ben left feedback on v1", "New task
   assigned", "Source video replaced", etc.

   Auto-mark-read on bell open. Click a notification card to open the
   corresponding task modal in the parent. Persists last-open timestamp
   in localStorage so unread-count survives reloads even if the editor
   hasn't actually clicked into anything yet. */
const EditorNotificationBell = forwardRef(function EditorNotificationBell(
  { editorId, onOpenTask, onOpenCreative, companionLabel, onCompanion },
  ref,
) {
  const [notifications, setNotifications] = useState([])
  const [open, setOpen] = useState(false)
  const [seenAt, setSeenAt] = useState(() => {
    try { return localStorage.getItem(`editor.notifSeenAt.${editorId}`) || '' } catch { return '' }
  })
  // Pull notifications for this editor. Limit to last 30 days + 50 rows
  // so the bell doesn't grow unbounded. Reload every 60s while the
  // portal is open so newly-dispatched notifications appear without
  // a page refresh.
  useEffect(() => {
    if (!editorId) return
    let mounted = true
    const load = () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      supabase.from('lib_editor_notifications')
        .select('*')
        .eq('editor_id', editorId)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(50)
        .then(({ data }) => { if (mounted) setNotifications(data || []) })
    }
    load()
    const interval = setInterval(load, 60000)
    return () => { mounted = false; clearInterval(interval) }
  }, [editorId])

  // Thumbnails per notification — so you can tell at a glance WHICH clip each
  // notification is about (Ben 2026-06-27: "easier way to know what is what
  // w/ some thumbnails"). Fetch the creative thumbnails for the notifications'
  // creative_ids in one query and map by id.
  const [notifThumbs, setNotifThumbs] = useState({})
  // Key the fetch on the actual SET of creative ids, not the array reference —
  // the 60s reload replaces `notifications` every tick, which would otherwise
  // re-run this effect needlessly.
  const notifCreativeIds = useMemo(
    () => [...new Set(notifications.map(n => n.creative_id).filter(Boolean))].sort().join(','),
    [notifications],
  )
  useEffect(() => {
    const ids = notifCreativeIds ? notifCreativeIds.split(',') : []
    if (!ids.length) { setNotifThumbs({}); return }
    let on = true
    supabase.from('lib_creative_library')
      .select('id, thumbnail_url').in('id', ids)
      .then(({ data }) => {
        if (!on) return
        const m = {}
        for (const r of (data || [])) if (r.thumbnail_url) m[r.id] = r.thumbnail_url
        setNotifThumbs(m)
      })
    return () => { on = false }
  }, [notifCreativeIds])

  const unseenCount = notifications.filter(n => !seenAt || n.created_at > seenAt).length
  // Pending = unread (read_at is null) AND created since last bell open.
  // We mark them read via the bell-open path; reading happens implicitly
  // when the editor clicks a notification card or opens the related task.
  const markSeen = () => {
    const ts = new Date().toISOString()
    try { localStorage.setItem(`editor.notifSeenAt.${editorId}`, ts) } catch {}
    setSeenAt(ts)
  }
  const handleOpen = () => {
    setOpen(true)
    setTimeout(markSeen, 300)
  }
  // Expose imperative open() so a companion bell (Activity ↔ Inbox) can
  // pop us open without lifting all of this internal state to the parent.
  useImperativeHandle(ref, () => ({ open: handleOpen }), [])
  const handleNotificationClick = async (n) => {
    // Mark this specific notification read in the DB so future bell
    // opens don't show it as unseen.
    if (!n.read_at) {
      await supabase.from('lib_editor_notifications')
        .update({ read_at: new Date().toISOString() }).eq('id', n.id)
      setNotifications(curr => curr.map(x => x.id === n.id
        ? { ...x, read_at: new Date().toISOString() } : x))
    }
    setOpen(false)
    // Prefer opening the creative drawer in-place over any kind of full
    // navigation. new_upload_needs_assignment notifications carry the
    // creative_id but no task_id (a task hasn't been created yet — that's
    // the whole point of "needs editor"). Previously the fallback path
    // did `window.location.href = link_path` which reloaded the entire
    // dashboard just to land back on the same route. Now: if the parent
    // gave us onOpenCreative + the notification has a creative_id, open
    // the drawer instead. Single-frame, no nav, modal pops on top.
    if (n.creative_id && onOpenCreative) {
      onOpenCreative(n.creative_id)
      return
    }
    // Task-bound notifications open the task modal in the portal.
    if (n.task_id) { onOpenTask?.(n.task_id); return }
    // Last resort: deep-link via link_path. Same-route navigation will
    // still reload, so this is a fallback for notifications that have
    // neither a creative_id nor a task_id (rare; e.g. system messages).
    if (n.link_path) {
      try { window.location.href = n.link_path } catch {}
    }
  }
  const relTime = (iso) => {
    const t = new Date(iso).getTime()
    const diff = Date.now() - t
    const mins = Math.round(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.round(hrs / 24)
    return `${days}d ago`
  }
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!editorId) return null
  return (
    <>
      {/* Inline trigger — caller wraps multiple bells in a single fixed
          tray so they don't stack on top of each other or the dashboard
          avatar. Pre-2026-05-31 this was position:fixed top:12 right:16
          AND the same on NotificationBell — two bells overlapped each
          other AND the dashboard chrome. */}
      <button onClick={handleOpen} title="Notifications"
        style={{
          position: 'relative',
          height: 38, padding: '0 14px', borderRadius: 9,
          background: 'var(--paper)', border: '1px solid var(--rule)',
          cursor: 'pointer', boxShadow: '0 2px 6px rgba(10,10,10,0.10)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--ink-2)', lineHeight: 1,
        }}>Inbox</span>
        {unseenCount > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            minWidth: 18, height: 18, borderRadius: 999,
            background: 'var(--down)', color: 'var(--paper)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            padding: '0 5px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}>{unseenCount > 99 ? '99+' : unseenCount}</span>
        )}
      </button>
      {/* Right-anchored drawer (Ben 2026-06-26). Backdrop click + Esc close. */}
      <Modal open={open} onClose={() => setOpen(false)} size="md" drawer
        eyebrow="Inbox"
        title="Notifications"
        subtitle={notificationsSubtitle(notifications, unseenCount, seenAt)}
        right={companionLabel && onCompanion ? (
          <button
            onClick={() => { setOpen(false); onCompanion() }}
            style={bellSwitchBtn}>{companionLabel}</button>
        ) : null}>
        {notifications.length === 0 ? (
          <div style={{
            padding: '48px 28px 56px', textAlign: 'center',
          }}>
            <div style={{
              fontFamily: 'var(--serif)', fontSize: 18, fontStyle: 'italic',
              color: 'var(--ink-2)', marginBottom: 8,
            }}>You're all caught up.</div>
            <div style={{
              fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)',
              lineHeight: 1.55, maxWidth: 340, margin: '0 auto',
            }}>Feedback, new task assignments, source-video updates, and approvals show up here.</div>
          </div>
        ) : (
          <div>
            {groupNotifications(notifications).map(group => (
              <div key={group.kind}>
                <div style={{
                  padding: '12px 22px 6px',
                  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                  letterSpacing: '0.16em', textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                }}>
                  <span style={{ color: group.color }}>{group.label}</span>
                  <span style={{ color: 'var(--ink-4)', fontSize: 9 }}>
                    {group.items.length}
                  </span>
                </div>
                {group.items.map(n => {
                  const isNew = !seenAt || n.created_at > seenAt
                  const cleanTitle = sanitizeNotifText(n.title)
                  const cleanBody = sanitizeNotifText(n.body)
                  return (
                    <button key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
                        padding: '12px 22px 13px',
                        background: n.read_at ? 'transparent' : 'rgba(244,225,74,0.08)',
                        border: 'none',
                        borderTop: '1px solid var(--rule)',
                        borderLeft: `3px solid ${group.color}`,
                        cursor: 'pointer', textAlign: 'left',
                        font: 'inherit', color: 'inherit',
                        transition: 'background 100ms ease',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--paper-2)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = n.read_at ? 'transparent' : 'rgba(244,225,74,0.08)' }}>
                      {/* Thumbnail of the clip the notification is about — quick
                          visual ID (Ben 2026-06-27). Falls back to a kind-coloured
                          tile when there's no thumbnail. */}
                      <div style={{
                        flexShrink: 0, width: 56, height: 38, borderRadius: 7,
                        overflow: 'hidden', background: 'var(--ink)',
                        border: '1px solid var(--rule)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {notifThumbs[n.creative_id]
                          ? <img src={notifThumbs[n.creative_id]} alt="" loading="lazy"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.color }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: 'flex', alignItems: 'baseline',
                          gap: 10, marginBottom: cleanBody ? 4 : 0,
                        }}>
                          <div style={{
                            flex: 1, minWidth: 0,
                            fontFamily: 'var(--serif)', fontSize: 14.5, fontWeight: 500,
                            color: 'var(--ink)', lineHeight: 1.3,
                            letterSpacing: '-0.005em',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{cleanTitle}</div>
                          {isNew && (
                            <span style={{
                              flexShrink: 0,
                              width: 6, height: 6, borderRadius: '50%',
                              background: group.color,
                              display: 'inline-block',
                            }} />
                          )}
                        </div>
                        {cleanBody && (
                          <div style={{
                            fontFamily: 'var(--sans)', fontSize: 12.5,
                            color: 'var(--ink-2)', lineHeight: 1.45,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            marginBottom: 5,
                          }}>{cleanBody}</div>
                        )}
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 9.5,
                          color: 'var(--ink-4)', letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                        }}>{relTime(n.created_at)}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
})

// Small mono button used in the bell modal header to hop between
// Inbox and Activity without closing-then-re-finding the other bell.
const bellSwitchBtn = {
  padding: '4px 10px',
  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-2)',
  border: '1px solid var(--rule)', borderRadius: 9,
  cursor: 'pointer',
}

/* Notification bell — floating button in the top-right of the Library
   tab. Click to open a right-side slider with the recent submissions
   feed. Unseen count (anything created since last open) shows as a
   red dot on the bell. */
const NotificationBell = forwardRef(function NotificationBell(
  { submissions, onOpenCreative, companionLabel, onCompanion },
  ref,
) {
  const [open, setOpen] = useState(false)
  // Submission currently being previewed inline. We now also support
  // submissions whose external_url was ingested into Supabase storage
  // by the ingest-external-submission Edge Function — those carry a
  // file_url too. Submissions still pending ingest render the inline
  // preview disabled (use the "Open review link" affordance instead).
  const [previewing, setPreviewing] = useState(null)
  const adminIdentity = useAdminIdentity()
  // "Seen" timestamp — anything created AFTER this counts as new.
  // Persists in localStorage so the bell remembers across reloads.
  const [seenAt, setSeenAt] = useState(() => {
    try { return localStorage.getItem('lib.notifSeenAt') || '' } catch { return '' }
  })
  const unseenCount = submissions.filter(s => !seenAt || s.created_at > seenAt).length
  // Pending-approval count = submissions that haven't been approved or
  // soft-deleted. Surfaced in the drawer header so the operator sees the
  // review backlog at a glance.
  const pendingApproval = submissions.filter(s => !s.approved_at && !s.deleted_at).length
  const markSeen = () => {
    const ts = new Date().toISOString()
    try { localStorage.setItem('lib.notifSeenAt', ts) } catch {}
    setSeenAt(ts)
  }
  const handleOpen = () => {
    setOpen(true)
    // Mark seen after a small delay so the unread badge animation
    // can play before disappearing.
    setTimeout(markSeen, 300)
  }
  // Expose imperative open() so the companion bell (Inbox ↔ Activity)
  // can hop into us without lifting the state to the parent.
  useImperativeHandle(ref, () => ({ open: handleOpen }), [])
  const relTime = (iso) => {
    const t = new Date(iso).getTime()
    const diff = Date.now() - t
    const mins = Math.round(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.round(hrs / 24)
    return `${days}d ago`
  }
  // Close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      {/* Inline button — caller wraps both bells in the BellTray
          fixed-position container so they don't overlap the dashboard
          avatar or stack on top of each other. */}
      <button onClick={handleOpen} title="Recent activity"
        style={{
          position: 'relative',
          height: 38, padding: '0 14px', borderRadius: 9,
          background: 'var(--paper)', border: '1px solid var(--rule)',
          cursor: 'pointer', boxShadow: '0 2px 6px rgba(10,10,10,0.10)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--ink-2)', lineHeight: 1,
        }}>Activity</span>
        {unseenCount > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            minWidth: 18, height: 18, borderRadius: 999,
            background: 'var(--down)', color: 'var(--paper)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            padding: '0 5px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}>{unseenCount > 99 ? '99+' : unseenCount}</span>
        )}
      </button>
      {/* Right-anchored drawer (Ben 2026-06-26 — the centred modal floated
          awkwardly mid-screen). */}
      <Modal open={open} onClose={() => setOpen(false)} size="md" drawer
        eyebrow="Recent activity"
        title={`${submissions.length} submission${submissions.length === 1 ? '' : 's'} this week`}
        subtitle={pendingApproval > 0 ? `${pendingApproval} awaiting review` : 'All caught up'}
        right={companionLabel && onCompanion ? (
          <button
            onClick={() => { setOpen(false); onCompanion() }}
            style={bellSwitchBtn}>{companionLabel}</button>
        ) : null}>
        {/* Per-editor breakdown — pinned at the top of the panel so
            you see who has stuff in flight without scrolling. */}
        {(() => {
          const byEditor = {}
          for (const s of submissions) {
            const name = s.submitted_by_name || 'Unknown'
            if (!byEditor[name]) byEditor[name] = { total: 0, pending: 0 }
            byEditor[name].total++
            if (!s.approved_at) byEditor[name].pending++
          }
          const editors = Object.entries(byEditor)
          if (editors.length === 0) return null
          return (
            <div style={{
              marginBottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap',
            }}>
              {editors.map(([name, c]) => (
                <span key={name} style={{
                  padding: '2px 8px',
                  background: c.pending > 0 ? 'rgba(232,180,8,0.15)' : 'var(--paper)',
                  border: '1px solid ' + (c.pending > 0 ? '#e8b408' : 'var(--rule)'),
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
                  borderRadius: 9,
                }}>
                  {name} · <strong>{c.total}</strong>{c.pending > 0 ? ` (${c.pending} pending)` : ''}
                </span>
              ))}
            </div>
          )
        })()}
        {submissions.length === 0 && (
          <div style={{
            padding: 40, textAlign: 'center',
            fontFamily: 'var(--sans)', fontStyle: 'italic',
            color: 'var(--ink-3)',
          }}>Nothing new this week. When an editor uploads a cut, it'll appear here.</div>
        )}
              <div style={{ display: 'grid', gap: 8 }}>
                {submissions.map(s => {
                  const isNew = !seenAt || s.created_at > seenAt
                  // Pull the joined creative info — that's what tells you
                  // WHICH video the editor finished. Without this, all the
                  // bell shows is editor name + version number, which is
                  // useless context.
                  const creative = s.task?.creative
                  const creativeId = creative?.id
                  const creativeName = creative?.display_name || creative?.canonical_name || creative?.name || '(unknown creative)'
                  const creativeType = creative?.type
                  const creativeCreator = creative?.creator
                  // Thumbnail priority: submission's own thumb (preferred,
                  // since it's the actual submitted cut), then the creative's
                  // current thumb (for the typical case where the editor
                  // pasted a Frame.io / Drive link with no thumb of its own).
                  const thumb = s.thumbnail_url || creative?.thumbnail_url
                  return (
                    <button key={s.id}
                      onClick={() => creativeId && onOpenCreative?.(creativeId)}
                      disabled={!creativeId}
                      title={creativeId ? `Open ${creativeName}` : 'Creative not found'}
                      style={{
                        display: 'grid', gridTemplateColumns: '64px 1fr',
                        gap: 12, alignItems: 'center',
                        padding: '8px 10px',
                        background: s.approved_at ? 'rgba(62,138,94,0.05)' : 'var(--paper)',
                        border: '1px solid ' + (isNew ? '#3e7eba' : 'var(--rule)'),
                        borderLeft: '3px solid ' + (s.approved_at ? 'var(--up)' : '#3e7eba'),
                        cursor: creativeId ? 'pointer' : 'default',
                        textAlign: 'left', font: 'inherit', color: 'inherit',
                      }}>
                      <div style={{
                        width: 64, height: 40, background: '#000', overflow: 'hidden',
                        flexShrink: 0,
                      }}>
                        {thumb ? (
                          <img src={thumb} alt="" loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{
                            width: '100%', height: '100%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--mono)', fontSize: 9, color: 'rgba(255,255,255,0.4)',
                          }}>{creativeType || 'VIDEO'}</div>
                        )}
                      </div>
                      <div style={{ minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {/* Row 1: creative name (the thing Ben actually wants to know) */}
                        <div style={{
                          fontWeight: 600, fontSize: 11.5,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: 'var(--ink)',
                        }} title={creativeName}>
                          {creativeName}
                        </div>
                        {/* Row 2: editor + version + time + NEW pill + ingest chip */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                          <span style={{
                            padding: '1px 5px', background: 'var(--ink-3)', color: 'var(--paper)',
                            borderRadius: 9, fontSize: 9, fontWeight: 700,
                          }}>v{s.version_number}</span>
                          <span style={{ fontWeight: 600, fontSize: 10.5, color: 'var(--ink-2)' }}>{s.submitted_by_name || 'Unknown'}</span>
                          <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>· {relTime(s.created_at)}</span>
                          {creativeCreator && (
                            <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>· {creativeCreator}</span>
                          )}
                          {isNew && (
                            <span style={{
                              padding: '1px 5px', background: '#3e7eba', color: 'var(--paper)',
                              borderRadius: 9, fontSize: 9, fontWeight: 700,
                              letterSpacing: '0.08em',
                            }}>NEW</span>
                          )}
                          {/* External-submission ingest status. The row click bubbles
                              to onOpenCreative; the chip's Retry button stops
                              propagation so it doesn't open the drawer. */}
                          <IngestStatusChip
                            submission={s}
                            onRetry={async (sub) => {
                              await retryIngest(sub.id)
                              // No optimistic update here — the activity bell polls
                              // every 60s via the load() effect, so the chip will
                              // refresh to pending on next tick.
                            }} />
                        </div>
                        {/* Row 3: status + view-submission action */}
                        <div style={{
                          marginTop: 3, display: 'flex', alignItems: 'center', gap: 10,
                          fontSize: 10, color: 'var(--ink-3)',
                        }}>
                          <span style={{
                            fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                            color: s.approved_at ? 'var(--up)' : '#3e7eba',
                          }}>{s.approved_at ? 'Approved' : 'In review'}</span>
                          {s.file_url && (
                            // In-place preview for Supabase-hosted files. Old
                            // behaviour was `target="_blank"` + the toDownloadUrl
                            // wrapper, which (a) opened a new tab and (b) forced
                            // a binary download via Content-Disposition. Ben
                            // wants to watch it from the dashboard — so we open
                            // a video preview Modal here instead. Download is
                            // still available as a secondary action inside the
                            // preview modal.
                            <button type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPreviewing(s)
                              }}
                              style={{
                                background: 'transparent', border: 'none',
                                padding: 0, cursor: 'pointer',
                                color: 'var(--ink-2)', textDecoration: 'underline',
                                fontFamily: 'inherit', fontSize: 'inherit',
                              }}>Play submission</button>
                          )}
                          {!s.file_url && s.external_url && (
                            // External review tools (Frame.io / Drive / Dropbox)
                            // block iframe embedding, so the only sensible
                            // affordance is "open in new tab".
                            <a href={s.external_url}
                              target="_blank" rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: 'var(--ink-2)', textDecoration: 'underline' }}>
                              Open review link ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
      </Modal>
      {/* Inline video preview for the submission Play action above. Rendered
          inside this same Fragment so it stacks above the Activity modal
          (the Modal primitive auto-increments z-index by mount depth). */}
      <SubmissionPreviewModal
        submission={previewing}
        currentUser={adminIdentity}
        onClose={() => setPreviewing(null)} />
    </>
  )
})


// Module-level wrapperStyle constants for OptVideoPlayer call sites.
// Inline `{ height: N }` objects would create a new prop reference on
// every parent render and silently defeat the memo() wrap on
// OptVideoPlayer (caught in code-review 2026-06-01). Hoisting these
// here gives each call site a stable identity.
// Wrapper styles for OptVideoPlayer call sites. Always pair a fixed height
// with a maxHeight cap so 9:16 vertical submissions can't run away when
// the modal is wide (Ben 2026-06-10: "when I click review on a thing
// that is a mobile video, it is very, very, very tall"). The maxHeight
// is viewport-relative so the player shrinks on shorter screens too.
const OPT_PLAYER_WRAP_FILL = { height: '100%', maxHeight: 'min(56vh, 460px)' }
// Full-stage fill for the SubmissionPreviewModal review surface: the modal
// is a FIXED 86vh, so the player should fill its column (video centred on
// black via object-fit: contain) instead of capping at 460px and leaving a
// dead black void below it (Ben 2026-06-27: "it doesn't expand out"). The
// fixed modal height already bounds tall 9:16 videos, so no cap is needed.
const OPT_PLAYER_WRAP_STAGE = { height: '100%', maxHeight: '100%' }
// Per-row lowercased search text, keyed by row object identity (see the
// filter pipeline for why this must NOT live as a property on the row).
const SEARCH_BLOBS = new WeakMap()

/* Full-screen review surface for a submission. OPT-branded player on
   top of comments sidebar; approve / request revision live in the
   modal footer so the operator can act WITHIN the review surface
   instead of bouncing back out. Frame.io-ish layout, but ours.
   Comments live in lib_submission_comments (migration 119); admin-
   authored comments fire a trigger that notifies the editor via the
   existing bell. */
function SubmissionPreviewModal({ submission, onClose, currentUser, onApprove, onRequestRevision, busy: parentBusy, onCommentsChanged }) {
  const playerRef = useRef(null)
  const [playerState, setPlayerState] = useState({ currentTime: 0, duration: 0, playing: false })
  const [comments, setComments] = useState([])
  const [posting, setPosting] = useState(false)
  // Composer state. ts=null means a general (non-timestamped) comment.
  const [composer, setComposer] = useState({ open: false, body: '', ts: null, parentId: null })
  // Revision-request composer — separate from comment composer because
  // sending a revision request is a one-shot action (no thread / no
  // resolve / no marker). Opens a full-width textarea above the footer.
  const [revisionDraft, setRevisionDraft] = useState({ open: false, body: '' })
  // Marker hover state — shared between the player scrubber and the
  // sidebar so hovering EITHER surface pulses BOTH. Frame.io-style
  // cross-highlight.
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null)
  const { currentTime, duration } = playerState

  // Load comments + poll every 10s while the modal is open so admin/
  // editor side-by-side stays in sync without realtime. supabase
  // realtime channels are heavier infra — poll is fine for a small
  // per-submission feed.
  const reloadComments = useCallback(async () => {
    if (!submission?.id) return
    const { data } = await supabase
      .from('lib_submission_comments')
      .select('*')
      .eq('submission_id', submission.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
    if (!data) return
    // Merge-by-id instead of replace, so an optimistic insert that
    // hasn't propagated to the next poll yet doesn't flicker out of
    // the list. The poll wins for any row that DOES come back from
    // the server (server is source of truth — picks up edits, resolves,
    // soft-deletes); optimistic-only rows survive until the server
    // catches up. Same shape as a CRDT last-write-wins merge.
    setComments(prev => {
      const byId = new Map(data.map(c => [c.id, c]))
      const localOnly = prev.filter(c => !byId.has(c.id))
      return [...data, ...localOnly]
    })
  }, [submission?.id])
  useEffect(() => { reloadComments() }, [reloadComments])
  useEffect(() => {
    if (!submission) return
    const t = setInterval(reloadComments, 10_000)
    return () => clearInterval(t)
  }, [submission, reloadComments])

  // OptVideoPlayer pushes time/duration/playing changes up via onState.
  const onPlayerState = useCallback((s) => setPlayerState(s), [])
  // Seek into the video from a comment-thread click. Goes through the
  // player's imperative handle so play+seek behaves uniformly.
  const seekTo = useCallback((seconds) => {
    playerRef.current?.seekTo(seconds)
  }, [])

  // Post a new top-level comment OR a reply (when parentId set). Author
  // identity falls back to 'Admin' if we couldn't resolve a name — the
  // trigger doesn't care, and the editor still gets a notification.
  const postComment = useCallback(async ({ body, ts, parentId }) => {
    if (!submission?.id || !body?.trim()) return
    setPosting(true)
    try {
      const row = {
        submission_id: submission.id,
        parent_id: parentId || null,
        timestamp_seconds: parentId ? null : (ts != null ? Number(ts.toFixed(3)) : null),
        author_kind: currentUser?.kind || 'admin',
        author_id: currentUser?.id || null,
        author_name: currentUser?.name || 'Admin',
        body: body.trim(),
      }
      const { data, error } = await supabase
        .from('lib_submission_comments')
        .insert(row)
        .select('*')
        .single()
      if (error) throw error
      setComments(curr => [...curr, data])
      setComposer({ open: false, body: '', ts: null, parentId: null })
      onCommentsChanged?.()
    } catch (e) {
      try { alert(`Comment failed: ${e.message || e}`) } catch {}
    } finally {
      setPosting(false)
    }
  }, [submission?.id, currentUser, onCommentsChanged])

  // Resolve / re-open a top-level comment. Admin-only — editors can
  // reply but shouldn't be able to close their own feedback threads.
  const toggleResolve = useCallback(async (comment) => {
    if (currentUser?.kind !== 'admin') return
    const patch = comment.resolved_at
      ? { resolved_at: null, resolved_by_name: null }
      : { resolved_at: new Date().toISOString(), resolved_by_name: currentUser?.name || 'Admin' }
    setComments(curr => curr.map(c => c.id === comment.id ? { ...c, ...patch } : c))
    await supabase.from('lib_submission_comments').update(patch).eq('id', comment.id)
    onCommentsChanged?.()
  }, [currentUser, onCommentsChanged])

  // Soft-delete a comment. Author-only (or admin override). Replies are
  // cascade-deleted via the FK ON DELETE CASCADE — but for soft delete
  // we just hide the parent; replies become orphans of a missing thread.
  // For the small per-submission scale this is acceptable.
  const deleteComment = useCallback(async (comment) => {
    setComments(curr => curr.filter(c => c.id !== comment.id))
    await supabase.from('lib_submission_comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', comment.id)
    onCommentsChanged?.()
  }, [onCommentsChanged])

  // Derived data — memoized on `comments` so the 1Hz onState push from
  // the player doesn't rebuild these arrays + force a fresh
  // `playerMarkers` reference (which would defeat the memo wrap on
  // OptVideoPlayer and cause a full player re-render every second).
  const { topLevels, repliesBy, sortedTop, openCount, playerMarkers } = useMemo(() => {
    const tops = comments.filter(c => !c.parent_id)
    const replies = comments.reduce((acc, c) => {
      if (!c.parent_id) return acc
      if (!acc[c.parent_id]) acc[c.parent_id] = []
      acc[c.parent_id].push(c)
      return acc
    }, {})
    const sorted = [...tops].sort((a, b) => {
      const at = a.timestamp_seconds, bt = b.timestamp_seconds
      if (at == null && bt == null) return new Date(a.created_at) - new Date(b.created_at)
      if (at == null) return 1
      if (bt == null) return -1
      return at - bt
    })
    const open = tops.filter(c => !c.resolved_at).length
    const markers = tops
      .filter(c => c.timestamp_seconds != null)
      .map(c => ({
        id: c.id,
        ts: c.timestamp_seconds,
        color: c.resolved_at ? 'rgba(255,255,255,0.4)' : '#3e7eba',
        title: c.body,
        authorName: c.author_name,
      }))
    return { topLevels: tops, repliesBy: replies, sortedTop: sorted, openCount: open, playerMarkers: markers }
  }, [comments])

  if (!submission) return null
  // Stream the proxy for instant playback; download still grabs file_url.
  const url = submission.preview_proxy_url || submission.file_url
  const filename = `v${submission.version_number || 1}.mp4`
  const editor = submission.submitted_by_name || 'Unknown editor'
  const isApproved = !!submission.approved_at
  const canAct = !submission.__synthetic && !isApproved
  // Send-revision handler — local wrapper that closes the draft on success.
  const handleSendRevision = async () => {
    if (!revisionDraft.body.trim() || !onRequestRevision) return
    try {
      await onRequestRevision(submission, revisionDraft.body.trim())
      setRevisionDraft({ open: false, body: '' })
    } catch (e) {
      try { alert(`Revision request failed: ${e?.message || e}`) } catch {}
    }
  }
  return (
    <Modal open={!!submission} onClose={onClose} size="lg"
      eyebrow={isApproved ? 'Approved submission' : 'Review submission'}
      title={`v${submission.version_number || 1} · ${editor}`}
      subtitle={`${openCount} open comment${openCount === 1 ? '' : 's'}${submission.__synthetic ? ' · direct upload' : ''}`}>
      {/* Flex-column wrapper so the action footer + revision composer stay
          pinned to the bottom while the video / comments grid takes the
          remaining height. Without this wrapper the Modal body would
          scroll the footer off-screen on shorter viewports. */}
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 400px',
        gap: 0, minHeight: 0, flex: '1 1 auto',
      }}>
        {/* Player + meta column */}
        <div style={{
          minWidth: 0, display: 'flex', flexDirection: 'column',
          background: '#0a0a0a',
        }}>
          {/* Custom OPT-branded player. Comment markers sit on the
              actual scrubber, click anywhere on the bar to scrub. */}
          {/* DEFINITE-height container (not a flex-fill chain) so the
              player's height:100% resolves and can't overflow the 86vh modal
              — the flex-fill version pushed the footer (Revise) off-screen and
              broke Review. compact drops the minHeight:400 floor, matching the
              working library detail-modal player. (Root-caused 2026-06-27.) */}
          <div style={{ height: 'min(58vh, 520px)', background: 'black', flexShrink: 0 }}>
            <OptVideoPlayer ref={playerRef}
              src={url}
              markers={playerMarkers}
              onState={onPlayerState}
              compact
              downloadUrl={toDownloadUrl(submission.file_url, filename)}
              downloadName={filename}
              wrapperStyle={OPT_PLAYER_WRAP_STAGE}
              hoveredMarkerId={hoveredMarkerId}
              onMarkerHoverChange={setHoveredMarkerId} />
          </div>
          {/* Editor's submission note. Tucked just below the player so
              the operator sees context without scrolling. */}
          {submission.notes && (
            <div style={{
              padding: '12px 22px',
              background: 'var(--paper-2)',
              borderTop: '1px solid var(--rule)',
              fontFamily: 'var(--serif)', fontSize: 13.5, lineHeight: 1.55,
              color: 'var(--ink-2)', fontStyle: 'italic',
              flexShrink: 0,
            }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--ink-4)', marginRight: 8, fontStyle: 'normal',
              }}>Editor note</span>
              {submission.notes}
            </div>
          )}
        </div>
        {/* Comments column */}
        <div style={{
          borderLeft: '1px solid var(--rule)',
          background: 'var(--paper)',
          display: 'flex', flexDirection: 'column',
          minHeight: 0, overflow: 'hidden',
        }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Comments</span>
            <span style={{ color: 'var(--ink-4)' }}>
              {openCount > 0 ? `${openCount} open · ${comments.length} total` : `${comments.length} total`}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {sortedTop.length === 0 && (
              <div style={{
                padding: '36px 8px', textAlign: 'center',
                fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 14,
                color: 'var(--ink-3)', lineHeight: 1.6,
              }}>No comments yet.<br/>
                <span style={{ fontStyle: 'normal', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                  Click the scrubber or "+ Comment" below
                </span>
              </div>
            )}
            {sortedTop.map(c => (
              <CommentThread key={c.id}
                comment={c}
                replies={repliesBy[c.id] || []}
                onSeek={seekTo}
                onReply={(parentId) => {
                  playerRef.current?.pause()
                  setComposer({ open: true, body: '', ts: null, parentId })
                }}
                onResolve={toggleResolve}
                onDelete={deleteComment}
                canResolve={currentUser?.kind === 'admin'}
                currentUser={currentUser}
                isHovered={hoveredMarkerId === c.id}
                onHoverChange={(hovering) => setHoveredMarkerId(hovering ? c.id : null)} />
            ))}
          </div>
          {/* Comment composer — synthetic submissions get an explanation
              instead, since there's no submission_id to attach comments to. */}
          <div style={{ borderTop: '1px solid var(--rule)', padding: '12px 14px', background: 'var(--paper-2)' }}>
            {submission.__synthetic ? (
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)',
                lineHeight: 1.5, padding: '4px 2px',
              }}>
                <strong style={{ color: 'var(--ink-2)' }}>Comments unavailable.</strong>{' '}
                This creative was uploaded directly as "edited" and has no
                editor submission record.
              </div>
            ) : (
              <>
                {/* "Comment as" indicator — shows who the comment will be
                    attributed to. Comes from useAdminIdentity (auth user
                    name) or scope.editorName for editor-portal users. */}
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--ink-4)', marginBottom: 6,
                }}>
                  Commenting as <strong style={{ color: 'var(--ink-2)' }}>{currentUser?.name || 'Admin'}</strong>
                </div>
                {!composer.open ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => {
                        // Read currentTime DIRECTLY off the player ref
                        // instead of from playerState — the React-state
                        // path lags ~250ms behind the live video so the
                        // captured ts could be stale (Ben 2026-06-01:
                        // "I can't leave a comment at certain time
                        // periods").
                        const liveTs = url ? (playerRef.current?.getCurrentTime() ?? currentTime) : null
                        // Pause so the operator can think + type without
                        // the video running away (Ben 2026-06-01: "when
                        // I leave comments on the video, it doesn't
                        // automatically pause you").
                        playerRef.current?.pause()
                        setComposer({ open: true, body: '', ts: liveTs, parentId: null })
                      }}
                      style={{
                        flex: 1, padding: '9px 12px',
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        border: 'none', cursor: 'pointer',
                      }}>+ Comment{url && duration > 0 ? ` at ${fmtTime(playerRef.current?.getCurrentTime() ?? currentTime)}` : ''}</button>
                    {url && duration > 0 && (
                      <button onClick={() => {
                          playerRef.current?.pause()
                          setComposer({ open: true, body: '', ts: null, parentId: null })
                        }}
                        title="General comment (no timestamp)"
                        style={{
                          padding: '9px 12px',
                          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                          letterSpacing: '0.08em', textTransform: 'uppercase',
                          background: 'transparent', color: 'var(--ink-3)',
                          border: '1px solid var(--rule)', cursor: 'pointer',
                        }}>General</button>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                      letterSpacing: '0.1em', textTransform: 'uppercase',
                      color: 'var(--ink-3)', marginBottom: 6,
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>
                        {composer.parentId
                          ? 'Reply'
                          : composer.ts != null
                            ? `At ${fmtTime(composer.ts)}`
                            : 'General comment'}
                      </span>
                      <button onClick={() => setComposer({ open: false, body: '', ts: null, parentId: null })}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--ink-4)', fontSize: 14, padding: 0,
                        }}>×</button>
                    </div>
                    <textarea
                      autoFocus
                      value={composer.body}
                      onChange={e => setComposer(c => ({ ...c, body: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          postComment({ body: composer.body, ts: composer.ts, parentId: composer.parentId })
                        }
                      }}
                      placeholder="What needs to change?"
                      rows={3}
                      style={{
                        width: '100%', padding: '8px 10px',
                        fontFamily: 'var(--sans)', fontSize: 12.5,
                        background: 'var(--paper)', border: '1px solid var(--rule)',
                        outline: 'none', resize: 'vertical',
                        boxSizing: 'border-box',
                      }} />
                    <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)' }}>
                        ⌘/Ctrl-Enter to send
                      </span>
                      <button onClick={() => postComment({ body: composer.body, ts: composer.ts, parentId: composer.parentId })}
                        disabled={posting || !composer.body.trim()}
                        style={{
                          padding: '7px 14px',
                          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                          letterSpacing: '0.08em', textTransform: 'uppercase',
                          background: posting || !composer.body.trim() ? 'var(--ink-4)' : 'var(--ink)',
                          color: 'var(--paper)', border: 'none',
                          cursor: posting || !composer.body.trim() ? 'not-allowed' : 'pointer',
                        }}>{posting ? 'Posting…' : 'Send'}</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {/* Footer — Approve / Request revision / Download.
          Lives inside the Modal footer slot (the Modal already supports
          a `footer` prop for this kind of bottom-bar). */}
      <div style={{
        padding: '14px 22px',
        background: 'var(--paper-2)',
        borderTop: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        {url && (
          <a href={toDownloadUrl(url, filename)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--ink-3)', textDecoration: 'underline',
            }}>Download original</a>
        )}
        <span style={{ flex: 1 }} />
        {isApproved && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--up)',
          }}>Approved · {new Date(submission.approved_at).toLocaleDateString()}</span>
        )}
        {canAct && onRequestRevision && !revisionDraft.open && (
          <button onClick={() => setRevisionDraft({ open: true, body: '' })}
            disabled={parentBusy}
            style={{
              padding: '8px 16px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: '#d09c08', color: '#3a2904',
              border: 'none', cursor: parentBusy ? 'not-allowed' : 'pointer',
            }}>Request revision</button>
        )}
        {canAct && onApprove && (
          <button onClick={() => onApprove(submission)}
            disabled={parentBusy}
            style={{
              padding: '8px 18px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: parentBusy ? 'var(--ink-4)' : 'var(--up)',
              color: 'white',
              border: 'none', cursor: parentBusy ? 'not-allowed' : 'pointer',
            }}>{parentBusy ? 'Working…' : 'Approve'}</button>
        )}
      </div>
      {/* Revision-request composer — slides in above the footer when the
          operator hits "Request revision". One-shot send; closes on
          success. */}
      {revisionDraft.open && (
        <div style={{
          padding: '14px 22px',
          background: 'rgba(208,156,8,0.08)',
          borderTop: '1px solid rgba(208,156,8,0.4)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            color: '#7a5800', marginBottom: 6,
          }}>Request revision — tell {editor} what to change</div>
          <textarea
            autoFocus
            value={revisionDraft.body}
            onChange={e => setRevisionDraft(d => ({ ...d, body: e.target.value }))}
            placeholder="Be specific. The editor sees this verbatim in their notification."
            rows={3}
            style={{
              width: '100%', padding: '8px 10px',
              fontFamily: 'var(--sans)', fontSize: 13,
              background: 'var(--paper)', border: '1px solid var(--rule)',
              outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }} />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setRevisionDraft({ open: false, body: '' })}
              disabled={parentBusy}
              style={{
                padding: '7px 14px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-3)',
                border: '1px solid var(--rule)', cursor: 'pointer',
              }}>Cancel</button>
            <button onClick={handleSendRevision}
              disabled={parentBusy || !revisionDraft.body.trim()}
              style={{
                padding: '7px 14px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: parentBusy || !revisionDraft.body.trim() ? 'var(--ink-4)' : '#d09c08',
                color: '#3a2904',
                border: 'none', cursor: parentBusy || !revisionDraft.body.trim() ? 'not-allowed' : 'pointer',
              }}>{parentBusy ? 'Sending…' : 'Send revision request'}</button>
          </div>
        </div>
      )}
      </div>
    </Modal>
  )
}

// Single comment thread = one top-level comment + N flat replies.
// Replies don't nest further; that keeps the visual hierarchy simple
// and matches Frame.io's convention.
function CommentThread({ comment, replies, onSeek, onReply, onResolve, onDelete, canResolve, currentUser, isHovered, onHoverChange }) {
  const isAuthor = currentUser?.kind === comment.author_kind &&
    (currentUser?.id ? currentUser.id === comment.author_id : currentUser?.name === comment.author_name)
  return (
    <div
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      style={{
        marginBottom: 10,
        padding: 10,
        background: isHovered
          ? 'rgba(244,225,74,0.32)'
          : comment.resolved_at ? 'rgba(62,138,94,0.06)' : 'white',
        border: '1px solid ' + (isHovered ? '#f4e14a' : 'var(--rule)'),
        borderLeft: `3px solid ${
          isHovered ? '#f4e14a'
            : comment.resolved_at ? 'var(--up)' : '#3e7eba'
        }`,
        opacity: comment.resolved_at ? 0.78 : 1,
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease',
        transform: isHovered ? 'translateX(-2px)' : 'translateX(0)',
        boxShadow: isHovered
          ? '0 4px 14px rgba(244,225,74,0.35), 0 0 0 1px rgba(244,225,74,0.6)'
          : 'none',
        position: 'relative',
      }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
            color: comment.author_kind === 'admin' ? '#2f5a8a' : 'var(--up)',
          }}>{comment.author_name || 'Anon'}</span>
          {comment.timestamp_seconds != null && (
            <button onClick={() => onSeek?.(comment.timestamp_seconds)}
              style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                color: '#3e7eba', textDecoration: 'underline',
              }}>{formatTs(comment.timestamp_seconds)}</button>
          )}
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)' }}>
          {relTimeShort(comment.created_at)}
        </span>
      </div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)',
        lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        textDecoration: comment.resolved_at ? 'line-through' : 'none',
      }}>{comment.body}</div>
      {/* Replies, indented */}
      {replies.length > 0 && (
        <div style={{ marginTop: 8, marginLeft: 12, paddingLeft: 10, borderLeft: '2px solid var(--rule)' }}>
          {replies.map(r => (
            <div key={r.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                  color: r.author_kind === 'admin' ? '#2f5a8a' : 'var(--up)',
                }}>{r.author_name || 'Anon'}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)' }}>
                  {relTimeShort(r.created_at)}
                </span>
              </div>
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-2)',
                lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{r.body}</div>
            </div>
          ))}
        </div>
      )}
      {/* Per-thread actions */}
      <div style={{
        marginTop: 8, display: 'flex', gap: 8,
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.08em',
        textTransform: 'uppercase', fontWeight: 700,
      }}>
        <button onClick={() => onReply?.(comment.id)}
          style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink-3)' }}>Reply</button>
        {canResolve && (
          <button onClick={() => onResolve?.(comment)}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: comment.resolved_at ? '#b8893e' : 'var(--up)' }}>
            {comment.resolved_at ? 'Re-open' : 'Resolve'}
          </button>
        )}
        {isAuthor && (
          <button onClick={() => { if (confirm('Delete this comment?')) onDelete?.(comment) }}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--down)', marginLeft: 'auto' }}>Delete</button>
        )}
      </div>
    </div>
  )
}

// Format a time-in-seconds as M:SS or H:MM:SS for the marker labels.
function formatTs(seconds) {
  if (seconds == null || !isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

function relTimeShort(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d`
  return new Date(iso).toLocaleDateString()
}

/* Modal video preview with explicit teardown. The native <video> element
   sometimes stalls the main thread for hundreds of ms when unmounted
   mid-buffer (browser cleans up decoder + network connection). Pausing
   and clearing src in a useEffect cleanup forces immediate teardown so
   closing the detail modal feels instant instead of laggy. */
/* Frame.io / Drive / Dropbox link submission. Lets editors paste a
   review-tool URL as v_n instead of uploading the raw file. Same
   submission row, just with external_url instead of file_url. */
const TRANSCRIPT_NORMALIZATIONS = [
  [/\bup digital\b/gi, 'OPT Digital'],
  [/\bopt\.?\s+digital\b/gi, 'OPT Digital'],
  [/\bapt digital\b/gi, 'OPT Digital'],
  [/\boptimist digital\b/gi, 'OPT Digital'],
]
function normaliseTranscript(text) {
  if (!text) return text
  let out = text
  for (const [pattern, replacement] of TRANSCRIPT_NORMALIZATIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

// PreviewVideo removed 2026-06-01 — every video surface now uses
// OptVideoPlayer (compact mode) so chrome stays consistent across
// Library detail, EditTaskModal source preview, SubmissionsPanel
// version cards, and the SubmissionPreviewModal review surface.



export default function AdsCreativeLibrary({ editorScope, category = 'ad' }) {
  const scope = editorScope || ADMIN_SCOPE
  // Shorts is its OWN page (Ben 2026-06-28: "shorts should be its own page not
  // a tab"). `category` scopes the whole platform — library, queue, uploads —
  // to ad creatives or short-form creatives. No in-page toggle.
  const isShorts = category === 'short'
  // In editor-view mode, default to the Editing Queue tab since that's why
  // they came (to see their assignments). Admins land on Library.
  // Ben (2026-06-10) cut the Triage and Launch queue views to de-clutter —
  // two sub-views only, so a saved 'triage'/'launch' from before the cut
  // falls back to the default.
  const tabKey = `lib.tab.${category}`
  const [tab, setTab] = useState(() => {
    const fallback = scope.isEditorView ? 'queue' : 'library'
    try {
      const saved = localStorage.getItem(tabKey)
      if (saved === 'invoice') return scope.isEditorView ? 'invoice' : fallback
      return (saved === 'library' || saved === 'queue') ? saved : fallback
    } catch { return fallback }
  })
  useEffect(() => { try { localStorage.setItem(tabKey, tab) } catch {} }, [tab, tabKey])

  // Editorial page hero — its own serif identity per platform + active tab.
  const platformLabel = scope.isEditorView ? 'Editor portal' : (isShorts ? 'Shorts' : 'Ads')
  const heroEyebrow = `${platformLabel} · ${tab === 'library' ? 'Library' : tab === 'invoice' ? 'Invoice' : 'Editing queue'}`
  const hero = tab === 'library'
    ? (isShorts ? { title: 'The shorts library.', italic: 'shorts' } : { title: 'The creative library.', italic: 'creative' })
    : tab === 'invoice'
      ? { title: 'Your invoice.', italic: 'invoice' }
      : (isShorts ? { title: 'The shorts queue.', italic: 'shorts' } : { title: 'The editing queue.', italic: 'editing' })

  return (
    <div style={{ padding: '12px 0 60px' }}>
      <SectionHead
        level="page"
        eyebrow={heroEyebrow}
        title={hero.title}
        italicWord={hero.italic}
        gap={20}
        right={
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
            <TabBtn active={tab === 'library'} onClick={() => setTab('library')}>Library</TabBtn>
            <TabBtn active={tab === 'queue'}   onClick={() => setTab('queue')}>Editing queue</TabBtn>
            {scope.isEditorView && (
              <TabBtn active={tab === 'invoice'} onClick={() => setTab('invoice')}>Invoice</TabBtn>
            )}
          </div>
        }
      />

      {/* Both tabs stay mounted — toggle visibility instead of mount/unmount.
          Why: unmounting a tab destroys all of its state (filters, scroll
          position, expanded rows, in-flight fetches) and the next switch
          back has to re-mount and re-fetch from scratch. With 200+ library
          rows + a dozen useMemo computations, that re-mount alone is ~400ms
          of paint time. Keeping both mounted means switching is a
          near-instant visibility flip and the user's filters survive. */}
      <div style={{ display: tab === 'library' ? 'block' : 'none' }}>
        <LibraryTab scope={scope} category={category} />
      </div>
      <div style={{ display: tab === 'queue' ? 'block' : 'none' }}>
        <EditingQueueTab scope={scope} category={category} />
      </div>
      {scope.isEditorView && (
        <div style={{ display: tab === 'invoice' ? 'block' : 'none' }}>
          <InvoiceTab scope={scope} active={tab === 'invoice'} />
        </div>
      )}
    </div>
  )
}

// Parse an editor-typed video length into seconds. Accepts "m:ss" / "h:mm:ss"
// (colon form) or a bare number treated as minutes ("2" = 120s, "1.5" = 90s).
// Returns null on anything unparseable so callers can keep the manual input open.
function parseDurationInput(str) {
  const t = (str || '').trim()
  if (!t) return null
  if (t.includes(':')) {
    const parts = t.split(':').map(p => parseInt(p, 10))
    if (parts.some(n => Number.isNaN(n) || n < 0)) return null
    let s = 0
    for (const p of parts) s = s * 60 + p
    return s
  }
  const n = parseFloat(t)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 60)
}

/* InvoiceTab — the editor's pay surface inside the portal.
   For one editor, lists each task's MOST-RECENT APPROVED submission, the link
   to that cut, and its length. Tallies the total approved video time and, when
   the editor has a flat per-minute rate set, the pay. Lengths captured at
   upload show as "auto"; external review links (or anything we couldn't read)
   get a manual length the editor types here. */
function InvoiceTab({ scope, active }) {
  const [editors, setEditors] = useState([])
  const [selectedEditorId, setSelectedEditorId] = useState(scope.editorId || '')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [draftLen, setDraftLen] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [copiedKey, setCopiedKey] = useState(null)

  // Editors can only ever see their own invoice; the team-wide / admin
  // portal can switch between editors via the picker.
  const lockedToSelf = !!scope.editorId && !scope.isTeamWide
  const canPick = !lockedToSelf

  useEffect(() => {
    let mounted = true
    supabase.from('lib_creative_editors')
      .select('id, name, rate_per_minute, active')
      .order('name')
      .then(({ data }) => {
        if (!mounted) return
        const list = data || []
        setEditors(list)
        // Default the picker to the logged-in editor, else first active editor.
        if (!selectedEditorId) {
          const first = list.find(e => e.active !== false) || list[0]
          if (first) setSelectedEditorId(first.id)
        }
      })
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedEditor = editors.find(e => e.id === selectedEditorId) || null
  const rate = selectedEditor?.rate_per_minute != null ? Number(selectedEditor.rate_per_minute) : null

  const load = useCallback(async () => {
    if (!selectedEditorId) { setRows([]); setLoading(false); return }
    setLoading(true); setErr(null)
    try {
      // Every approved, non-deleted submission this editor made.
      const { data: subs, error: sErr } = await supabase
        .from('lib_task_submissions')
        .select('id, task_id, version_number, approved_at, file_url, external_url, duration_seconds, duration_source, thumbnail_url')
        .eq('submitted_by_editor_id', selectedEditorId)
        .not('approved_at', 'is', null)
        .is('deleted_at', null)
      if (sErr) throw sErr

      // Keep only the most-recent approved version per task.
      const latestByTask = new Map()
      for (const s of (subs || [])) {
        const cur = latestByTask.get(s.task_id)
        if (!cur || (s.version_number || 0) > (cur.version_number || 0)) latestByTask.set(s.task_id, s)
      }
      const kept = [...latestByTask.values()]
      if (kept.length === 0) { setRows([]); setLoading(false); return }

      // Resolve task → creative for the name + a fallback link.
      const taskIds = [...new Set(kept.map(s => s.task_id).filter(Boolean))]
      const { data: tasks } = await supabase
        .from('lib_editing_tasks')
        .select('id, creative_id')
        .in('id', taskIds)
      const taskMap = new Map((tasks || []).map(t => [t.id, t]))
      const creativeIds = [...new Set((tasks || []).map(t => t.creative_id).filter(Boolean))]
      let creativeMap = new Map()
      if (creativeIds.length) {
        const { data: creatives } = await supabase
          .from('lib_creative_library')
          .select('id, name, canonical_name, display_name, type, final_cut_url, drive_url, preview_url')
          .in('id', creativeIds)
        creativeMap = new Map((creatives || []).map(c => [c.id, c]))
      }

      const built = kept.map(s => {
        const task = taskMap.get(s.task_id)
        const creative = task ? creativeMap.get(task.creative_id) : null
        const name = creative ? rowDisplayName(creative) : 'Untitled edit'
        const fname = `${name}-v${s.version_number || 1}.mp4`
        // Link priority: the editor's own submitted file, then an external
        // review link they pasted, then the creative's resolved final cut.
        let link = null
        if (s.file_url) link = toDownloadUrl(s.file_url, fname)
        else if (s.external_url) link = s.external_url
        else if (creative) link = toDownloadUrl(creative.final_cut_url || creative.drive_url || creative.preview_url, fname)
        return {
          id: s.id,
          name,
          type: creative?.type || null,
          version: s.version_number || 1,
          approvedAt: s.approved_at,
          link,
          isExternal: !s.file_url && !!s.external_url,
          durationSeconds: s.duration_seconds != null ? Number(s.duration_seconds) : null,
          durationSource: s.duration_source || null,
          thumb: s.thumbnail_url || null,
        }
      }).sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt))

      setRows(built)
    } catch (e) {
      setErr(e.message || 'Failed to load invoice')
    } finally {
      setLoading(false)
    }
  }, [selectedEditorId])

  useEffect(() => { if (active) load() }, [active, load])

  const totalSeconds = rows.reduce((acc, r) => acc + (r.durationSeconds || 0), 0)
  const missing = rows.filter(r => r.durationSeconds == null).length
  const totalMinutes = totalSeconds / 60
  const pay = rate != null ? totalMinutes * rate : null

  const saveDuration = async (row) => {
    const seconds = parseDurationInput(draftLen)
    if (seconds == null) { setErr('Enter a length like 1:30 or 2 (minutes).'); return }
    setSavingId(row.id); setErr(null)
    try {
      const { error } = await supabase.from('lib_task_submissions')
        .update({ duration_seconds: seconds, duration_source: 'manual' })
        .eq('id', row.id)
      if (error) throw error
      setRows(rs => rs.map(r => r.id === row.id ? { ...r, durationSeconds: seconds, durationSource: 'manual' } : r))
      setEditingId(null); setDraftLen('')
    } catch (e) {
      setErr(e.message || 'Could not save length')
    } finally {
      setSavingId(null)
    }
  }

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1600)
    } catch { /* clipboard blocked — no-op */ }
  }
  const copyAll = () => {
    const lines = rows
      .filter(r => r.link)
      .map(r => `${r.name}\t${r.durationSeconds != null ? formatTs(r.durationSeconds) : '—'}\t${r.link}`)
    copy(lines.join('\n'), '__all__')
  }

  const labelMono = {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: 'var(--ink-3)',
  }

  return (
    <div style={{ padding: '4px 0 40px' }}>
      {/* Header: editor + summary tiles */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap', marginBottom: 16,
      }}>
        <div>
          <div style={labelMono}>Invoice · approved video time</div>
          {canPick ? (
            <select value={selectedEditorId} onChange={e => setSelectedEditorId(e.target.value)}
              style={{ ...inputStyle, marginTop: 6, maxWidth: 280, fontFamily: 'var(--serif)', fontSize: 18 }}>
              <option value="">Select an editor…</option>
              {editors.map(e => (
                <option key={e.id} value={e.id}>{e.name}{e.active === false ? ' (inactive)' : ''}</option>
              ))}
            </select>
          ) : (
            <h2 style={{ margin: '4px 0 0', fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)' }}>
              {selectedEditor?.name || scope.editorName || 'You'}
            </h2>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <SummaryTile label="Approved edits" value={String(rows.length)} />
          <SummaryTile label="Total video time" value={formatTs(totalSeconds)} accent />
          {rate != null
            ? <SummaryTile label={`Pay @ $${rate.toFixed(2)}/min`} value={`$${(pay || 0).toFixed(2)}`} accent />
            : <SummaryTile label="Pay" value="rate not set" muted />}
        </div>
      </div>

      {err && (
        <div style={{
          marginBottom: 12, padding: '10px 12px', background: 'rgba(181,62,62,0.06)',
          border: '1px solid rgba(181,62,62,0.3)', borderLeft: '3px solid var(--down)',
          fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--down)',
        }}>{err}</div>
      )}

      {missing > 0 && !loading && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', background: '#fffaea',
          border: '1px solid #e8b408', fontFamily: 'var(--mono)', fontSize: 11, color: '#7a4e08',
        }}>
          {missing} edit{missing === 1 ? '' : 's'} {missing === 1 ? 'has' : 'have'} no length yet — these are
          usually pasted review links. Set the length on each to include it in the total.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={copyAll} disabled={rows.length === 0}
          style={{
            padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: copiedKey === '__all__' ? 'var(--up)' : 'var(--paper)',
            color: copiedKey === '__all__' ? 'white' : 'var(--ink-2)',
            border: '1px solid ' + (copiedKey === '__all__' ? 'var(--up)' : 'var(--rule)'),
            cursor: rows.length === 0 ? 'not-allowed' : 'pointer', opacity: rows.length === 0 ? 0.5 : 1,
          }}>{copiedKey === '__all__' ? 'Copied' : 'Copy all (name · length · link)'}</button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--sans)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
          Loading approved edits…
        </div>
      ) : rows.length === 0 ? (
        <div style={{
          padding: 40, textAlign: 'center', border: '1px dashed var(--rule)',
          fontFamily: 'var(--sans)', fontStyle: 'italic', color: 'var(--ink-3)',
        }}>
          No approved edits yet. Once an admin approves a submission, it shows up here with its length.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--rule)', background: 'var(--paper)' }}>
          {/* Column header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 110px 96px 150px', gap: 12,
            padding: '8px 14px', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)',
            ...labelMono,
          }}>
            <span>Edit</span><span>Approved</span><span>Length</span><span style={{ textAlign: 'right' }}>Link</span>
          </div>
          {rows.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 110px 96px 150px', gap: 12,
              padding: '10px 14px', borderBottom: '1px solid var(--rule)', alignItems: 'center',
            }}>
              {/* Name + type */}
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{r.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>
                  v{r.version}{r.type ? ` · ${r.type}` : ''}{r.isExternal ? ' · link' : ''}
                </div>
              </div>
              {/* Approved date */}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                {r.approvedAt ? new Date(r.approvedAt).toLocaleDateString() : '—'}
              </div>
              {/* Length (display or manual input) */}
              <div>
                {editingId === r.id ? (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input autoFocus value={draftLen} onChange={e => setDraftLen(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveDuration(r); if (e.key === 'Escape') { setEditingId(null); setDraftLen('') } }}
                      placeholder="1:30" style={{ ...inputStyle, width: 56, padding: '3px 6px', fontSize: 12 }} />
                    <button onClick={() => saveDuration(r)} disabled={savingId === r.id}
                      style={{ padding: '3px 7px', fontFamily: 'var(--mono)', fontSize: 10, background: 'var(--ink)', color: 'var(--paper)', border: 'none', cursor: 'pointer' }}>
                      {savingId === r.id ? '…' : '✓'}
                    </button>
                  </div>
                ) : r.durationSeconds != null ? (
                  <button onClick={() => { setEditingId(r.id); setDraftLen(formatTs(r.durationSeconds)) }}
                    title={`Edit length (${r.durationSource || 'auto'})`}
                    style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink)' }}>{formatTs(r.durationSeconds)}</span>
                    {r.durationSource === 'manual' && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--ink-4)', marginLeft: 4 }}>m</span>
                    )}
                  </button>
                ) : (
                  <button onClick={() => { setEditingId(r.id); setDraftLen('') }}
                    style={{
                      padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 10,
                      letterSpacing: '0.04em', textTransform: 'uppercase',
                      background: '#fffaea', color: '#7a4e08', border: '1px solid #e8b408', cursor: 'pointer',
                    }}>Set length</button>
                )}
              </div>
              {/* Link */}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {r.link ? (
                  <>
                    <a href={r.link} target="_blank" rel="noreferrer"
                      style={{
                        padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--paper)', color: 'var(--ink-2)', border: '1px solid var(--rule)',
                        textDecoration: 'none',
                      }}>Open</a>
                    <button onClick={() => copy(r.link, r.id)}
                      style={{
                        padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: copiedKey === r.id ? 'var(--up)' : 'var(--paper)',
                        color: copiedKey === r.id ? 'white' : 'var(--ink-2)',
                        border: '1px solid ' + (copiedKey === r.id ? 'var(--up)' : 'var(--rule)'), cursor: 'pointer',
                      }}>{copiedKey === r.id ? 'Copied' : 'Copy'}</button>
                  </>
                ) : (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>no link</span>
                )}
              </div>
            </div>
          ))}
          {/* Totals footer */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 110px 96px 150px', gap: 12,
            padding: '12px 14px', background: 'var(--paper-2)', alignItems: 'center',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              {rows.length} edit{rows.length === 1 ? '' : 's'} · total
            </span>
            <span />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{formatTs(totalSeconds)}</span>
            <span style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: rate != null ? 'var(--up)' : 'var(--ink-4)' }}>
              {rate != null ? `$${(pay || 0).toFixed(2)}` : '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryTile({ label, value, accent, muted }) {
  return (
    <div style={{
      minWidth: 120, padding: '8px 14px',
      border: '1px solid ' + (accent ? 'var(--ink)' : 'var(--rule)'),
      background: accent ? 'var(--ink)' : 'var(--paper)',
    }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: accent ? 'rgba(255,255,255,0.7)' : 'var(--ink-3)',
      }}>{label}</div>
      <div style={{
        marginTop: 3, fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500,
        color: accent ? 'white' : muted ? 'var(--ink-4)' : 'var(--ink)',
      }}>{value}</div>
    </div>
  )
}

/* ─────────────────────────── TRIAGE TAB ─────────────────────────── */

/* Triage = "everything uploaded in the last 48h that the coordinator
   hasn't approved or flagged yet" + everything auto-flagged (heuristic
   or AI) regardless of age that still hasn't been triaged. Shows the
   FULL set including bad-flagged rows (the hideBadTakes filter is
   intentionally NOT applied here) so the coordinator sees what the
   AI flagged and can un-flag false positives.

   This is where Layers 1/2/3 of the bad-take system surface for human
   confirmation. After triage, rows drop out (triaged_at IS NOT NULL)
   and behave like any library row going forward. */
/* ─────────────────────────── LIBRARY TAB ─────────────────────────── */

// Resolve the currently-logged-in auth user to a lib_creative_editors row
// when they're flagged as an assignment coordinator (notify_on_unassigned).
// Returns null otherwise. Used to mount the EditorNotificationBell for
// admins/coordinators (e.g. Kirill) so they get in-app notifications about
// new uploads that need editor assignment.
//
// Matches on auth_user_id first (the canonical link), falling back to
// case-insensitive email match for editors who haven't logged in yet but
// were invited by email.
function useCoordinatorEditorId(scope) {
  const [coordinatorId, setCoordinatorId] = useState(null)
  useEffect(() => {
    // Editor-view already has a dedicated bell via scope.editorId — no need
    // to layer a second one on top.
    if (scope?.isEditorView) return
    let mounted = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // Try auth_user_id first, fall back to email. Filter by the flag so
      // non-coordinator admins don't get a notification bell they don't need.
      const orClauses = [`auth_user_id.eq.${user.id}`]
      if (user.email) orClauses.push(`email.ilike.${user.email}`)
      const { data } = await supabase.from('lib_creative_editors')
        .select('id, notify_on_unassigned, active')
        .or(orClauses.join(','))
        .eq('notify_on_unassigned', true)
        .neq('active', false)
        .limit(1)
      if (mounted && data && data.length > 0 && data[0].id) setCoordinatorId(data[0].id)
    })()
    return () => { mounted = false }
  }, [scope?.isEditorView])
  return coordinatorId
}

function LibraryTab({ scope = ADMIN_SCOPE, pendingOpen = null, category = 'ad' }) {
  // Assignment coordinator (e.g. Kirill) gets the editor-style bell so
  // new_upload_needs_assignment notifications surface inside the dashboard.
  // Null for everyone else (editors already have scope.editorId).
  const coordinatorEditorId = useCoordinatorEditorId(scope)
  // Cross-bell refs: the inbox modal and the activity modal each expose an
  // imperative open() so the other one can hop into it via the "Activity →"
  // / "← Inbox" companion button in the modal header. Keeps each bell's
  // open/seen state self-contained while still letting the user toggle
  // between them without closing back to the page first.
  const inboxBellRef = useRef(null)
  const activityBellRef = useRef(null)
  // Hydrate from module cache so tab-switches don't re-show a blank
  // "Loading…" — we show the previous data instantly and revalidate.
  const cached = scope.isEditorView ? null : PAGE_CACHE
  const [rows, setRows] = useState(() => cached?.rows || [])
  const [loading, setLoading] = useState(() => !cached?.rows)
  const [err, setErr] = useState(null)
  // Search input: defer the value used for filtering so typing stays
  // snappy on a 200+ row library. The visible <input> uses `q` (fast),
  // the heavy filter useMemo below uses `deferredQ` (low priority).
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  // All filters are Sets to support multi-select. Empty set = no filter applied.
  const [typeFilter, setTypeFilter]   = useState(() => new Set())
  const [offerFilter, setOfferFilter] = useState(() => new Set())  // values: offer_slug | '__none__'
  const [runFilter, setRunFilter]     = useState(() => new Set())  // values: 'yes' | 'no'
  const [outcomeFilter, setOutcomeFilter] = useState(() => new Set())  // values: 'winner' | 'loser' | 'ungraded'
  const [creatorFilter, setCreatorFilter] = useState(() => new Set())  // values: creator name | '__none__'
  const [stageFilter, setStageFilter] = useState(() => new Set())  // values: 'raw_unused' | 'raw_used' | 'edited_seg' | 'merged'
  // Upload-date filter. Preset windows only — operator picks a quick range
  // and the list narrows to clips whose added_at falls inside it. Set so
  // the same FilterDropdown component as the other chips works; in practice
  // only one preset is ever selected at a time. Values: 'today', 'last7',
  // 'last30', 'last90'. Empty Set = no filter.
  // Hide low-quality (corrupted-on-ingest) clips by default. The 2026-05-20
  // Drive-import batch left 81 rows pointing at 1-3 MB placeholder files
  // pretending to be 60-100 MB videos — they look pixelated when played
  // because the original ingest only stored partial bytes. Operator can
  // toggle these back on via the filter chip to see/triage them.
  // ALWAYS true since 2026-06-11 — the show/hide toggles were removed, so
  // flagged clips are permanently hidden. Deliberately NOT initialised
  // from localStorage: the old banner click persisted `false`, and anyone
  // who ever clicked it would otherwise boot with flagged clips stuck
  // visible and no UI left to hide them.
  const [hideLowQuality] = useState(true)
  const [hideBadTakes] = useState(true)
  // Column sort for the Matrix view. sortKey = '' means default order
  // (insertion / added_at desc). Clicking a header sets the key; clicking
  // the same key again toggles direction.
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState('asc')   // 'asc' | 'desc'
  const [drawerRow, setDrawerRow] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  // Share-with-editor lives in the Editing-queue toolbar too, but coordinators
  // spend most of their time on the Library tab and couldn't find it there —
  // surface the same modal from here.
  const [shareLinksOpen, setShareLinksOpen] = useState(false)
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('lib.view') || 'list' } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('lib.view', view) } catch {} }, [view])
  const [confirmDelete, setConfirmDelete] = useState(null)
  // Bulk selection — set of row IDs. When non-empty, shows the bulk
  // action bar above the grid. Clicking a tile's checkbox toggles
  // membership; clicking the body (outside checkbox) still opens
  // the detail drawer as normal.
  const [selected, setSelected] = useState(() => new Set())
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  // Editors + offers for inline dropdowns in the Matrix view. Loaded once
  // alongside the main rows fetch — not chained, so we don't add latency.
  const [editors, setEditors] = useState(() => cached?.editors || [])
  const [offers, setOffers] = useState(() => cached?.offers || [])
  // Drive-style folders (migration 146). The open folder lives in the URL
  // (?folder=<id>; absent = library root) so every folder is its own
  // history entry — browser back walks UP the folder trail instead of
  // leaving the page, deep links work, and refresh keeps your place.
  // Search ignores folder scoping (global), matching how Drive behaves.
  const [folders, setFolders] = useState(() => cached?.folders || [])
  const [searchParams] = useSearchParams()
  const folderId = searchParams.get('folder') || null
  // Writes go through the LIVE window.location, not the router's
  // searchParams snapshot. Two reasons: (1) setSearchParams closes over
  // the render-time URL, and several long-lived [] -dep callbacks (load,
  // focusUnassignedRaw) would navigate to a mount-time query, silently
  // yanking the user out of whatever folder they're in; (2) this page
  // strips one-shot deep-link params (?creative, ?task) with raw
  // history.replaceState, which the router never sees — rebuilding from
  // the router snapshot would resurrect them on the next folder click.
  // Reading the live URL makes setFolderId genuinely stable AND respects
  // those strips. No-op writes bail out so re-clicking the current crumb
  // can't stack dead history entries under the Back button.
  // replace:true is for corrections (deleted/unknown folder): they fix
  // the URL without burning the history entry the user came from.
  const navigate = useNavigate()
  const navRef = useRef(navigate)
  navRef.current = navigate
  const setFolderId = useCallback((next, { replace = false } = {}) => {
    const sp = new URLSearchParams(window.location.search)
    const curr = sp.get('folder') || null
    const value = (typeof next === 'function' ? next(curr) : next) || null
    if (value === curr) return
    if (value) sp.set('folder', value)
    else sp.delete('folder')
    const qs = sp.toString()
    navRef.current(
      { pathname: window.location.pathname, search: qs ? `?${qs}` : '' },
      { replace },
    )
  }, [])
  const [moveFolderOpen, setMoveFolderOpen] = useState(false)
  // Filter panel collapsed by default — the FILTERS button's count badge
  // carries the "something is active" signal while it's closed.
  const [filtersOpen, setFiltersOpen] = useState(false)
  // True while a clip drag is in flight — folder cards light up as drop
  // targets the moment the drag starts (Drive behaviour) instead of only
  // when the cursor happens to cross one.
  const [dragActive, setDragActive] = useState(false)
  // Transient confirmation pill ("Moved 3 clips to Electricians") — the
  // moved clips vanish from the current view, which otherwise reads as
  // data loss.
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const showToast = useCallback((msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  // dragend fires on the drag SOURCE and bubbles — one window listener
  // beats wiring onDragEnd through every card and row, and also catches
  // drags cancelled with Esc.
  useEffect(() => {
    if (!dragActive) return
    const end = () => setDragActive(false)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [dragActive])
  // Boolean (not the array) is what the hot filter memo keys on — a
  // rename/re-parent producing a fresh folders array must not re-run the
  // whole filter/sort pipeline.
  // The Shorts page is a flat, fully-separate library — no folders at all
  // (Ben 2026-06-28: "shouldn't even have the folders"). Folders are an
  // ad-library feature.
  const isShorts = category === 'short'
  const hasFolders = !isShorts && folders.length > 0
  // Admins are tracked in lib_creative_editors but should NOT appear in
  // the "EDITORS" filter chip, the assignment dropdown, or the per-editor
  // stats breakdown — they don't take queue work, they manage it.
  // Keep `editors` full so id→name lookups still resolve historical
  // assignments; derive `assignableEditors` for any user-facing list.
  // Ben caught this 2026-05-24 (Kmamajevs showing as a queue editor).
  const assignableEditors = useMemo(
    () => (editors || []).filter(e => e.tier !== 'admin'),
    [editors],
  )
  // Distinct creators derived from current rows — used for the Creator
  // dropdown in matrix + detail modal. Recomputed when rows change so a
  // newly-added creator immediately appears in the picker.
  const knownCreators = useMemo(() => {
    const set = new Set()
    for (const r of rows) if (r.creator) set.add(r.creator)
    return Array.from(set).sort()
  }, [rows])

  const toggleSelect = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelected(new Set()), [])
  // Stable reference for the row-click handler — MatrixRow uses React.memo
  // so passing a fresh inline lambda each render would defeat the memo.
  // Open the detail modal. Wrapped in startTransition so React marks the
  // modal mount as a low-priority update — the matrix row's hover/press
  // feedback paints first, then the modal slides in. Without this, the
  // entire modal subtree (form fields + type pills + editor pickers + the
  // tasks fetch effect) blocks the next paint, which is why row clicks
  // used to feel like a 200-400ms freeze before anything happened.
  const openDrawer = useCallback((row) => {
    startTransition(() => setDrawerRow(row))
  }, [])

  // Deep-link: ?creative=<id> in the URL auto-opens the detail modal for
  // that creative once rows load. Used by external links (e.g. the
  // low-quality spreadsheet export, Slack messages, Sentinel deep-links)
  // so an editor can click a row identifier anywhere and land directly
  // on its modal instead of scrolling 200+ matrix rows. If the creative
  // isn't in the current filter window (e.g. hideLowQuality is on and
  // the linked row is flagged), we fall back to a one-shot DB fetch so
  // the link still works.
  const deepLinkOpenedRef = useRef(false)
  useEffect(() => {
    if (deepLinkOpenedRef.current) return
    const url = new URL(window.location.href)
    const creativeId = url.searchParams.get('creative')
    if (!creativeId) return
    const stripParam = () => {
      url.searchParams.delete('creative')
      window.history.replaceState({}, '', url.toString())
    }
    const local = rows.find(r => r.id === creativeId)
    if (local) {
      deepLinkOpenedRef.current = true
      openDrawer(local)
      stripParam()
      return
    }
    // Not in current rows (filter hiding it OR not yet loaded). If rows
    // are empty, wait for the next render. If rows are loaded but the
    // creative isn't present, fetch directly.
    if (!rows.length) return
    deepLinkOpenedRef.current = true
    supabase.from('lib_creative_library').select('*').eq('id', creativeId).maybeSingle()
      .then(({ data }) => { if (data) openDrawer(data) })
      .finally(stripParam)
  }, [rows, openDrawer])

  // Cross-modal navigation: when a user clicks a "Used in" or "Made from"
  // link inside the detail modal, jump the modal to that row. Looks up the
  // full row from our local rows state first (no network) and only fetches
  // if it's not in the current filter window.
  //
  // Race-safe via a token ref — if the user clicks two links quickly and
  // the network reorders responses, only the most recent click wins.
  // Also excludes excluded-from-library rows so we don't navigate to
  // intentionally-hidden creatives.
  const openRowRef = useRef(null)
  // Mirror drawerRow.id in a ref so openRowById can short-circuit same-id
  // re-clicks without depending on drawerRow itself (which would rebuild
  // the callback every time the drawer opens or closes).
  const drawerRowIdRef = useRef(null)
  useEffect(() => { drawerRowIdRef.current = drawerRow?.id || null }, [drawerRow])

  const openRowById = useCallback(async (id) => {
    if (!id) return
    // Same row is already in the drawer — bail out. Crucial: the lean
    // `rows` state has no `transcript` field, but the modal lazy-loads it
    // on open. Re-clicking the same row would call setDrawerRow(local)
    // with the lean row, nuking the in-modal transcript.
    if (id === drawerRowIdRef.current) return
    const local = rows.find(r => r.id === id)
    if (local) { setDrawerRow(local); return }
    const token = {}
    openRowRef.current = token
    const { data } = await supabase
      .from('lib_creative_library')
      .select('*, assigned_editor:assigned_editor_id (id, name)')
      .eq('id', id)
      .eq('exclude_from_library', false)
      .maybeSingle()
    if (openRowRef.current !== token) return  // a newer click superseded this fetch
    if (data) {
      setDrawerRow({
        ...data,
        assigned_editor_name: data.assigned_editor?.name || null,
      })
    }
  }, [rows])

  // Cross-tab open request. The Launch queue (and any future sibling tab)
  // hands the parent a { id, ts } object when the user clicks "Open in
  // library". The parent switches to the library tab and forwards the
  // request down here; we observe the timestamp-bumped object so the
  // SAME id can re-fire (closing the drawer + clicking the same row again
  // a few seconds later should re-open, not silently no-op).
  const pendingOpenSeenRef = useRef(0)
  useEffect(() => {
    if (!pendingOpen || !pendingOpen.id) return
    if (pendingOpen.ts === pendingOpenSeenRef.current) return
    pendingOpenSeenRef.current = pendingOpen.ts
    openRowById(pendingOpen.id)
  }, [pendingOpen, openRowById])

  // Lean column list — everything EXCEPT `transcript` (which can be 5-16KB
  // per row and is only needed inside the detail modal). 200+ rows × ~3KB
  // of transcript = 600KB+ wasted on the first paint. Pulling without it
  // cuts the initial payload roughly in half. Transcripts get lazy-loaded
  // in a follow-up query after first paint so library search still works.
  const LIB_LEAN_COLS = 'id,name,canonical_name,description,type,creator,status,offer_slug,has_been_run,manually_marked_used,assigned_editor_id,parent_id,version_number,thumbnail_url,final_cut_thumbnail_url,content_category,outcome,preview_url,drive_url,size_mb,duration_seconds,v21_script_id,derived_hook_id,derived_body_id,derivation_score,stage_rough_cut,stage_final_cut,stage_approved,stage_delivered,rough_cut_url,final_cut_url,approved_url,delivered_url,exclude_from_library,added_at,updated_at,notes,priority,source_bucket,drive_id,is_low_quality,low_quality_reason,low_quality_actual_mb,is_bad_take,bad_take_reason,folder_id'

  const load = useCallback(async (background = false, attempt = 0) => {
    if (!background) setLoading(true)
    setErr(null)
    // 20s hard timeout. supabase-js has no built-in timeout, so when
    // Supabase wedges (PostgREST schema-cache stall, Postgres pool
    // exhaustion, Cloudflare 521) the request hangs forever and the
    // page sits on its loading spinner. With Promise.race we surface
    // a visible error after 20s and the user can hit retry.
    const TIMEOUT_MS = 20_000
    const timeoutErr = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(
        'Supabase timed out — try again or restart the project from the Supabase dashboard.'
      )), TIMEOUT_MS))
    let rowsRes, edRes, ofRes, fdRes
    try {
      ;[rowsRes, edRes, ofRes, fdRes] = await Promise.race([
        Promise.all([
          supabase.from('lib_creative_library')
            .select(`${LIB_LEAN_COLS},assigned_editor:assigned_editor_id (id, name)`)
            .eq('exclude_from_library', false)
            .order('added_at', { ascending: false }),
          supabase.from('lib_creative_editors').select('*').eq('active', true).order('name'),
          supabase.from('offers').select('slug,name').eq('retired', false).order('slug'),
          supabase.from('lib_creative_folders').select('id,name,parent_id').order('name'),
        ]),
        timeoutErr,
      ])
    } catch (e) {
      // AbortError from Supabase auth-lock contention is usually transient —
      // retry with a tiny backoff. Capped at 3 attempts so a real abort
      // (e.g. genuine 401 wrapped in AbortError) eventually surfaces
      // instead of pegging the API forever.
      if (e?.name === 'AbortError' && attempt < 3) {
        if (!background) setLoading(false)
        setTimeout(() => load(background, attempt + 1), 50 * (attempt + 1))
        return
      }
      setErr(e.message || 'Load failed')
      setLoading(false)
      return
    }
    // Migration 099 adds is_bad_take + bad_take_reason. If those columns aren't
    // in the DB yet (code deployed ahead of the migration), retry without them
    // so the library still loads. Rows will show is_bad_take=undefined (falsy),
    // which the filter treats as "not a bad take" — safe default. Self-heals
    // the moment the migration is applied.
    // The fallbacks CHAIN: each strips its column from the previous
    // attempt's list (not the original constant), so a DB missing both
    // migration 099 AND 146 still converges instead of re-introducing
    // the first missing column on the second retry.
    let effectiveCols = LIB_LEAN_COLS
    if (rowsRes.error?.code === '42703' && rowsRes.error.message?.includes('is_bad_take')) {
      effectiveCols = effectiveCols
        .replace(',is_bad_take,bad_take_reason', '')
        .replace('is_bad_take,bad_take_reason,', '')
        .replace('is_bad_take,bad_take_reason', '')
      const { data: fd, error: fe } = await supabase.from('lib_creative_library')
        .select(`${effectiveCols},assigned_editor:assigned_editor_id (id, name)`)
        .eq('exclude_from_library', false)
        .order('added_at', { ascending: false })
      rowsRes = { data: fd, error: fe }
    }
    // Migration 146 adds folder_id. Same code-ahead-of-migration fallback
    // as is_bad_take above: retry the row fetch without the column so the
    // library still loads; rows show folder_id=undefined (root). The
    // folders table fetch failing (42P01, table missing) is handled below
    // by treating folders as empty — the folder UI simply doesn't appear.
    if (rowsRes.error?.code === '42703' && rowsRes.error.message?.includes('folder_id')) {
      effectiveCols = effectiveCols.replace(',folder_id', '')
      const { data: fd, error: fe } = await supabase.from('lib_creative_library')
        .select(`${effectiveCols},assigned_editor:assigned_editor_id (id, name)`)
        .eq('exclude_from_library', false)
        .order('added_at', { ascending: false })
      rowsRes = { data: fd, error: fe }
    }

    if (rowsRes.error) setErr(rowsRes.error.message)
    else {
      // Preserve any transcripts we already loaded from a previous
      // session (or from the background loader below) — the lean
      // refetch doesn't include them, so without this we'd nuke
      // transcript-aware search on every revalidate.
      const existingTx = new Map((PAGE_CACHE.rows || []).filter(r => r.transcript).map(r => [r.id, r.transcript]))
      const merged = (rowsRes.data || []).map(r => ({
        ...r,
        assigned_editor_name: r.assigned_editor?.name || null,
        transcript: existingTx.get(r.id) || undefined,
      }))
      setRows(merged)
      // Cache for cross-mount + cross-tab hydration
      PAGE_CACHE.rows = merged
      PAGE_CACHE.rowsTime = Date.now()
    }
    setEditors(edRes.data || [])
    setOffers(ofRes.data || [])
    // Folders: an error here (e.g. 42P01 — migration 146 not applied yet,
    // or a transient network blip on just this query) means we keep
    // whatever folder list we already have and DON'T touch the URL — a
    // failed fetch must never strip a valid ?folder deep link. Only a
    // successful fetch is authoritative enough to declare the folder in
    // the URL a ghost (deleted in another tab / foreign id) and correct
    // the location back to the root.
    if (!fdRes?.error) {
      const folderRows = fdRes?.data || []
      setFolders(folderRows)
      PAGE_CACHE.folders = folderRows
      setFolderId(curr => (curr && !folderRows.some(f => f.id === curr)) ? null : curr, { replace: true })
    }
    PAGE_CACHE.editors = edRes.data || []
    PAGE_CACHE.editorsTime = Date.now()
    PAGE_CACHE.offers = ofRes.data || []
    PAGE_CACHE.offersTime = Date.now()
    setLoading(false)

    // Background-load transcripts after first paint so library search
    // covers transcript text. Doesn't block the visible UI; rows get
    // patched with their transcripts when the second query resolves.
    setTimeout(async () => {
      const { data: tx } = await supabase
        .from('lib_creative_library')
        .select('id,transcript')
        .eq('exclude_from_library', false)
        .not('transcript', 'is', null)
      if (!tx) return
      const byId = new Map(tx.map(r => [r.id, r.transcript]))
      setRows(curr => {
        const next = curr.map(r => byId.has(r.id) ? { ...r, transcript: byId.get(r.id) } : r)
        PAGE_CACHE.rows = next
        return next
      })
    }, 0)
  }, [])

  // Inline patch — used by the Matrix view when an inline dropdown changes.
  // Optimistic: capture the pre-update snapshot inside the setRows updater
  // so concurrent calls (e.g. user blurs description, then editor select
  // fires before the first patch resolves) each get a fresh `prev` from
  // current state — no stale-closure clobbering.
  const patchRow = useCallback(async (id, patch) => {
    let prevRow = null
    setRows(curr => {
      const idx = curr.findIndex(r => r.id === id)
      if (idx < 0) return curr
      prevRow = curr[idx]
      const next = { ...prevRow, ...patch }
      if ('assigned_editor_id' in patch) {
        const ed = editors.find(e => e.id === patch.assigned_editor_id)
        next.assigned_editor_name = ed?.name || null
      }
      const out = curr.slice()
      out[idx] = next
      return out
    })
    if (!prevRow) return
    const { error } = await supabase.from('lib_creative_library').update(patch).eq('id', id)
    if (error) {
      // Roll back ONLY this row's columns — preserve any other patches that
      // landed between the optimistic update and now.
      const rollbackKeys = Object.keys(patch)
      setRows(curr => curr.map(r => {
        if (r.id !== id) return r
        const restored = { ...r }
        for (const k of rollbackKeys) restored[k] = prevRow[k]
        if ('assigned_editor_id' in patch) restored.assigned_editor_name = prevRow.assigned_editor_name
        return restored
      }))
      setErr(error.message)
    }
  }, [editors])

  // On mount: cached data → silent revalidate; cold → foreground load.
  useEffect(() => {
    load(!!cached?.rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Compute which raw rows have already been edited (incorporated into
  // an edited composite).
  //
  // Type-based rule from Ben (2026-05-20):
  //   - Raw Hook   -> always treated as already edited
  //   - Raw Body   -> always treated as NOT yet edited
  //   - Other raw types -> transcript-overlap heuristic (10-word phrase
  //     from raw appears verbatim in any edited row's transcript)
  //
  // The type rule reflects Ben's actual workflow: all his hook raws have
  // been merged into Joined composites already, and bodies are his
  // current editing queue. The heuristic covers Testimony / Full Video
  // raws that fall between those buckets.
  // Previously O(R × W × E × L) — for every raw row, every 10-word phrase
  // was substring-searched against every edited transcript. With 200 rows
  // and full transcripts this was millions of `String.prototype.includes`
  // calls running on every rows update (including the background
  // transcript merge), and it routinely froze the UI for 1-3 seconds.
  //
  // New approach: build a Set of all 10-word phrases (sliding by 5) from
  // edited transcripts ONCE, then for each raw row test its phrases via
  // Set.has — O(R + E×W) with hash lookups.
  //
  // Cheap fingerprint of the inputs the scan actually reads (transcript
  // corpus + manual overrides + row count). This is the most expensive
  // computation on the page (1-3s at volume) and used to re-run on EVERY
  // rows identity change — a status dropdown click, a folder move — and
  // always ran at least twice per load (once with empty transcripts,
  // again when the background transcript merge landed). The ref-gate
  // below re-scans only when the fingerprint moves.
  const usedRawScanKey = useMemo(() => {
    let n = 0
    for (const r of rows) {
      n += (r.transcript ? r.transcript.length : 0)
      if (r.manually_marked_used === true) n += 7
      else if (r.manually_marked_used === false) n += 13
    }
    return `${rows.length}|${n}`
  }, [rows])
  const usedRawCache = useRef({ key: null, value: new Set() })

  const usedRawIds = useMemo(() => {
    if (usedRawCache.current.key === usedRawScanKey) return usedRawCache.current.value
    const used = new Set()
    // Tri-state manual override:
    //   manually_marked_used = TRUE  → force into "used" set
    //   manually_marked_used = FALSE → explicitly NOT used; skip the
    //                                  Hook / transcript heuristics
    //                                  for this row entirely
    //   manually_marked_used = NULL  → let the heuristic decide
    // This is what lets clicking "RAW" on a Hook actually move it to
    // the RAW filter bucket — without the tri-state the fast-path
    // would silently keep it classified as EDITED RAW.
    const overridden = new Set()
    for (const r of rows) {
      if (r.status !== 'raw') continue
      if (r.manually_marked_used === true)  { used.add(r.id); overridden.add(r.id) }
      if (r.manually_marked_used === false) {                  overridden.add(r.id) }
    }
    // (Removed) Type-based Hook fast-path. Used to auto-mark every raw
    // Hook as "used" by default — the assumption was that Hooks are
    // self-contained and never need a separate edit pass. That broke for
    // new freshly-uploaded Hooks that genuinely DO need an editor (the
    // operator was getting "ticked / used" badges on stuff they'd just
    // uploaded). Now Hooks follow the same rules as everything else:
    // they're only considered used if the operator manually marks them,
    // OR if their transcript matches phrases in an edited composite.
    // Build phrase Set from edited transcripts
    const editedPhrases = new Set()
    for (const r of rows) {
      if (r.status !== 'edited' || !r.transcript) continue
      const t = r.transcript.toLowerCase().replace(/\s+/g, ' ').trim()
      const words = t.split(' ')
      if (words.length < 10) continue
      for (let i = 0; i <= words.length - 10; i++) {
        editedPhrases.add(words.slice(i, i + 10).join(' '))
      }
    }
    if (editedPhrases.size === 0) return used
    // Test each raw row against the Set. Skip if the operator
    // explicitly overrode this row to unused via manually_marked_used=false.
    for (const r of rows) {
      if (r.status !== 'raw') continue
      if (r.type === 'Hook' || r.type === 'Body') continue
      if (used.has(r.id)) continue
      if (overridden.has(r.id)) continue   // explicit override wins
      const t = (r.transcript || '').toLowerCase().replace(/\s+/g, ' ').trim()
      if (t.length < 60) continue
      const words = t.split(' ')
      if (words.length < 10) continue
      for (let i = 0; i <= words.length - 10; i += 5) {
        if (editedPhrases.has(words.slice(i, i + 10).join(' '))) {
          used.add(r.id); break
        }
      }
    }
    usedRawCache.current = { key: usedRawScanKey, value: used }
    return used
  }, [rows, usedRawScanKey])


  // The RAW work-queue view (raw_unused alone) deliberately keeps folder
  // scoping so filed raws can't dodge assignment; every other active filter
  // goes global like search (see the folder-scope block below + FolderBar).
  const rawQueueView = stageFilter.size === 1 && stageFilter.has('raw_unused')
  const filtersActive = typeFilter.size > 0 || offerFilter.size > 0
    || runFilter.size > 0 || outcomeFilter.size > 0 || creatorFilter.size > 0
    || (stageFilter.size > 0 && !rawQueueView)

  const filtered = useMemo(() => {
    // Scope to the page's category FIRST (Ads library vs Shorts page) so the
    // Shorts page only shows short creatives — not ads (Ben 2026-06-28).
    let list = rows.filter(r => (r.content_category || 'ad') === category)
    // Hide rows whose stored file is broken / sub-par. Default ON. Operator
    // toggles via the chip in the toolbar when they want to see/triage them.
    if (hideLowQuality) list = list.filter(r => !r.is_low_quality)
    if (hideBadTakes) list = list.filter(r => !r.is_bad_take)
    const search = deferredQ.trim().toLowerCase()
    // Folder scoping (Drive-style): inside a folder show only its direct
    // clips; at the root show un-filed clips. Skipped while searching so
    // search stays global — same as Drive. Until the first folder exists
    // every row has folder_id null and the root view is identical to the
    // pre-folders library.
    //
    // raw_unused carve-out: the RAW / needs-editing view is a WORK QUEUE,
    // not a browse view — the unassigned banner counts the FULL row set
    // and its "Filter to these →" click lands at the root with EXACTLY
    // this filter set. Hiding filed raws there would show fewer rows than
    // the banner promised (and let filed raws dodge assignment forever).
    // Only the exact single-selection bypasses scoping — a multi-select
    // that merely includes raw_unused keeps the root un-filed-only, so
    // filed edited cuts can't leak into a browse view.
    // An explicit filter is global, exactly like search: a coordinator who
    // picks OFFER=electricians-maps expects EVERY matching clip, including
    // ones already filed into a folder. Without this, the root view's
    // "un-filed only" restriction hid filed clips from the filtered result —
    // e.g. the Austin raws live in the Electricians folder, so filtering by
    // their offer at the root surfaced nothing but the folder card.
    // (rawQueueView + filtersActive are hoisted above the memo.)
    if (folderId) {
      // Inside a folder: always scope to that folder's direct clips.
      list = list.filter(r => r.folder_id === folderId)
    } else if (hasFolders && !rawQueueView && !search && !filtersActive) {
      // Root browse with no search/filter: show only un-filed clips.
      list = list.filter(r => !r.folder_id)
    }
    if (search) list = list.filter(r => {
      // Search blob includes the new display_name + messaging_angle so a
      // coordinator searching for "STOP-PAYING-FOR-LEADS" or "ACCOUNTANT"
      // hits both legacy canonical and post-overhaul rows.
      // Search blob cached in a WeakMap keyed by row OBJECT IDENTITY —
      // rebuilding a ~16KB lowercased string (transcripts!) per row per
      // keystroke made search visibly laggy despite useDeferredValue.
      // WeakMap, not a property on the row: every patch path builds the
      // replacement via { ...r, ...patch }, and a spread would COPY a
      // cached own-property onto the new object (stale blob indexing the
      // pre-edit fields — shipped and caught in review 2026-06-12). A
      // WeakMap entry stays behind on the old object instead, so a fresh
      // row identity always recomputes, and dropped rows get GC'd.
      let blob = SEARCH_BLOBS.get(r)
      if (blob === undefined) {
        blob = `${r.name} ${r.canonical_name || ''} ${r.display_name || ''} ${r.messaging_angle || ''} ${r.messaging_angle_override || ''} ${r.description || ''} ${r.creator || ''} ${r.v21_script_id || ''} ${r.notes || ''} ${r.transcript || ''}`.toLowerCase()
        SEARCH_BLOBS.set(r, blob)
      }
      return blob.includes(search)
    })
    // Multi-select filters: empty Set = no filter; otherwise OR within
    // a group (any-match) and AND across groups (intersection).
    if (typeFilter.size > 0) list = list.filter(r => typeFilter.has(r.type))
    if (offerFilter.size > 0) list = list.filter(r => {
      if (offerFilter.has('__none__') && !r.offer_slug) return true
      return r.offer_slug && offerFilter.has(r.offer_slug)
    })
    if (runFilter.size > 0) list = list.filter(r => {
      if (runFilter.has('yes') && r.has_been_run) return true
      if (runFilter.has('no') && !r.has_been_run) return true
      return false
    })
    if (outcomeFilter.size > 0) list = list.filter(r => {
      if (outcomeFilter.has('winner') && r.outcome === 'winner') return true
      if (outcomeFilter.has('loser') && r.outcome === 'loser') return true
      if (outcomeFilter.has('ungraded') && !r.outcome) return true
      return false
    })
    if (creatorFilter.size > 0) list = list.filter(r => {
      if (creatorFilter.has('__none__') && !r.creator) return true
      return r.creator && creatorFilter.has(r.creator)
    })
    if (stageFilter.size > 0) {
      list = list.filter(r => {
        // STATUS filter "RAW" = every raw clip (Ben 2026-06-29 — no more
        // "edited raw" split, so RAW shows all raw, EDITED shows all edited).
        if (stageFilter.has('raw_all') && r.status === 'raw') return true
        // raw_unused stays strict for the "needs editor" banner only: raw +
        // not yet used + no editor + not Testimony. (Not a STATUS option.)
        if (stageFilter.has('raw_unused') && r.status === 'raw' && !usedRawIds.has(r.id) && !r.assigned_editor_id && r.type !== 'Testimony') return true
        if (stageFilter.has('edited_seg') && r.status === 'edited') return true
        return false
      })
    }
    // (Uploaded-date + latest-only filters removed 2026-06-11 with their
    // toolbar controls; the branches were unreachable dead weight.)
    // Column sort (Matrix view) — applied last so it works on the filtered list
    if (sortKey) {
      const dir = sortDir === 'desc' ? -1 : 1
      const valueOf = (r) => {
        switch (sortKey) {
          case 'id':       return (rowDisplayName(r) || '').toLowerCase()
          case 'desc':     return (r.description || r.name || '').toLowerCase()
          case 'type':     return (r.type || '').toLowerCase()
          case 'creator':  return (r.creator || '').toLowerCase()
          case 'editor':   return (r.assigned_editor_name || '').toLowerCase()
          case 'offer':    return (r.offer_slug || '').toLowerCase()
          case 'run':      return r.has_been_run ? 1 : 0
          case 'status':   return (r.status || '').toLowerCase()
          case 'uploaded': return r.added_at ? new Date(r.added_at).getTime() : 0
          default:         return 0
        }
      }
      list = [...list].sort((a, b) => {
        const va = valueOf(a), vb = valueOf(b)
        if (va < vb) return -1 * dir
        if (va > vb) return 1 * dir
        return 0
      })
    }
    return list
  }, [rows, category, deferredQ, typeFilter, offerFilter, runFilter, outcomeFilter, creatorFilter, stageFilter, rawQueueView, filtersActive, hideLowQuality, hideBadTakes, sortKey, sortDir, usedRawIds, folderId, hasFolders])

  // Header click handler — passed down to the Matrix header row.
  // First click on a column: asc. Second click: desc. Third click: clear.
  const handleSort = useCallback((key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortKey(''); setSortDir('asc') }   // third click clears
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }, [sortKey, sortDir])

  // Flagged (low-quality / bad-take) clips are permanently hidden since
  // 2026-06-11, so every count the operator sees is computed over the
  // rows that can actually appear — a chip advertising clips the view
  // can never show reads as a bug.
  // Scoped to the page's category — Ads library shows ad creatives, the Shorts
  // page shows short-form (Ben 2026-06-28: shorts is its own page). No toggle.
  const visibleRows = useMemo(
    () => rows.filter(r => !r.is_low_quality && !r.is_bad_take
      && (r.content_category || 'ad') === category),
    [rows, category],
  )

  // Per-type counts for the chip badges (over all VISIBLE rows, ignoring current type filter)
  const typeCounts = useMemo(() => {
    const m = {}
    for (const r of visibleRows) m[r.type] = (m[r.type] || 0) + 1
    return m
  }, [visibleRows])

  const offerCounts = useMemo(() => {
    const m = { __none__: 0 }
    for (const r of visibleRows) {
      if (r.offer_slug) m[r.offer_slug] = (m[r.offer_slug] || 0) + 1
      else m.__none__ += 1
    }
    return m
  }, [visibleRows])

  const creatorCounts = useMemo(() => {
    const m = { __none__: 0 }
    for (const r of visibleRows) {
      if (r.creator) m[r.creator] = (m[r.creator] || 0) + 1
      else m.__none__ += 1
    }
    return m
  }, [visibleRows])

  const runCount    = useMemo(() => visibleRows.filter(r => r.has_been_run).length, [visibleRows])
  const notRunCount = useMemo(() => visibleRows.filter(r => !r.has_been_run).length, [visibleRows])
  const winnerCount = useMemo(() => visibleRows.filter(r => r.outcome === 'winner').length, [visibleRows])
  const loserCount  = useMemo(() => visibleRows.filter(r => r.outcome === 'loser').length, [visibleRows])
  const ungradedCount = useMemo(() => visibleRows.filter(r => !r.outcome).length, [visibleRows])
  // Stable reference for MatrixRow's editor dropdown — same memo concern
  // as openDrawer: avoid re-creating this array each render.
  // Excludes admins so they don't show up in assignment dropdowns.
  const activeEditors = useMemo(
    () => editors.filter(e => e.active && e.tier !== 'admin'),
    [editors],
  )
  // Status counts. 'Edited' includes Joined (since Joined is a sub-state of
  // edited). 'Merged' is a narrower filter showing only Joined.
  const stageCounts = useMemo(() => ({
    raw_all:    visibleRows.filter(r => r.status === 'raw').length,
    raw_unused: visibleRows.filter(r => r.status === 'raw' && !usedRawIds.has(r.id) && !r.assigned_editor_id && r.type !== 'Testimony').length,
    edited_seg: visibleRows.filter(r => r.status === 'edited').length,
  }), [visibleRows, usedRawIds])

  // Section groups for the list view — used when no type filter, shows
  // Hooks/Bodies/Joined/Testimony as separate sections. With multi-select
  // type filter, still group by type so each selected type gets its own
  // section.
  const grouped = useMemo(() => {
    // Inside a folder the operator is managing a BATCH (one angle/offer),
    // so the useful split is workflow state, not clip type: finished cuts
    // on top, raw source underneath. Type stays visible via the tile
    // pills. At the root (and during global search) keep the type
    // sections — that's a browse surface, not a batch.
    if (folderId && !deferredQ.trim()) {
      // 'review' = a finished cut awaiting approval — it belongs with the
      // edited work, not under "Raw footage".
      const isCut = (r) => r.status === 'edited' || r.status === 'review'
      const edited = filtered.filter(isCut)
      const raw = filtered.filter(r => !isCut(r))
      return [
        { type: 'Edited cuts', rows: edited },
        { type: 'Raw footage', rows: raw },
      ].filter(g => g.rows.length > 0)
    }
    const order = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']
    return order
      .map(t => ({ type: t, rows: filtered.filter(r => r.type === t) }))
      .filter(g => g.rows.length > 0)
  }, [filtered, folderId, deferredQ])

  // Unassigned raw clips that need an editor. Excludes Testimony per
  // Ben's rule ("testimony footage can just sit in there raw"), and
  // skips Hook auto-marked-used rows (already in the EDITED RAW
  // bucket via usedRawIds heuristic). Only counted on the FULL row
  // set, not the filtered view, so the warning is always accurate
  // even when the user has filters applied.
  const unassignedRawCount = useMemo(() => {
    let n = 0
    for (const r of rows) {
      if (r.status !== 'raw') continue
      if (r.type === 'Testimony') continue
      if (r.assigned_editor_id) continue
      if (usedRawIds.has(r.id)) continue
      // Flagged clips aren't assignment candidates — and since the
      // show/hide toggles were removed (2026-06-11) they're permanently
      // hidden, so counting them would promise rows the view can't show.
      if (r.is_low_quality || r.is_bad_take) continue
      n += 1
    }
    return n
  }, [rows, usedRawIds])

  // Recent submissions for the activity feed. Loads in the background
  // after first paint so the initial library render isn't blocked.
  // Joins through task -> creative so the bell card can show WHICH
  // video each editor finished (was just showing editor name + version,
  // useless without the creative context). Falls back to the creative's
  // thumbnail when the submission itself is a Drive/Frame.io link with
  // no inline thumbnail of its own.
  const [recentSubmissions, setRecentSubmissions] = useState([])
  const reloadSubmissions = useCallback(() => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    return supabase.from('lib_task_submissions')
      .select(`
        id, task_id, version_number, submitted_by_name, file_url, external_url,
        thumbnail_url, approved_at, created_at,
        ingest_status, ingest_source, ingest_error_text,
        task:lib_editing_tasks (
          id, creative_id,
          creative:lib_creative_library (
            id, canonical_name, name, type, creator, thumbnail_url, preview_url
          )
        )
      `)
      .gte('created_at', sevenDaysAgo)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setRecentSubmissions(data || []))
  }, [])
  useEffect(() => {
    let mounted = true
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    supabase.from('lib_task_submissions')
      .select(`
        id, task_id, version_number, submitted_by_name, file_url, external_url,
        thumbnail_url, approved_at, created_at,
        ingest_status, ingest_source, ingest_error_text,
        task:lib_editing_tasks (
          id, creative_id,
          creative:lib_creative_library (
            id, canonical_name, name, type, creator, thumbnail_url, preview_url
          )
        )
      `)
      .gte('created_at', sevenDaysAgo)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => { if (mounted) setRecentSubmissions(data || []) })
    return () => { mounted = false }
  }, [])

  // Filter helper for clicking the unassigned banner — narrows the view
  // to raw + unassigned non-Testimony rows by setting the existing
  // filter chips. Also turns OFF hide-low-quality and hide-bad-takes so
  // raw rows flagged for either don't get silently excluded — the banner
  // count ignores both flags, so the filtered view has to as well or the
  // operator sees "Nothing matches" while the banner still says N raw.
  const focusUnassignedRaw = useCallback(() => {
    setStageFilter(new Set(['raw_unused']))
    setTypeFilter(new Set(['Hook', 'Body', 'Joined', 'Full Video', 'Retargeting']))
    // NOTE: hide flags are left alone — the count now excludes flagged
    // clips, and the show/hide toggles are gone (2026-06-11), so unhiding
    // here would strand low-quality rows on screen with no way back.
    // Jump back to the library root (where the raw_unused view ignores
    // folder scoping) so folders can't hide rows the count promised.
    setFolderId(null)
  }, [])

  // Bulk download — for each selected row, kicks off a browser download
  // of its best available HIGH-QUALITY video URL. Priority matters:
  //   final_cut_url -- editor's approved final cut, always full quality
  //   drive_url     -- original ingest from Google Drive (older rows)
  //   preview_url   -- LAST resort; for older Drive-imported rows this
  //                    is a 720p transcode (looks dog shit on download),
  //                    but for new TUS-uploaded rows it IS the original.
  // Putting drive_url before preview_url means the old Drive-imported
  // rows download the original Drive file instead of the compressed
  // preview, which is the source of the "quality is terrible" complaint.
  // Sequential with a small stagger so the browser doesn't dedupe
  // simultaneous downloads to the same origin.
  const bulkDownload = useCallback(() => {
    const ids = Array.from(selected)
    const targets = ids
      .map(id => rows.find(r => r.id === id))
      .filter(Boolean)
      .map(r => ({
        name: rowDisplayName(r),
        url: r.final_cut_url || r.drive_url || r.preview_url,
      }))
      .filter(t => t.url)
    if (targets.length === 0) return
    targets.forEach((t, i) => {
      setTimeout(() => {
        const a = document.createElement('a')
        // Rewrite to ?download=<filename> so Supabase serves with
        // Content-Disposition: attachment and the browser saves the
        // raw bytes to disk instead of streaming the video in a tab.
        a.href = toDownloadUrl(t.url, t.name || 'creative.mp4')
        a.download = t.name || 'creative.mp4'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 180)
    })
  }, [selected, rows])

  // ── Folder CRUD (migration 146) ────────────────────────────────────
  // Clip counts per folder, for the folder cards. Respects the default-on
  // hide flags so a card never advertises clips that render as "Nothing
  // matches" when the folder is opened (a folder of hidden bad takes
  // saying "2 clips" but opening empty reads as data loss).
  const folderClipCounts = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      if (!r.folder_id) continue
      if (hideLowQuality && r.is_low_quality) continue
      if (hideBadTakes && r.is_bad_take) continue
      m.set(r.folder_id, (m.get(r.folder_id) || 0) + 1)
    }
    return m
  }, [rows, hideLowQuality, hideBadTakes])

  const syncFolders = useCallback((updater) => {
    setFolders(curr => {
      const next = updater(curr)
      PAGE_CACHE.folders = next
      return next
    })
  }, [])
  const syncRows = useCallback((updater) => {
    setRows(curr => {
      const next = updater(curr)
      PAGE_CACHE.rows = next
      return next
    })
  }, [])

  // New folders are created inside the folder currently open — same as
  // Drive's "New folder" button.
  const createFolder = useCallback(async (name) => {
    const { data, error } = await supabase.from('lib_creative_folders')
      .insert({ name, parent_id: folderId })
      .select('id,name,parent_id').single()
    if (error) throw error
    syncFolders(curr => [...curr, data])
    return data   // upload modal uses the new id to file the batch
  }, [folderId, syncFolders])

  // Rename + re-parent share one write path; both are a single-column
  // patch on the folder row.
  const patchFolder = useCallback(async (folder, patch) => {
    const { error } = await supabase.from('lib_creative_folders')
      .update(patch).eq('id', folder.id)
    if (error) throw error
    syncFolders(curr => curr.map(f => f.id === folder.id ? { ...f, ...patch } : f))
  }, [syncFolders])
  // Stable wrappers — FolderBar is memoized; inline lambdas in its JSX
  // would defeat the memo on every parent render.
  const renameFolder = useCallback((folder, name) => patchFolder(folder, { name }), [patchFolder])
  const reparentFolder = useCallback((folder, parentId) => patchFolder(folder, { parent_id: parentId }), [patchFolder])

  // Delete = subtree gone, clips released to the deleted folder's parent
  // (never deleted). The release + delete run atomically server-side
  // (lib_delete_creative_folder RPC) so a failure can't leave clips moved
  // but the folder alive. If the operator is standing inside the deleted
  // subtree, hop them up to the surviving parent.
  const deleteFolder = useCallback(async (folder) => {
    const { error } = await supabase.rpc('lib_delete_creative_folder', { p_folder_id: folder.id })
    if (error) throw error
    const removed = subtreeIds(folders, folder.id)
    syncFolders(curr => curr.filter(f => !removed.has(f.id)))
    syncRows(curr => curr.map(r => removed.has(r.folder_id) ? { ...r, folder_id: folder.parent_id || null } : r))
    if (folderId && removed.has(folderId)) setFolderId(folder.parent_id || null, { replace: true })
  }, [folders, folderId, setFolderId, syncFolders, syncRows])

  // Moving a clip moves its WHOLE version family (parent_id chain).
  // Filing v1 while v2 stays behind would split the family across
  // folders — and with "latest only" on, hide it from both views.
  const moveClipsToFolder = useCallback(async (ids, destId) => {
    const roots = new Set()
    for (const id of ids) {
      const r = rows.find(x => x.id === id)
      roots.add(r?.parent_id || id)
    }
    const family = rows.filter(r => roots.has(r.parent_id || r.id)).map(r => r.id)
    const { error } = await supabase.from('lib_creative_library')
      .update({ folder_id: destId }).in('id', family)
    if (error) throw error
    const idSet = new Set(family)
    syncRows(curr => curr.map(r => idSet.has(r.id) ? { ...r, folder_id: destId } : r))
  }, [rows, syncRows])

  // Stable navigate handler — FolderBar is memoized, an inline lambda
  // would re-render the whole card grid on every keystroke. Scroll to top
  // because entering a folder is a page navigation, not a filter tweak.
  const navigateFolder = useCallback((id) => {
    setFolderId(id)
    window.scrollTo({ top: 0 })
  }, [setFolderId])
  // Selection clears on ANY folder change — including browser back/
  // forward, which never goes through navigateFolder — so a bulk action
  // can't target rows that are no longer on screen.
  useEffect(() => { clearSelection() }, [folderId, clearSelection])

  // Drag a clip onto a folder card / breadcrumb (Drive behaviour). If the
  // dragged tile is part of the current selection the whole selection
  // travels; otherwise just that clip. Payload is ids only — the drop side
  // re-resolves rows, so a stale drag can't move ghosts.
  const onClipDragStart = useCallback((row, e) => {
    const ids = selected.has(row.id) ? Array.from(selected) : [row.id]
    e.dataTransfer.setData('application/x-lib-clips', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'move'
    setDragActive(true)
  }, [selected])

  const dropClipsToFolder = useCallback(async (ids, destId) => {
    const destName = destId ? (folders.find(f => f.id === destId)?.name || 'folder') : 'the library root'
    showToast(`Moving ${ids.length} clip${ids.length === 1 ? '' : 's'}…`)
    try {
      await moveClipsToFolder(ids, destId)
      clearSelection()
      showToast(`✓ Moved ${ids.length} clip${ids.length === 1 ? '' : 's'} to ${destName}`)
    } catch (e) {
      setToast(null)
      setErr(e.message || 'Move failed')
    }
  }, [moveClipsToFolder, clearSelection, folders, showToast])

  // Badge for the FILTERS button: how many filter groups are active.
  const activeFilterCount =
    stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size + outcomeFilter.size

  // Where the current selection lives, for the move picker's "current"
  // tag + no-op guard: a folder id (or null = root) only when EVERY
  // selected clip agrees; undefined (no guard) for mixed selections,
  // which global search makes possible.
  const selectionFolderId = useMemo(() => {
    if (!moveFolderOpen) return undefined
    const fids = new Set(Array.from(selected).map(id => rows.find(r => r.id === id)?.folder_id || null))
    return fids.size === 1 ? fids.values().next().value : undefined
  }, [moveFolderOpen, selected, rows])

  return (
    <>
      {/* Notification surface — editors get the editor-side bell
          (personal feed of feedback / assignments / source updates /
          approvals), admins get the recent-submissions bell. Two
          different bells reading two different tables.
          Assignment coordinators (e.g. Kirill, flagged via
          notify_on_unassigned) ALSO get the editor-side bell mounted
          so they see new_upload_needs_assignment notifications in
          the dashboard alongside the admin submissions bell. */}
      {/* Bell tray — single fixed-position container that holds whichever
          bells are mounted for this scope. Positioned at top:76 right:16
          so it sits BELOW the dashboard chrome (the avatar/menu live at
          top:12 area) instead of overlapping it (Ben 2026-05-31). Flex
          row means multiple bells stack horizontally with a small gap
          instead of piling on top of each other. */}
      <div style={{
        position: 'fixed', top: 76, right: 12, zIndex: 90,
        display: 'flex', gap: 8, alignItems: 'center',
        // Narrow windows: the tray must never push past the viewport edge
        // (Ben 2026-06-11 — Inbox/Activity buttons were clipping). Wrap
        // right-aligned instead of overflowing.
        maxWidth: 'calc(100vw - 24px)', flexWrap: 'wrap', justifyContent: 'flex-end',
      }}>
        {!scope.isEditorView && coordinatorEditorId && (
          <EditorNotificationBell
            ref={inboxBellRef}
            editorId={coordinatorEditorId}
            onOpenCreative={(creativeId) => {
              // Same in-place drawer open the Activity bell uses — find in
              // rows, fall back to a one-shot fetch if filtered out. This
              // replaces the previous window.location.href reload that
              // blanked the whole dashboard just to land back here.
              const local = rows.find(r => r.id === creativeId)
              if (local) {
                openDrawer(local)
              } else {
                supabase.from('lib_creative_library')
                  .select('*')
                  .eq('id', creativeId)
                  .maybeSingle()
                  .then(({ data }) => { if (data) openDrawer(data) })
              }
            }}
            companionLabel="Activity →"
            onCompanion={() => activityBellRef.current?.open()}
          />
        )}
        {scope.isEditorView && scope.editorId && (
          <EditorNotificationBell
            editorId={scope.editorId}
            onOpenTask={(taskId) => {
              // We need to find the matching task row to open the modal.
              // The editor portal renders EditingQueueTab; the task open
              // happens via tab.setEditingTask. But this bell lives in
              // LibraryTab. Easiest: navigate the URL with ?task=<id>
              // and let the queue tab pick it up.
              try {
                const url = new URL(window.location.href)
                url.searchParams.set('task', taskId)
                window.history.replaceState({}, '', url.toString())
                // Force the editor portal to switch to the queue tab
                // where the editing task modals live.
                try { localStorage.setItem('lib.tab', 'queue') } catch {}
                // Round-trip reload so EditingQueueTab picks up the
                // ?task= param and pops the modal cleanly.
                window.location.reload()
              } catch {}
            }}
          />
        )}
        {!scope.isEditorView && (
          <NotificationBell
            ref={activityBellRef}
            submissions={recentSubmissions}
            onOpenCreative={(creativeId) => {
              // Find the creative in rows + open the detail modal. If it's not
              // in the current filter (e.g. low-quality hidden), pull it
              // directly from the DB by id so we can still open the drawer.
              const local = rows.find(r => r.id === creativeId)
              if (local) {
                openDrawer(local)
              } else {
                supabase.from('lib_creative_library')
                  .select('*')
                  .eq('id', creativeId)
                  .maybeSingle()
                  .then(({ data }) => { if (data) openDrawer(data) })
              }
            }}
            companionLabel={coordinatorEditorId ? '← Inbox' : null}
            onCompanion={coordinatorEditorId ? () => inboxBellRef.current?.open() : null}
          />
        )}
      </div>

      {/* Upload dock — floating bottom-right indicator showing the
          background upload queue. Survives modal close + tab navigation.
          Refreshes the library list whenever the queue empties so new
          rows surface without a manual refresh. */}
      <UploadDock onRefresh={() => load(true)} />
      <TopUploadProgressBar />

      {/* Toolbar — ONE visible row. The five filter dropdowns + toggles
          live behind a single FILTERS button (count badge = active
          filters) so the resting state is calm; the old full-width yellow
          banner is now the compact ⚠ icon next to the search box. */}
      <div style={{
        padding: '10px 14px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 14,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, description, transcript, notes…"
            style={{
              flex: '1 1 280px', maxWidth: 420,
              padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 12.5,
              background: 'var(--paper)', border: '1px solid var(--rule)', outline: 'none',
            }} />
          {/* Needs-attention icon — replaces the old full-width banner.
              Click applies the same "unassigned raw" filter set. */}
          {unassignedRawCount > 0 && (
            <button type="button"
              onClick={() => { focusUnassignedRaw(); setFiltersOpen(true) }}
              title={`${unassignedRawCount} raw creative${unassignedRawCount === 1 ? '' : 's'} need editor assignment — click to filter to them`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 9px',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                background: '#fff3d1', color: '#9a4d00',
                border: '1.5px solid #d68f00', borderRadius: 9, cursor: 'pointer',
              }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
              {unassignedRawCount}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
            {filtered.length} / {visibleRows.length}
          </span>
          <button type="button"
            onClick={() => setFiltersOpen(v => !v)}
            style={{
              padding: '6px 12px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: filtersOpen || activeFilterCount > 0 ? 'var(--ink)' : 'var(--paper)',
              color: filtersOpen || activeFilterCount > 0 ? 'var(--paper)' : 'var(--ink)',
              border: '1px solid ' + (filtersOpen || activeFilterCount > 0 ? 'var(--ink)' : 'var(--rule)'),
              cursor: 'pointer',
            }}>
            Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''} {filtersOpen ? '▴' : '▾'}
          </button>
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
            <ViewBtn active={view === 'tile'}   onClick={() => setView('tile')}>Tiles</ViewBtn>
            <ViewBtn active={view === 'list'}   onClick={() => setView('list')}>List</ViewBtn>
            <ViewBtn active={view === 'matrix'} onClick={() => setView('matrix')}>Matrix</ViewBtn>
          </div>
          {scope.canUpload && (
            <button onClick={() => setUploadOpen(true)} style={primaryBtn}>
              + Upload creative
            </button>
          )}
          {/* Share with editor — removed at Ben's request 2026-06-26
              ("don't need this right now"). ShareLinksModal + state kept
              intact below so it's a one-line restore. */}
        </div>

        {/* Expanded filter panel — everything that used to be a permanent
            second row of chips. Collapsed by default; the FILTERS button
            badge keeps active filters discoverable while hidden. */}
        {filtersOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule)',
        }}>
          <FilterDropdown label="STATUS"
            selected={stageFilter}
            options={[
              // Two states only (Ben 2026-06-29 retired "Edited raw"):
              //   RAW    = needs editing
              //   EDITED = a finished cut (status='edited' in the DB)
              { value: 'raw_all',    label: 'RAW',    sublabel: 'needs editing', count: stageCounts.raw_all,    dot: 'var(--down)' },
              { value: 'edited_seg', label: 'EDITED', sublabel: 'finished cut',  count: stageCounts.edited_seg, dot: 'var(--up)' },
            ]}
            allCount={visibleRows.length}
            onChange={setStageFilter} />
          <FilterDropdown label="TYPE"
            selected={typeFilter}
            options={TYPES.map(t => ({ value: t, label: t.toUpperCase(), count: typeCounts[t] || 0, dot: typeColor(t).ink }))}
            allCount={visibleRows.length}
            onChange={setTypeFilter} />
          <FilterDropdown label="OFFER"
            selected={offerFilter}
            options={[
              ...offers.map(o => ({
                value: o.slug,
                label: o.slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '').toUpperCase(),
                count: offerCounts[o.slug] || 0,
                dot: offerColor(o.slug).ink,
              })),
              ...(offerCounts.__none__ > 0 ? [{ value: '__none__', label: 'NO OFFER', count: offerCounts.__none__, dot: 'var(--ink-4)' }] : []),
            ]}
            allCount={visibleRows.length}
            onChange={setOfferFilter} />
          {/* Creator filter removed 2026-06-26 (Ben). */}
          <FilterDropdown label="RUN"
            selected={runFilter}
            options={[
              { value: 'yes', label: 'RUN BEFORE', count: runCount,    dot: 'var(--up)' },
              { value: 'no',  label: 'NOT YET',    count: notRunCount, dot: 'var(--ink-4)' },
            ]}
            allCount={visibleRows.length}
            onChange={setRunFilter} />
          <FilterDropdown label="GRADE"
            selected={outcomeFilter}
            options={[
              { value: 'winner',   label: 'WINNERS',  count: winnerCount,   dot: 'var(--up)' },
              { value: 'loser',    label: 'LOSERS',   count: loserCount,    dot: 'var(--down)' },
              { value: 'ungraded', label: 'UNGRADED', count: ungradedCount, dot: 'var(--ink-4)' },
            ]}
            allCount={visibleRows.length}
            onChange={setOutcomeFilter} />
          {/* Uploaded-date filter, latest-only and the low-quality / bad-take
              show/hide toggles removed 2026-06-11 (Ben: too much noise).
              Flagged clips are now simply always hidden; their state vars
              keep their defaults so the filter pipeline is unchanged. */}
          {(stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size + outcomeFilter.size + creatorFilter.size > 0) && (
            <button type="button"
              onClick={() => {
                setStageFilter(new Set()); setTypeFilter(new Set())
                setOfferFilter(new Set()); setRunFilter(new Set())
                setOutcomeFilter(new Set()); setCreatorFilter(new Set())
              }}
              style={{
                marginLeft: 4, padding: '4px 9px',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-3)',
                border: '1px solid var(--rule)', cursor: 'pointer',
              }}>Clear filters</button>
          )}
          {/* Bulk-edit discovery hint. Visible only when nothing is selected
              and the operator can actually edit. Single-click selects every
              currently-visible row so the operator can immediately see the
              bulk bar appear. */}
          {selected.size === 0 && scope.canEditCreative && filtered.length > 0 && (view === 'matrix' || view === 'list') && (
            <button type="button"
              onClick={() => setSelected(new Set(filtered.map(r => r.id)))}
              title="Click any row's checkbox (left column) to start a bulk selection, or this button to select all visible rows. Bulk-edit creator, status, editor, offer, type."
              style={{
                marginLeft: 'auto', padding: '5px 10px',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'var(--paper)', color: 'var(--ink)',
                border: '1.5px dashed var(--ink-3)', cursor: 'pointer',
                borderRadius: 9,
              }}>☐ Bulk edit · select all {filtered.length}</button>
          )}
          {/* Occasional utility, not a daily control — lives in the panel
              so the resting toolbar stays one row. */}
          {scope.canUpload && (
            <RenameUnnamedButton rows={rows} onComplete={() => load(true)} />
          )}
        </div>
        )}
      </div>

      {err && <ErrorBanner msg={err} onRetry={() => load(false)} />}

      {/* Drive-style folder navigation — breadcrumb + folder cards for
          the folder currently open. Hidden entirely until the first
          folder exists. While a search is active the cards hide and a
          "search covers all folders" tag shows instead, because results
          are global. */}
      {!isShorts && (
        <FolderBar
          folders={folders}
          currentFolderId={folderId}
          onNavigate={navigateFolder}
          clipCounts={folderClipCounts}
          searching={Boolean(deferredQ.trim()) || filtersActive}
          canManage={scope.canEditCreative}
          onCreate={createFolder}
          onRename={renameFolder}
          onDelete={deleteFolder}
          onMoveFolder={reparentFolder}
          onDropClips={dropClipsToFolder}
          dropReady={dragActive}
          onError={setErr}
        />
      )}

      {/* Move-confirmation pill — fixed bottom-center, Drive-style */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          zIndex: 120, padding: '10px 18px',
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
          letterSpacing: '0.05em', borderRadius: 9,
          boxShadow: '0 6px 24px rgba(10,10,10,0.35)',
          pointerEvents: 'none',
        }}>{toast}</div>
      )}

      {/* Bulk selection bar — sticky, appears when ≥1 tile is selected */}
      {selected.size > 0 && scope.canEditCreative && (
        <div style={{
          position: 'sticky', top: 64, zIndex: 50,
          marginBottom: 14, padding: '10px 14px',
          background: 'var(--ink)', color: 'var(--paper)',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.08em',
          }}>
            {selected.size} selected
          </span>
          <button onClick={() => setSelected(new Set(filtered.map(r => r.id)))}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all visible ({filtered.length})</button>
          <button onClick={clearSelection}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
          <span style={{ flex: 1 }} />
          <button onClick={bulkDownload} disabled={bulkBusy}
            title="Trigger a browser download of each selected file (final cut ▸ preview ▸ drive)"
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer',
            }}>↓ Download {selected.size}</button>
          <button onClick={() => setMoveFolderOpen(true)} disabled={bulkBusy}
            title="Move the selected clips (and their other versions) into a folder"
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer',
            }}>Move to folder</button>
          <button onClick={() => setBulkEditOpen(true)} disabled={bulkBusy}
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'var(--accent)', color: 'var(--ink)',
              border: 'none', cursor: 'pointer',
            }}>Bulk edit {selected.size}</button>
        </div>
      )}

      {loading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'grid', gap: 24 }}>
          {grouped.map(group => (
            <section key={group.type}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10,
              }}>
                <h3 style={{
                  margin: 0, fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500,
                  color: 'var(--ink)',
                }}>{group.type}</h3>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>{group.rows.length} clip{group.rows.length === 1 ? '' : 's'}</span>
              </div>
              {view === 'tile' ? (
                <div style={{
                  display: 'grid', gap: 14,
                  // Uniform cells — consistent column count regardless of the
                  // filtered mix (Ben: must not jump 8→4 per row). Edited clips
                  // are distinguished by the green EDITED pill, not by size.
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                }}>
                  {group.rows.map(r => (
                    <CreativeCard key={r.id} row={r}
                      isUsed={usedRawIds.has(r.id)}
                      onClick={() => setDrawerRow(r)}
                      selected={selected.has(r.id)}
                      selectionMode={selected.size > 0}
                      onToggleSelect={scope.canEditCreative ? toggleSelect : null}
                      onDragStartClip={scope.canEditCreative ? onClipDragStart : null} />
                  ))}
                </div>
              ) : view === 'list' ? (
                <CreativeListView
                  rows={group.rows}
                  usedRawIds={usedRawIds}
                  onClick={setDrawerRow}
                  onDelete={scope.canDelete ? setConfirmDelete : null}
                  selected={selected}
                  selectionMode={selected.size > 0}
                  onToggleSelect={scope.canEditCreative ? toggleSelect : null}
                  onDragStartClip={scope.canEditCreative ? onClipDragStart : null}
                />
              ) : (
                <CreativeMatrixView
                  rows={group.rows}
                  editors={activeEditors}
                  offers={offers}
                  creators={knownCreators}
                  usedRawIds={usedRawIds}
                  onRowClick={openDrawer}
                  onPatch={scope.canEditCreative ? patchRow : null}
                  /* onAssignEditor enabled separately so team-wide
                     editor portal can reassign rows without unlocking
                     every other inline cell. */
                  onAssignEditor={(scope.canEditCreative || scope.canAssignEditor) ? patchRow : null}
                  selected={selected}
                  selectionMode={selected.size > 0}
                  onToggleSelect={scope.canEditCreative ? toggleSelect : null}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
              )}
            </section>
          ))}
        </div>
      )}

      {drawerRow && (
        <CreativeDetailModal
          // Remount per row so local state (viewRaw toggle, approvedSub fetch,
          // edit form) resets when navigating between clips via VersionsPanel /
          // UsageHistory — otherwise the raw/edit toggle leaks across rows.
          key={drawerRow.id}
          row={drawerRow}
          isUsed={!!usedRawIds?.has(drawerRow.id)}
          scope={scope}
          editors={editors}
          offers={offers}
          knownCreators={knownCreators}
          onOpenRow={openRowById}
          onClose={() => startTransition(() => setDrawerRow(null))}
          onSaved={() => { load(true) }}
          onRowPatched={(id, patch) => {
            // Merge changed fields into the parent's rows state.
            // No full DB reload — DB is already updated by the modal's
            // debounced auto-save. Updates the assigned_editor_name
            // derived field too.
            setRows(curr => curr.map(r => {
              if (r.id !== id) return r
              const next = { ...r, ...patch }
              if ('assigned_editor_id' in patch) {
                const ed = editors.find(e => e.id === patch.assigned_editor_id)
                next.assigned_editor_name = ed?.name || null
              }
              return next
            }))
          }}
          onDeleted={() => {
            // Remove the row from local state instead of calling load()
            // — load() refetches everything and the page scrolls to top.
            const id = drawerRow?.id
            setDrawerRow(null)
            if (id) {
              setRows(curr => curr.filter(r => r.id !== id))
              if (PAGE_CACHE.rows) PAGE_CACHE.rows = PAGE_CACHE.rows.filter(r => r.id !== id)
            }
          }}
        />
      )}

      {shareLinksOpen && (
        <ShareLinksModal
          editors={editors}
          onClose={() => setShareLinksOpen(false)}
        />
      )}
      {uploadOpen && (
        <UploadModal
          editors={editors}
          offers={offers}
          defaultCategory={category}
          knownCreators={knownCreators}
          folderId={isShorts ? null : folderId}
          folders={isShorts ? [] : folders}
          onCreateFolder={createFolder}
          onClose={() => setUploadOpen(false)}
          onSaved={() => { setUploadOpen(false); load() }}
          onOfferAdded={(newOffer) => {
            // Optimistically push the new niche into local + cache so the
            // dropdown shows it immediately (including in other modals
            // that read from the same prop). The next full load() will
            // confirm it from the DB.
            setOffers(curr => {
              if (curr.some(o => o.slug === newOffer.slug)) return curr
              return [...curr, newOffer].sort((a, b) => (a.slug || '').localeCompare(b.slug || ''))
            })
            if (Array.isArray(PAGE_CACHE.offers) && !PAGE_CACHE.offers.some(o => o.slug === newOffer.slug)) {
              PAGE_CACHE.offers = [...PAGE_CACHE.offers, newOffer]
            }
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          row={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => {
            const id = confirmDelete?.id
            setConfirmDelete(null)
            if (id) {
              setRows(curr => curr.filter(r => r.id !== id))
              if (PAGE_CACHE.rows) PAGE_CACHE.rows = PAGE_CACHE.rows.filter(r => r.id !== id)
            }
          }}
        />
      )}

      {bulkEditOpen && (
        <BulkEditModal
          ids={Array.from(selected)}
          editors={editors}
          offers={offers}
          knownCreators={knownCreators}
          onClose={() => setBulkEditOpen(false)}
          onSaved={(updatedIds, patch) => {
            // Merge the patch into local rows state instead of refetching —
            // keeps scroll position, filters, and section expansion intact.
            // Derive assigned_editor_name from the editors array so the
            // editor chip on each row updates without a roundtrip.
            const editor = patch.assigned_editor_id
              ? editors.find(e => e.id === patch.assigned_editor_id)
              : null
            const idSet = new Set(updatedIds)
            setRows(curr => curr.map(r => {
              if (!idSet.has(r.id)) return r
              const merged = { ...r, ...patch }
              if (patch.assigned_editor_id !== undefined) {
                merged.assigned_editor_name = editor?.name || null
              }
              return merged
            }))
            setBulkEditOpen(false)
            clearSelection()
          }} />
      )}

      {moveFolderOpen && (
        <FolderPickerModal
          title={`Move ${selected.size} clip${selected.size === 1 ? '' : 's'}`}
          subtitle="Pick a destination. A clip's other versions move with it; each clip lives in exactly one folder."
          folders={folders}
          currentId={selectionFolderId}
          onClose={() => setMoveFolderOpen(false)}
          onPick={async (destId) => {
            await dropClipsToFolder(Array.from(selected), destId)
            setMoveFolderOpen(false)
          }}
        />
      )}
    </>
  )
}

function ViewBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px',
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'transparent',
      color: active ? 'var(--paper)' : 'var(--ink-3)',
      border: 'none', cursor: 'pointer',
    }}>{children}</button>
  )
}

function BigToggle({ active, onClick, label, count, subtitle }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '14px 20px', textAlign: 'left',
      cursor: 'pointer', border: 'none',
      borderRight: '1px solid var(--rule)',
      background: active ? 'var(--ink)' : 'var(--paper)',
      color: active ? 'var(--paper)' : 'var(--ink)',
      transition: 'background 0.12s',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4,
      }}>
        <span style={{
          fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500,
        }}>{label}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
          color: active ? 'rgba(255,255,255,0.7)' : 'var(--ink-3)',
        }}>{count}</span>
      </div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 11.5, lineHeight: 1.35,
        color: active ? 'rgba(255,255,255,0.7)' : 'var(--ink-3)',
      }}>{subtitle}</div>
    </button>
  )
}

function FilterChip({ active, onClick, children, count, color }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 11px',
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'var(--paper)',
      color: active ? 'var(--paper)' : 'var(--ink-2)',
      border: '1px solid ' + (active ? 'var(--ink)' : 'var(--rule)'),
      borderRadius: 9, cursor: 'pointer',
    }}>
      {color && !active && (
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      )}
      <span>{children}</span>
      {count != null && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          color: active ? 'rgba(255,255,255,0.6)' : 'var(--ink-4)',
        }}>{count}</span>
      )}
    </button>
  )
}

function LivePulseDot() {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 8, height: 8 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: 'var(--up)',
      }} />
      <span style={{
        position: 'absolute', inset: -3, borderRadius: '50%',
        background: 'var(--up)', opacity: 0.4,
        animation: 'libPulse 1.6s ease-in-out infinite',
      }} />
      <style>{`@keyframes libPulse {
        0%   { transform: scale(0.6); opacity: 0.55 }
        70%  { transform: scale(1.6); opacity: 0 }
        100% { transform: scale(1.6); opacity: 0 }
      }`}</style>
    </span>
  )
}

function StatusBadge({ status }) {
  if (status === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--up)',
      }}>
        <LivePulseDot /> Live
      </span>
    )
  }
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: STATUS_COLOR[status] || 'var(--ink-3)',
    }}>{STATUS_LABEL[status] || status}</span>
  )
}

// memo'd for the same reason as CreativeMatrixView — modal open/close
// shouldn't force the entire list to re-render when no list-relevant
// props changed.
const CreativeListView = memo(function CreativeListView({ rows, usedRawIds, onClick, onDelete, selected, selectionMode, onToggleSelect, onDragStartClip = null }) {
  // Selectable adds a 26px checkbox column at the very left. Mirrors the
  // matrix view so bulk-edit works identically across both view modes.
  const selectable = !!onToggleSelect
  // Added an "Uploaded" column between Status and Actions so the operator
  // can scan upload dates at a glance and combine with the date filter.
  const gridCols = selectable
    ? '26px 52px minmax(220px, 1.6fr) 90px 90px 130px 70px 80px 90px 80px'
    : '52px minmax(220px, 1.6fr) 90px 90px 130px 70px 80px 90px 80px'

  // Header "select all visible" handler. Toggles all rows currently in
  // this group's list — caller passes group.rows so the meaning matches
  // what the operator sees.
  const allVisible = selectable && rows.length > 0 && rows.every(r => selected?.has(r.id))
  const someVisible = selectable && rows.some(r => selected?.has(r.id)) && !allVisible
  const toggleAll = () => {
    if (!selectable) return
    if (allVisible) rows.forEach(r => onToggleSelect(r.id))
    else            rows.forEach(r => !selected?.has(r.id) && onToggleSelect(r.id))
  }

  return (
    // overflow-x: the row template needs ~1064px; on tablets the action
    // columns were hard-clipped (≤768px CSS hides main overflow).
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)', overflowX: 'auto' }}>
    <div style={{ minWidth: 1064 }}>
      <div style={{
        display: 'grid', gridTemplateColumns: gridCols,
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
        alignItems: 'center',
      }}>
        {selectable && (
          <div onClick={toggleAll} title="Select / deselect all visible rows in this group — then bulk-edit creator, status, editor, offer, etc."
            style={{
              width: 18, height: 18, borderRadius: 9,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'var(--paper)'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}>
            {allVisible && (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someVisible && (
              <span style={{ width: 9, height: 2.5, background: 'var(--ink)' }} />
            )}
          </div>
        )}
        <div></div>
        <div>Name</div>
        <div>Type</div>
        <div>Creator</div>
        <div>Offer</div>
        <div>Run?</div>
        <div>Status</div>
        <div>Uploaded</div>
        <div style={{ textAlign: 'right' }}>Actions</div>
      </div>
      {rows.map((r, i) => (
        <ListRow key={r.id} row={r} isLast={i === rows.length - 1}
          isUsed={usedRawIds?.has(r.id)}
          gridCols={gridCols}
          selectable={selectable}
          selected={selected?.has(r.id)}
          selectionMode={selectionMode}
          onToggleSelect={onToggleSelect}
          onDragStartClip={onDragStartClip}
          onClick={() => onClick(r)} onDelete={() => onDelete(r)} />
      ))}
    </div>
    </div>
  )
})

function ListRow({ row: r, isLast, gridCols, isUsed, onClick, onDelete, selectable, selected, selectionMode, onToggleSelect, onDragStartClip = null }) {
  // `onDelete` may be null when the viewer doesn't have delete permission
  const [hover, setHover] = useState(false)
  // In selection mode, body-clicks toggle selection instead of opening
  // the detail drawer — matches matrix-view behaviour.
  const handleRowClick = () => {
    if (selectionMode && selectable) onToggleSelect?.(r.id)
    else onClick()
  }
  // Debounced hover-to-play. The raw `hover` boolean drives the visual
  // (paper-2 tint) immediately; `hoverPlay` is only set 320ms after
  // hover begins, so dragging the mouse across 200 rows no longer
  // spawns 200 video elements / network requests.
  const [hoverPlay, setHoverPlay] = useState(false)
  useEffect(() => {
    if (!hover) { setHoverPlay(false); return }
    const t = setTimeout(() => setHoverPlay(true), 120)
    return () => clearTimeout(t)
  }, [hover])
  const offerName = r.offer_slug ? r.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '') : null
  const oc = offerColor(r.offer_slug)
  // Left stripe color matches Matrix view: red = raw needs editing,
  // grey = raw already merged, green = edited, orange = merged final
  const stripeColor =
    (r.type === 'Joined' && r.status === 'edited') ? '#b86a0c'
    : (r.status === 'edited')                       ? 'var(--up)'
    : (r.status === 'raw' && isUsed)                ? 'var(--ink-4)'
    :                                                 'var(--down)'
  // Soft full-row tint that lets Ben see at a glance:
  //   green = edited / done
  //   yellow = assigned to an editor, in progress
  //   red = raw + unassigned + actually needs editing (i.e. not auto-used Hooks)
  const tint = rowStatusTint(r, isUsed)
  return (
        <div
          style={{
            display: 'grid', gridTemplateColumns: gridCols,
            padding: '10px 14px', gap: 12, alignItems: 'center',
            borderBottom: isLast ? 'none' : '1px solid var(--rule)',
            borderLeft: `3px solid ${stripeColor}`,
            background: selected
              ? 'rgba(244,225,74,0.15)'
              : (hover ? (tint?.hover || 'var(--paper-2)') : (tint?.base || 'transparent')),
            transition: 'background 0.12s',
            cursor: 'pointer',
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          draggable={!!onDragStartClip}
          onDragStart={onDragStartClip ? (e) => onDragStartClip(r, e) : undefined}
          onClick={handleRowClick}>
          {selectable && (
            <div onClick={(e) => { e.stopPropagation(); onToggleSelect?.(r.id) }}
              title="Select for bulk edit"
              style={{
                width: 16, height: 16, borderRadius: 9,
                border: selected ? '2px solid var(--ink)' : (hover ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)'),
                background: selected ? 'var(--accent)' : 'var(--paper)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
                transition: 'border-color 0.08s',
              }}>
              {selected && (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          )}
          {/* Thumb. Hover-to-play used to swap to a <video> on every
              mouseenter — that fired N requests for every pass of the
              mouse and tanked scroll perf. Now we wait for `hoverPlay`
              (set after a 320ms hover via the parent's debounced
              useEffect), then load the preview with preload=metadata. */}
          <div style={{
            width: 56, height: 36, background: '#000',
            border: '1px solid var(--rule)', overflow: 'hidden',
            position: 'relative',
          }}>
            {(() => {
              // Image rows: render preview_url (the full-quality original)
              // not thumbnail_url. For NEW image uploads these are the same
              // URL, but for OLD Drive-imported rows the thumbnail can be
              // a downscaled Drive transcode — saving the wrong file via
              // right-click "Save image as". Hover-to-play is video-only.
              const isImageContent = r.preview_url && /\.(jpe?g|png|webp|gif|heic|heif)(\?|$)/i.test(r.preview_url)
              const tileSrc = isImageContent ? r.preview_url : r.thumbnail_url
              const showVideoHover = hoverPlay && r.preview_url && !isImageContent
              return (
                <>
                  {tileSrc && !showVideoHover && (
                    <img src={tileSrc} alt="" loading="lazy" draggable={false}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  )}
                  {showVideoHover && (
                    <video src={r.preview_url} autoPlay muted loop playsInline preload="metadata" draggable={false}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  )}
                </>
              )
            })()}
          </div>
          {/* Name */}
          <div style={{ minWidth: 0 }}>
            {/* title= surfaces the full display_name on hover (browser-
                native tooltip). Names are longer post-overhaul and the
                row wraps in ellipsis, so without this the operator has
                to open the modal to read the messaging slot. */}
            <div title={rowDisplayName(r)} style={{
              fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500,
              color: 'var(--ink)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textDecoration: (r.status === 'raw' && isUsed) ? 'line-through' : 'none',
              opacity: (r.status === 'raw' && isUsed) ? 0.7 : 1,
            }}>
              {(r.status === 'raw' && isUsed) && (
                <span title="Already edited"
                  style={{ color: 'var(--up)', fontWeight: 600, marginRight: 5 }}>✓</span>
              )}
              {rowDisplayName(r)}
            </div>
          </div>
          {/* Type pill */}
          <div>
            <span style={{
              display: 'inline-block',
              padding: '2px 7px',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: typeColor(r.type).soft,
              color: typeColor(r.type).ink,
              border: '1px solid ' + typeColor(r.type).border,
              borderRadius: 9,
            }}>{r.type}</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.creator || '—'}</div>
          {/* Offer pill */}
          <div>
            {offerName ? (
              <span style={{
                display: 'inline-block', padding: '2px 7px',
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: oc.soft, color: oc.ink,
                border: '1px solid ' + oc.border, borderRadius: 9,
              }}>{offerName}</span>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>—</span>
            )}
          </div>
          {/* Run? pill */}
          <div>
            {r.has_been_run ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 7px',
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'rgba(62,138,94,0.10)', color: 'var(--up)',
                border: '1px solid rgba(62,138,94,0.35)', borderRadius: 9,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--up)' }} />
                Yes
              </span>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>—</span>
            )}
          </div>
          <div><StatusBadge status={r.status} /></div>
          {/* Uploaded date — YYYY-MM-DD compact mono so the column stays tight. */}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}
               title={r.added_at ? new Date(r.added_at).toLocaleString() : ''}>
            {r.added_at ? new Date(r.added_at).toISOString().slice(0, 10) : '—'}
          </div>
          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <CopyLinkButton
              url={r.final_cut_url || r.drive_url || r.preview_url}
              label="Link"
              title="Copy a shareable link to this video" />
            {onDelete && (
              <button onClick={e => { e.stopPropagation(); onDelete() }} style={{
                padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--down)',
                border: '1px solid var(--down)', cursor: 'pointer',
              }}>Delete</button>
            )}
          </div>
        </div>
  )
}

/* Matrix view — mirrors the Component Edits spreadsheet column-by-column.
   Per-stage pills (Raw / Rough Cut / Final Cut / Approved / Delivered)
   with editable values, type color coding, hover-to-preview thumbnail.
   Click any row to open the detail modal. */
/* Matrix view — edge-to-edge dense table modeled on the Component Edits
   spreadsheet but trimmed of the 4 per-stage columns Ben said he didn't
   need. Every cell that can be edited (description, type, creator, editor,
   offer, run?, status) is inline-editable via onPatch — no modal click
   needed. Static thumbnail only (no hover-to-play) to keep scrolling fast
   when 100+ rows are visible. */
// Condensed edge-to-edge layout. Adds a 22px checkbox column when bulk-
// select handlers are wired in. Slightly tighter column widths than before.
// Columns: rank · thumb · id · description · type · creator · editor · offer · run · status · uploaded · raw.
// "Uploaded" was added between Status and Raw so the operator can scan
// added_at without opening the detail modal.
const MATRIX_COLS_BASE = '38px minmax(110px, 0.85fr) minmax(180px, 1.8fr) 86px 70px 120px 120px 56px 76px 78px 62px'
const MATRIX_COLS_SEL  = `26px ${MATRIX_COLS_BASE}`

// Header cell with clickable sort + arrow indicator. Used in CreativeMatrixView.
function SortableHeader({ label, k, sortKey, sortDir, onSort }) {
  const isActive = sortKey === k
  return (
    <div onClick={() => onSort?.(k)}
      title={`Sort by ${label}`}
      style={{
        cursor: onSort ? 'pointer' : 'default',
        userSelect: 'none',
        color: isActive ? 'var(--ink)' : 'var(--ink-3)',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>
      <span>{label}</span>
      {isActive ? (
        <span style={{ fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
      ) : (
        <span style={{ fontSize: 9, color: 'var(--ink-4)', opacity: 0.4 }}>↕</span>
      )}
    </div>
  )
}

// React.memo wraps the matrix view so opening / closing the detail
// modal (which only flips the parent's drawerRow state) doesn't force
// a full re-render of 200+ rows. The view's own props don't change
// when drawerRow toggles, so the memo short-circuits → matrix DOM
// stays put → close-modal feels instant instead of taking 200-500ms
// to re-reconcile every row.
const CreativeMatrixView = memo(function CreativeMatrixView({ rows, editors, offers, creators, usedRawIds, onRowClick, onPatch, onAssignEditor, selected, selectionMode, onToggleSelect, sortKey, sortDir, onSort }) {
  const selectable = !!onToggleSelect
  const cols = selectable ? MATRIX_COLS_SEL : MATRIX_COLS_BASE
  const allVisible = rows.every(r => selected?.has(r.id))
  const someVisible = !allVisible && rows.some(r => selected?.has(r.id))
  const toggleAll = () => {
    if (!onToggleSelect) return
    if (allVisible) rows.forEach(r => onToggleSelect(r.id))   // toggles off all
    else            rows.forEach(r => !selected?.has(r.id) && onToggleSelect(r.id))  // adds missing
  }
  return (
    <div style={{ width: '100%', background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: cols,
        gap: 5, padding: '6px 10px',
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
        alignItems: 'center',
      }}>
        {selectable && (
          <div onClick={toggleAll} title="Select / deselect all visible rows — then bulk-edit creator, status, editor, offer, etc."
            style={{
              width: 18, height: 18, borderRadius: 9,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'var(--paper)'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}>
            {allVisible && (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someVisible && (
              <span style={{ width: 9, height: 2.5, background: 'var(--ink)' }} />
            )}
          </div>
        )}
        <div></div>
        <SortableHeader label="ID"          k="id"      sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Description" k="desc"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Type"        k="type"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Creator"     k="creator" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Editor"      k="editor"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Offer"       k="offer"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Run?"        k="run"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Status"      k="status"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortableHeader label="Uploaded"    k="uploaded" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <div>Raw</div>
      </div>
      {rows.map((r, i) => (
        <MatrixRow key={r.id} row={r}
          editors={editors} offers={offers} creators={creators}
          isLast={i === rows.length - 1}
          isUsed={!!usedRawIds?.has(r.id)}
          onRowClick={onRowClick}
          onPatch={onPatch}
          onAssignEditor={onAssignEditor}
          cols={cols}
          selected={selected?.has(r.id)}
          selectionMode={selectionMode}
          onToggleSelect={onToggleSelect} />
      ))}
    </div>
  )
})

/* Native <select>/<input> styled to look flat in the cell. Clicking opens
   the native picker (which is fast and avoids hand-rolling popovers).
   stopPropagation so the click doesn't fall through to the row's onClick
   (which opens the full detail modal). */
const cellSelectStyle = {
  width: '100%', padding: '3px 18px 3px 6px',
  background: 'transparent', border: '1px solid transparent',
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
  cursor: 'pointer', appearance: 'auto',
  outline: 'none',
}
const cellInputStyle = {
  width: '100%', padding: '3px 6px',
  background: 'transparent', border: '1px solid transparent',
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
  outline: 'none',
}

const MatrixRow = memo(function MatrixRow({ row: r, editors, offers, creators, isLast, isUsed, onRowClick, onPatch, onAssignEditor, cols, selected, selectionMode, onToggleSelect }) {
  const [hover, setHover] = useState(false)
  const tc = typeColor(r.type)
  const oc = offerColor(r.offer_slug)
  const editable = !!onPatch
  // Editor assignment is gated separately so team-wide editor portal
  // can reassign rows even when the rest of the cells are read-only.
  const canAssignEditor = !!(onAssignEditor || onPatch)
  const selectable = !!onToggleSelect
  // Local state for the still-editable creator field. Description is
  // read-only at this scope (edits live in the detail modal) so we
  // don't carry desc state any more — fewer setState calls + no
  // re-init useEffect firing on every row patch.
  const [creator, setCreator] = useState(r.creator || '')
  useEffect(() => { setCreator(r.creator || '') }, [r.creator])
  const stop = e => e.stopPropagation()
  // In selection mode, clicking row body toggles selection instead of
  // opening the drawer. Inline-editor cells still stopPropagation so
  // editing doesn't toggle selection.
  const handleRowClick = () => {
    if (selectionMode && selectable) onToggleSelect(r.id)
    else onRowClick?.(r)
  }
  // Pipeline-state color stripe on the left edge of every row — fast
  // visual scan of which rows are raw / edited / merged.
  // Used raws (already merged into a Joined) get a muted grey stripe
  // instead of red — so you can spot them as "done, no action needed".
  const stripeColor =
    (r.type === 'Joined' && r.status === 'edited') ? '#b86a0c'     // merged (orange)
    : (r.status === 'edited')                       ? 'var(--up)'     // edited (green)
    : (r.status === 'raw' && isUsed)                ? 'var(--ink-4)'        // raw + used (muted)
    :                                                 'var(--down)'     // raw + unused (red — needs attention)
  // Soft full-row tint so Ben can scan status from across the matrix:
  //   green  = edited / done
  //   yellow = raw + assigned (in progress)
  //   red    = raw + unassigned + needs attention
  // Selection state and hover take precedence over the tint so the UI
  // stays consistent with the rest of the surface.
  const tint = rowStatusTint(r, isUsed)
  return (
    <div
      onClick={handleRowClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: cols,
        gap: 5, padding: '4px 10px', alignItems: 'center',
        borderBottom: isLast ? 'none' : '1px solid var(--rule)',
        borderLeft: `3px solid ${stripeColor}`,
        background: selected
          ? 'rgba(244,225,74,0.15)'
          : (hover ? (tint?.hover || 'var(--paper-2)') : (tint?.base || 'transparent')),
        cursor: 'pointer', transition: 'background 0.08s',
        fontFamily: 'var(--mono)', fontSize: 10,
      }}>
      {selectable && (
        <div onClick={(e) => { e.stopPropagation(); onToggleSelect(r.id) }}
          title="Select for bulk edit"
          style={{
            width: 16, height: 16, borderRadius: 9,
            // Selected: solid dark border. Hovered row: dark border so it
            // pops as discoverable. Otherwise: visible but muted.
            border: selected ? '2px solid var(--ink)' : (hover ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)'),
            background: selected ? 'var(--accent)' : 'var(--paper)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            transition: 'border-color 0.08s',
          }}>
          {selected && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      {/* Thumbnail — static, no hover-to-play (was slowing the page) */}
      <div style={{ width: 36, height: 24, overflow: 'hidden', background: '#000', border: '1px solid var(--rule)' }}>
        {r.thumbnail_url && (
          <img src={r.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </div>
      {/* ID (canonical_name, small mono). Raw+used = strikethrough +
          green check so it's obvious the raw is already merged into a
          Joined elsewhere and doesn't need editing. */}
      <div style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 10, color: 'var(--ink-3)',
        display: 'flex', alignItems: 'center', gap: 4,
        textDecoration: (r.status === 'raw' && isUsed) ? 'line-through' : 'none',
        opacity: (r.status === 'raw' && isUsed) ? 0.65 : 1,
      }} title={rowDisplayName(r)}>
        {(r.status === 'raw' && isUsed) && (
          <span title="Already edited"
            style={{ color: 'var(--up)', fontWeight: 600, flexShrink: 0 }}>✓</span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {rowDisplayName(r)}
        </span>
      </div>
      {/* Description — read-only at this scope. Editing happens in the
          detail modal (click the row) so the matrix stays a clean
          scan-friendly grid instead of a sea of focusable inputs. */}
      <div style={{
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-2)',
        display: 'flex', alignItems: 'center', gap: 6,
      }} title={r.description || r.name}>
        {r.is_low_quality && (
          <span title={`Source file is ${r.low_quality_reason === 'placeholder' ? 'a truncated placeholder' : 'sub-par bitrate'} (only ${r.low_quality_actual_mb ?? '?'} MB stored). Re-upload from source to fix.`}
            style={{
              flexShrink: 0,
              padding: '1px 5px',
              background: 'var(--down)', color: 'var(--paper)',
              fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              borderRadius: 9,
            }}>LOW-Q</span>
        )}
        {r.is_bad_take && (() => {
          // Source-aware label so the operator can tell at a glance whether
          // the flag came from the human (Layer 1 upload toggle / Kirill in
          // the detail modal), a deterministic heuristic, or the AI. AI flags
          // get a softer color because the operator might want to un-flag.
          const src = r.bad_take_source
          const label = src === 'ai' ? 'BAD?' : 'BAD'
          const bg    = src === 'ai' ? '#a05810' : '#7a2020'
          const sourceLabel = src === 'upload' ? 'flagged at upload'
                            : src === 'heuristic' ? 'auto-flagged (filename/duration)'
                            : src === 'ai' ? 'AI-flagged — review recommended'
                            : src === 'coordinator' ? 'flagged by coordinator'
                            : 'flagged'
          return (
            <span title={`${sourceLabel}${r.bad_take_reason ? ' — ' + r.bad_take_reason : ''}`}
              style={{
                flexShrink: 0,
                padding: '1px 5px',
                background: bg, color: 'var(--paper)',
                fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                borderRadius: 9,
              }}>{label}</span>
          )
        })()}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.description || r.name}
        </span>
      </div>
      {/* Type — inline select, rendered as colored pill */}
      <div onClick={stop} style={{ position: 'relative' }}>
        {editable ? (
          <select value={r.type || ''}
            onChange={e => onPatch(r.id, { type: e.target.value })}
            style={{
              ...cellSelectStyle,
              background: tc.soft, color: tc.ink,
              border: '1px solid ' + tc.border, borderRadius: 9,
              fontWeight: 600, fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <span style={{
            padding: '2px 6px',
            background: tc.soft, color: tc.ink, border: '1px solid ' + tc.border,
            fontWeight: 600, fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{r.type}</span>
        )}
      </div>
      {/* Creator — inline select from known creators */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.creator || ''}
            onChange={e => {
              const v = e.target.value
              if (v === '__ADD__') {
                const next = prompt('New creator name')
                if (next && next.trim()) onPatch(r.id, { creator: next.trim().toUpperCase() })
              } else {
                onPatch(r.id, { creator: v || null })
              }
            }}
            style={cellSelectStyle}>
            <option value="">—</option>
            {(creators || []).map(c => <option key={c} value={c}>{c}</option>)}
            {/* Ensure current value is in options even if not in known list */}
            {r.creator && !(creators || []).includes(r.creator) && (
              <option value={r.creator}>{r.creator}</option>
            )}
            <option value="__ADD__">+ Add new…</option>
          </select>
        ) : (
          <span style={{ color: 'var(--ink-3)' }}>{r.creator || '—'}</span>
        )}
      </div>
      {/* Editor — inline select. Uses canAssignEditor (separate gate
          from `editable`) so the team-wide editor portal can reassign
          rows even when other cells are read-only. */}
      <div onClick={stop}>
        {canAssignEditor ? (
          <select value={r.assigned_editor_id || ''}
            onChange={e => (onAssignEditor || onPatch)(r.id, { assigned_editor_id: e.target.value || null })}
            style={{ ...cellSelectStyle, color: r.assigned_editor_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            <option value="">—</option>
            {editors.filter(e => e.active && e.tier !== 'admin').map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        ) : (
          <span style={{ color: r.assigned_editor_id ? 'var(--ink)' : 'var(--ink-4)' }}>
            {r.assigned_editor_name || '—'}
          </span>
        )}
      </div>
      {/* Offer — inline select with color */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.offer_slug || ''}
            onChange={e => onPatch(r.id, { offer_slug: e.target.value || null })}
            style={{
              ...cellSelectStyle,
              background: r.offer_slug ? oc.soft : 'transparent',
              color: r.offer_slug ? oc.ink : 'var(--ink-4)',
              border: r.offer_slug ? '1px solid ' + oc.border : '1px solid transparent',
              borderRadius: 9,
              fontWeight: r.offer_slug ? 600 : 400,
              fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            <option value="">—</option>
            {offers.map(o => <option key={o.slug} value={o.slug}>{o.slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '')}</option>)}
          </select>
        ) : (
          <span style={{ color: 'var(--ink-3)' }}>{r.offer_slug || '—'}</span>
        )}
      </div>
      {/* Run? — toggle button */}
      <div onClick={stop} style={{ display: 'flex', justifyContent: 'center' }}>
        {editable ? (
          <button type="button"
            onClick={() => onPatch(r.id, { has_been_run: !r.has_been_run })}
            title={r.has_been_run ? 'Has been run' : 'Not yet run'}
            style={{
              padding: '3px 7px',
              background: r.has_been_run ? 'rgba(62,138,94,0.15)' : 'transparent',
              border: r.has_been_run ? '1px solid rgba(62,138,94,0.4)' : '1px solid var(--rule)',
              borderRadius: 9, cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              color: r.has_been_run ? 'var(--up)' : 'var(--ink-4)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            {r.has_been_run ? 'Yes' : '—'}
          </button>
        ) : (
          <span style={{ color: r.has_been_run ? 'var(--up)' : 'var(--ink-4)' }}>
            {r.has_been_run ? 'Yes' : '—'}
          </span>
        )}
      </div>
      {/* Status — inline select */}
      <div onClick={stop}>
        {editable ? (
          <select value={r.status || 'raw'}
            onChange={e => onPatch(r.id, { status: e.target.value })}
            style={{
              ...cellSelectStyle,
              color: STATUS_COLOR[r.status] || 'var(--ink-3)',
              fontWeight: 600, fontSize: 9.5, textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
          </select>
        ) : (
          <span style={{ color: STATUS_COLOR[r.status] || 'var(--ink-3)' }}>{STATUS_LABEL[r.status] || r.status}</span>
        )}
      </div>
      {/* Uploaded — added_at as YYYY-MM-DD. Title tooltip shows full timestamp. */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-3)' }}
           title={r.added_at ? new Date(r.added_at).toLocaleString() : ''}>
        {r.added_at ? new Date(r.added_at).toISOString().slice(0, 10) : '—'}
      </div>
      {/* Raw — open the source file */}
      <div onClick={stop} style={{ display: 'flex', justifyContent: 'center' }}>
        {r.drive_url ? (
          <a href={r.drive_url} target="_blank" rel="noreferrer"
            onClick={stop}
            style={{
              padding: '3px 8px',
              background: 'rgba(62,138,94,0.12)',
              border: '1px solid rgba(62,138,94,0.4)',
              color: 'var(--up)', textDecoration: 'none',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              borderRadius: 9,
            }}>Open</a>
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>—</span>
        )}
      </div>
    </div>
  )
})

/* StageLinkCell — if there's a URL for this stage, render a colored
   clickable link pill that opens the file. If status is set but URL
   isn't, fall back to the status indicator (X / In progress / Blocked /
   Skip). If neither, show '—'. */
function StageLinkCell({ value, url, label }) {
  const s = stageStyle(value)
  if (url) {
    return (
      <div style={{ textAlign: 'center' }}>
        <a href={url} target="_blank" rel="noreferrer"
          onClick={e => e.stopPropagation()}
          title={label}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', textDecoration: 'none',
            background: value === 'done' ? 'var(--up)' : '#1f4e8f',
            color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            borderRadius: 9,
          }}>Open ↗</a>
      </div>
    )
  }
  if (!value) return <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 12 }}>—</div>
  return (
    <div style={{ textAlign: 'center' }}>
      <span style={{
        display: 'inline-block', minWidth: 22, padding: '2px 6px',
        background: s.bg, color: s.color,
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: value === 'skip' ? '1px solid var(--rule)' : 'none',
      }}>{s.label}</span>
    </div>
  )
}

/* Editor picker — custom dropdown that shows each editor with their
   color dot inline. Popover uses position: fixed + computed coords so
   it isn't clipped by ancestor 'overflow: auto' containers (Modal body,
   matrix scroll, etc.) and renders above modal backdrops via high
   z-index. */
// Compute popover coords from a button rect, flipping vertically/
// horizontally if the popover would clip off-screen. Used by both
// EditorPicker and OptionPicker so they always stay on-screen even
// in narrow modals or near viewport edges.
function popoverCoords(rect, maxHeight = 280, gap = 2) {
  if (!rect) return null
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth  || document.documentElement.clientWidth
  const spaceBelow = vh - rect.bottom
  const spaceAbove = rect.top
  // Flip above when not enough room below AND there's more room above.
  const placeAbove = spaceBelow < maxHeight + gap && spaceAbove > spaceBelow
  const computedHeight = Math.min(maxHeight, placeAbove ? spaceAbove - gap - 8 : spaceBelow - gap - 8)
  // Horizontal: anchor left, but clamp to keep right edge inside viewport.
  let left = rect.left
  const width = rect.width
  if (left + width > vw - 8) left = Math.max(8, vw - width - 8)
  return {
    top: placeAbove ? Math.max(8, rect.top - computedHeight - gap) : rect.bottom + gap,
    left,
    width,
    maxHeight: computedHeight,
  }
}

function EditorPicker({ value, editors, onChange, placeholder = '— Unassigned' }) {
  // Single combined state (null = closed, { rect } = open). Avoids the
  // race where setOpen(true) commits a frame before setRect(...) lands —
  // see FilterDropdown for the full breakdown.
  const [popover, setPopover] = useState(null)
  const ref = useRef(null)
  const popRef = useRef(null)
  const open = !!popover
  const handleToggle = () => {
    if (popover) setPopover(null)
    else if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
  }
  const closePopover = () => setPopover(null)
  useEffect(() => {
    if (!popover) return
    const onDoc = (e) => {
      const inBtn = ref.current && ref.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setPopover(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setPopover(null) }
    const onScroll = () => {
      if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [!!popover])
  const current = editors.find(e => e.id === value)
  const coords = popover ? popoverCoords(popover.rect) : null
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button"
        onClick={handleToggle}
        style={{
          ...inputStyle, display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', width: '100%', textAlign: 'left',
        }}>
        {current ? (
          <>
            <span style={{ width: 10, height: 10, borderRadius: 9,
              background: editorColor(current), flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: 'var(--sans)' }}>{current.name}</span>
          </>
        ) : (
          <span style={{ flex: 1, fontFamily: 'var(--sans)', color: 'var(--ink-4)' }}>{placeholder}</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {popover && coords && createPortal(
        <div ref={popRef} style={{
          position: 'fixed',
          top: coords.top,
          left: coords.left,
          width: coords.width,
          maxHeight: coords.maxHeight, overflowY: 'auto',
          // High z-index so we sit above modal backdrops (z 100+) and
          // their dialogs (z 101+). Picker is the topmost UI when open.
          zIndex: 9999,
          background: 'var(--paper)', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.25)',
          padding: 4,
        }}>
          <button type="button"
            onClick={() => { onChange(null); closePopover() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 10px', background: !value ? 'var(--paper-2)' : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: !value ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            <span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--ink-4)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>Unassigned</span>
          </button>
          {editors.filter(e => e.active !== false && e.tier !== 'admin').map(e => {
            const isOn = e.id === value
            return (
              <button key={e.id} type="button"
                onClick={() => { onChange(e.id); closePopover() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 10px', background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: isOn ? 600 : 500,
                }}>
                <span style={{ width: 10, height: 10, borderRadius: 9, background: editorColor(e), flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{e.name}</span>
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

/* Branded offer / niche picker — same portal dropdown as EditorPicker so the
   dropdowns share the OPT look instead of an unbranded native <select>
   (Ben 2026-06-27: "all dropdowns should be branded"). Shows each offer's
   colour chip. */
function OfferPicker({ value, offers, onChange, placeholder = '— Pick offer —' }) {
  const [popover, setPopover] = useState(null)
  const ref = useRef(null)
  const popRef = useRef(null)
  const open = !!popover
  const handleToggle = () => {
    if (popover) setPopover(null)
    else if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
  }
  const closePopover = () => setPopover(null)
  useEffect(() => {
    if (!popover) return
    const onDoc = (e) => {
      const inBtn = ref.current && ref.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setPopover(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setPopover(null) }
    const onScroll = () => { if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) }) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [!!popover])
  const current = offers.find(o => o.slug === value)
  const coords = popover ? popoverCoords(popover.rect) : null
  const chip = (slug) => { const c = offerColor(slug); return (c && c.ink) || 'var(--ink-4)' }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={handleToggle}
        style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', width: '100%', textAlign: 'left' }}>
        {current ? (
          <>
            <span style={{ width: 10, height: 10, borderRadius: 9, background: chip(current.slug), flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: 'var(--sans)' }}>{current.name}</span>
          </>
        ) : (
          <span style={{ flex: 1, fontFamily: 'var(--sans)', color: 'var(--ink-4)' }}>{placeholder}</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {popover && coords && createPortal(
        <div ref={popRef} style={{
          position: 'fixed', top: coords.top, left: coords.left, width: coords.width,
          maxHeight: coords.maxHeight, overflowY: 'auto', zIndex: 9999,
          background: 'var(--paper)', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.25)', padding: 4,
        }}>
          <button type="button" onClick={() => { onChange(null); closePopover() }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
              background: !value ? 'var(--paper-2)' : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: !value ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            <span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--ink-4)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>No offer</span>
          </button>
          {offers.map(o => {
            const isOn = o.slug === value
            return (
              <button key={o.slug} type="button" onClick={() => { onChange(o.slug); closePopover() }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
                  background: isOn ? 'var(--paper-2)' : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: isOn ? 600 : 500 }}>
                <span style={{ width: 10, height: 10, borderRadius: 9, background: chip(o.slug), flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{o.name}</span>
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

/* Creator picker — dropdown of known creators with an inline 'Add new'
   that switches to a free-text input. Avoids typos that fragment creators
   into multiple variants (NATALIE vs Natalie vs natalie). */
function CreatorPicker({ value, known, onChange }) {
  const [addingNew, setAddingNew] = useState(false)
  // If the current value isn't in the known list, expose it inline so the
  // dropdown still shows it as selected.
  const options = useMemo(() => {
    const set = new Set(known)
    if (value && !set.has(value)) set.add(value)
    return Array.from(set).sort()
  }, [known, value])
  if (addingNew) {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <input type="text" autoFocus
          defaultValue={value || ''}
          onBlur={e => { onChange(e.target.value.toUpperCase().trim() || null); setAddingNew(false) }}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="New creator name"
          style={inputStyle} />
      </div>
    )
  }
  return (
    <select value={value || ''}
      onChange={e => {
        if (e.target.value === '__ADD__') setAddingNew(true)
        else onChange(e.target.value || null)
      }}
      style={selectStyle}>
      <option value="">— Pick creator —</option>
      {options.map(c => <option key={c} value={c}>{c}</option>)}
      <option value="__ADD__">+ Add new creator…</option>
    </select>
  )
}

/* Transcript display with expand/collapse + copy-to-clipboard. Sits in
   the detail modal under the form. Long transcripts collapse to ~6 lines
   with a 'Show more' affordance. */
function TranscriptBox({ text: rawText }) {
  // Apply OPT-brand normalisations so Whisper's "up digital" / "apt
  // digital" mishearings don't leak into the displayed transcript.
  const text = useMemo(() => normaliseTranscript(rawText), [rawText])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(0)
  const copiedTimerRef = useRef(null)
  const containerRef = useRef(null)
  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current) }, [])
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  // Compute highlighted segments for the search term. Splits the
  // transcript on case-insensitive matches of the query and wraps each
  // hit in a <mark> with a data-match index so we can scroll the
  // focused match into view via prev / next.
  const { segments, matchCount } = useMemo(() => {
    if (!query || !text) return { segments: [{ text: text || '', highlight: false }], matchCount: 0 }
    const q = query.trim()
    if (!q) return { segments: [{ text, highlight: false }], matchCount: 0 }
    const lowerText = text.toLowerCase()
    const lowerQ = q.toLowerCase()
    const segs = []
    let i = 0
    let count = 0
    while (i < text.length) {
      const idx = lowerText.indexOf(lowerQ, i)
      if (idx < 0) { segs.push({ text: text.slice(i), highlight: false }); break }
      if (idx > i) segs.push({ text: text.slice(i, idx), highlight: false })
      segs.push({ text: text.slice(idx, idx + q.length), highlight: true, matchIdx: count })
      count += 1
      i = idx + q.length
    }
    return { segments: segs, matchCount: count }
  }, [text, query])

  useEffect(() => {
    if (currentMatch >= matchCount) setCurrentMatch(Math.max(0, matchCount - 1))
  }, [matchCount, currentMatch])

  // Scroll the focused match into the visible portion of the scroller
  useEffect(() => {
    if (!query || matchCount === 0 || !containerRef.current) return
    const target = containerRef.current.querySelector(`[data-match="${currentMatch}"]`)
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentMatch, query, matchCount])

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 5, gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>Transcript</div>
        {/* Inline find-in-transcript — Ctrl+F-style search that highlights
            matches inside the current clip and provides prev/next jumpers. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180, maxWidth: 360 }}>
          <input type="text" value={query}
            onChange={e => { setQuery(e.target.value); setCurrentMatch(0) }}
            placeholder="Find in transcript…"
            style={{
              flex: 1,
              padding: '4px 8px',
              border: '1px solid var(--rule)', borderRadius: 9,
              background: 'var(--paper)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
              outline: 'none',
            }} />
          {query && (
            <>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right',
              }}>
                {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '0/0'}
              </span>
              <button onClick={() => setCurrentMatch(m => matchCount === 0 ? 0 : (m - 1 + matchCount) % matchCount)}
                disabled={matchCount === 0} title="Previous match"
                style={{
                  padding: '2px 7px', fontFamily: 'var(--mono)', fontSize: 12,
                  background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9,
                  cursor: matchCount === 0 ? 'default' : 'pointer', color: 'var(--ink-3)',
                }}>‹</button>
              <button onClick={() => setCurrentMatch(m => matchCount === 0 ? 0 : (m + 1) % matchCount)}
                disabled={matchCount === 0} title="Next match"
                style={{
                  padding: '2px 7px', fontFamily: 'var(--mono)', fontSize: 12,
                  background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9,
                  cursor: matchCount === 0 ? 'default' : 'pointer', color: 'var(--ink-3)',
                }}>›</button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <button onClick={onCopy} type="button"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: copied ? 'var(--up)' : 'var(--ink-3)',
              textDecoration: 'underline',
            }}>{copied ? 'Copied' : 'Copy'}</button>
          <button onClick={() => setExpanded(v => !v)} type="button"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--ink-3)', textDecoration: 'underline',
            }}>{expanded ? 'Collapse' : 'Show full'}</button>
        </div>
      </div>
      <div ref={containerRef} style={{
        maxHeight: expanded ? 'none' : 420,
        overflowY: expanded ? 'visible' : 'auto',
        padding: 14,
        background: 'var(--paper-2)', border: '1px solid var(--rule)',
        fontFamily: 'var(--sans)', fontSize: 13.5, lineHeight: 1.6,
        color: 'var(--ink-2)', borderRadius: 10,
        whiteSpace: 'pre-wrap',
      }}>
        {text
          ? segments.map((s, i) => s.highlight
              ? <mark key={i} data-match={s.matchIdx} style={{
                  background: s.matchIdx === currentMatch ? '#f4e14a' : 'rgba(244,225,74,0.45)',
                  color: 'var(--ink)',
                  padding: '0 2px', borderRadius: 9,
                  boxShadow: s.matchIdx === currentMatch ? '0 0 0 2px var(--ink)' : 'none',
                }}>{s.text}</mark>
              : <span key={i}>{s.text}</span>
            )
          : <em style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>Transcript not generated yet — re-run transcription from the source clip's detail modal.</em>}
      </div>
    </div>
  )
}

/* Usage history — when viewing a Hook or Body source clip, show which
   Joined composites used it. Match is heuristic: extract the slot from
   the row's original name (Hook 4, Body C, HAMMER-H1, etc.) then query
   joined rows whose name contains that slot. */
/* Versions panel — lists all version siblings of the current creative
   (linked via parent_id pointing at v1). Lets Ben upload a new version
   that inherits most metadata from the current one but gets its own
   row + new transcript + new preview. */
// Edited versions — the editor's actual submitted cuts (lib_task_submissions)
// for THIS creative's editing task(s). The library modal previously only
// showed the TASK ("Gahen · in_progress") with no way to see the work; this
// surfaces every submitted cut with an inline player + download, newest first
// (Ben 2026-06-27: "still cant see the edited versions in here").
function EditedVersionsPanel({ creativeId, onApproved }) {
  const [subs, setSubs] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  useEffect(() => {
    let on = true
    ;(async () => {
      // creative → its task ids (via the queue view we already trust) → subs.
      const { data: q } = await supabase.from('lib_editing_queue')
        .select('task_id').eq('creative_id', creativeId)
      const ids = [...new Set((q || []).map(t => t.task_id).filter(Boolean))]
      if (!ids.length) { if (on) setSubs([]); return }
      const { data } = await supabase.from('lib_task_submissions')
        .select('id, task_id, version_number, submitted_by_name, file_url, preview_proxy_url, thumbnail_url, approved_at, created_at')
        .in('task_id', ids).is('deleted_at', null)
        .order('created_at', { ascending: false })
      if (on) setSubs((data || []).filter(s => s.file_url))
    })()
    return () => { on = false }
  }, [creativeId])

  // Approve a version straight from the library (Ben 2026-06-28: "still
  // missing the ability to approve down here"). Marks the submission approved,
  // moves its task to done, and points the creative's final cut at this cut.
  const approve = async (s) => {
    if (busyId) return
    setBusyId(s.id)
    try {
      const nowIso = new Date().toISOString()
      await supabase.from('lib_task_submissions')
        .update({ approved_at: nowIso, approved_by_name: 'admin' }).eq('id', s.id)
      if (s.task_id) {
        await supabase.from('lib_editing_tasks')
          .update({ status: 'done', completed_at: nowIso }).eq('id', s.task_id)
      }
      await supabase.from('lib_creative_library')
        .update({ final_cut_url: s.file_url, stage_final_cut: 'done', status: 'edited' })
        .eq('id', creativeId)
      setSubs(curr => (curr || []).map(x => x.id === s.id ? { ...x, approved_at: nowIso } : x))
      onApproved?.()
    } catch (e) {
      try { alert(`Approve failed: ${e?.message || e}`) } catch {}
    } finally {
      setBusyId(null)
    }
  }

  if (!subs || subs.length === 0) return null  // nothing submitted yet — stay quiet

  return (
    <Field label={`Edited versions (${subs.length})`}>
      <div style={{ display: 'grid', gap: 8 }}>
        {subs.map(s => {
          const isOpen = openId === s.id
          const approved = !!s.approved_at
          return (
            <div key={s.id} style={{ border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', background: 'var(--paper)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
                {/* Clickable area — expands the inline player. Kept a div (not a
                    button) so the Approve button can sit beside it without
                    nesting buttons. */}
                <div onClick={() => setOpenId(isOpen ? null : s.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                  <div style={{ width: 64, height: 40, flexShrink: 0, background: 'var(--ink)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                    {s.thumbnail_url && (
                      <img src={s.thumbnail_url} alt="" loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    )}
                    <span style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', color: '#fff', fontSize: 13,
                      textShadow: '0 1px 3px rgba(0,0,0,0.6)',
                    }}>{isOpen ? '▾' : '▶'}</span>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>
                      v{s.version_number || 1} · {s.submitted_by_name || 'editor'}
                    </div>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-3)' }}>
                      {s.created_at ? new Date(s.created_at).toLocaleDateString() : ''}
                    </div>
                  </div>
                </div>
                {/* Status + Approve action. Approve flips this version to the
                    creative's final cut + marks the task done. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{
                    padding: '3px 9px', borderRadius: 999,
                    fontFamily: 'var(--sans)', fontSize: 9.5, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase', color: '#fff',
                    background: approved ? 'var(--up)' : '#3e7eba',
                  }}>{approved ? 'Approved' : 'In review'}</span>
                  {!approved && (
                    <button type="button" onClick={() => approve(s)} disabled={busyId === s.id}
                      title="Approve this cut as the final version"
                      style={{
                        padding: '5px 11px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--up)', color: '#fff', border: '1px solid var(--up)',
                        borderRadius: 9, cursor: busyId === s.id ? 'wait' : 'pointer',
                      }}>{busyId === s.id ? '…' : '✓ Approve'}</button>
                  )}
                </div>
              </div>
              {isOpen && (
                <div style={{ background: 'var(--ink)', borderTop: '1px solid var(--rule)' }}>
                  <OptVideoPlayer src={s.preview_proxy_url || s.file_url} compact
                    poster={s.thumbnail_url}
                    downloadUrl={toDownloadUrl(s.file_url, `v${s.version_number || 1}.mp4`)}
                    downloadName={`v${s.version_number || 1}.mp4`}
                    wrapperStyle={OPT_PLAYER_WRAP_320} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Field>
  )
}

// Full version-management panel for a creative's editing task — renders the
// SAME SubmissionsPanel + upload zone + review modal as the editing-queue task
// modal, so the library detail modal is 1:1 (Ben 2026-06-28: "missing approve,
// revise, copy link, review, upload edited versions"). Self-contained so it
// never touches the queue modal. `task` is a lib_editing_queue row.
function TaskWorkPanel({ task, scope = ADMIN_SCOPE, onChanged }) {
  const [submissions, setSubmissions] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [reviewingSub, setReviewingSub] = useState(null)
  const [commentsBySubId, setCommentsBySubId] = useState({})
  const uploadInputRef = useRef(null)
  const uploadXhrRef = useRef(null)
  const adminIdentity = useAdminIdentity()
  const reviewIdentity = (scope.isEditorView && scope.editorId)
    ? { kind: 'editor', id: scope.editorId, name: scope.editorName || 'Editor' }
    : adminIdentity

  const reloadSubmissions = useCallback(async () => {
    if (!task?.task_id) { setSubmissions([]); return }
    const { data } = await supabase.from('lib_task_submissions')
      .select('*').eq('task_id', task.task_id).is('deleted_at', null)
      .order('version_number', { ascending: false })
    setSubmissions(data || [])
  }, [task?.task_id])
  useEffect(() => { reloadSubmissions() }, [reloadSubmissions])

  const submissionIdsKey = submissions.map(s => s.id).join(',')
  const reloadCommentCounts = useCallback(async () => {
    if (!submissions.length) { setCommentsBySubId({}); return }
    const ids = submissions.map(s => s.id)
    const { data, error } = await supabase.from('lib_submission_comments')
      .select('id, submission_id, parent_id, timestamp_seconds, body, author_name, resolved_at, deleted_at')
      .in('submission_id', ids).is('deleted_at', null)
    if (error || !data) return
    const map = {}
    for (const id of ids) map[id] = { total: 0, open: 0, markers: [] }
    for (const c of data) {
      const bucket = map[c.submission_id]; if (!bucket) continue
      bucket.total += 1
      if (!c.parent_id && !c.resolved_at) bucket.open += 1
      if (!c.parent_id && c.timestamp_seconds != null) {
        bucket.markers.push({ id: c.id, ts: c.timestamp_seconds, color: c.resolved_at ? 'rgba(255,255,255,0.4)' : '#3e7eba', title: c.body, authorName: c.author_name })
      }
    }
    for (const id of ids) map[id].markers.sort((a, b) => a.ts - b.ts)
    setCommentsBySubId(map)
  }, [submissionIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reloadCommentCounts() }, [reloadCommentCounts])

  const startUpload = useCallback(async (file) => {
    if (!file || !task?.task_id) return
    setUploadFile(file); setBusy(true); setErr(null); setUploadProgress(0)
    try {
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `edited/${Date.now()}_${sanitized}`
      await uploadWithResume(file, {
        bucket: 'creative-uploads', path: storagePath, contentType: file.type || 'video/mp4',
        onProgress: (frac) => setUploadProgress(Math.round(frac * 70)),
        registerHandle: (instance) => { uploadXhrRef.current = instance },
      })
      uploadXhrRef.current = null
      setUploadProgress(72)
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`
      let submissionThumbUrl = null
      let thumbBlob = await captureVideoThumbnail(file)
      if (!thumbBlob) thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
      if (thumbBlob) {
        const thumbPath = `edited/${Date.now()}_${sanitized}_thumb.jpg`
        try {
          await uploadWithResume(thumbBlob, { bucket: 'creative-uploads', path: thumbPath, contentType: 'image/jpeg', upsert: true })
          submissionThumbUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${thumbPath}`
        } catch { /* best-effort */ }
      }
      setUploadProgress(78)
      const nextVersion = (submissions.length || 0) + 1
      let durationSeconds = null
      try { const dims = await probeMediaDimensions(file); if (dims?.duration_s != null) durationSeconds = dims.duration_s } catch { /* manual fallback */ }
      const { error: sErr } = await supabase.from('lib_task_submissions').insert({
        task_id: task.task_id, submitted_by_editor_id: task.editor_id || null, submitted_by_name: task.editor_name || null,
        file_url: publicUrl, file_storage_path: storagePath, thumbnail_url: submissionThumbUrl,
        version_number: nextVersion, duration_seconds: durationSeconds, duration_source: durationSeconds != null ? 'auto' : null,
      })
      if (sErr) throw sErr
      setUploadProgress(85)
      await supabase.from('lib_creative_library').update({ final_cut_url: publicUrl, final_cut_thumbnail_url: submissionThumbUrl, stage_final_cut: 'done' }).eq('id', task.creative_id)
      setUploadProgress(95)
      await supabase.from('lib_editing_tasks').update({ status: 'review', started_at: task.started_at || new Date().toISOString() }).eq('id', task.task_id)
      setUploadProgress(100)
      await reloadSubmissions()
      setUploadFile(null)
      onChanged?.()
    } catch (e) {
      setErr(e.message || 'upload failed'); setUploadProgress(null)
    } finally { setBusy(false) }
  }, [task?.task_id, task?.creative_id, task?.started_at, task?.editor_id, task?.editor_name, submissions.length, reloadSubmissions, onChanged])

  const approveSubmission = useCallback(async (sub) => {
    setBusy(true); setErr(null)
    try {
      const { error: e1 } = await supabase.from('lib_task_submissions').update({ approved_at: new Date().toISOString(), approved_by_name: 'admin' }).eq('id', sub.id)
      if (e1) throw e1
      if (sub.file_url) {
        const { error: e2 } = await supabase.from('lib_creative_library').update({ final_cut_url: sub.file_url, final_cut_thumbnail_url: sub.thumbnail_url, stage_final_cut: 'done', status: 'edited' }).eq('id', task.creative_id)
        if (e2) throw e2
      }
      const { error: e3 } = await supabase.from('lib_editing_tasks').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', task.task_id)
      if (e3) throw e3
      if (task.editor_id) {
        notifyEditor({ editor_id: task.editor_id, kind: 'approved', task_id: task.task_id, submission_id: sub.id, creative_id: task.creative_id,
          title: `v${sub.version_number || 1} approved — ${taskDisplayName(task)}`, body: 'Admin approved your cut. Task moved to done.', link_path: `/editor-view?task=${task.task_id}` })
      }
      await reloadSubmissions(); onChanged?.()
    } catch (e) { setErr(e.message || 'approve failed') } finally { setBusy(false) }
  }, [task?.task_id, task?.creative_id, task?.editor_id, reloadSubmissions, onChanged])

  const deleteSubmission = useCallback(async (sub) => {
    setBusy(true); setErr(null)
    try {
      await supabase.from('lib_task_submissions').update({ deleted_at: new Date().toISOString() }).eq('id', sub.id)
      await reloadSubmissions()
    } catch (e) { setErr(e.message || 'delete failed') } finally { setBusy(false) }
  }, [reloadSubmissions])

  const requestRevision = useCallback(async (sub, feedbackText) => {
    setBusy(true); setErr(null)
    try {
      const { error: fbErr } = await supabase.from('lib_task_submissions').update({ feedback_text: feedbackText, feedback_at: new Date().toISOString(), feedback_by_name: reviewIdentity?.name || 'Admin', feedback_read_at: null }).eq('id', sub.id)
      if (fbErr) throw fbErr
      const { error: stErr } = await supabase.from('lib_editing_tasks').update({ status: 'needs_revision' }).eq('id', task.task_id)
      if (stErr) { setErr(`Feedback saved but task status update failed: ${stErr.message}`); await reloadSubmissions(); return }
      if (task.editor_id) {
        notifyEditor({ editor_id: task.editor_id, kind: 'revision_requested', task_id: task.task_id, submission_id: sub.id, creative_id: task.creative_id,
          title: `Revision requested on v${sub.version_number || 1} — ${taskDisplayName(task)}`, body: feedbackText.length > 180 ? feedbackText.slice(0, 177) + '…' : feedbackText, link_path: `/editor-view?task=${task.task_id}` })
      }
      await reloadSubmissions(); onChanged?.()
    } catch (e) { setErr(`Revision request failed: ${e.message || e}`) } finally { setBusy(false) }
  }, [task?.task_id, task?.editor_id, reviewIdentity, reloadSubmissions, onChanged])

  if (!task?.task_id) return null

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {err && (
        <div style={{ padding: '8px 12px', background: '#fff1f1', border: '1px solid var(--down)', borderRadius: 9, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--down)' }}>{err}</div>
      )}
      <SubmissionsPanel
        submissions={submissions}
        commentsBySubId={commentsBySubId}
        canApprove={scope.canEditTask}
        canDelete={scope.canEditTask}
        canFeedback={true}
        onOpenReview={(sub) => setReviewingSub(sub)}
        currentUserName={reviewIdentity?.name || 'Admin'}
        currentUserRole={(scope.isEditorView && scope.editorId) ? 'editor' : 'admin'}
        taskEditorId={task.editor_id}
        taskName={taskDisplayName(task)}
        busy={busy}
        onApprove={approveSubmission}
        onDelete={deleteSubmission}
        onFeedbackSaved={(subId, patch) => setSubmissions(curr => curr.map(s => s.id === subId ? { ...s, ...patch } : s))}
        onRequestRevision={requestRevision}
      />
      {scope.canUpload && (
        <div style={{ padding: '14px 16px', border: '1px solid var(--rule)', background: 'var(--paper-2)', borderRadius: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10 }}>
            <span>Upload edited version</span>
            {uploadProgress === 100 && <span style={{ color: 'var(--up)' }}>Submitted for review</span>}
          </div>
          <div
            onClick={() => !busy && uploadInputRef.current?.click()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && !busy) startUpload(f) }}
            onDragOver={e => e.preventDefault()}
            style={{ padding: 20, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer', border: '2px dashed ' + (busy ? 'var(--accent)' : 'var(--rule)'), background: uploadFile ? 'var(--paper)' : 'transparent', borderRadius: 9, transition: 'border-color 0.2s' }}>
            <input ref={uploadInputRef} type="file" accept="video/*" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f && !busy) startUpload(f) }} />
            {uploadFile ? (
              <>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>{uploadFile.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 4 }}>
                  {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                  {busy && uploadProgress != null && ` · ${uploadProgress}%`}
                  {uploadProgress === 100 && ' · Done'}
                </div>
              </>
            ) : (
              <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)' }}>
                Drop the edited cut here, or <span style={{ color: 'var(--ink)', fontWeight: 600 }}>click to select</span>
              </div>
            )}
          </div>
        </div>
      )}
      <SubmissionPreviewModal
        submission={reviewingSub}
        currentUser={reviewIdentity}
        busy={busy}
        onApprove={async (sub) => { await approveSubmission(sub); setReviewingSub(null) }}
        onRequestRevision={async (sub, fb) => { await requestRevision(sub, fb); setReviewingSub(null) }}
        onCommentsChanged={reloadCommentCounts}
        onClose={() => setReviewingSub(null)} />
    </div>
  )
}

function VersionsPanel({ row, onReload, onOpenRow }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState(null)
  const fileInputRef = useRef(null)

  // Root id = the v1 row. If current row has parent_id, that's the root.
  // Otherwise this row IS the root.
  const rootId = row.parent_id || row.id

  useEffect(() => {
    let mounted = true
    // Pull all versions: the root + everything with parent_id = root.
    supabase.from('lib_creative_library')
      .select('id, canonical_name, name, version_number, status, type, thumbnail_url, preview_url, added_at')
      .or(`id.eq.${rootId},parent_id.eq.${rootId}`)
      .eq('exclude_from_library', false)
      .order('version_number', { ascending: true })
      .then(({ data }) => {
        if (!mounted) return
        setVersions(data || [])
        setLoading(false)
      })
    return () => { mounted = false }
  }, [rootId])

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true); setErr(null); setProgress('Uploading…')
    try {
      const nextVersion = Math.max(0, ...versions.map(v => v.version_number || 1)) + 1
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `ingest/${Date.now()}_v${nextVersion}_${sanitized}`
      // 1. Upload via TUS resumable (handles multi-GB files + progress).
      await uploadWithResume(file, {
        bucket: 'creative-uploads',
        path: storagePath,
        contentType: file.type || 'video/mp4',
        onProgress: (frac) => setProgress(`Uploading ${Math.round(frac * 100)}%…`),
      })
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`

      // 2. Browser-side first-frame capture — gives identify-actor a real
      //    image to face-match against. Best-effort; null result just means
      //    the row has no thumbnail and identify-actor will skip it.
      //    Pre-upload File-based capture skips files > 500 MB to avoid
      //    stalling the upload reading the whole File off disk. Big files
      //    fall through to the post-upload URL path which uses HTTP range
      //    requests against the just-uploaded URL — no stall, no size cap.
      setProgress('Capturing thumbnail…')
      let thumbnailUrl = null
      let thumbBlob = await captureVideoThumbnail(file)
      if (!thumbBlob) {
        thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
      }
      if (thumbBlob) {
        const thumbPath = `ingest/${Date.now()}_v${nextVersion}_${sanitized}_thumb.jpg`
        try {
          await uploadWithResume(thumbBlob, {
            bucket: 'creative-uploads',
            path: thumbPath,
            contentType: 'image/jpeg',
            upsert: true,
          })
          thumbnailUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${thumbPath}`
        } catch { /* thumbnail best-effort */ }
      }

      // 3. Insert new library row inheriting metadata + thumbnail
      setProgress('Creating version…')
      const { data: inserted, error: insErr } = await supabase.from('lib_creative_library')
        .insert({
          name: `v${nextVersion} of ${rowDisplayName(row)}`,
          type: row.type,
          creator: row.creator,
          // Inherit parent status. A v2 of a raw is another raw take; a v2 of
          // an edited cut is a revised cut. Hardcoding 'edited' here used to
          // wrongly promote raw takes to edited on upload.
          status: row.status || 'raw',
          offer_slug: row.offer_slug,
          assigned_editor_id: row.assigned_editor_id,
          // Stay in the source clip's folder — a v2 landing at the library
          // root would split the version family across folders. Key only
          // included when set so this insert keeps working if migration
          // 146 isn't applied yet (no 42703 self-heal loop on this path).
          ...(row.folder_id ? { folder_id: row.folder_id } : {}),
          parent_id: rootId,
          version_number: nextVersion,
          size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
          preview_url: publicUrl,
          thumbnail_url: thumbnailUrl,
          source_bucket: 'New version upload',
          notes: `v${nextVersion} of ${rowDisplayName(row)}, uploaded ${new Date().toISOString().slice(0,10)}.`,
        })
        .select()
        .single()
      if (insErr) throw insErr

      // 4. Fire transcribe → identify-actor → describe sequentially in the
      //    background. The chain matters: identify-actor writes the
      //    creator column, then describe regenerates canonical_name from
      //    the now-correct creator + transcript. Async IIFE so it doesn't
      //    block the modal close.
      setProgress('Transcribing in background…')
      ;(async () => {
        try {
          await supabase.functions.invoke('transcribe-library-clip', {
            body: { library_id: inserted.id, storage_path: storagePath },
          })
          await supabase.functions.invoke('identify-actor', {
            body: { library_ids: [inserted.id] },
          })
          await supabase.functions.invoke('creative-library-describe', {
            body: { library_ids: [inserted.id] },
          })
        } catch (e) {
          // Background pipeline; surface to console but don't block UI.
          console.warn('post-upload pipeline failed', e)
        }
      })()
      // Optimistic: add to local list
      setVersions(prev => [...prev, inserted])
      setUploadOpen(false); setUploadFile(null); setProgress(null)
    } catch (e) {
      setErr(e.message || 'upload failed')
      setProgress(null)
    } finally {
      setUploading(false)
    }
  }

  if (loading) return null
  // Only show panel if there's a version structure to display OR upload affordance
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 6,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>
          Versions {versions.length > 1 && `· ${versions.length}`}
        </div>
        <button onClick={() => { setUploadOpen(true); setTimeout(() => fileInputRef.current?.click(), 50) }}
          type="button"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--ink)', textDecoration: 'underline',
          }}>+ Upload new version</button>
      </div>
      {/* Hidden file picker triggered by the button above */}
      <input ref={fileInputRef} type="file" accept="video/*"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { setUploadFile(f); handleUpload(f) } }} />
      {err && (
        <div style={{ padding: '6px 10px', background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)', color: 'var(--down)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 6 }}>
          {err}
        </div>
      )}
      {progress && (
        <div style={{ padding: '6px 10px', background: 'var(--paper-2)', border: '1px solid var(--rule)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>
          {progress}
        </div>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        {versions.map(v => {
          const isCurrent = v.id === row.id
          const canOpen = !isCurrent && onOpenRow
          return (
            <div key={v.id}
              onClick={canOpen ? () => onOpenRow(v.id) : undefined}
              title={canOpen ? 'View this version' : undefined}
              style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 10,
              background: isCurrent ? 'var(--accent-soft)' : 'var(--paper-2)',
              border: isCurrent ? '1px solid var(--ink)' : '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
              cursor: canOpen ? 'pointer' : 'default',
            }}>
              <div style={{ width: 40, height: 24, background: '#000', overflow: 'hidden', flexShrink: 0 }}>
                {v.thumbnail_url && (
                  <img src={v.thumbnail_url} alt="" loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
              <span style={{
                padding: '2px 7px', background: 'var(--ink)', color: 'var(--paper)',
                fontWeight: 600, letterSpacing: '0.06em',
              }}>v{v.version_number || 1}</span>
              <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: isCurrent ? 700 : 500 }}>
                  {rowDisplayName(v)}
                  {isCurrent && <span style={{ marginLeft: 6, color: 'var(--ink-3)', fontSize: 9.5 }}>CURRENT</span>}
                </div>
              </div>
              <span style={{ color: v.status === 'edited' ? 'var(--up)' : 'var(--down)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {v.status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UsageHistory({ row, onOpenRow, onRowPatched }) {
  // Two-way derivation panel:
  //   - Hooks/Bodies: list composites where derived_hook_id == this.id
  //                   (or derived_body_id for bodies). This is the
  //                   transcript-matcher's authoritative output.
  //   - Composites (Joined / Full Video / Retargeting / Testimony):
  //                   show the matched Hook + Body source clips by
  //                   derived_hook_id / derived_body_id.
  //
  // The transcript matcher misses sometimes (different audio mix, the
  // hook got chopped in the edit, low-quality transcription). The
  // operator can now manually override the Hook + Body source via
  // the [Replace] action in each card's header — that writes
  // derived_hook_id / derived_body_id directly and the matcher's
  // guess is preserved if not touched.
  const isSource    = row && (row.type === 'Hook' || row.type === 'Body')
  const isComposite = row && ['Joined', 'Full Video', 'Retargeting', 'Testimony'].includes(row.type)
  const [matches, setMatches] = useState([])
  const [sources, setSources] = useState({ hook: null, body: null })
  const [loading, setLoading] = useState(false)
  // Source picker state — { role: 'hook'|'body' } when open
  const [picker, setPicker] = useState(null)
  const [busy, setBusy] = useState(false)

  // Apply a chosen source row to the composite. Writes
  // derived_hook_id or derived_body_id + immediately patches local
  // state so the panel refreshes without a network round-trip.
  const applySource = async (role, sourceId) => {
    if (!row || !isComposite) return
    setBusy(true)
    const col = role === 'hook' ? 'derived_hook_id' : 'derived_body_id'
    const { error } = await supabase.from('lib_creative_library')
      .update({ [col]: sourceId || null })
      .eq('id', row.id)
    setBusy(false)
    if (error) { alert(error.message); return }
    // Notify parent so the rows state mirrors the override
    onRowPatched?.(row.id, { [col]: sourceId || null })
    // Refresh the local sources display
    if (!sourceId) {
      setSources(prev => ({ ...prev, [role]: null }))
    } else {
      const { data } = await supabase.from('lib_creative_library')
        .select('id, name, canonical_name, type, status, thumbnail_url, preview_url')
        .eq('id', sourceId).maybeSingle()
      if (data) setSources(prev => ({ ...prev, [role]: data }))
    }
    setPicker(null)
  }

  // SOURCE → COMPOSITES: pull rows where derived_*_id points at this row
  useEffect(() => {
    let mounted = true
    if (!isSource) { setMatches([]); return }
    setLoading(true)
    const col = row.type === 'Hook' ? 'derived_hook_id' : 'derived_body_id'
    supabase.from('lib_creative_library')
      .select('id, name, canonical_name, status, thumbnail_url, preview_url, derivation_score, type')
      .eq(col, row.id)
      .order('name')
      .then(({ data }) => {
        if (!mounted) return
        setMatches(data || [])
        setLoading(false)
      })
    return () => { mounted = false }
  }, [row?.id, row?.type, isSource])

  // COMPOSITE → SOURCES: pull Hook + Body source rows by id
  useEffect(() => {
    let mounted = true
    if (!isComposite) { setSources({ hook: null, body: null }); return }
    const ids = [row.derived_hook_id, row.derived_body_id].filter(Boolean)
    if (ids.length === 0) { setSources({ hook: null, body: null }); return }
    supabase.from('lib_creative_library')
      .select('id, name, canonical_name, type, status, thumbnail_url, preview_url')
      .in('id', ids)
      .then(({ data }) => {
        if (!mounted) return
        const byId = Object.fromEntries((data || []).map(r => [r.id, r]))
        setSources({
          hook: row.derived_hook_id ? byId[row.derived_hook_id] || null : null,
          body: row.derived_body_id ? byId[row.derived_body_id] || null : null,
        })
      })
    return () => { mounted = false }
  }, [row?.id, row?.derived_hook_id, row?.derived_body_id, isComposite])

  // Composite "Made from" panel — now editable
  if (isComposite) {
    return (
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
          marginBottom: 5,
        }}>Made from</div>
        <div style={{ display: 'grid', gap: 6 }}>
          <SourceSlot
            role="hook"
            label="Hook source"
            sourceRow={sources.hook}
            busy={busy}
            onOpenRow={onOpenRow}
            onPick={() => setPicker({ role: 'hook' })}
            onClear={() => applySource('hook', null)}
          />
          <SourceSlot
            role="body"
            label="Body source"
            sourceRow={sources.body}
            busy={busy}
            onOpenRow={onOpenRow}
            onPick={() => setPicker({ role: 'body' })}
            onClear={() => applySource('body', null)}
          />
        </div>
        {picker && (
          <SourcePickerModal
            role={picker.role}
            currentId={picker.role === 'hook' ? row.derived_hook_id : row.derived_body_id}
            onClose={() => setPicker(null)}
            onPick={(id) => applySource(picker.role, id)}
          />
        )}
      </div>
    )
  }

  if (!isSource) return null
  if (loading) return null
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        marginBottom: 5,
      }}>
        Used in {matches.length} Joined composite{matches.length === 1 ? '' : 's'}
      </div>
      {matches.length === 0 ? (
        <div style={{
          padding: '10px 12px', background: 'var(--paper-2)',
          border: '1px dashed var(--rule)',
          fontFamily: 'var(--sans)', fontStyle: 'italic',
          fontSize: 12, color: 'var(--ink-3)',
        }}>
          Not yet merged with any body / hook. Once a Joined creative
          named after this slot exists, it'll show up here.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {matches.map(m => (
            <DerivationLinkRow key={m.id} row={m} onOpenRow={onOpenRow} />
          ))}
        </div>
      )}
    </div>
  )
}

/* Slot card for an editable Hook / Body source link inside the
   composite's "Made from" panel. If sourceRow is set, shows the row
   + a Replace / Clear pair. If empty, shows a single "+ Link {role}"
   call-to-action. */
function SourceSlot({ role, label, sourceRow, busy, onOpenRow, onPick, onClear }) {
  if (!sourceRow) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px',
        background: 'var(--paper-2)', border: '1px dashed var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
      }}>
        <span style={{ flex: 1 }}>
          No {label.toLowerCase()} linked yet
        </span>
        <button onClick={onPick} disabled={busy} type="button"
          style={{
            padding: '4px 10px',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: 'var(--ink)', color: 'var(--paper)',
            border: 'none', cursor: 'pointer', borderRadius: 9,
          }}>+ Link {role}</button>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 10px',
      background: 'var(--paper-2)', border: '1px solid var(--rule)',
      fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      <div style={{ width: 40, height: 24, background: '#000', overflow: 'hidden', flexShrink: 0 }}>
        {sourceRow.thumbnail_url && (
          <img src={sourceRow.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
      </div>
      <div onClick={() => onOpenRow?.(sourceRow.id)}
        style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          cursor: onOpenRow ? 'pointer' : 'default',
        }}>
        <div style={{ fontWeight: 600 }}>{rowDisplayName(sourceRow)}</div>
        <div style={{ color: 'var(--ink-4)', fontSize: 10 }}>{sourceRow.name}</div>
      </div>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
        letterSpacing: '0.08em', color: 'var(--ink-4)',
      }}>{role.toUpperCase()} SOURCE</span>
      <button onClick={onPick} disabled={busy} type="button"
        style={{
          padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--ink-2)',
          border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 9,
        }}>Replace</button>
      <button onClick={onClear} disabled={busy} type="button"
        title="Clear this link"
        style={{
          padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--down)',
          border: '1px solid rgba(181,62,62,0.35)', cursor: 'pointer', borderRadius: 9,
        }}>Clear</button>
    </div>
  )
}

/* Modal-style picker. Loads all Hook OR Body rows, search-filters as
   the operator types, click to commit. Used by SourceSlot when the
   operator wants to override the transcript matcher's guess. */
function SourcePickerModal({ role, currentId, onClose, onPick }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let mounted = true
    const targetType = role === 'hook' ? 'Hook' : 'Body'
    supabase.from('lib_creative_library')
      .select('id, name, canonical_name, thumbnail_url, status, creator')
      .eq('type', targetType)
      .eq('exclude_from_library', false)
      .order('canonical_name', { ascending: true })
      .then(({ data }) => {
        if (!mounted) return
        setRows(data || [])
        setLoading(false)
      })
    return () => { mounted = false }
  }, [role])
  const filtered = useMemo(() => {
    const search = q.trim().toLowerCase()
    if (!search) return rows
    return rows.filter(r => {
      const blob = `${r.name} ${r.canonical_name || ''} ${r.display_name || ''} ${r.messaging_angle || ''} ${r.creator || ''}`.toLowerCase()
      return blob.includes(search)
    })
  }, [rows, q])
  return (
    <Modal open={true} onClose={onClose} size="md"
      eyebrow={`Link ${role}`}
      title={`Pick the ${role} this composite was built from`}
      subtitle="The transcript matcher's guess is shown highlighted. Type to filter, click any row to commit."
      footer={<button onClick={onClose} style={ghostBtn}>Cancel</button>}>
      <div style={{ padding: '14px 20px', display: 'grid', gap: 10 }}>
        <input type="text" value={q} onChange={e => setQ(e.target.value)}
          placeholder={`Search ${role}s by name, canonical name, creator…`}
          autoFocus
          style={{
            padding: '8px 12px',
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
            border: '1px solid var(--rule)', borderRadius: 9,
            background: 'var(--paper)', outline: 'none',
          }} />
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', fontStyle: 'italic', color: 'var(--ink-3)' }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontStyle: 'italic', color: 'var(--ink-3)' }}>
            No matching {role}s
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 4, maxHeight: 420, overflowY: 'auto' }}>
            {filtered.map(r => {
              const isCurrent = r.id === currentId
              return (
                <button key={r.id} type="button"
                  onClick={() => onPick(r.id)}
                  style={{
                    display: 'grid', gridTemplateColumns: '44px 1fr auto',
                    gap: 10, alignItems: 'center',
                    padding: '6px 10px', textAlign: 'left',
                    background: isCurrent ? 'rgba(244,225,74,0.15)' : 'var(--paper)',
                    border: '1px solid ' + (isCurrent ? 'var(--accent)' : 'var(--rule)'),
                    cursor: 'pointer', borderRadius: 9,
                  }}>
                  <div style={{ width: 44, height: 28, background: '#000', overflow: 'hidden' }}>
                    {r.thumbnail_url && (
                      <img src={r.thumbnail_url} alt="" loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rowDisplayName(r)}
                    </div>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-4)' }}>
                      {r.creator || '—'} · {r.status}
                    </div>
                  </div>
                  {isCurrent && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                      letterSpacing: '0.08em', color: 'var(--ink)',
                      background: 'var(--accent)', padding: '2px 6px', borderRadius: 9,
                    }}>CURRENT</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* Small row for "Made from" + "Used in" lists. Same look as the previous
   inline list but extracted so both panels share. Role label appears as
   a tiny eyebrow on the right ("HOOK SOURCE", "BODY SOURCE").
   Clicking the row jumps the parent modal to that creative when
   onOpenRow is provided. */
function DerivationLinkRow({ row, role, onOpenRow }) {
  const [hover, setHover] = useState(false)
  const clickable = !!onOpenRow
  return (
    <div
      onClick={clickable ? () => onOpenRow(row.id) : undefined}
      onMouseEnter={clickable ? () => setHover(true) : undefined}
      onMouseLeave={clickable ? () => setHover(false) : undefined}
      title={clickable ? 'Open this creative' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 10px',
        background: hover ? 'var(--paper)' : 'var(--paper-2)',
        border: `1px solid ${hover ? 'var(--ink)' : 'var(--rule)'}`,
        fontFamily: 'var(--mono)', fontSize: 11,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 80ms, border-color 80ms',
      }}>
      <div style={{ width: 40, height: 24, background: '#000', overflow: 'hidden', flexShrink: 0 }}>
        {row.thumbnail_url && (
          <img src={row.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <div style={{ fontWeight: 600 }}>{rowDisplayName(row)}</div>
        <div style={{ color: 'var(--ink-4)', fontSize: 10 }}>{row.name}</div>
      </div>
      {role && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
          letterSpacing: '0.08em', color: 'var(--ink-4)',
        }}>{role}</span>
      )}
      <span style={{
        color: row.status === 'edited' ? 'var(--up)' : 'var(--ink-4)',
        fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>{row.status}</span>
      {clickable && (
        <span style={{
          color: 'var(--ink-4)', fontSize: 13, lineHeight: 1,
          opacity: hover ? 1 : 0.4, transition: 'opacity 80ms',
        }}>→</span>
      )}
    </div>
  )
}

/* Inline stage value editor — used inside CreativeDetailModal so Ben can
   set Raw / Rough cut / Final cut / Approved / Delivered per-creative. */
function StageEditor({ label, value, onChange }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--ink-3)', marginBottom: 4,
      }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STAGE_VALUES.map(s => {
          const active = (value || null) === s.v
          const styleProps = active
            ? { background: s.bg === 'transparent' ? 'var(--ink)' : s.bg, color: s.color === '#ccc' ? 'var(--paper)' : s.color }
            : { background: 'var(--paper)', color: 'var(--ink-3)' }
          return (
            <button key={String(s.v)} onClick={() => onChange(s.v)} style={{
              padding: '4px 8px',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              border: '1px solid ' + (active ? 'transparent' : 'var(--rule)'),
              borderRadius: 9, cursor: 'pointer',
              ...styleProps,
            }}>{s.label === 'X' && !active ? 'Done' : s.label === '—' ? 'Not started' : s.label}</button>
          )
        })}
      </div>
    </div>
  )
}

function StageCell({ value }) {
  const s = stageStyle(value)
  if (!value) return <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 12 }}>—</div>
  return (
    <div style={{ textAlign: 'center' }}>
      <span style={{
        display: 'inline-block', minWidth: 22, padding: '2px 6px',
        background: s.bg, color: s.color,
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: value === 'skip' ? '1px solid var(--rule)' : 'none',
      }}>{s.label}</span>
    </div>
  )
}

/* ──────────────────────── BULK EDIT MODAL ──────────────────────── */
/* Applies a patch to N selected library rows in a single .update().in()
   call. Empty fields are skipped — only fields the user explicitly sets
   are written. Lets Ben reorganise dozens of clips in one pass. */

function BulkEditModal({ ids, editors = [], offers = [], knownCreators = [], onClose, onSaved }) {
  // null = no change, otherwise the value to write
  const [type, setType] = useState(null)
  // statusChoice represents the THREE buckets the Library uses:
  //   'raw_unused' → status='raw',    manually_marked_used=false
  //   'raw_used'   → status='raw',    manually_marked_used=true     (EDITED RAW)
  //   'edited'     → status='edited'  (manually_marked_used left alone)
  // null = keep existing for both columns.
  const [statusChoice, setStatusChoice] = useState(null)
  const [creator, setCreator] = useState(null)
  const [assignedEditorId, setAssignedEditorId] = useState(null)
  const [offerSlug, setOfferSlug] = useState(null)
  const [hasBeenRun, setHasBeenRun] = useState(null)   // null | true | false
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const patch = useMemo(() => {
    const p = {}
    if (type !== null)             p.type = type
    if (statusChoice === 'raw')        { p.status = 'raw';    p.manually_marked_used = false }
    if (statusChoice === 'edited')     { p.status = 'edited' }
    if (creator !== null)          p.creator = creator
    if (assignedEditorId !== null) p.assigned_editor_id = assignedEditorId || null
    if (offerSlug !== null)        p.offer_slug = offerSlug || null
    if (hasBeenRun !== null)       p.has_been_run = hasBeenRun
    return p
  }, [type, statusChoice, creator, assignedEditorId, offerSlug, hasBeenRun])
  const hasChanges = Object.keys(patch).length > 0

  const apply = async () => {
    if (!hasChanges) return
    setBusy(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .update(patch)
      .in('id', ids)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.(ids, patch)  // parent merges in-place; no full reload
  }

  // Small "Keep existing" pill that appears when a field is null
  const keepPill = { padding: '5px 9px', fontSize: 10, fontFamily: 'var(--mono)',
    background: 'transparent', color: 'var(--ink-4)',
    border: '1px dashed var(--rule)', cursor: 'pointer', letterSpacing: '0.06em',
    textTransform: 'uppercase', fontWeight: 600, borderRadius: 9 }

  return (
    <Modal open={true} onClose={onClose} size="md"
      eyebrow={`BULK EDIT · ${ids.length} CLIP${ids.length === 1 ? '' : 'S'}`}
      title="Reorganise selected creatives"
      subtitle="Click a field's value to set it. Anything left as KEEP EXISTING stays unchanged."
      footer={
        <>
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {!hasChanges && !err && (
            <span style={{
              fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-4)',
              marginRight: 'auto', fontStyle: 'italic',
            }}>Set at least one field to apply</span>
          )}
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={apply} disabled={busy || !hasChanges} style={primaryBtn}>
            {busy ? 'Applying…' : `Apply to ${ids.length} clip${ids.length === 1 ? '' : 's'}`}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 16 }}>
        {/* TYPE — colored pill buttons + keep-existing */}
        <Field label="Type">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button onClick={() => setType(null)} type="button"
              style={type === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            {TYPES.map(t => {
              const isOn = type === t
              const tc = typeColor(t)
              return (
                <button key={t} type="button" onClick={() => setType(t)}
                  style={{
                    padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? tc.ink : tc.soft,
                    color: isOn ? 'white' : tc.ink,
                    border: '1px solid ' + (isOn ? tc.ink : tc.border),
                    borderRadius: 9, cursor: 'pointer',
                  }}>{t}</button>
              )
            })}
          </div>
        </Field>

        {/* STATUS — three pill buttons matching the Library STATUS filter:
              RAW         (status='raw',   manually_marked_used=false)
              EDITED RAW  (status='raw',   manually_marked_used=true)
              EDITED      (status='edited')
            so the bulk-edit dropdown reads consistently with the filter. */}
        <Field label="Status">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button onClick={() => setStatusChoice(null)} type="button"
              style={statusChoice === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            {[
              { v: 'raw',    label: 'RAW',    color: 'var(--down)' },
              { v: 'edited', label: 'EDITED', color: 'var(--up)' },
            ].map(opt => {
              const isOn = statusChoice === opt.v
              return (
                <button key={opt.v} type="button" onClick={() => setStatusChoice(opt.v)}
                  style={{
                    padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? opt.color : 'var(--paper)',
                    color: isOn ? 'white' : opt.color,
                    border: '1px solid ' + opt.color,
                    borderRadius: 9, cursor: 'pointer',
                  }}>{opt.label}</button>
              )
            })}
          </div>
        </Field>

        {/* RUN BEFORE — pill toggle */}
        <Field label="Run before">
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setHasBeenRun(null)} type="button"
              style={hasBeenRun === null ? { ...keepPill, color: 'var(--ink)', borderColor: 'var(--ink)', borderStyle: 'solid', background: 'var(--accent)' } : keepPill}>
              Keep existing
            </button>
            <button onClick={() => setHasBeenRun(true)} type="button"
              style={{
                padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: hasBeenRun === true ? 'var(--up)' : 'var(--paper)',
                color: hasBeenRun === true ? 'white' : 'var(--up)',
                border: '1px solid var(--up)',
                borderRadius: 9, cursor: 'pointer',
              }}>Yes — run before</button>
            <button onClick={() => setHasBeenRun(false)} type="button"
              style={{
                padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: hasBeenRun === false ? 'var(--ink)' : 'var(--paper)',
                color: hasBeenRun === false ? 'white' : 'var(--ink-3)',
                border: '1px solid var(--rule)',
                borderRadius: 9, cursor: 'pointer',
              }}>No — not yet</button>
          </div>
        </Field>

        {/* Creator field removed 2026-06-26 (Ben). */}
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Offer / niche">
            <select value={offerSlug === null ? '__KEEP__' : offerSlug || '__CLEAR__'}
              onChange={e => {
                const v = e.target.value
                if (v === '__KEEP__') setOfferSlug(null)
                else if (v === '__CLEAR__') setOfferSlug(null)
                else setOfferSlug(v)
              }}
              style={selectStyle}>
              <option value="__KEEP__">— KEEP EXISTING —</option>
              <option value="">Clear offer</option>
              {offers.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Assigned editor">
            {/* Tri-state: 'KEEP EXISTING' / 'Unassign' / specific editor.
                Custom UI since EditorPicker doesn't model 'keep existing'. */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" onClick={() => setAssignedEditorId(null)}
                style={assignedEditorId === null ? {
                  padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'var(--accent)', color: 'var(--ink)',
                  border: '1px solid var(--ink)', borderRadius: 9, cursor: 'pointer',
                } : {
                  padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--ink-4)',
                  border: '1px dashed var(--rule)', borderRadius: 9, cursor: 'pointer',
                }}>Keep existing</button>
              <div style={{ flex: '1 1 220px', minWidth: 200 }}>
                <EditorPicker value={assignedEditorId === null ? '' : (assignedEditorId || '')}
                  editors={editors}
                  onChange={v => setAssignedEditorId(v || '')}
                  placeholder="Unassign (clear editor)" />
              </div>
            </div>
          </Field>
        </div>

        {hasChanges && (
          <div style={{
            padding: '10px 12px', background: 'var(--paper-2)',
            border: '1px dashed var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
            letterSpacing: '0.04em',
          }}>
            <strong style={{ color: 'var(--ink)' }}>Will write:</strong>{' '}
            {Object.entries(patch).map(([k, v]) => (
              <span key={k}>{k}={v === null ? 'null' : String(v)}; </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ConfirmDeleteModal({ row, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const confirm = () => {
    // Optimistic delete: onDeleted() closes the dialog AND drops the row from
    // local state immediately, so it feels instant. The DB delete runs in the
    // background; a failure just means the row reappears on the next reload.
    onDeleted?.()
    supabase
      .from('lib_creative_library')
      .delete()
      .eq('id', row.id)
      .then(({ error }) => { if (error) console.error('Delete failed:', error.message) })
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Delete"
      title="Remove this creative?"
      subtitle="This removes the database row from your library. The file in Drive is NOT deleted — you can re-add it later by uploading again."
      footer={
        <>
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={confirm} disabled={busy} style={{
            ...primaryBtn, background: 'var(--down)', borderColor: 'var(--down)',
          }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 12, padding: 12,
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          color: 'var(--ink-2)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{rowDisplayName(row)}</div>
          {row.canonical_name && row.canonical_name !== row.name && (
            <div style={{ marginTop: 4, color: 'var(--ink-4)', fontSize: 11 }}>{row.name}</div>
          )}
          <div style={{ marginTop: 6, color: 'var(--ink-3)', fontSize: 11 }}>
            {row.type} · {row.creator || 'no creator'} · {row.size_mb ? Math.round(row.size_mb) + ' MB' : ''}
          </div>
        </div>
      </div>
    </Modal>
  )
}


/* Multi-select filter dropdown — small button that opens a popover with
   checkboxes. selected is a Set of currently-chosen values; onChange
   receives a new Set. Button label shows count when 2+ are selected.
   Click outside or Esc to close. */
// DOMRect has its top/left/bottom/right/width/height as getters on the
// PROTOTYPE, not own enumerable properties. That means `{ ...domRect }`
// silently drops every positioning field. The result of spread is just
// `{}`. This caused FilterDropdown popovers to render with NaN coords
// (top/left undefined → arithmetic produces NaN) and disappear — the
// "▲ arrow but no panel" bug Ben kept hitting.
//
// rectToObj copies the values into a plain object that can be safely
// spread / extended.
function rectToObj(r) {
  if (!r) return null
  return {
    top: r.top, left: r.left, bottom: r.bottom, right: r.right,
    width: r.width, height: r.height,
  }
}

function FilterDropdown({ label, selected, options, allCount, onChange }) {
  // Single combined state: null = closed, { rect } = open with captured
  // trigger rect. Earlier two-state versions had a subtle race where
  // `setOpen(true)` could commit a frame before `setRect(...)` landed,
  // leaving the render gate `open && rect` false for one render and
  // letting concurrent setRows updates (from background transcript
  // loader / cache hydration) replace the popover instance before it
  // appeared. Collapsing to one state means a single atomic update.
  const [popover, setPopover] = useState(null)
  const ref = useRef(null)
  const popRef = useRef(null)
  const open = !!popover
  const handleToggle = () => {
    if (popover) {
      setPopover(null)
    } else if (ref.current) {
      setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
    }
  }
  useEffect(() => {
    if (!popover) return
    const onDocClick = (e) => {
      const inBtn = ref.current && ref.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setPopover(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setPopover(null) }
    const onScroll = () => {
      if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [!!popover])

  const isAll = selected.size === 0
  const selectedOpts = options.filter(o => selected.has(o.value))
  const buttonLabel = isAll
    ? `${label}: ALL`
    : selectedOpts.length === 1
      ? `${label}: ${selectedOpts[0].label}`
      : `${label}: ${selectedOpts.length} SELECTED`

  const toggle = (v) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(next)
  }
  const clear = () => onChange(new Set())

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button"
        onClick={handleToggle}
        style={{
          padding: '5px 9px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: isAll ? 'var(--paper)' : 'var(--accent)',
          color: 'var(--ink)',
          border: '1px solid ' + (isAll ? 'var(--rule)' : 'var(--ink)'),
          borderRadius: 9, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
        {selectedOpts.length === 1 && selectedOpts[0].dot && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: selectedOpts[0].dot, display: 'inline-block' }} />
        )}
        <span>{buttonLabel}</span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>{open ? '▲' : '▼'}</span>
      </button>
      {popover && (() => {
        const popoverWidth = Math.max(260, popover.rect.width)
        const synthRect = { ...popover.rect, width: popoverWidth }
        const coords = popoverCoords(synthRect, 320, 4)
        if (!coords) return null
        return createPortal(
        <div ref={popRef} style={{
          position: 'fixed',
          top: coords.top,
          left: coords.left,
          minWidth: popoverWidth,
          maxHeight: coords.maxHeight, overflowY: 'auto',
          zIndex: 9999,
          background: 'var(--paper)', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.25)',
          padding: 4,
        }}>
          <button onClick={clear}
            type="button"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '6px 10px',
              background: isAll ? 'var(--paper-2)' : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11,
              fontWeight: isAll ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            <span style={{
              width: 16, height: 16, borderRadius: 9,
              border: isAll ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
              background: isAll ? 'var(--accent)' : 'var(--paper)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {isAll && (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span style={{ flex: 1 }}>All</span>
            <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{allCount}</span>
          </button>
          {options.map(opt => {
            const isOn = selected.has(opt.value)
            return (
              <button key={opt.value}
                onClick={() => toggle(opt.value)}
                type="button"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '6px 10px',
                  background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--mono)', fontSize: 11,
                  fontWeight: isOn ? 700 : 500,
                  letterSpacing: '0.06em',
                }}>
                <span style={{
                  width: 16, height: 16, borderRadius: 9,
                  border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                  background: isOn ? 'var(--accent)' : 'var(--paper)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {isOn && (
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: opt.dot || 'var(--ink-4)',
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1 }}>
                  {opt.label}
                  {opt.sublabel && (
                    <span style={{ marginLeft: 6, color: 'var(--ink-4)', fontSize: 9.5, fontWeight: 400, textTransform: 'none' }}>
                      · {opt.sublabel}
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{opt.count}</span>
              </button>
            )
          })}
        </div>,
        document.body
        )
      })()}
    </div>
  )
}

/* Editorial-style inline filter strip — kept for any callers that still
   want the inline format. New library toolbar uses FilterDropdown. */
function FilterStrip({ label, active, options, onPick, onClear, totalCount }) {
  const sep = (
    <span style={{ color: 'var(--ink-4)', opacity: 0.5, padding: '0 8px' }}>·</span>
  )
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', flexWrap: 'wrap',
      padding: '4px 0',
      fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      <div style={{
        width: 56, flexShrink: 0,
        fontSize: 9.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--ink-3)',
      }}>{label}</div>
      <button onClick={onClear} type="button"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontFamily: 'var(--mono)', fontSize: 11,
          color: !active ? 'var(--ink)' : 'var(--ink-3)',
          fontWeight: !active ? 600 : 400,
          borderBottom: !active ? '2px solid var(--accent)' : '2px solid transparent',
          lineHeight: 1.5,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
        All <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{totalCount}</span>
      </button>
      {options.map(opt => {
        const isOn = active === opt.value
        return (
          <span key={opt.value} style={{ display: 'inline-flex', alignItems: 'baseline' }}>
            {sep}
            <button onClick={() => onPick(opt.value)} type="button"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontFamily: 'var(--mono)', fontSize: 11,
                color: isOn ? 'var(--ink)' : 'var(--ink-3)',
                fontWeight: isOn ? 600 : 400,
                borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                lineHeight: 1.5,
                display: 'inline-flex', alignItems: 'center', gap: 5,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
              {opt.dot && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: opt.dot, display: 'inline-block' }} />
              )}
              <span>{opt.label}</span>
              <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>{opt.count}</span>
            </button>
          </span>
        )
      })}
    </div>
  )
}

function CreativeCard({ row, isUsed = false, onClick, selected = false, selectionMode = false, onToggleSelect = null, onDragStartClip = null }) {
  const [hover, setHover] = useState(false)
  // 320ms hover delay before swapping to the preview video — avoids
  // spawning a network request + video decoder for every tile the
  // operator's cursor crosses during a scan.
  const [hoverPlay, setHoverPlay] = useState(false)
  useEffect(() => {
    if (!hover) { setHoverPlay(false); return }
    const t = setTimeout(() => setHoverPlay(true), 120)
    return () => clearTimeout(t)
  }, [hover])
  // In selectionMode, clicking the tile body toggles selection instead of
  // opening the drawer. Click the checkbox directly to toggle out of
  // selection mode. The checkbox is always visible to onToggleSelect-
  // enabled viewers (otherwise it's hidden entirely).
  const handleCardClick = (e) => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(row.id)
    } else {
      onClick?.()
    }
  }
  const handleCheckboxClick = (e) => {
    e.stopPropagation()
    if (onToggleSelect) onToggleSelect(row.id)
  }
  const tint = rowStatusTint(row, isUsed)
  // Display status — a clip carrying a submitted edit (final_cut_url) must NOT
  // read RAW just because it isn't approved yet (Ben 2026-06-27: "these are
  // still saying raw even though theyre edited"). edited (approved) > review
  // (edit submitted) > raw.
  const dispStatus = row.status === 'edited' ? 'edited'
    : (row.final_cut_url && row.final_cut_url !== row.preview_url) ? 'review'
    : 'raw'
  // Prefer the EDITED frame on the tile so edited clips show the edit, not the
  // raw (Ben 2026-06-28: "some thumbnails aren't pulling through the edited").
  const tileThumb = row.final_cut_thumbnail_url || row.thumbnail_url
  // Inline rename from the grid (Ben 2026-06-28: "need to be able to rename
  // these"). Double-click the name → edit → save display_name.
  const [renaming, setRenaming] = useState(false)
  const [localName, setLocalName] = useState(null)
  const displayedName = localName ?? rowDisplayName(row)
  const saveRename = async (val) => {
    const v = (val || '').trim()
    setRenaming(false)
    if (!v || v === displayedName) return
    setLocalName(v)
    try { await supabase.from('lib_creative_library').update({ display_name: v }).eq('id', row.id) } catch { /* surfaced on next refetch */ }
  }
  return (
    <div onClick={handleCardClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      draggable={!!onDragStartClip}
      onDragStart={onDragStartClip ? (e) => onDragStartClip(row, e) : undefined}
      style={{
        cursor: 'pointer',
        background: tint ? (hover ? tint.hover : tint.base) : 'var(--paper)',
        border: selected ? '2px solid var(--accent)'
              : hover ? '1px solid var(--ink)'
              : '1px solid var(--rule)',
        borderRadius: 12, overflow: 'hidden',
        transition: 'border-color 0.12s, background 0.12s',
        position: 'relative',
        outline: selected ? '1px solid rgba(240,224,80,0.5)' : 'none',
        outlineOffset: selected ? 1 : 0,
      }}>
      {/* Selection checkbox — top-left corner. Always visible if a
          toggle handler is wired in; hover/selected states have stronger
          contrast. */}
      {onToggleSelect && (
        <div onClick={handleCheckboxClick}
          style={{
            position: 'absolute', top: 8, left: 8, zIndex: 3,
            width: 22, height: 22,
            borderRadius: 9,
            background: selected ? 'var(--accent)' : 'rgba(255,255,255,0.92)',
            border: selected ? '2px solid var(--ink)' : '1.5px solid var(--ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            opacity: (selected || hover || selectionMode) ? 1 : 0.55,
            transition: 'opacity 0.12s, background 0.12s, border-color 0.12s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            ...(selected ? { animation: 'optBoxPop 0.22s cubic-bezier(0.2,1.5,0.4,1)' } : {}),
          }}
          title={selected ? 'Deselect' : 'Select for bulk edit'}>
          {selected && (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              style={{ animation: 'optCheckPop 0.24s cubic-bezier(0.2,1.5,0.4,1) both' }}>
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      {/* Thumbnail */}
      <div style={{
        aspectRatio: '16 / 9',
        background: tileThumb
          ? '#000'   // black behind the image to hide letterbox for portrait
          : 'linear-gradient(135deg, var(--paper-2) 0%, var(--rule) 100%)',
        position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {/* draggable={false} on the media: browsers start a NATIVE image
            drag when the grab lands on an <img> (which covers most of the
            tile), hijacking the card's drag and dropping our clip payload
            on the floor. The card div must own every drag. */}
        {/* Thumbnail stays as the base layer so the hover video can fade in
            on top of it — no black flash while the video buffers (Ben). */}
        {tileThumb && (
          <img src={tileThumb} alt=""
            loading="lazy"
            draggable={false}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {hoverPlay && row.preview_url && (
          <video src={row.preview_proxy_url || row.preview_url}
            autoPlay muted loop playsInline preload="metadata"
            poster={tileThumb || undefined}
            draggable={false}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {!tileThumb && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            No thumbnail
          </span>
        )}
        {/* Type pill — top-left, color-coded per type */}
        {row.type && row.type !== 'unknown' && (() => {
          const tc = typeColor(row.type)
          return (
            <span style={{
              /* bottom-left so it never collides with the top-left select
                 checkbox (Ben: "label for hook appearing above") */
              position: 'absolute', bottom: 6, left: 6,
              padding: '3px 9px', borderRadius: 999,
              background: tc.ink, color: '#fff',
              fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{row.type}</span>
          )
        })()}
        {/* v21 match pill — top-right */}
        {row.v21_script_id && (
          <span style={{
            position: 'absolute', top: 6, right: 6,
            padding: '2px 6px',
            background: 'var(--accent)', color: 'var(--ink)',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
            letterSpacing: '0.06em',
          }}>{row.v21_script_id}</span>
        )}
        {/* Status pill — bottom-right. Edited = green, Review = amber (edit
            submitted, not yet approved), Raw = dark. Derived so a clip with an
            edit never shows Raw (Ben 2026-06-27). */}
        <span style={{
          position: 'absolute', bottom: 6, right: 6,
          padding: '3px 9px', borderRadius: 999,
          background: dispStatus === 'edited' ? 'var(--up)'
            : dispStatus === 'review' ? '#d09c08'
            : 'rgba(21,22,26,0.70)',
          color: '#fff',
          fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{dispStatus === 'edited' ? 'Edited' : dispStatus === 'review' ? 'Review' : 'Raw'}</span>
      </div>
      {/* Body */}
      <div style={{ padding: '10px 12px' }}>
        {renaming ? (
          <input autoFocus type="text" defaultValue={displayedName}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onBlur={e => saveRename(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') e.target.blur()
              else if (e.key === 'Escape') { setLocalName(localName); setRenaming(false) }
            }}
            style={{
              width: '100%', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              color: 'var(--ink)', padding: '2px 6px', borderRadius: 6,
              border: '1px solid var(--ink)', outline: 'none', boxSizing: 'border-box',
            }} />
        ) : (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            color: 'var(--ink)', lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            textDecoration: (row.status === 'raw' && isUsed) ? 'line-through' : 'none',
            opacity: (row.status === 'raw' && isUsed) ? 0.7 : 1,
            cursor: 'text',
          }} title="Double-click to rename"
            onDoubleClick={e => { e.stopPropagation(); setRenaming(true) }}>
            {(row.status === 'raw' && isUsed) && (
              <span title="Already edited"
                style={{ color: 'var(--up)', marginRight: 4 }}>✓</span>
            )}
            {displayedName}
          </div>
        )}
        <div style={{
          marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {/* Creator display removed 2026-06-26 (Ben). */}
          {row.offer_slug && (() => {
            const oc = offerColor(row.offer_slug)
            const short = row.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '')
            return (
              <span style={{
                padding: '1px 5px',
                background: oc.soft, color: oc.ink,
                border: '1px solid ' + oc.border, borderRadius: 9,
                fontWeight: 600,
              }}>{short}</span>
            )
          })()}
          {row.has_been_run && (
            <span title="Run before"
              style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--up)' }} />
          )}
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={dispStatus} /></span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── DETAIL MODAL (click row) ─────────────────────── */

function CreativeDetailModal({ row, isUsed = false, scope = ADMIN_SCOPE, editors: editorsProp, offers: offersProp, knownCreators: knownCreatorsProp, onOpenRow, onClose, onSaved, onRowPatched, onDeleted }) {
  const [edit, setEdit] = useState(row)
  // Lead with the EDITED version (Ben 2026-06-26): pull the sibling versions
  // (root + parent_id=root) and play the edited one as the big player; the raw
  // is demoted to a small clickable thumbnail. The metadata form below still
  // edits whichever row you actually opened.
  const [siblings, setSiblings] = useState([])
  useEffect(() => {
    const rootId = row.parent_id || row.id
    let on = true
    supabase.from('lib_creative_library')
      .select('id, status, preview_url, preview_proxy_url, thumbnail_url, version_number, name, canonical_name, display_name, type')
      .or(`id.eq.${rootId},parent_id.eq.${rootId}`)
      .eq('exclude_from_library', false)
      .order('version_number', { ascending: false })
      .then(({ data }) => { if (on) setSiblings(data || []) })
    return () => { on = false }
  }, [row.parent_id, row.id])
  const editedSibling = siblings.find(v => v.status === 'edited' && v.preview_url)
  const playerRow = editedSibling || row
  const rawSibling = siblings.find(v => v.status === 'raw' && v.preview_url && v.id !== playerRow.id)

  // ── Task-flow merge (Ben 2026-06-27: "merge raw + approved edit into 1
  //    file, edited taking precedence") ───────────────────────────────────
  // When an editor's cut is approved, it's written to THIS row's
  // final_cut_url while the raw stays in preview_url — one record holds both.
  // hasRowEdit = the row carries an approved edit distinct from its raw.
  const hasRowEdit = !!(row.final_cut_url && row.final_cut_url !== row.preview_url)
  // Pull the submission behind final_cut_url so we can stream its fast proxy
  // and show its poster instead of the heavy original.
  const [approvedSub, setApprovedSub] = useState(null)
  useEffect(() => {
    if (!hasRowEdit) { setApprovedSub(null); return }
    let on = true
    supabase.from('lib_task_submissions')
      .select('id, task_id, file_url, preview_proxy_url, thumbnail_url, version_number, approved_at')
      .eq('file_url', row.final_cut_url)
      .order('approved_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .then(({ data }) => { if (on) setApprovedSub(data?.[0] || null) })
    return () => { on = false }
  }, [hasRowEdit, row.final_cut_url])
  // The big player leads with the edit; the user can flip to the raw.
  const [viewRaw, setViewRaw] = useState(false)

  // Auto-pick the offer/niche from the folder when none is set yet
  // (Ben 2026-06-27: "automatically pick the offer and niche"). Uses the
  // majority offer of the other clips in the same folder; only fills an EMPTY
  // field — never overrides a manual choice.
  useEffect(() => {
    if (row.offer_slug || !row.folder_id) return
    let on = true
    supabase.from('lib_creative_library')
      .select('offer_slug').eq('folder_id', row.folder_id).not('offer_slug', 'is', null)
      .then(({ data }) => {
        if (!on || !data || !data.length) return
        const counts = {}
        for (const r of data) counts[r.offer_slug] = (counts[r.offer_slug] || 0) + 1
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
        if (best && best[0]) setEdit(e => (e.offer_slug ? e : { ...e, offer_slug: best[0] }))
      })
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.folder_id])
  const editApproved = !!approvedSub?.approved_at
  const editView = {
    src: approvedSub?.preview_proxy_url || approvedSub?.file_url || row.final_cut_url,
    poster: approvedSub?.thumbnail_url || row.thumbnail_url,
    download: row.final_cut_url, name: rowDisplayName(row),
    key: 'edit-' + (approvedSub?.file_url || row.final_cut_url || row.id),
    // Honest label: final_cut_url is set on every upload, not just approval.
    label: (editApproved ? 'Approved edit' : 'Edited cut')
      + (approvedSub?.version_number ? ` · v${approvedSub.version_number}` : ''),
  }
  const rawView = {
    src: row.preview_proxy_url || row.preview_url,
    poster: row.thumbnail_url,
    download: row.drive_url || row.preview_url, name: rowDisplayName(row),
    key: 'raw-' + row.id, label: 'Raw source',
  }
  const lead = viewRaw ? rawView : editView

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle') // idle | saving | saved | error
  // Approve the pending edit straight from the library (Ben 2026-06-27: "it
  // really just needs to be reviewed"). Marks the submission approved, moves
  // its task to done, and flips the row to status='edited'.
  const [approving, setApproving] = useState(false)
  const approveRowEdit = async () => {
    // Don't partial-apply: if we can't resolve the submission behind
    // final_cut_url, flipping the library to 'edited' while the queue task
    // stays open is a silent inconsistency. Bail with a clear message.
    if (!approvedSub?.id) {
      setErr("Couldn't find the submitted file to approve — reload and try again.")
      return
    }
    setApproving(true)
    try {
      const nowIso = new Date().toISOString()
      await supabase.from('lib_task_submissions')
        .update({ approved_at: nowIso, approved_by_name: 'admin' }).eq('id', approvedSub.id)
      if (approvedSub.task_id) {
        await supabase.from('lib_editing_tasks')
          .update({ status: 'done', completed_at: nowIso }).eq('id', approvedSub.task_id)
      }
      const { error } = await supabase.from('lib_creative_library')
        .update({ status: 'edited', final_cut_thumbnail_url: approvedSub?.thumbnail_url || undefined }).eq('id', row.id)
      if (error) throw error
      setEdit(e => ({ ...e, status: 'edited' }))
      setApprovedSub(s => (s ? { ...s, approved_at: nowIso } : s))
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'approve failed')
    } finally {
      setApproving(false)
    }
  }
  // Replace-source-file state. Only used when the row is is_low_quality:
  // operator clicks "Replace original" → file picker → TUS upload → patch
  // the SAME row's preview_url (preserves editor task links). is_low_quality
  // flag clears automatically because the new file's size_mb will be > the
  // bad threshold next audit run.
  const [replaceProgress, setReplaceProgress] = useState(null) // null | 'uploading 35%' | 'done' | 'error: ...'
  const replaceInputRef = useRef(null)
  const handleReplaceFile = async (file) => {
    if (!file) return
    try {
      setReplaceProgress('uploading 0%')
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      // Stamp the path with a timestamp so the new URL differs from the
      // old (browsers cache aggressively by URL). Keeps the SAME library id.
      const storagePath = `incoming/${row.id}_replaced_${Date.now()}_${sanitized}`
      let lastPct = -1
      await uploadWithResume(file, {
        bucket: 'creative-uploads',
        path: storagePath,
        contentType: file.type || 'video/mp4',
        onProgress: (frac) => {
          const pct = Math.floor(frac * 20) * 5
          if (pct !== lastPct) { lastPct = pct; setReplaceProgress(`uploading ${pct}%`) }
        },
      })
      const newUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`
      const sizeMB = Math.round(file.size / 1024 / 1024 * 10) / 10
      // Regenerate the thumbnail from the new high-quality source — without
      // this the matrix tile + kanban card kept showing the OLD low-res
      // poster, so a replaced HQ file looked unchanged from the operator's
      // POV. Try the local File fast path first, fall back to HTTP-range
      // off the just-uploaded URL for >500MB files.
      let newThumbnailUrl = null
      const isVideoFile = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)
      if (isVideoFile) {
        let thumbBlob = await captureVideoThumbnail(file)
        if (!thumbBlob) thumbBlob = await captureVideoThumbnailFromUrl(newUrl)
        if (thumbBlob) {
          const thumbPath = `incoming/${row.id}_replaced_${Date.now()}_thumb.jpg`
          const { error: thumbErr } = await supabase.storage
            .from('creative-uploads')
            .upload(thumbPath, thumbBlob, { upsert: true, contentType: 'image/jpeg' })
          if (!thumbErr) {
            newThumbnailUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${thumbPath}`
          }
        }
      } else {
        // Image replace: the uploaded file IS the thumbnail (full-quality).
        newThumbnailUrl = newUrl
      }
      setReplaceProgress('saving')
      // Single PATCH: update URL + size + clear all low-quality flag fields
      // so the row stops appearing in the "hidden" bucket and the LOW-Q
      // badge disappears immediately. We do NOT touch transcript / creator /
      // canonical_name — those derived fields still apply since the source
      // content is the same clip, just at higher quality.
      const patch = {
        preview_url: newUrl,
        size_mb: sizeMB,
        is_low_quality: false,
        low_quality_reason: null,
        low_quality_actual_mb: null,
        low_quality_detected_at: null,
        source_bucket: 'Source file replaced',
        notes: `Source file replaced on ${new Date().toISOString().slice(0,10)} (was ${row.low_quality_reason || 'damaged'}, ${row.low_quality_actual_mb || '?'} MB).\n\n${row.notes || ''}`.trim(),
      }
      if (newThumbnailUrl) patch.thumbnail_url = newThumbnailUrl
      const { error: upErr } = await supabase.from('lib_creative_library').update(patch).eq('id', row.id)
      if (upErr) throw new Error(upErr.message)
      // Surface the updated row to the parent matrix so it disappears from
      // the low-quality filter immediately.
      onRowPatched?.(row.id, {
        preview_url: newUrl,
        size_mb: sizeMB,
        is_low_quality: false,
        low_quality_reason: null,
        low_quality_actual_mb: null,
        ...(newThumbnailUrl ? { thumbnail_url: newThumbnailUrl } : {}),
      })
      // Notify any editor currently assigned to a task on this creative —
      // their source video just changed and any cut they were working on
      // may be out of sync. Lookup tasks for this creative + dispatch.
      try {
        const { data: tasksForCreative } = await supabase.from('lib_editing_tasks')
          .select('id, editor_id')
          .eq('creative_id', row.id)
          .not('editor_id', 'is', null)
          .neq('status', 'done')
        const seen = new Set()
        for (const t of tasksForCreative || []) {
          if (seen.has(t.editor_id)) continue
          seen.add(t.editor_id)
          notifyEditor({
            editor_id: t.editor_id,
            kind: 'source_replaced',
            task_id: t.id,
            creative_id: row.id,
            title: `Source video replaced — ${rowDisplayName(row)}`,
            body: 'Admin replaced the source clip with a higher-quality version. Re-download before continuing your edit.',
            link_path: `/editor-view?task=${t.id}`,
          })
        }
      } catch { /* notification dispatch is best-effort */ }
      // Fire transcribe pipeline so transcript + actor + canonical_name
      // get regenerated from the new HQ file (the old transcript was from
      // a 0.3 Mbps audio track, probably garbage).
      const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)
      if (isVideo) {
        supabase.functions.invoke('transcribe-library-clip', {
          body: { library_id: row.id, storage_path: storagePath },
        }).then(() => {
          supabase.functions.invoke('identify-actor', { body: { library_ids: [row.id] } })
            .then(() => supabase.functions.invoke('creative-library-describe', { body: { library_ids: [row.id] } }))
        }).catch(() => { /* best-effort */ })
      }
      setReplaceProgress('done')
      setTimeout(() => setReplaceProgress(null), 2500)
    } catch (e) {
      setReplaceProgress(`error: ${e?.message || 'failed'}`)
    }
  }
  // Prefer props from the parent (avoid 3 extra network roundtrips
  // each time the modal opens). Fall back to local fetch if the
  // parent didn't pass them (e.g. modal opened standalone somewhere).
  const [editorsLocal, setEditorsLocal] = useState([])
  const [offersLocal, setOffersLocal] = useState([])
  const [knownCreatorsLocal, setKnownCreatorsLocal] = useState([])
  // Offer create/edit modal state. null = closed; { existing } = open
  // (existing=null → create mode, existing=row → edit mode).
  const [offerModal, setOfferModal] = useState(null)
  const editors = editorsProp && editorsProp.length > 0 ? editorsProp : editorsLocal
  // Merge any locally created/renamed offers over the base list (local wins
  // by slug) so the dropdown reflects edits made via OfferConfigModal without
  // waiting for the parent to reload.
  const offersBase = offersProp && offersProp.length > 0 ? offersProp : offersLocal
  const offers = useMemo(() => {
    const map = new Map()
    for (const o of offersBase) map.set(o.slug, { slug: o.slug, name: o.name })
    for (const o of offersLocal) map.set(o.slug, { slug: o.slug, name: o.name })
    return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [offersBase, offersLocal])
  const knownCreators = knownCreatorsProp && knownCreatorsProp.length > 0 ? knownCreatorsProp : knownCreatorsLocal
  const [showAdvanced, setShowAdvanced] = useState(false)
  // When the viewer is an editor on /editor-view, auto-target them as the assignee.
  // 2026-05-21: dropped the inline assign-editor form below the existing
  // tasks list — it duplicated the main 'Assigned Editor' picker higher
  // up in the modal. Migration 087's trigger auto-creates a task whenever
  // assigned_editor_id is set on a raw clip, so the lower form was just
  // doing the same thing in a wordier way.
  const [existingTasks, setExistingTasks] = useState([])
  const firstEditRef = useRef(true)
  const saveTimerRef = useRef(null)
  const savedFlashTimerRef = useRef(null)
  // Track if any auto-save fired during this modal session — if so, we
  // ping onSaved() ONCE when the modal closes so the parent list reloads
  // with fresh data. Avoids the "screen refreshes every keystroke" jank.
  const dirtyDuringSessionRef = useRef(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const deleteCreative = async () => {
    // Cancel any pending debounced auto-save — without this, a save that
    // was queued (e.g. user edited a field then clicked Delete within 600ms)
    // would fire AFTER the delete, re-upserting the row back into the DB.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    setDeleting(true); setErr(null)
    // Best-effort: also remove the underlying storage objects so deleting a
    // bad take doesn't leave orphaned bytes in the bucket. Paths are derived
    // from the row's URL fields. Never blocks the DB delete.
    try {
      const urls = [row.preview_url, row.final_cut_url, row.rough_cut_url,
                    row.approved_url, row.delivered_url, row.thumbnail_url].filter(Boolean)
      const uploads = [], thumbs = []
      for (const u of urls) {
        const mU = u.match(/\/creative-uploads\/(.+)$/)
        if (mU) { uploads.push(decodeURIComponent(mU[1].split('?')[0])); continue }
        const mT = u.match(/\/creative-thumbnails\/(.+)$/)
        if (mT) thumbs.push(decodeURIComponent(mT[1].split('?')[0]))
      }
      // Fire-and-forget so the Delete button doesn't hang on the storage
      // round-trip — the DB delete below is what the user is waiting on.
      if (uploads.length) supabase.storage.from('creative-uploads').remove(uploads).catch(() => {})
      if (thumbs.length) supabase.storage.from('creative-thumbnails').remove(thumbs).catch(() => {})
    } catch { /* orphaned bytes are a cost concern, not a blocker */ }
    const { error } = await supabase.from('lib_creative_library').delete().eq('id', row.id)
    setDeleting(false)
    if (error) {
      setErr(error.message)
      setConfirmDelete(false)
    } else {
      onDeleted?.()
    }
  }

  useEffect(() => {
    let mounted = true
    // Editing-queue tasks for this creative — always fetch (row-specific).
    supabase.from('lib_editing_queue').select('*').eq('creative_id', row.id)
      .then(({ data }) => { if (mounted) setExistingTasks(data || []) })
    // Lazy-load the (potentially large) script for THIS row only — it's
    // deliberately excluded from the lean list query. If migration 101
    // (script_text) isn't applied yet the select 42703s; treat as empty.
    // The `=== undefined` guard means we set it once and never clobber
    // text the user has already started typing.
    supabase.from('lib_creative_library').select('script_text').eq('id', row.id).maybeSingle()
      .then(({ data, error }) => {
        if (!mounted || error) return
        // Use null (not '') for an empty script so a script-less clip isn't
        // re-saved as an empty string on the next auto-save (null → null is
        // a no-op; '' would be a real write).
        setEdit(e => (e.script_text === undefined ? { ...e, script_text: data?.script_text ?? null } : e))
      })
    // Only fetch editors / offers / creators if the parent didn't pass
    // them as props. Avoids 3 redundant queries per modal open.
    if (!editorsProp || editorsProp.length === 0) {
      supabase.from('lib_creative_editors').select('*').eq('active', true).order('name')
        .then(({ data }) => { if (mounted) setEditorsLocal(data || []) })
    }
    if (!offersProp || offersProp.length === 0) {
      supabase.from('offers').select('slug,name').eq('retired', false).order('slug')
        .then(({ data }) => { if (mounted) setOffersLocal(data || []) })
    }
    if (!knownCreatorsProp || knownCreatorsProp.length === 0) {
      supabase.from('lib_creative_library').select('creator')
        .not('creator', 'is', null).eq('exclude_from_library', false)
        .then(({ data }) => {
          if (!mounted) return
          const set = new Set((data || []).map(r => r.creator).filter(Boolean))
          setKnownCreatorsLocal(Array.from(set).sort())
        })
    }
    return () => { mounted = false }
  }, [row.id, editorsProp, offersProp, knownCreatorsProp])

  const save = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSaving(true)
    setErr(null)
    setAutoSaveStatus('saving')
    const patch = {
      type: edit.type, creator: edit.creator, status: edit.status,
      v21_script_id: edit.v21_script_id, notes: edit.notes,
      canonical_name: edit.canonical_name,
      assigned_editor_id: edit.assigned_editor_id || null,
      offer_slug: edit.offer_slug || null,
      content_category: edit.content_category === 'short' ? 'short' : 'ad',
      has_been_run: !!edit.has_been_run,
      // Manual winner/loser grade on the creative (migration 031). null = ungraded.
      outcome: edit.outcome === 'winner' || edit.outcome === 'loser' ? edit.outcome : null,
      // The third STATUS button (EDITED RAW) writes both status='raw'
      // AND manually_marked_used=true, so include the flag in every
      // save. Otherwise the override is lost on the next auto-save.
      manually_marked_used: !!edit.manually_marked_used,
      // Editable name — blank falls back to the auto canonical_name (NULL).
      display_name: (edit.display_name ?? '').trim() || null,
      is_bad_take: !!edit.is_bad_take,
      bad_take_reason: edit.bad_take_reason || null,
      // Messaging angle override (migration 103). Coordinator's free-text
      // rewrite of the AI-generated angle. Empty string -> NULL so the
      // partial unique index on display_name behaves cleanly.
      messaging_angle_override: edit.messaging_angle_override ? edit.messaging_angle_override.trim() || null : null,
      // Only write script_text once it's actually been loaded/edited
      // (lazy-fetched after mount). Including it unconditionally would let
      // an unrelated save fire `script_text: null` before the fetch lands
      // and wipe an existing script.
      ...(edit.script_text !== undefined ? { script_text: edit.script_text || null } : {}),
    }
    // Self-heal when the code references columns whose migration hasn't been
    // applied to the DB yet (is_bad_take/bad_take_reason from 099, script_text
    // from 101, etc.). Without this, ONE missing column 42703-fails the whole
    // update and NOTHING persists — so editing creator/status/notes silently
    // does nothing. On 42703 we strip the named-missing column and retry, so
    // every other field still saves. Self-heals the moment the migration lands.
    let working = { ...patch }
    let resp = await supabase.from('lib_creative_library').update(working).eq('id', row.id)
    let guard = 0
    while (resp.error?.code === '42703' && guard < Object.keys(patch).length) {
      guard++
      const missing = Object.keys(working).find(k => (resp.error.message || '').includes(k))
      if (!missing) break
      delete working[missing]
      resp = await supabase.from('lib_creative_library').update(working).eq('id', row.id)
    }
    const { error } = resp
    if (!silent) setSaving(false)
    if (error) {
      setErr(error.message)
      setAutoSaveStatus('error')
    } else {
      setAutoSaveStatus('saved')
      // Both auto-save AND manual 'Save now' merge the changes into the
      // parent's row state in place — no full reload, no scroll jump,
      // no loss of section visibility / grouping. DB is already updated.
      if (onRowPatched) {
        onRowPatched(row.id, patch)
      } else if (!silent) {
        // Fallback for cases where parent didn't wire onRowPatched
        onSaved?.()
      }
      if (silent) dirtyDuringSessionRef.current = true
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
      savedFlashTimerRef.current = setTimeout(() => setAutoSaveStatus('idle'), 1500)
    }
  }, [edit, row.id, onSaved, onRowPatched])

  // Close handler. Flushes any pending debounced save first (so the
  // last few keystrokes always land in DB + parent state), then closes.
  // save() itself now does the in-place onRowPatched merge — no full
  // reload from this path.
  const handleClose = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      await save({ silent: true })
    }
    onClose?.()
  }, [onClose, save])

  // Auto-save on field changes — Notion-style, debounced 600ms.
  // The `save` callback is kept in a ref so the useEffect only fires
  // when `edit` actually changes — NOT every time the save ref
  // re-creates (which happens on every parent re-render because
  // onRowPatched is passed as an inline arrow). Without this ref,
  // every onRowPatched-triggered parent re-render scheduled ANOTHER
  // save 600ms later → 'Saving… Saved' would flicker forever.
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(() => {
    if (firstEditRef.current) { firstEditRef.current = false; return }
    if (!scope.canEditCreative) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveRef.current({ silent: true }) }, 600)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [edit, scope.canEditCreative])

  // Cleanup pending timers on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
  }, [])

  // The legacy `assign()` handler is gone with the form it backed —
  // assignment now flows through the upper `assigned_editor_id`
  // picker + migration 087's auto-task trigger.

  // Pick the best playback URL — self-hosted preview > drive iframe.
  // An edit-only row (final_cut_url, no raw preview) still plays as video.
  const playbackKind = (playerRow.preview_url || (hasRowEdit && lead.src)) ? 'video' : row.drive_url ? 'iframe' : 'none'

  return (
    <Modal open={true} onClose={handleClose} size="lg"
      eyebrow={edit.type || row.type || 'Creative'}
      title={rowDisplayName(edit)}
      subtitle={(() => {
        // The big title is the name you input (display_name); the subtitle
        // keeps the original/canonical filename for reference (Ben 2026-06-28).
        const orig = edit.canonical_name || row.name
        const sizeBit = row.size_mb ? `${row.source_bucket || 'Manual upload'} · ${Math.round(row.size_mb)} MB` : (row.source_bucket || '')
        return (orig && orig !== rowDisplayName(edit)) ? orig : sizeBit
      })()}
      footer={
        confirmDelete ? (
          <>
            <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto', fontFamily: 'var(--mono)' }}>
              Delete this creative permanently? Can't be undone.
            </span>
            <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={ghostBtn}>Cancel</button>
            <button onClick={deleteCreative} disabled={deleting}
              style={{ ...primaryBtn, background: 'var(--down)', borderColor: 'var(--down)' }}>
              {deleting ? 'Deleting…' : 'Delete forever'}
            </button>
          </>
        ) : (
          <>
            {scope.canEditCreative && (
              <span style={{
                fontSize: 11, fontFamily: 'var(--mono)', marginRight: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                color: autoSaveStatus === 'error' ? 'var(--down)'
                     : autoSaveStatus === 'saving' ? 'var(--ink-3)'
                     : autoSaveStatus === 'saved' ? 'var(--up)'
                     : 'var(--ink-4)',
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: autoSaveStatus === 'error' ? 'var(--down)'
                            : autoSaveStatus === 'saving' ? '#e8b408'
                            : autoSaveStatus === 'saved' ? 'var(--up)'
                            : 'var(--ink-4)',
                }} />
                {autoSaveStatus === 'saving' ? 'Saving…'
                  : autoSaveStatus === 'saved' ? 'Saved'
                  : autoSaveStatus === 'error' ? (err || 'Save failed')
                  : 'Changes save automatically'}
              </span>
            )}
            {err && !scope.canEditCreative && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
            {scope.canDelete && onDeleted && (
              <button onClick={() => setConfirmDelete(true)}
                style={{ ...ghostBtn, color: 'var(--down)', borderColor: 'rgba(181,62,62,0.4)' }}>
                Delete
              </button>
            )}
            <button onClick={handleClose} style={ghostBtn}>Cancel</button>
            {scope.canEditCreative && (
              <button onClick={() => save()} disabled={saving} style={primaryBtn}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </>
        )
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 16 }}>
        {/* Low-quality banner — surfaces WHY playback is dog-shit (file
            was ingested at tiny bitrate, no Drive backup) and gives a
            one-click Replace Original button that runs a TUS upload
            against the SAME row id, preserving editor task assignments. */}
        {row.is_low_quality && (
          <div style={{
            padding: '12px 14px',
            background: '#fff1f1', border: '1px solid var(--down)',
            borderLeft: '3px solid var(--down)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--down)',
            }}>Source file is damaged</div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
              Only <strong>{row.low_quality_actual_mb ?? '?'} MB</strong> stored on disk
              {row.duration_seconds ? ` for a ${row.duration_seconds}-second clip` : ''} —
              this works out to roughly{' '}
              <strong>{
                row.duration_seconds && row.low_quality_actual_mb
                  ? `${((row.low_quality_actual_mb * 1024 * 1024 * 8) / row.duration_seconds / 1000000).toFixed(1)} Mbps`
                  : 'sub-par bitrate'
              }</strong>
              {' '}({row.low_quality_reason === 'placeholder' ? 'truncated during ingest' : 'ingested at low bitrate'}).
              No Drive backup exists. Re-upload the original from source to fix — the row id stays
              the same so any editor task assignments are preserved.
            </div>
            {replaceProgress ? (
              <div style={{
                padding: '6px 10px', background: 'var(--paper)', border: '1px solid var(--rule)',
                fontFamily: 'var(--mono)', fontSize: 11, color: replaceProgress.startsWith('error') ? 'var(--down)' : 'var(--ink-2)',
              }}>{replaceProgress}</div>
            ) : (
              <div>
                <input type="file" ref={replaceInputRef} accept="video/*,image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReplaceFile(f) }} />
                <button type="button" onClick={() => replaceInputRef.current?.click()}
                  style={{
                    padding: '8px 14px',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--ink)', color: 'var(--paper)',
                    border: 'none', cursor: 'pointer', borderRadius: 9,
                  }}>↑ Replace original</button>
              </div>
            )}
          </div>
        )}

        {/* Two-column body — media LEFT, editable fields RIGHT — mirrors the
            editing-queue task modal so the two views read identically
            (Ben 2026-06-26: "still different here"). auto-fit collapses to
            one column on narrow screens. */}
        <div style={{
          display: 'grid', gap: 20, alignItems: 'start',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        }}>
        {/* ── LEFT: media ── */}
        <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
        {/* Video preview — uses the compact OPT player so the chrome
            matches the Review modal + the inline SubmissionsPanel
            player (Ben 2026-06-01: "needs to be pretty congruent
            across the board"). */}
        {playbackKind === 'video' && (hasRowEdit ? (
          /* ── Merged view: ONE record holds the approved edit + the raw.
             The edit leads; the secondary thumbnail flips the player to the
             raw and back (Ben 2026-06-27). ── */
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{
                padding: '3px 10px', borderRadius: 999,
                background: viewRaw ? 'rgba(21,22,26,0.70)' : 'var(--up)', color: '#fff',
                fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>{lead.label}</span>
              <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)' }}>
                {viewRaw ? 'the original footage — edit at right'
                  : (editApproved ? 'the approved cut — raw at right' : 'the latest cut — raw at right')}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 10, alignItems: 'start' }}>
              <div style={{ background: 'var(--ink)', border: '1px solid var(--rule)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ height: 'min(62vh, 540px)', background: 'black' }}>
                  <OptVideoPlayer key={lead.key} src={lead.src} compact
                    poster={lead.poster}
                    downloadUrl={lead.download ? toDownloadUrl(lead.download, lead.name) : undefined}
                    downloadName={lead.name || 'creative.mp4'}
                    wrapperStyle={OPT_PLAYER_WRAP_STAGE} />
                </div>
              </div>
              {/* Secondary — the OTHER version. Click swaps the big player.
                  Disabled when that version has no playable source (e.g. an
                  edit-only row with no raw preview) so we never swap to blank. */}
              {(() => {
                const other = viewRaw ? editView : rawView
                const canSwap = !!other.src
                return (
                  <button type="button"
                    onClick={canSwap ? () => setViewRaw(v => !v) : undefined}
                    disabled={!canSwap}
                    title={!canSwap ? (viewRaw ? 'No edit source' : 'No raw source available')
                      : (viewRaw ? 'Back to the approved edit' : 'View the raw source')}
                    style={{
                      padding: 0, border: '1px solid var(--rule)', borderRadius: 10,
                      overflow: 'hidden', cursor: canSwap ? 'pointer' : 'default',
                      opacity: canSwap ? 1 : 0.45, background: 'var(--ink)',
                      aspectRatio: '9 / 12', position: 'relative',
                    }}>
                    {other.poster
                      ? <img src={other.poster} alt="" loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      : <div style={{ width: '100%', height: '100%' }} />}
                    <span style={{
                      position: 'absolute', bottom: 5, left: 5,
                      padding: '2px 7px', borderRadius: 999,
                      background: viewRaw ? 'var(--up)' : 'rgba(21,22,26,0.78)', color: '#fff',
                      fontFamily: 'var(--sans)', fontSize: 8.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>{viewRaw ? 'Edit' : 'Raw'}</span>
                  </button>
                )
              })()}
            </div>
          </div>
        ) : (
          <div>
            {/* Lead-version label — makes it obvious you're watching the edit. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                padding: '3px 10px', borderRadius: 999,
                background: editedSibling ? 'var(--up)' : 'rgba(21,22,26,0.70)', color: '#fff',
                fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>{editedSibling ? 'Edited version' : (playerRow.status === 'edited' ? 'Edited' : 'Raw')}</span>
              {editedSibling && (
                <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)' }}>
                  the finished cut — raw source at right
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: rawSibling ? '1fr 96px' : '1fr', gap: 10, alignItems: 'start' }}>
              {/* Player + download share ONE card — identical structure to
                  the editing-queue modal so the two views read the same
                  (Ben 2026-06-26: "we still also have separate views"). The
                  download lives in the card FOOTER, not a floating bar under
                  the video, and is labelled by what you're actually watching. */}
              <div style={{ background: 'var(--ink)', border: '1px solid var(--rule)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ height: 'min(62vh, 540px)', background: 'black' }}>
                  {(() => {
                    const dl = playerRow.final_cut_url || playerRow.drive_url || playerRow.preview_url
                    return (
                  <OptVideoPlayer key={playerRow.id} src={playerRow.preview_proxy_url || playerRow.preview_url} compact
                    poster={playerRow.thumbnail_url}
                    downloadUrl={dl ? toDownloadUrl(dl, rowDisplayName(playerRow)) : undefined}
                    downloadName={rowDisplayName(playerRow) || 'creative.mp4'}
                    wrapperStyle={OPT_PLAYER_WRAP_STAGE} />
                    )
                  })()}
                </div>
                {/* Download moved OUT from under the video into the form below
                    (Ben 2026-06-26: not below the live video). Card = player. */}
              </div>
              {/* Raw source — small clickable thumbnail (Ben: raw only a snippet). */}
              {rawSibling && (
                <button type="button" onClick={() => onOpenRow?.(rawSibling.id)}
                  title="View the raw source"
                  style={{
                    padding: 0, border: '1px solid var(--rule)', borderRadius: 10,
                    overflow: 'hidden', cursor: 'pointer', background: 'var(--ink)',
                    aspectRatio: '9 / 12', position: 'relative',
                  }}>
                  {rawSibling.thumbnail_url
                    ? <img src={rawSibling.thumbnail_url} alt="" loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <div style={{ width: '100%', height: '100%' }} />}
                  <span style={{
                    position: 'absolute', bottom: 5, left: 5,
                    padding: '2px 7px', borderRadius: 999,
                    background: 'rgba(21,22,26,0.78)', color: '#fff',
                    fontFamily: 'var(--sans)', fontSize: 8.5, fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                  }}>Raw</span>
                </button>
              )}
            </div>
          </div>
        ))}
        {playbackKind === 'iframe' && (
          <div style={{ aspectRatio: '16 / 9', background: 'black', position: 'relative' }}>
            <iframe src={driveEmbedUrl(row.drive_url)}
              title={row.name}
              style={{ width: '100%', height: '100%', border: 'none' }}
              allow="autoplay" />
            <div style={{
              position: 'absolute', bottom: 6, left: 6, right: 6,
              padding: '4px 8px', fontSize: 10.5, fontFamily: 'var(--mono)',
              background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)',
              letterSpacing: '0.05em', borderRadius: 9,
            }}>
              Drive-hosted preview · self-hosted version still processing
            </div>
          </div>
        )}
        {playbackKind === 'none' && (
          <div style={{
            aspectRatio: '16 / 9', background: 'var(--paper-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--sans)', fontStyle: 'italic', color: 'var(--ink-3)',
          }}>
            No playback available
          </div>
        )}
        </div>{/* end LEFT media column */}

        {/* ── RIGHT: editable fields rail ── */}
        <div style={{ display: 'grid', gap: 16, minWidth: 0, alignContent: 'start' }}>
        {/* Slim form — only the fields Ben actually uses to organise creatives.
            Notes, v21 script, and original filename are tucked into the
            'Advanced' disclosure below. */}
        <Field label="Name">
          {/* Editable name (Ben 2026-06-26). Sets display_name directly; blank
              falls back to the auto canonical_name. */}
          <input type="text"
            value={edit.display_name ?? rowDisplayName(edit) ?? ''}
            onChange={e => setEdit({ ...edit, display_name: e.target.value })}
            placeholder={edit.canonical_name || 'Creative name'}
            title={edit.display_name ?? rowDisplayName(edit) ?? ''}
            style={inputStyle} />
        </Field>

        {/* File download — in the form, NOT under the player (Ben 2026-06-26).
            For a merged row (raw + approved edit on one record) we offer BOTH
            downloads explicitly so the flow is clear; otherwise a single
            download labelled raw/final. */}
        {hasRowEdit ? (
          <Field label="Downloads">
            <div style={{ display: 'grid', gap: 8 }}>
              {[
                { label: '↓ Final cut', url: row.final_cut_url, name: rowDisplayName(row), primary: true },
                { label: '↓ Raw source', url: row.drive_url || row.preview_url, name: rowDisplayName(row) + '-raw', primary: false },
              ].filter(d => d.url).map(d => (
                <div key={d.label} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <a href={toDownloadUrl(d.url, d.name)}
                    download={d.name || 'creative.mp4'}
                    rel="noreferrer"
                    title={`Download the ${d.primary ? 'approved edit' : 'raw source'}`}
                    style={{
                      padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 10.5,
                      fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: d.primary ? 'var(--ink)' : 'var(--paper)',
                      color: d.primary ? 'var(--paper)' : 'var(--ink-2)',
                      border: d.primary ? '1px solid var(--ink)' : '1px solid var(--rule)',
                      textDecoration: 'none', borderRadius: 9, minWidth: 130, textAlign: 'center',
                    }}>{d.label}</a>
                  <CopyLinkButton url={toDownloadUrl(d.url, d.name)} label="Copy link" />
                </div>
              ))}
            </div>
          </Field>
        ) : (() => {
          const dl = playerRow.final_cut_url || playerRow.drive_url || playerRow.preview_url
          if (!dl) return null
          const isEdit = !!editedSibling || playerRow.status === 'edited'
          return (
            <Field label={isEdit ? 'Final cut' : 'Raw source'}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <a href={toDownloadUrl(dl, rowDisplayName(playerRow))}
                  download={rowDisplayName(playerRow) || 'creative.mp4'}
                  rel="noreferrer"
                  title="Download this file"
                  style={{
                    padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 10.5,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'var(--ink)', color: 'var(--paper)',
                    textDecoration: 'none', borderRadius: 9,
                  }}>↓ Download{isEdit ? '' : ' raw'}</a>
                <CopyLinkButton url={toDownloadUrl(dl, rowDisplayName(playerRow))} label="Copy link" />
              </div>
            </Field>
          )
        })()}

        <Field label="Messaging angle (override)">
          {/* Free-text override of the AI-generated messaging_angle. The AI
              value is preserved in messaging_angle so we can compare and
              revert. Empty override -> AI value wins. */}
          <input type="text"
            value={edit.messaging_angle_override || ''}
            placeholder={edit.messaging_angle ? `AI: ${edit.messaging_angle}` : 'No angle generated yet — describe will populate after transcribe'}
            onChange={e => setEdit({ ...edit, messaging_angle_override: e.target.value })}
            style={inputStyle} />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 4 }}>
            Edits the MESSAGING slot in display_name. Use kebab-case or plain words —
            it'll be UPPER-KEBAB-CASED automatically.
          </div>
        </Field>

        {/* Type — pill button group, color-coded per type. Much more
            scannable than a native select. */}
        <Field label="Type">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {TYPES.map(t => {
              const isOn = edit.type === t
              const tc = typeColor(t)
              return (
                <button key={t} type="button"
                  onClick={() => setEdit({ ...edit, type: t })}
                  style={{
                    padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? tc.ink : tc.soft,
                    color: isOn ? 'white' : tc.ink,
                    border: '1px solid ' + (isOn ? tc.ink : tc.border),
                    borderRadius: 9, cursor: 'pointer',
                    transition: 'all 0.1s',
                  }}>
                  {t}
                </button>
              )
            })}
          </div>
        </Field>

        {/* Format — ad vs short-form. Drives the editing-queue Ads | Shorts
            toggle (Ben 2026-06-28). */}
        <Field label="Format">
          <div style={{ display: 'flex', gap: 5 }}>
            {[
              { v: 'ad', label: 'Ad creative' },
              { v: 'short', label: 'Short creative' },
            ].map(opt => {
              const isOn = (edit.content_category || 'ad') === opt.v
              return (
                <button key={opt.v} type="button"
                  onClick={() => setEdit({ ...edit, content_category: opt.v })}
                  style={{
                    flex: 1, padding: '8px 12px',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? 'var(--ink)' : 'var(--paper)',
                    color: isOn ? 'var(--paper)' : 'var(--ink-3)',
                    border: '1px solid ' + (isOn ? 'var(--ink)' : 'var(--rule)'),
                    cursor: 'pointer', borderRadius: 9,
                  }}>
                  {opt.label}
                </button>
              )
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Status">
            {/* When the clip carries a submitted edit, the status is DERIVED
                from the edit (Ben 2026-06-27: an edited clip shouldn't read
                RAW). Unapproved edit → "Needs review" + one-click Approve;
                approved/edited → "Edited". No edit → the manual RAW/EDITED
                pills. */}
            {hasRowEdit && !editApproved && edit.status !== 'edited' ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 9,
                  background: '#fffaea', border: '1px solid #e8b408', color: '#9a7400',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d09c08' }} />
                  Needs review
                </div>
                <button type="button" onClick={approveRowEdit} disabled={approving}
                  style={{
                    padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--up)', color: '#fff', border: '1px solid var(--up)',
                    borderRadius: 9, cursor: approving ? 'wait' : 'pointer', width: '100%',
                  }}>
                  {approving ? 'Approving…' : '✓ Approve edit'}
                </button>
              </div>
            ) : (hasRowEdit || edit.status === 'edited') ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 9,
                background: 'var(--up)', color: '#fff',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>✓ Edited</div>
            ) : (
              <div style={{ display: 'flex', gap: 5 }}>
                {[
                  { v: 'raw',    label: 'RAW',    color: 'var(--down)',
                    isOn: edit.status === 'raw',
                    apply: () => setEdit({ ...edit, status: 'raw', manually_marked_used: false }) },
                  { v: 'edited', label: 'EDITED', color: 'var(--up)',
                    isOn: edit.status === 'edited',
                    apply: () => setEdit({ ...edit, status: 'edited' }) },
                ].map(opt => (
                  <button key={opt.v} type="button"
                    onClick={opt.apply}
                    style={{
                      flex: 1, padding: '8px 14px',
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      background: opt.isOn ? opt.color : 'var(--paper)',
                      color: opt.isOn ? 'white' : opt.color,
                      border: '1px solid ' + opt.color,
                      cursor: 'pointer', borderRadius: 9,
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label="Run before?">
            <button type="button"
              onClick={() => setEdit({ ...edit, has_been_run: !edit.has_been_run })}
              style={{
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: edit.has_been_run ? 'var(--up)' : 'var(--paper)',
                color: edit.has_been_run ? 'white' : 'var(--ink-3)',
                border: edit.has_been_run ? '1px solid var(--up)' : '1px solid var(--rule)',
                cursor: 'pointer', textAlign: 'center', width: '100%',
              }}>
              {edit.has_been_run ? 'Yes — run before' : 'No — not yet'}
            </button>
          </Field>
        </div>

        {/* WINNER / LOSER — manual grade on the creative (migration 031). Click
            an active one again to clear back to ungraded. */}
        <Field label="Winner?">
          <div style={{ display: 'flex', gap: 5 }}>
            <button type="button"
              onClick={() => setEdit({ ...edit, outcome: edit.outcome === 'winner' ? null : 'winner' })}
              style={{
                flex: 1, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: edit.outcome === 'winner' ? 'var(--up)' : 'var(--paper)',
                color: edit.outcome === 'winner' ? '#fff' : 'var(--up)',
                border: '1px solid var(--up)', borderRadius: 9, cursor: 'pointer',
              }}>
              ✓ Winner
            </button>
            <button type="button"
              onClick={() => setEdit({ ...edit, outcome: edit.outcome === 'loser' ? null : 'loser' })}
              style={{
                flex: 1, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: edit.outcome === 'loser' ? 'var(--down)' : 'var(--paper)',
                color: edit.outcome === 'loser' ? '#fff' : 'var(--down)',
                border: '1px solid var(--down)', borderRadius: 9, cursor: 'pointer',
              }}>
              ✕ Loser
            </button>
          </div>
        </Field>

        {/* Creator field removed 2026-06-26 (Ben) — offer + editor only. */}
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Offer / niche">
            <OfferPicker value={edit.offer_slug || null} offers={offers}
              onChange={v => setEdit({ ...edit, offer_slug: v || null })} />
            {scope.canEditCreative && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" onClick={() => setOfferModal({ existing: null })}
                  style={{
                    flex: 1, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'var(--paper)', color: 'var(--ink-3)', border: '1px solid var(--rule)',
                    borderRadius: 9, cursor: 'pointer',
                  }}>+ New offer</button>
                <button type="button" disabled={!edit.offer_slug}
                  onClick={async () => {
                    const { data } = await supabase.from('offers').select('*').eq('slug', edit.offer_slug).maybeSingle()
                    setOfferModal({ existing: data || { slug: edit.offer_slug } })
                  }}
                  style={{
                    flex: 1, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'var(--paper)', color: 'var(--ink-3)', border: '1px solid var(--rule)',
                    borderRadius: 9, opacity: edit.offer_slug ? 1 : 0.4,
                    cursor: edit.offer_slug ? 'pointer' : 'not-allowed',
                  }}>Edit offer</button>
              </div>
            )}
          </Field>
          <Field label="Assigned editor">
            <EditorPicker value={edit.assigned_editor_id}
              editors={editors}
              onChange={v => setEdit({ ...edit, assigned_editor_id: v || null })} />
          </Field>
        </div>

        {offerModal && (
          <OfferConfigModal
            open={true}
            existing={offerModal.existing}
            onClose={() => setOfferModal(null)}
            onSaved={(saved) => {
              // Reflect the create/rename in the dropdown immediately and
              // assign the offer to this creative.
              if (saved?.slug) {
                setOffersLocal(prev => [
                  ...prev.filter(o => o.slug !== saved.slug),
                  { slug: saved.slug, name: saved.name },
                ])
                setEdit(e => ({ ...e, offer_slug: saved.slug }))
              }
              setOfferModal(null)
            }}
          />
        )}
        </div>{/* end RIGHT fields rail */}
        </div>{/* end two-column body */}

        {/* Bad take flag — coordinator/admin marks clips that should never
            be used (wrong angle, flubbed lines, technical failure, etc.).
            Hidden by default in the library via the toolbar filter chip. */}
        <div style={{
          padding: '10px 14px',
          background: edit.is_bad_take ? 'rgba(122,32,32,0.07)' : 'var(--paper-2)',
          border: '1px solid ' + (edit.is_bad_take ? 'rgba(122,32,32,0.35)' : 'var(--rule)'),
          borderLeft: '3px solid ' + (edit.is_bad_take ? '#7a2020' : 'var(--rule)'),
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flexShrink: 0 }}>
            <input type="checkbox"
              checked={!!edit.is_bad_take}
              onChange={e => setEdit({ ...edit, is_bad_take: e.target.checked, bad_take_reason: e.target.checked ? (edit.bad_take_reason || '') : null })} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.10em', textTransform: 'uppercase',
              color: edit.is_bad_take ? '#7a2020' : 'var(--ink-3)' }}>
              Bad take
            </span>
          </label>
          {edit.is_bad_take && (
            <input type="text"
              value={edit.bad_take_reason || ''}
              onChange={e => setEdit({ ...edit, bad_take_reason: e.target.value || null })}
              placeholder="Reason (optional) — wrong angle, flubbed line, audio issue…"
              style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
          )}
          {!edit.is_bad_take && (
            <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.4 }}>
              Flag this clip to hide it from the library. Useful for bad angles, technical failures, or duplicate takes you never want used.
            </span>
          )}
        </div>

        {/* Advanced disclosure — only opens if user wants to touch the rarely-
            used fields. Keeps the default view clean. */}
        <button type="button" onClick={() => setShowAdvanced(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '6px 0', textAlign: 'left',
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}>
          {showAdvanced ? '▾ Hide details' : '▸ More details (notes, v21 script, original filename)'}
        </button>
        {showAdvanced && (
          <>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <Field label="v21 script slot">
                <input type="text" value={edit.v21_script_id || ''}
                  onChange={e => setEdit({ ...edit, v21_script_id: e.target.value })}
                  placeholder="A.1, B.2, etc." style={inputStyle} />
              </Field>
              <Field label="Original filename">
                <div style={{
                  padding: '8px 11px', fontFamily: 'var(--mono)', fontSize: 11,
                  background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }} title={row.name}>{row.name}</div>
              </Field>
            </div>
            <Field label="Script">
              <textarea value={edit.script_text ?? ''}
                onChange={e => setEdit({ ...edit, script_text: e.target.value })}
                rows={6}
                placeholder="Paste the script this footage was shot from. Editors see this (read-only) on their task."
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)', lineHeight: 1.5 }} />
            </Field>
            <Field label="Notes">
              <textarea value={edit.notes || ''}
                onChange={e => setEdit({ ...edit, notes: e.target.value })}
                rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }} />
            </Field>
          </>
        )}

        {row.transcript && <TranscriptBox text={row.transcript} />}

        {/* Submitted work — the SAME SubmissionsPanel + upload + review the
            editing-queue task modal uses, so the two are 1:1 (Ben 2026-06-28:
            "missing approve, revise, copy link, review, upload"). Scoped to
            this creative's editing task. */}
        {existingTasks[0] && (
          <TaskWorkPanel task={existingTasks[0]} scope={scope} onChanged={onSaved} />
        )}

        {/* Versions — raw library siblings linked via parent_id (NOT the
            editor's cuts — those are in Edited versions above). */}
        <VersionsPanel row={row} onReload={() => onSaved?.()} onOpenRow={onOpenRow} />

        {/* Hook/Body history — when viewing a source clip, show which
            Joined composites have used it. */}
        <UsageHistory row={row} onOpenRow={onOpenRow} onRowPatched={onRowPatched} />

        {/* Existing tasks */}
        {existingTasks.length > 0 && (
          <Field label="Editing tasks">
            <div style={{ display: 'grid', gap: 6 }}>
              {existingTasks.map(t => (
                <div key={t.task_id} style={{
                  padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  display: 'flex', alignItems: 'center', gap: 12,
                  fontFamily: 'var(--mono)', fontSize: 11,
                }}>
                  <span style={{ fontWeight: 600 }}>{t.editor_name}</span>
                  <span style={{ color: 'var(--ink-3)' }}>{t.task_type}</span>
                  <span style={{ color: 'var(--ink-3)' }}>{t.status}</span>
                  <span style={{ marginLeft: 'auto', color: (t.is_overdue && t.status !== 'review') ? 'var(--down)' : 'var(--ink-4)' }}>
                    {(t.is_overdue && t.status !== 'review') ? '⚠ overdue ' : ''}{t.due_date || 'no due date'}
                  </span>
                </div>
              ))}
            </div>
          </Field>
        )}

        {/* The duplicate "Assign editor" block that lived here is gone.
            Setting `Assigned Editor` higher up in the modal already
            creates a task automatically (via migration 087's trigger).
            Priority / task type / due date can be tweaked from the
            Editing Queue tab on the freshly-created task row. */}

        {row.drive_url && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
            Drive: <a href={row.drive_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{row.drive_url.slice(0, 70)}…</a>
          </div>
        )}
      </div>
    </Modal>
  )
}

function driveEmbedUrl(url) {
  // Convert /file/d/ID/view → /file/d/ID/preview
  const m = url.match(/\/file\/d\/([^/]+)/)
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`
  return url
}

function EditingQueueTab({ scope = ADMIN_SCOPE, category = 'ad' }) {
  // Stale-while-revalidate: hydrate from the cross-tab module cache
  // so re-mounting the queue tab doesn't show a blank loading state
  // for 2+ seconds while the same data re-fetches.
  const cached = scope.isEditorView ? null : PAGE_CACHE
  const [tasks, setTasks] = useState(() => cached?.tasks || [])
  const [editors, setEditors] = useState(() => cached?.editors || [])
  const [loading, setLoading] = useState(() => !cached?.tasks)
  const [err, setErr] = useState(null)
  const [view, setView] = useState(() => {
    try {
      const saved = localStorage.getItem('queue.view')
      // 'lanes' was the old "Editor lanes" view; it's been removed. Map
      // stale localStorage values to 'kanban' so returning users land
      // somewhere sensible.
      if (saved === 'lanes') return 'kanban'
      return saved || 'list'
    } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('queue.view', view) } catch {} }, [view])
  // `category` ('ad' | 'short') comes from the PAGE now — the queue is scoped
  // to ad creatives or the Shorts page, not an in-page toggle (Ben 2026-06-28).
  const [addEditorOpen, setAddEditorOpen] = useState(false)
  const [addTaskOpen, setAddTaskOpen] = useState(false)
  // Prefill for AddTaskModal — set when the user drags across days in
  // the Timeline view. Falls back to empty fields when opened via the
  // toolbar button or the editor row '+ Add' button.
  const [addTaskPrefill, setAddTaskPrefill] = useState({ editorId: '', due: '', start: '' })
  const [manageEditorsOpen, setManageEditorsOpen] = useState(false)
  const [shareLinksOpen, setShareLinksOpen] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [editingEditor, setEditingEditor] = useState(null)
  // Editor multi-select for filtering. Editor-view auto-selects the
  // viewing editor on first mount so they see their own tasks by default.
  const [selectedEditors, setSelectedEditors] = useState(() => {
    if (scope.isEditorView && scope.editorId) return new Set([scope.editorId])
    return new Set()
  })
  // Auto-clear any admin IDs from the selectedEditors filter. The filter
  // chip used to list everyone including admins; if a user had Kmamajevs
  // selected from before this fix, drop it on first load with the editors
  // data so the UI doesn't show a stale admin filter.
  // Ben caught this 2026-05-24 — 'EDITORS: KMAMAJEVS' chip was active.
  useEffect(() => {
    if (!editors || editors.length === 0) return
    const adminIds = new Set(editors.filter(e => e.tier === 'admin').map(e => e.id))
    if (adminIds.size === 0) return
    setSelectedEditors(prev => {
      const next = new Set([...prev].filter(id => !adminIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [editors])
  // Status multi-select for filtering — empty = show all.
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set())

  // Bulk-select state for the queue list. Keyed by task_id (lib_editing_tasks.id).
  // Admin-only: editors don't bulk-edit each other's tasks. Cleared when the
  // task list reloads to avoid stale IDs.
  const [selectedTasks, setSelectedTasks] = useState(() => new Set())
  const toggleTaskSelect = useCallback((taskId) => {
    setSelectedTasks(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])
  const clearTaskSelection = useCallback(() => setSelectedTasks(new Set()), [])
  const [bulkTaskBusy, setBulkTaskBusy] = useState(false)
  const [bulkTaskMsg, setBulkTaskMsg] = useState(null)
  const canBulkEditTasks = !scope.isEditorView

  // Submissions with unread feedback. Used for the editor-portal banner
  // ("You have feedback on N submissions") and the per-task FEEDBACK
  // badge. Keyed by task_id for fast lookup during the task-card render.
  // We pull a flat list of {id, task_id, version_number} so the banner
  // can show counts + a Set of task_ids so the badge render is O(1).
  const [pendingFeedback, setPendingFeedback] = useState({ tasks: new Set(), submissions: [] })
  useEffect(() => {
    let mounted = true
    // Editor view sees their own tasks. Admin view sees everyone's so
    // they can spot any unread feedback they themselves wrote.
    let q = supabase.from('lib_task_submissions')
      .select('id, task_id, version_number, feedback_text, feedback_at, feedback_by_name')
      .not('feedback_text', 'is', null)
      .is('feedback_read_at', null)
      .is('deleted_at', null)
      .order('feedback_at', { ascending: false })
    q.then(({ data }) => {
      if (!mounted) return
      let rows = data || []
      // Filter to this editor's tasks if we're on a per-editor share link.
      // For team-wide editor links or admins we keep the full list.
      if (scope.isEditorView && scope.editorId && tasks.length > 0) {
        const myTaskIds = new Set(tasks.filter(t => t.editor_id === scope.editorId).map(t => t.task_id))
        rows = rows.filter(s => myTaskIds.has(s.task_id))
      }
      setPendingFeedback({
        tasks: new Set(rows.map(s => s.task_id)),
        submissions: rows,
      })
    })
    return () => { mounted = false }
  }, [tasks, scope.isEditorView, scope.editorId])
  // Clear local pending state when a task modal closes — the modal
  // marked feedback_read_at, so next render of the badge/banner should
  // reflect that immediately without re-querying.
  const clearPendingForTask = useCallback((taskId) => {
    setPendingFeedback(prev => {
      if (!prev.tasks.has(taskId)) return prev
      const nextTasks = new Set(prev.tasks); nextTasks.delete(taskId)
      return {
        tasks: nextTasks,
        submissions: prev.submissions.filter(s => s.task_id !== taskId),
      }
    })
  }, [])

  const load = useCallback(async (background = false, attempt = 0) => {
    if (!background) setLoading(true)
    setErr(null)
    // 20s hard timeout (see LibraryTab.load — same reasoning).
    const TIMEOUT_MS = 20_000
    const timeoutErr = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(
        'Supabase timed out — try again or restart the project from the Supabase dashboard.'
      )), TIMEOUT_MS))
    let t, e
    try {
      ;[t, e] = await Promise.race([
        Promise.all([
          supabase.from('lib_editing_queue').select('*'),
          supabase.from('lib_creative_editors').select('*').order('name'),
        ]),
        timeoutErr,
      ])
    } catch (err) {
      // Bounded AbortError-from-auth-lock retry. Same shape as LibraryTab.load
      // and LaunchQueueTab.load — cap at 3 attempts so a genuine 401-as-Abort
      // surfaces instead of looping forever.
      if (err?.name === 'AbortError' && attempt < 3) {
        if (!background) setLoading(false)
        setTimeout(() => load(background, attempt + 1), 50 * (attempt + 1))
        return
      }
      setErr(err.message || 'Load failed')
      setLoading(false)
      return
    }
    if (t.error) setErr(t.error.message)
    else {
      setTasks(t.data || [])
      PAGE_CACHE.tasks = t.data || []
      PAGE_CACHE.tasksTime = Date.now()
    }
    setEditors(e.data || [])
    PAGE_CACHE.editors = e.data || []
    PAGE_CACHE.editorsTime = Date.now()
    setLoading(false)
  }, [])

  // On mount: if we have cached data, do a silent background revalidate.
  // Otherwise show the spinner and do a foreground load.
  useEffect(() => {
    if (cached?.tasks) load(true)
    else load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deep-link: ?task=<id> in the URL auto-opens the EditTaskModal for
  // that task once tasks are loaded. Used by the editor notification
  // bell — clicking a notification card hops the user into the right
  // task without manually scrolling/searching.
  useEffect(() => {
    if (!tasks.length) return
    const url = new URL(window.location.href)
    const taskId = url.searchParams.get('task')
    if (!taskId) return
    const found = tasks.find(t => t.task_id === taskId)
    if (found) {
      setEditingTask(found)
      // Strip the param so refreshing doesn't re-pop the modal forever.
      url.searchParams.delete('task')
      window.history.replaceState({}, '', url.toString())
    }
  }, [tasks])

  // Filter tasks by selected editors + selected statuses. Empty sets =
  // no filter on that dimension. Both filters are AND-combined.
  const filteredTasks = useMemo(() => {
    // Ads | Shorts first — scopes the whole board (KPIs + every view derive
    // from this). Legacy rows with no category read as 'ad'.
    let out = tasks.filter(t => (t.content_category || 'ad') === category)
    if (selectedEditors.size > 0) {
      out = out.filter(t => selectedEditors.has(t.editor_id) || (t.editor_id == null && selectedEditors.has('unassigned')))
    }
    if (selectedStatuses.size > 0) {
      out = out.filter(t => selectedStatuses.has(t.status))
    }
    return out
  }, [tasks, category, selectedEditors, selectedStatuses])

  // Only count as overdue when the editor is actually blocking. status='review'
  // means the editor has submitted; the task is on the coordinator now.
  const overdue  = filteredTasks.filter(t => t.is_overdue && t.status !== 'review').length
  const inProg   = filteredTasks.filter(t => t.status === 'in_progress').length
  const queued   = filteredTasks.filter(t => t.status === 'queued').length
  const review   = filteredTasks.filter(t => t.status === 'review').length
  const revision = filteredTasks.filter(t => t.status === 'needs_revision').length
  const done     = filteredTasks.filter(t => t.status === 'done').length

  const toggleEditor = (id) => {
    setSelectedEditors(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Move a task to a new status (Kanban drag-and-drop). Optimistic update:
  // patch local state immediately, then write to DB. Roll back on error.
  const moveTaskStatus = useCallback(async (task, nextStatus) => {
    if (!task || !nextStatus || task.status === nextStatus) return
    const prevStatus = task.status
    setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: nextStatus } : t))
    const { error } = await supabase
      .from('lib_editing_tasks')
      .update({ status: nextStatus })
      .eq('id', task.task_id)
    if (error) {
      setTasks(prev => prev.map(t => t.task_id === task.task_id ? { ...t, status: prevStatus } : t))
      setErr(error.message)
    }
  }, [])

  // General-purpose task assignment update — handles editor change AND/OR
  // date shift in a single optimistic update + DB write. Used by:
  //   - Lane drop (drag to another editor's row)
  //   - Date drop  (drag within a row to a different X position)
  //   - Combined  (drag to another row at a different X)
  const updateTaskAssignment = useCallback(async (task, { editorId, assignedAt, dueDate }) => {
    if (!task) return
    const patch = {}
    if (editorId !== undefined)  patch.editor_id  = editorId
    if (assignedAt !== undefined) patch.assigned_at = assignedAt
    if (dueDate !== undefined)   patch.due_date   = dueDate
    if (Object.keys(patch).length === 0) return

    const prevState = {
      editor_id: task.editor_id, editor_name: task.editor_name, editor_slug: task.editor_slug,
      assigned_at: task.assigned_at, due_date: task.due_date,
    }
    const editor = editorId !== undefined ? editors.find(e => e.id === editorId) : null
    setTasks(curr => curr.map(t => {
      if (t.task_id !== task.task_id) return t
      const next = { ...t }
      if (editorId !== undefined) {
        next.editor_id   = editorId
        next.editor_name = editor?.name || (editorId ? '…' : 'Unassigned')
        next.editor_slug = editor?.slug || null
      }
      if (assignedAt !== undefined) next.assigned_at = assignedAt
      if (dueDate !== undefined)    next.due_date    = dueDate
      return next
    }))
    const { error } = await supabase.from('lib_editing_tasks').update(patch).eq('id', task.task_id)
    if (error) {
      setTasks(curr => curr.map(t => t.task_id === task.task_id ? { ...t, ...prevState } : t))
      setErr(error.message)
    } else if (editorId !== undefined && editorId && editorId !== prevState.editor_id) {
      // Editor was reassigned — notify the NEW editor that they own this
      // task now. Use 'assignment' kind for first-time assignment (prev
      // was null) and 'reassignment' for editor-to-editor handoff.
      notifyEditor({
        editor_id: editorId,
        kind: prevState.editor_id ? 'reassignment' : 'assignment',
        task_id: task.task_id,
        creative_id: task.creative_id,
        title: prevState.editor_id
          ? `Reassigned to you — ${taskDisplayName(task) || 'task'}`
          : `New assignment — ${taskDisplayName(task) || 'task'}`,
        body: task.due_date ? `Due ${task.due_date}.` : 'No due date set.',
        link_path: `/editor-view?task=${task.task_id}`,
      })
    }
  }, [editors])

  // Reassign callback used by the List view + Kanban card editor-picker.
  // Resolves to the full task from state before the no-op guard since
  // some callers pass {task_id, editor_id: null} stubs from drag payloads.
  const moveTaskToEditor = useCallback((taskOrStub, nextEditorId) => {
    if (!taskOrStub?.task_id) return
    const fullTask = tasks.find(t => t.task_id === taskOrStub.task_id) || taskOrStub
    if ((fullTask.editor_id || null) === (nextEditorId || null)) return
    return updateTaskAssignment(fullTask, { editorId: nextEditorId || null })
  }, [updateTaskAssignment, tasks])

  if (loading) return <LoadingState />
  if (err) return <ErrorBanner msg={err} onRetry={() => load(false)} />

  return (
    <>
      {/* Feedback-waiting banner — visible to editors AND admins. For
          editors it answers "do I have feedback to address". For admins
          it answers "did the editors actually see my notes yet". Click
          to filter the queue to those tasks. Hidden when zero. */}
      {pendingFeedback.tasks.size > 0 && (
        <div
          onClick={() => {
            // Filter to the tasks that have unread feedback.
            const taskIds = pendingFeedback.tasks
            const matchingTaskRows = tasks.filter(t => taskIds.has(t.task_id))
            // Set editor filter to the editors whose tasks have feedback,
            // so the editor sees a focused list. (No-op for editor-view
            // since they already only see their own tasks.)
            if (!scope.isEditorView) {
              const eds = new Set(matchingTaskRows.map(t => t.editor_id).filter(Boolean))
              if (eds.size > 0) setSelectedEditors(eds)
            }
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', marginBottom: 14,
            background: '#fffaea', border: '1px solid #e8b408',
            borderLeft: '3px solid #e8b408',
            cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 12,
            letterSpacing: '0.04em', color: '#7a4e08',
          }}
          title="Click to see which tasks have feedback waiting">
          <span>
            <strong>{pendingFeedback.submissions.length} submission{pendingFeedback.submissions.length === 1 ? ' has' : 's have'} feedback</strong> waiting
            {scope.isEditorView ? ' for you' : ' that the editor hasn\'t seen yet'}
            {' · across ' + pendingFeedback.tasks.size + ' task' + (pendingFeedback.tasks.size === 1 ? '' : 's')}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ textDecoration: 'underline' }}>Open the tasks →</span>
        </div>
      )}


      {/* KPI bar. Six tiles so Review + Revision get their own slots
          alongside Overdue / In progress / Queued / Done — Ben 2026-05-31
          wanted needs_revision visible at a glance (was buried in the
          status filter chip). Click a tile to filter the queue to that
          status; click again to clear. Auto-fit so it gracefully drops
          to 5/4/3 columns on narrower viewports. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18,
      }}>
        {/* All tile accent colors come from PALETTE so they stay in sync
            with VALUE_COLORS used elsewhere (status pips, Triage row
            borders, REVISE/REVIEW badges). Per the OPT design system,
            status surfaces all consume the same semantic palette. */}
        <KpiTile label="Overdue"     value={overdue}  accent={overdue > 0 ? PALETTE.red : null} />
        <KpiTile label="In progress" value={inProg}   accent={inProg > 0 ? PALETTE.amber : null}
          onClick={() => setSelectedStatuses(prev => prev.has('in_progress') ? new Set([...prev].filter(s => s !== 'in_progress')) : new Set([...prev, 'in_progress']))}
          active={selectedStatuses.has('in_progress')} />
        <KpiTile label="Review"      value={review}   accent={review > 0 ? PALETTE.blueLight : null}
          onClick={() => setSelectedStatuses(prev => prev.has('review') ? new Set([...prev].filter(s => s !== 'review')) : new Set([...prev, 'review']))}
          active={selectedStatuses.has('review')} />
        <KpiTile label="Revision"    value={revision} accent={revision > 0 ? PALETTE.orange : null}
          onClick={() => setSelectedStatuses(prev => prev.has('needs_revision') ? new Set([...prev].filter(s => s !== 'needs_revision')) : new Set([...prev, 'needs_revision']))}
          active={selectedStatuses.has('needs_revision')} />
        <KpiTile label="Queued"      value={queued}
          onClick={() => setSelectedStatuses(prev => prev.has('queued') ? new Set([...prev].filter(s => s !== 'queued')) : new Set([...prev, 'queued']))}
          active={selectedStatuses.has('queued')} />
        <KpiTile label="Done"        value={done}     accent={done > 0 ? PALETTE.green : null}
          onClick={() => setSelectedStatuses(prev => prev.has('done') ? new Set([...prev].filter(s => s !== 'done')) : new Set([...prev, 'done']))}
          active={selectedStatuses.has('done')} />
      </div>

      {/* Toolbar: actions + view toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        marginBottom: 14, padding: '10px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
      }}>
        {scope.canEditTask && (
          <button onClick={() => setAddTaskOpen(true)} style={primaryBtn}>+ Add task</button>
        )}
        {scope.canManageEditors && (
          <>
            {/* Share with editor — removed at Ben's request 2026-06-26.
                Manage editors stays; ShareLinksModal kept for easy restore. */}
            <button onClick={() => setManageEditorsOpen(true)} style={ghostBtn}>Manage editors</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {editors.filter(e => e.active && e.tier !== 'admin').length} editor{editors.filter(e => e.active && e.tier !== 'admin').length === 1 ? '' : 's'} · {filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
          <ViewBtn active={view === 'inbox'}    onClick={() => setView('inbox')}>Inbox</ViewBtn>
          <ViewBtn active={view === 'list'}     onClick={() => setView('list')}>List</ViewBtn>
          <ViewBtn active={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</ViewBtn>
          <ViewBtn active={view === 'kanban'}   onClick={() => setView('kanban')}>Kanban</ViewBtn>
        </div>
      </div>

      {/* Filter bar — uses the same FilterDropdown component as the
          Library tab so the UI language matches. Two compact buttons
          (Editors, Status) open to multi-select dropdowns instead of
          eating two horizontal strips of chips.
          Hidden only on per-editor links (where the editor is locked to
          their own tasks). Team-wide links and admins both get the
          full filter — that's the whole point of the team view. */}
      {(!scope.isEditorView || scope.isTeamWide) && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          padding: '10px 14px', background: 'var(--paper)',
          border: '1px solid var(--rule)', marginBottom: 14,
        }}>
          <span style={chipLabelStyle}>Filter</span>
          <FilterDropdown
            label="Editors"
            options={[
              { value: 'unassigned', label: 'Unassigned', dot: 'var(--ink-4)',
                count: tasks.filter(t => t.editor_id == null).length },
              ...editors.filter(e => e.active && e.tier !== 'admin').map(e => ({
                value: e.id, label: e.name, dot: editorColor(e),
                count: tasks.filter(t => t.editor_id === e.id).length,
              }))
            ]}
            selected={selectedEditors}
            allCount={tasks.length}
            onChange={setSelectedEditors}
          />
          <FilterDropdown
            label="Status"
            options={[
              { value: 'queued',         label: 'Queued',         dot: TASK_STATUS_COLOR.queued,         count: tasks.filter(t => t.status === 'queued').length },
              { value: 'in_progress',    label: 'In progress',    dot: TASK_STATUS_COLOR.in_progress,    count: tasks.filter(t => t.status === 'in_progress').length },
              { value: 'review',         label: 'In review',      dot: TASK_STATUS_COLOR.review,         count: tasks.filter(t => t.status === 'review').length },
              { value: 'needs_revision', label: 'Needs revision', dot: TASK_STATUS_COLOR.needs_revision, count: tasks.filter(t => t.status === 'needs_revision').length },
              { value: 'done',           label: 'Done',           dot: TASK_STATUS_COLOR.done,           count: tasks.filter(t => t.status === 'done').length },
              { value: 'blocked',        label: 'Blocked',        dot: TASK_STATUS_COLOR.blocked,        count: tasks.filter(t => t.status === 'blocked').length },
            ]}
            selected={selectedStatuses}
            allCount={tasks.length}
            onChange={setSelectedStatuses}
          />
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', letterSpacing: '0.04em' }}>
            {filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* Bulk-action bar for the queue list. Mirrors the Library tab pattern:
          sticky, dark, only appears when something is selected. Inline pickers
          (no separate modal) for the three most-common task bulk ops:
          reassign editor, change status, change priority. */}
      {selectedTasks.size > 0 && canBulkEditTasks && view === 'list' && (
        <div style={{
          position: 'sticky', top: 64, zIndex: 50,
          marginBottom: 14, padding: '10px 14px',
          background: 'var(--ink)', color: 'var(--paper)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.08em',
          }}>{selectedTasks.size} task{selectedTasks.size === 1 ? '' : 's'} selected</span>
          <button onClick={() => setSelectedTasks(new Set(filteredTasks.map(t => t.task_id)))}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all visible ({filteredTasks.length})</button>
          <button onClick={clearTaskSelection}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--paper)',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
          <span style={{ flex: 1 }} />
          {/* Reassign editor inline picker */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Reassign:
            <select disabled={bulkTaskBusy}
              defaultValue=""
              onChange={async (e) => {
                const v = e.target.value
                if (!v) return
                const editorId = v === '__UNASSIGN__' ? null : v
                setBulkTaskBusy(true); setBulkTaskMsg(null)
                const ids = [...selectedTasks]
                const { error } = await supabase.from('lib_editing_tasks')
                  .update({ editor_id: editorId }).in('id', ids)
                setBulkTaskBusy(false)
                if (error) { setBulkTaskMsg(`Reassign failed: ${error.message}`); return }
                setBulkTaskMsg(`Reassigned ${ids.length} task${ids.length === 1 ? '' : 's'}.`)
                e.target.value = ''
                load(true)
              }}
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'var(--paper)', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
              <option value="" disabled>— Pick editor —</option>
              <option value="__UNASSIGN__">Unassign</option>
              {editors.filter(e => e.active !== false && e.tier !== 'admin').map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          {/* Status inline picker */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Status:
            <select disabled={bulkTaskBusy}
              defaultValue=""
              onChange={async (e) => {
                const v = e.target.value
                if (!v) return
                setBulkTaskBusy(true); setBulkTaskMsg(null)
                const ids = [...selectedTasks]
                const patch = { status: v }
                if (v === 'done') patch.completed_at = new Date().toISOString()
                const { error } = await supabase.from('lib_editing_tasks')
                  .update(patch).in('id', ids)
                setBulkTaskBusy(false)
                if (error) { setBulkTaskMsg(`Status update failed: ${error.message}`); return }
                setBulkTaskMsg(`${ids.length} task${ids.length === 1 ? '' : 's'} → ${v}.`)
                e.target.value = ''
                load(true)
              }}
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'var(--paper)', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
              <option value="" disabled>— Pick status —</option>
              <option value="queued">queued</option>
              <option value="in_progress">in_progress</option>
              <option value="in_review">in_review</option>
              <option value="needs_revision">needs_revision</option>
              <option value="blocked">blocked</option>
              <option value="done">done</option>
            </select>
          </label>
          {/* Priority inline picker */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Priority:
            <select disabled={bulkTaskBusy}
              defaultValue=""
              onChange={async (e) => {
                const v = e.target.value
                if (!v) return
                setBulkTaskBusy(true); setBulkTaskMsg(null)
                const ids = [...selectedTasks]
                const { error } = await supabase.from('lib_editing_tasks')
                  .update({ priority: v }).in('id', ids)
                setBulkTaskBusy(false)
                if (error) { setBulkTaskMsg(`Priority update failed: ${error.message}`); return }
                setBulkTaskMsg(`${ids.length} task${ids.length === 1 ? '' : 's'} → ${v}.`)
                e.target.value = ''
                load(true)
              }}
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'var(--paper)', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
              <option value="" disabled>— Pick priority —</option>
              <option value="P0 - Critical">P0 — Critical</option>
              <option value="P1 - High">P1 — High</option>
              <option value="P2 - Medium">P2 — Medium</option>
              <option value="P3 - Low">P3 — Low</option>
            </select>
          </label>
          {bulkTaskMsg && (
            <span style={{ flexBasis: '100%', fontFamily: 'var(--mono)', fontSize: 10.5, color: '#f4e14a' }}>{bulkTaskMsg}</span>
          )}
        </div>
      )}

      {tasks.length === 0 ? (
        <div style={{
          border: '1px dashed var(--rule)', padding: 40, textAlign: 'center',
          background: 'var(--paper-2)', marginTop: 14,
        }}>
          <SectionHead level="section" eyebrow="Empty queue">No editing tasks yet</SectionHead>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-3)', marginTop: 8, marginBottom: 16 }}>
            Use <strong style={{ color: 'var(--ink)' }}>+ Add task</strong> above to assign a creative
            to one of your editors, or open any creative from the Library tab and use the "Assign editor" block at the bottom.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => setAddTaskOpen(true)} style={primaryBtn}>+ Add task</button>
            <button onClick={() => setAddEditorOpen(true)} style={ghostBtn}>+ Add editor</button>
          </div>
        </div>
      ) : view === 'list' ? (
        <QueueListView tasks={filteredTasks} editors={editors} onEdit={setEditingTask} feedbackTaskIds={pendingFeedback.tasks}
          selected={selectedTasks}
          selectionMode={selectedTasks.size > 0}
          onToggleSelect={canBulkEditTasks ? toggleTaskSelect : null}
          onReorder={async (orderedIds) => {
            // Optimistic local update — assign sequential sort_order to
            // the open tasks in their new order. Tasks not in the
            // ordered list keep their existing sort_order (done tasks).
            const orderMap = new Map(orderedIds.map((id, i) => [id, i + 1]))
            setTasks(curr => curr.map(t =>
              orderMap.has(t.task_id) ? { ...t, sort_order: orderMap.get(t.task_id) } : t))
            // Persist: batch updates one row at a time (Supabase doesn't
            // have a bulk UPDATE with per-row values; this is ~20 rows
            // worst case so latency is fine).
            const errors = []
            for (const [id, order] of orderMap) {
              const { error } = await supabase.from('lib_editing_tasks')
                .update({ sort_order: order }).eq('id', id)
              if (error) errors.push(error.message)
            }
            if (errors.length) setErr(errors.join(' · '))
          }} />
      ) : view === 'timeline' ? (
        <TimelineView tasks={filteredTasks} editors={editors.filter(e => e.active && e.tier !== 'admin')}
          onEdit={setEditingTask} onMoveEditor={moveTaskToEditor}
          onUpdateAssignment={updateTaskAssignment}
          onAddTask={(pre) => { setAddTaskPrefill(pre); setAddTaskOpen(true) }} />
      ) : view === 'inbox' ? (
        <InboxView tasks={filteredTasks} onEdit={setEditingTask} />
      ) : (
        <KanbanView
          tasks={filteredTasks}
          editors={editors.filter(e => e.active && e.tier !== 'admin')}
          onEdit={setEditingTask}
          onMove={moveTaskStatus}
          onReassignEditor={moveTaskToEditor}
          onAddInColumn={(col) => {
            // Pre-set the addTask form to land in this Kanban column.
            // We don't have a "prefillStatus" field today — easiest path
            // is to add the task with the column's status applied right
            // after creation. For now, just open the modal; operator
            // picks editor/dates as usual. (Column-aware prefill is a
            // small follow-up.)
            setAddTaskPrefill({ editorId: '', due: '', start: '' })
            setAddTaskOpen(true)
          }}
        />
      )}

      {addEditorOpen && (
        <AddEditorModal
          onClose={() => setAddEditorOpen(false)}
          onSaved={() => { setAddEditorOpen(false); load() }} />
      )}
      {manageEditorsOpen && (
        <ManageEditorsModal
          editors={editors}
          tasks={tasks}
          selfEditorId={scope.editorId || null}
          onClose={() => setManageEditorsOpen(false)}
          onEditorAdded={(e) => setEditors(curr => [...curr, e].sort((a, b) => (a.name || '').localeCompare(b.name || '')))}
          onEditorPatched={(id, patch) => setEditors(curr => curr.map(e => e.id === id ? { ...e, ...patch } : e))}
          onEditorsRemoved={(ids) => {
            const idSet = new Set(ids)
            setEditors(curr => curr.filter(e => !idSet.has(e.id)))
            // Patch any tasks that were assigned to deleted editors → unassign
            setTasks(curr => curr.map(t => idSet.has(t.editor_id)
              ? { ...t, editor_id: null, editor_name: null, editor_slug: null, editor_color: null }
              : t))
          }}
          onOpenEditor={(e) => { setManageEditorsOpen(false); setEditingEditor(e) }}
        />
      )}
      {shareLinksOpen && (
        <ShareLinksModal
          editors={editors.filter(e => e.active && e.tier !== 'admin')}
          onClose={() => setShareLinksOpen(false)}
        />
      )}
      {addTaskOpen && (
        <AddTaskModal
          editors={editors.filter(e => e.active && e.tier !== 'admin')}
          category={category}
          prefillEditorId={addTaskPrefill.editorId}
          prefillDue={addTaskPrefill.due}
          prefillStart={addTaskPrefill.start}
          // Set of creative ids that already have an open editing task,
          // so the modal's "hide creatives already in an open task" toggle
          // can filter them out. Done/blocked don't count — those are
          // closed and can be re-assigned if needed.
          existingTaskCreativeIds={new Set(
            tasks
              .filter(t => t.status && !['done', 'blocked'].includes(t.status))
              .map(t => t.creative_id)
              .filter(Boolean)
          )}
          onClose={() => { setAddTaskOpen(false); setAddTaskPrefill({ editorId: '', due: '', start: '' }) }}
          onSaved={(newQueueRows) => {
            setAddTaskOpen(false)
            setAddTaskPrefill({ editorId: '', due: '', start: '' })
            // Optimistic prepend so the new task lands immediately,
            // without waiting for the background refetch to return.
            if (newQueueRows && newQueueRows.length) {
              setTasks(curr => [...newQueueRows, ...curr])
            }
            // Background refresh to reconcile with any joins (editor
            // name lookups, creative thumbs, etc.) the view returns.
            load(true)
          }} />
      )}
      {editingTask && (
        <EditTaskModal
          // Remount per task so local state (the raw/edit toggle, submissions,
          // form fields) resets when switching tasks — otherwise the toggle
          // leaks across tasks (matches CreativeDetailModal's key).
          key={editingTask.task_id}
          task={editingTask}
          editors={editors}
          scope={scope}
          onClose={() => {
            // Mark this task's feedback as locally-read so the banner +
            // task-card badge update instantly. The DB write already
            // happened inside the modal's reloadSubmissions when the
            // editor opened it.
            if (scope.isEditorView) clearPendingForTask(editingTask.task_id)
            setEditingTask(null)
          }}
          onSaved={() => {
            // Keep the modal OPEN after approve / mark-done — the user wants
            // to see the state flip to 'done' inside the popup, not get the
            // entire queue list yanked out from under them. Background-
            // revalidate the list so it stays in sync without re-mounting
            // the table or showing a loading spinner.
            if (scope.isEditorView) clearPendingForTask(editingTask.task_id)
            load(true)
          }}
          onDeleted={() => { setEditingTask(null); load(true) }} />
      )}
      {editingEditor && (
        <EditEditorModal
          editor={editingEditor}
          selfEditorId={scope.editorId || null}
          onClose={() => setEditingEditor(null)}
          onSavedPatch={(patch) => {
            setEditors(curr => curr.map(e => e.id === editingEditor.id ? { ...e, ...patch } : e))
            // Propagate name/color/slug changes to tasks that reference this editor
            setTasks(curr => curr.map(t => t.editor_id === editingEditor.id
              ? {
                  ...t,
                  ...(patch.name  !== undefined ? { editor_name:  patch.name  } : {}),
                  ...(patch.color !== undefined ? { editor_color: patch.color } : {}),
                }
              : t))
            setEditingEditor(null)
          }}
          onDeleted={(id) => {
            setEditors(curr => curr.filter(e => e.id !== id))
            setTasks(curr => curr.map(t => t.editor_id === id
              ? { ...t, editor_id: null, editor_name: null, editor_slug: null, editor_color: null }
              : t))
            setEditingEditor(null)
          }} />
      )}
    </>
  )
}

/* Status filter strip — same chip pattern as EditorSelector but keyed on
   task.status. Counts shown per chip from the unfiltered tasks list. */
function StatusFilterStrip({ tasks, selected, onToggle, onClearAll }) {
  const STATUS_DEFS = [
    { v: 'queued',      label: 'Queued',      color: 'var(--ink-3)' },
    { v: 'in_progress', label: 'In progress', color: '#b86a0c' },
    { v: 'review',      label: 'In review',   color: '#3e7eba' },
    { v: 'done',        label: 'Done',        color: 'var(--up)' },
    { v: 'blocked',     label: 'Blocked',     color: 'var(--down)' },
  ]
  const counts = useMemo(() => {
    const m = {}
    for (const t of tasks) m[t.status] = (m[t.status] || 0) + 1
    return m
  }, [tasks])
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
      padding: '10px 14px', background: 'var(--paper)',
      border: '1px solid var(--rule)', marginBottom: 14,
    }}>
      <span style={chipLabelStyle}>Filter by status</span>
      <button
        onClick={selected.size === 0 ? undefined : onClearAll}
        disabled={selected.size === 0}
        title={selected.size === 0 ? 'Showing all statuses' : 'Reset to all statuses'}
        style={{
          padding: '5px 11px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: selected.size === 0 ? 'var(--ink)' : 'var(--paper)',
          color: selected.size === 0 ? 'var(--paper)' : 'var(--ink-2)',
          border: '1px solid ' + (selected.size === 0 ? 'var(--ink)' : 'var(--rule)'),
          borderRadius: 9,
          cursor: selected.size === 0 ? 'default' : 'pointer',
        }}>All statuses</button>
      {STATUS_DEFS.map(s => {
        const isOn = selected.has(s.v)
        const count = counts[s.v] || 0
        return (
          <button key={s.v} onClick={() => onToggle(s.v)}
            style={{
              padding: '5px 11px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              background: isOn ? s.color : 'var(--paper)',
              color: isOn ? 'white' : 'var(--ink-2)',
              border: '1px solid ' + (isOn ? s.color : 'var(--rule)'),
              borderRadius: 9, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 7,
            }}>
            {!isOn && <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />}
            <span>{s.label}</span>
            {count > 0 && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                color: isOn ? 'rgba(255,255,255,0.7)' : 'var(--ink-4)',
              }}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* Editor selection bar — multi-select chips that FILTER tasks to chosen editors.
   Empty selection = show all. Each chip has a small (✎) icon to open the edit modal. */
function EditorSelector({ editors, selected, onToggle, onClearAll, onEditEditor, tasks }) {
  if (!editors.length) return null
  const taskCountByEditorId = useMemo(() => {
    const m = {}
    for (const t of tasks) m[t.editor_id || 'unassigned'] = (m[t.editor_id || 'unassigned'] || 0) + 1
    return m
  }, [tasks])
  const sortedEditors = editors.filter(e => e.active && e.tier !== 'admin')

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
      padding: '10px 14px', background: 'var(--paper)',
      border: '1px solid var(--rule)', marginBottom: 14,
    }}>
      <span style={chipLabelStyle}>Show tasks for</span>
      {/* When selection is empty we're already in "all" mode — render the
          button as a passive indicator (no cursor, no-op click) so the
          operator doesn't get confused clicking it and seeing no change.
          When filtered, it's an active "Reset to all" button. */}
      <button
        onClick={selected.size === 0 ? undefined : onClearAll}
        disabled={selected.size === 0}
        title={selected.size === 0 ? 'Currently showing all editors' : 'Reset to all editors'}
        style={{
          padding: '5px 11px',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: selected.size === 0 ? 'var(--ink)' : 'var(--paper)',
          color: selected.size === 0 ? 'var(--paper)' : 'var(--ink-2)',
          border: '1px solid ' + (selected.size === 0 ? 'var(--ink)' : 'var(--rule)'),
          borderRadius: 9,
          cursor: selected.size === 0 ? 'default' : 'pointer',
        }}>All editors</button>
      {sortedEditors.map(e => {
        const isSelected = selected.has(e.id)
        const color = editorColor(e)
        const count = taskCountByEditorId[e.id] || 0
        return (
          <span key={e.id} style={{
            display: 'inline-flex', alignItems: 'stretch', borderRadius: 9,
            border: '1px solid ' + (isSelected ? color : 'var(--rule)'),
            background: isSelected ? color : 'var(--paper)',
            overflow: 'hidden',
          }}>
            <button onClick={() => onToggle(e.id)} style={{
              padding: '5px 10px 5px 8px', display: 'inline-flex', alignItems: 'center', gap: 7,
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
              letterSpacing: '0.04em',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: isSelected ? 'white' : 'var(--ink-2)',
            }}>
              {!isSelected && <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />}
              <span>{e.name}</span>
              {count > 0 && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                  color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--ink-4)',
                }}>{count}</span>
              )}
            </button>
            <button onClick={() => onEditEditor(e)} title="Edit editor"
              style={{
                padding: '0 6px', cursor: 'pointer',
                fontSize: 11, color: isSelected ? 'rgba(255,255,255,0.8)' : 'var(--ink-4)',
                background: 'transparent', border: 'none',
                borderLeft: '1px solid ' + (isSelected ? 'rgba(255,255,255,0.25)' : 'var(--rule)'),
              }}>✎</button>
          </span>
        )
      })}
    </div>
  )
}

/* QueueListView — matrix-style task list with sortable columns + inline edit
   on click. Mirrors the Component Edits sheet pattern.
   Tasks are pre-sorted by priority (P0/P1/P2/P3) and then by due date,
   so the leftmost numeric rank reflects "do this first". */
const PRIORITY_RANK = { 'P0 - Critical': 0, 'P1 - High': 1, 'P2 - Medium': 2, 'P3 - Low': 3 }
function priorityOrder(p) {
  if (p && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p)) return PRIORITY_RANK[p]
  return 99
}
function QueueListView({ tasks, editors, onEdit, onReorder, feedbackTaskIds, selected, selectionMode, onToggleSelect }) {
  const selectable = !!onToggleSelect
  // Sort by manual sort_order first (when any open task carries one), else
  // by priority + due date. Done tasks always sink to the bottom.
  const ordered = useMemo(() => {
    const open = tasks.filter(t => t.status !== 'done')
    const done = tasks.filter(t => t.status === 'done')
    const byPriority = (a, b) => {
      const pa = priorityOrder(a.priority)
      const pb = priorityOrder(b.priority)
      if (pa !== pb) return pa - pb
      const da = a.due_date || '9999-12-31'
      const db = b.due_date || '9999-12-31'
      if (da !== db) return da < db ? -1 : 1
      const aa = a.assigned_at || '9999-12-31'
      const ab = b.assigned_at || '9999-12-31'
      return aa < ab ? -1 : aa > ab ? 1 : 0
    }
    const bySortThenPriority = (a, b) => {
      const sa = a.sort_order ?? 999999
      const sb = b.sort_order ?? 999999
      if (sa !== sb) return sa - sb
      return byPriority(a, b)
    }
    const hasManual = open.some(t => t.sort_order != null)
    open.sort(hasManual ? bySortThenPriority : byPriority)
    done.sort(byPriority)
    return [...open, ...done]
  }, [tasks])

  // Drag-to-reorder state
  const [dragId, setDragId] = useState(null)
  const [dropTargetId, setDropTargetId] = useState(null)
  const [dropPosition, setDropPosition] = useState(null)  // 'before' | 'after'
  const handleRowDragStart = (e, taskId) => {
    e.dataTransfer.setData('text/plain', `queue-row:${taskId}`)
    e.dataTransfer.effectAllowed = 'move'
    setDragId(taskId)
  }
  const handleRowDragOver = (e, taskId) => {
    if (!dragId || dragId === taskId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (dropTargetId !== taskId || dropPosition !== pos) {
      setDropTargetId(taskId); setDropPosition(pos)
    }
  }
  const handleRowDrop = (e, targetTaskId) => {
    e.preventDefault()
    if (!dragId || dragId === targetTaskId) { setDragId(null); setDropTargetId(null); return }
    // Build the new ID order based on the current `ordered` list of open
    // tasks. Done tasks aren't reorderable (they sink to the bottom).
    const openIds = ordered.filter(t => t.status !== 'done').map(t => t.task_id)
    const fromIdx = openIds.indexOf(dragId)
    const toIdxOriginal = openIds.indexOf(targetTaskId)
    if (fromIdx < 0 || toIdxOriginal < 0) { setDragId(null); setDropTargetId(null); return }
    // Remove dragged id, compute insertion index relative to the shrunk array
    const withoutDragged = openIds.filter(id => id !== dragId)
    let insertAt = withoutDragged.indexOf(targetTaskId)
    if (dropPosition === 'after') insertAt += 1
    withoutDragged.splice(insertAt, 0, dragId)
    setDragId(null); setDropTargetId(null); setDropPosition(null)
    onReorder?.(withoutDragged)
  }

  if (!ordered.length) return null
  // Grid: [select] rank · thumb · creative · editor · status · task-type · due · priority · source.
  // First column is conditionally a 26px checkbox when bulk-select is enabled.
  const GRID = selectable
    ? '26px 40px 56px minmax(220px, 1.6fr) 130px 110px 110px 120px 90px 50px'
    : '40px 56px minmax(220px, 1.6fr) 130px 110px 110px 120px 90px 50px'

  // "Select all visible" — toggles every task currently shown in the list.
  const allVisible = selectable && ordered.length > 0 && ordered.every(t => selected?.has(t.task_id))
  const someVisible = selectable && ordered.some(t => selected?.has(t.task_id)) && !allVisible
  const toggleAll = () => {
    if (!selectable) return
    if (allVisible) ordered.forEach(t => onToggleSelect(t.task_id))
    else            ordered.forEach(t => !selected?.has(t.task_id) && onToggleSelect(t.task_id))
  }

  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: GRID,
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
        alignItems: 'center',
      }}>
        {selectable && (
          <div onClick={toggleAll} title="Select / deselect all visible tasks — bulk reassign editor, change status, change priority"
            style={{
              width: 18, height: 18, borderRadius: 9,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'var(--paper)'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}>
            {allVisible && (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someVisible && (
              <span style={{ width: 9, height: 2.5, background: 'var(--ink)' }} />
            )}
          </div>
        )}
        <div>#</div>
        <div></div>
        <div>Creative</div>
        <div>Editor</div>
        <div>Status</div>
        <div>Task type</div>
        <div>Due</div>
        <div>Priority</div>
        <div style={{ textAlign: 'right' }}>Source</div>
      </div>
      {ordered.map((t, i) => {
        const color = editorColor(t)
        const isDone = t.status === 'done'
        // Rank only for open tasks. Done sinks to the bottom and gets a "—".
        const openIdx = i < ordered.length - tasks.filter(x => x.status === 'done').length ? i + 1 : null
        const isDragging = dragId === t.task_id
        const isDropTarget = dropTargetId === t.task_id && dragId && dragId !== t.task_id
        const tint = rowStatusTintForTask(t)
        return (
          <div key={t.task_id}
            draggable={!isDone}
            onDragStart={isDone ? undefined : (e) => handleRowDragStart(e, t.task_id)}
            onDragOver={isDone ? undefined : (e) => handleRowDragOver(e, t.task_id)}
            onDragLeave={() => {
              if (dropTargetId === t.task_id) { setDropTargetId(null); setDropPosition(null) }
            }}
            onDrop={isDone ? undefined : (e) => handleRowDrop(e, t.task_id)}
            onDragEnd={() => { setDragId(null); setDropTargetId(null); setDropPosition(null) }}
            onClick={() => {
              // In selection mode, body-click toggles selection — matches the
              // Library-tab matrix/list behaviour so muscle memory transfers.
              if (selectionMode && selectable) onToggleSelect(t.task_id)
              else onEdit(t)
            }}
            style={{
              display: 'grid', gridTemplateColumns: GRID,
              padding: '10px 14px', gap: 12, alignItems: 'center',
              borderBottom: i === ordered.length - 1 ? 'none' : '1px solid var(--rule)',
              borderTop: isDropTarget && dropPosition === 'before' ? '2px solid var(--ink)' : '2px solid transparent',
              cursor: isDone ? 'pointer' : 'grab',
              transition: 'background 0.12s',
              opacity: isDragging ? 0.4 : (isDone ? 0.55 : 1),
              background: (selectable && selected?.has(t.task_id))
                ? 'rgba(244,225,74,0.15)'
                : (tint?.base || 'transparent'),
              boxShadow: isDropTarget && dropPosition === 'after' ? 'inset 0 -2px 0 0 var(--ink)' : 'none',
            }}
            onMouseEnter={e => {
              if (selectable && selected?.has(t.task_id)) return
              if (!tint) e.currentTarget.style.background = 'var(--paper-2)'
            }}
            onMouseLeave={e => {
              if (selectable && selected?.has(t.task_id)) return
              if (!tint) e.currentTarget.style.background = 'transparent'
            }}>
            {selectable && (
              <div onClick={(e) => { e.stopPropagation(); onToggleSelect(t.task_id) }}
                title="Select for bulk edit"
                style={{
                  width: 16, height: 16, borderRadius: 9,
                  border: selected?.has(t.task_id) ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                  background: selected?.has(t.task_id) ? 'var(--accent)' : 'var(--paper)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                }}>
                {selected?.has(t.task_id) && (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            )}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
              color: openIdx === 1 ? 'var(--accent-ink, #b8920c)'
                   : openIdx === 2 ? 'var(--ink-2)'
                   : openIdx === 3 ? 'var(--ink-3)'
                   : 'var(--ink-4)',
            }} title={isDone ? '' : 'Drag to reorder'}>
              {openIdx ? `#${openIdx}` : '—'}
              {!isDone && <span style={{ marginLeft: 4, opacity: 0.35, fontSize: 9 }}>⋮⋮</span>}
            </div>
            <div style={{
              width: 50, height: 32, overflow: 'hidden',
              background: '#000', border: '1px solid var(--rule)',
            }}>
              {t.thumbnail_url && <img src={t.thumbnail_url} alt="" loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500, color: 'var(--ink)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                {feedbackTaskIds?.has(t.task_id) && (
                  <span title="Unread feedback waiting on a submission"
                    style={{
                      flexShrink: 0,
                      padding: '1px 5px',
                      background: '#e8b408', color: '#5a3a08',
                      fontSize: 8.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      borderRadius: 9,
                    }}>Feedback</span>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {taskDisplayName(t)}
                </span>
              </div>
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t.creative_canonical_name
                  ? t.creative_name
                  : `${t.creative_type || ''}${t.creative_creator ? ' · ' + t.creative_creator : ''}${t.v21_script_id ? ' · ' + t.v21_script_id : ''}`}
              </div>
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              {t.editor_name && <span style={{ width: 9, height: 9, borderRadius: 9, background: color, flexShrink: 0 }} />}
              <span style={{ color: t.editor_name ? 'var(--ink)' : 'var(--ink-4)' }}>{t.editor_name || 'Unassigned'}</span>
            </div>
            <div><StatusPipBadge status={t.status} isOverdue={t.is_overdue && t.status !== 'review'} /></div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{t.task_type || '—'}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11,
                          color: (t.is_overdue && t.status !== 'review') ? 'var(--down)' : 'var(--ink-3)' }}>
              {(t.is_overdue && t.status !== 'review') && '⚠ '}{t.due_date || '—'}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
              {t.priority?.replace(' - ', ' ') || '—'}
            </div>
            <div style={{ textAlign: 'right' }}>
              {t.drive_url && (
                <a href={t.drive_url} target="_blank" rel="noreferrer"
                  onClick={e => e.stopPropagation()}
                  title="Open Drive file"
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', textDecoration: 'none' }}>↗</a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatusPipBadge({ status, isOverdue }) {
  const STEPS = ['queued', 'in_progress', 'review', 'done']
  if (status === 'blocked') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: 'rgba(181,62,62,0.1)', color: 'var(--down)',
        border: '1px solid rgba(181,62,62,0.3)', borderRadius: 9,
      }}>Blocked</span>
    )
  }
  const idx = STEPS.indexOf(status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ display: 'inline-flex', gap: 3 }}>
        {STEPS.map((s, i) => (
          <span key={s} style={{
            width: 7, height: 7, borderRadius: '50%',
            background: i <= idx
              ? (isOverdue ? 'var(--down)' : (s === 'done' ? 'var(--up)' : '#3e7eba'))
              : 'var(--rule)',
          }} />
        ))}
      </span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: TASK_STATUS_COLOR[status] || 'var(--ink-3)',
      }}>{TASK_STATUS_LABEL[status] || status}</span>
    </span>
  )
}

/* Generic option picker — same fixed-positioned popover pattern as
   EditorPicker. Each option gets a small color dot when `color` is set.
   Used for Priority + Task Type in EditTaskModal so the modal stops
   leaning on native <select> elements (which don't match the rest of
   the editorial design language). */
function OptionPicker({ value, options, onChange, placeholder = '— Select' }) {
  // Single combined state, same atomic-update pattern as FilterDropdown.
  const [popover, setPopover] = useState(null)
  const ref = useRef(null)
  const popRef = useRef(null)
  const open = !!popover
  const handleToggle = () => {
    if (popover) setPopover(null)
    else if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
  }
  const closePopover = () => setPopover(null)
  useEffect(() => {
    if (!popover) return
    const onDoc = (e) => {
      const inBtn = ref.current && ref.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setPopover(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setPopover(null) }
    const onScroll = () => {
      if (ref.current) setPopover({ rect: rectToObj(ref.current.getBoundingClientRect()) })
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [!!popover])
  const current = options.find(o => o.value === value)
  const coords = popover ? popoverCoords(popover.rect) : null
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={handleToggle}
        style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', width: '100%', textAlign: 'left' }}>
        {current ? (
          <>
            {current.color && <span style={{ width: 10, height: 10, borderRadius: 9, background: current.color, flexShrink: 0 }} />}
            <span style={{ flex: 1, fontFamily: 'var(--sans)' }}>{current.label}</span>
          </>
        ) : (
          <span style={{ flex: 1, fontFamily: 'var(--sans)', color: 'var(--ink-4)' }}>{placeholder}</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {popover && coords && createPortal(
        <div ref={popRef} style={{
          position: 'fixed', top: coords.top, left: coords.left, width: coords.width,
          maxHeight: coords.maxHeight, overflowY: 'auto', zIndex: 9999,
          background: 'var(--paper)', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.25)', padding: 4,
        }}>
          {options.map(o => {
            const isOn = o.value === value
            return (
              <button key={o.value} type="button"
                onClick={() => { onChange(o.value); closePopover() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 10px', background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: isOn ? 600 : 500,
                }}>
                {o.color && <span style={{ width: 10, height: 10, borderRadius: 9, background: o.color, flexShrink: 0 }} />}
                <span style={{ flex: 1 }}>{o.label}</span>
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

const PRIORITY_OPTIONS = [
  { value: 'P1 - High',   label: 'P1 · High',   color: 'var(--down)' },
  { value: 'P2 - Medium', label: 'P2 · Medium', color: '#b8893e' },
  { value: 'P3 - Low',    label: 'P3 · Low',    color: 'var(--ink-4)' },
]

/* Click any task anywhere → opens this modal. Change editor / status /
   priority / type / due date / notes. Or delete the task. */
function EditTaskModal({ task, editors, scope = ADMIN_SCOPE, onClose, onSaved, onDeleted }) {
  const [editorId, setEditorId] = useState(task.editor_id || '')
  const [status, setStatus] = useState(task.status || 'queued')
  const [priority, setPriority] = useState(task.priority || 'P2 - Medium')
  const [taskType, setTaskType] = useState(task.task_type || 'edit')
  const [due, setDue] = useState(task.due_date || '')
  const [startDate, setStartDate] = useState(
    task.assigned_at ? task.assigned_at.slice(0, 10) : ''
  )
  const [notes, setNotes] = useState(task.notes || '')
  // Editable creative name from the task modal too (Ben 2026-06-26) — writes
  // lib_creative_library.display_name for this task's creative.
  const [name, setName] = useState(task.creative_display_name || task.creative_name || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDel, setConfirmDel] = useState(false)
  // Submission being reviewed in the SubmissionPreviewModal (the
  // Frame.io-ish comment surface). Lifted to the task-modal level
  // because we need state for the nested modal to live above the
  // submission cards. Null = closed.
  const [reviewingSub, setReviewingSub] = useState(null)
  const adminIdentity = useAdminIdentity()
  // Editor portal users get tagged as the editor whose share link
  // they opened. Admins everywhere else fall back to useAdminIdentity.
  // The Modal's comment composer uses this for author attribution +
  // the resolve permission gate.
  const reviewIdentity = (scope.isEditorView && scope.editorId)
    ? { kind: 'editor', id: scope.editorId, name: scope.editorName || 'Editor' }
    : adminIdentity
  // The script this footage was shot from — read-only here so the editor
  // can read it while cutting. Fetched from the creative row (excluded from
  // the lean list). null = not yet loaded / none.
  const [scriptText, setScriptText] = useState(null)
  useEffect(() => {
    if (!task.creative_id) return
    let alive = true
    supabase.from('lib_creative_library').select('script_text').eq('id', task.creative_id).maybeSingle()
      .then(({ data, error }) => { if (alive && !error) setScriptText(data?.script_text || null) })
    return () => { alive = false }
  }, [task.creative_id])
  // Upload edited version state
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)
  // Live reference to the in-flight XHR so we can abort it on close.
  const uploadXhrRef = useRef(null)

  // Submitted-work state — fetches all submission rows for this task
  // from lib_task_submissions. Each upload is now a separate row so the
  // editor can have v1/v2/v3 instead of overwriting their last cut.
  // The legacy single-slot URLs on lib_creative_library are still kept
  // up-to-date with the latest submission so existing read paths
  // (library matrix view, etc.) continue to work.
  const [submissions, setSubmissions] = useState([])
  // Raw/edit toggle for the player — mirrors the library detail modal so both
  // views read identically (Ben 2026-06-27: "no congruency").
  const [taskViewRaw, setTaskViewRaw] = useState(false)
  const reloadSubmissions = useCallback(async () => {
    if (!task.task_id) return
    const { data } = await supabase.from('lib_task_submissions')
      .select('*')
      .eq('task_id', task.task_id)
      .is('deleted_at', null)
      .order('version_number', { ascending: false })
    setSubmissions(data || [])
    // Auto-mark feedback as read when an editor opens the task. We do
    // this on the editor portal only — admin viewing doesn't count as
    // "seen by editor". This clears the FEEDBACK badge + portal banner
    // automatically once the editor has loaded the task.
    if (scope.isEditorView && data && data.length > 0) {
      const unreadIds = data
        .filter(s => s.feedback_text && !s.feedback_read_at)
        .map(s => s.id)
      if (unreadIds.length > 0) {
        const readAt = new Date().toISOString()
        await supabase.from('lib_task_submissions')
          .update({ feedback_read_at: readAt })
          .in('id', unreadIds)
        // Local update so the "unread" label in the SubmissionsPanel
        // flips to "seen by editor" without a refetch.
        setSubmissions(curr => curr.map(s => unreadIds.includes(s.id) ? { ...s, feedback_read_at: readAt } : s))
      }
    }
  }, [task.task_id, scope.isEditorView])
  useEffect(() => { reloadSubmissions() }, [reloadSubmissions])

  // Polling refresh while any submission is in 'pending' ingest. Once they
  // all settle (success → ingest_status=null, failed → 'failed'), the
  // interval clears. 10s cadence is fast enough that the chip flips
  // shortly after the edge function finishes (typical: 5-30s for a
  // sub-220MB video) without spamming PostgREST.
  const hasPendingIngest = submissions.some(s => s.ingest_status === 'pending')
  useEffect(() => {
    if (!hasPendingIngest) return
    const t = setInterval(() => { reloadSubmissions() }, 10_000)
    return () => clearInterval(t)
  }, [hasPendingIngest, reloadSubmissions])

  // Comment counts per submission. Pulled from lib_submission_comments so
  // the inline SubmissionsPanel can show "💬 N comments · K open" instead
  // of "No feedback yet" (Ben 2026-06-01: leaving comments in the Review
  // modal wasn't reflected anywhere on the version card, so the panel
  // looked like nothing had happened). Refetches whenever the submissions
  // list changes and re-polls while the modal is open.
  const [commentsBySubId, setCommentsBySubId] = useState({})
  const submissionIdsKey = submissions.map(s => s.id).join(',')
  const reloadCommentCounts = useCallback(async () => {
    if (!submissions.length) { setCommentsBySubId({}); return }
    const ids = submissions.map(s => s.id)
    const { data, error } = await supabase
      .from('lib_submission_comments')
      .select('id, submission_id, parent_id, timestamp_seconds, body, author_name, resolved_at, deleted_at')
      .in('submission_id', ids)
      .is('deleted_at', null)
    if (error || !data) return
    const map = {}
    for (const id of ids) map[id] = { total: 0, open: 0, markers: [] }
    for (const c of data) {
      const bucket = map[c.submission_id]
      if (!bucket) continue
      bucket.total += 1
      if (!c.parent_id && !c.resolved_at) bucket.open += 1
      // Markers = top-level timestamped comments only. Replies stay
      // attached to their parent thread in the Review modal; surfacing
      // them on the player would visually clutter without helping
      // navigation. Shape matches OptVideoPlayer's `markers` prop
      // contract so the same data drives both the Review modal and the
      // inline compact player (single source of truth — no transforms
      // at render time).
      if (!c.parent_id && c.timestamp_seconds != null) {
        bucket.markers.push({
          id: c.id,
          ts: c.timestamp_seconds,
          color: c.resolved_at ? 'rgba(255,255,255,0.4)' : '#3e7eba',
          title: c.body,
          authorName: c.author_name,
        })
      }
    }
    // Sort each bucket's markers by timestamp so the scrubber reads
    // left-to-right in playback order.
    for (const id of ids) map[id].markers.sort((a, b) => a.ts - b.ts)
    setCommentsBySubId(map)
  }, [submissionIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reloadCommentCounts() }, [reloadCommentCounts])
  // Re-fetch counts when the Review modal closes — the admin probably
  // just posted/resolved a bunch of comments and the card needs to
  // reflect that immediately.
  const prevReviewingRef = useRef(null)
  useEffect(() => {
    if (prevReviewingRef.current && !reviewingSub) reloadCommentCounts()
    prevReviewingRef.current = reviewingSub
  }, [reviewingSub, reloadCommentCounts])

  // Tracks whether any field has been touched in this modal session.
  // Used by handleCloseModal to decide whether to flush a final save —
  // we don't want to write to the DB on every modal close if the user
  // just opened it to look. (Kirill bug #7, Ben 2026-05-31: edits to
  // priority/editor/due-date/notes were silently dropped if the user
  // clicked X or the backdrop instead of the Save button.)
  const dirtyRef = useRef(false)
  // First effect run = mount, NOT a user change. Skip it so we don't
  // mark dirty on initial form hydration from `task` props.
  const dirtyInitRef = useRef(true)
  useEffect(() => {
    if (dirtyInitRef.current) { dirtyInitRef.current = false; return }
    dirtyRef.current = true
  }, [editorId, status, priority, taskType, due, startDate, notes])

  const save = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setBusy(true)
    setErr(null)
    const patch = {
      editor_id: editorId || null,
      status, priority, task_type: taskType, due_date: due || null,
      assigned_at: startDate || null,
      notes: notes || null,
    }
    // Auto-set started_at when moving into in_progress
    if (status === 'in_progress' && !task.started_at) patch.started_at = new Date().toISOString()
    // Auto-set completed_at when moving to done
    if (status === 'done' && !task.completed_at) patch.completed_at = new Date().toISOString()
    const { error } = await supabase.from('lib_editing_tasks').update(patch).eq('id', task.task_id)
    // Persist an edited creative name (separate table). Only when it changed.
    if (task.creative_id && name !== (task.creative_display_name || task.creative_name || '')) {
      await supabase.from('lib_creative_library')
        .update({ display_name: name.trim() || null }).eq('id', task.creative_id)
    }
    if (!silent) setBusy(false)
    if (error) {
      if (!silent) setErr(error.message)
    } else {
      // Reset dirty so closing the modal twice doesn't fire a redundant
      // silent write. Manual Save also wins this flag back for the user.
      dirtyRef.current = false
      if (!silent) onSaved?.()
    }
  }, [editorId, status, priority, taskType, due, startDate, notes, name, task.task_id, task.creative_id, task.creative_display_name, task.creative_name, task.started_at, task.completed_at, onSaved])
  const remove = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_editing_tasks').delete().eq('id', task.task_id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }

  // Upload an edited version of the SAME creative — file → creative-uploads
  // bucket → write the URL into the appropriate stage on the SOURCE creative
  // → auto-advance task status to 'review' so admin sees there's a new
  // version. One-step flow: dropping or selecting a file kicks this off
  // immediately. Now uses TUS resumable (same as the admin upload paths)
  // so multi-GB camera-original cuts survive network blips and we keep
  // full quality bytes end-to-end. Was previously a raw XHR POST with
  // a 10-min timeout, which lost large files mid-flight.
  const startUpload = useCallback(async (file) => {
    if (!file) return
    setUploadFile(file)
    setBusy(true); setErr(null); setUploadProgress(0)
    try {
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `edited/${Date.now()}_${sanitized}`
      // tus-js-client gives us proper progress events + resume on
      // network blips + no in-memory single-POST cap. uploadXhrRef is
      // repurposed to hold the tus.Upload instance so handleCloseModal
      // can still abort an in-flight upload if the editor closes the
      // modal mid-transfer.
      const tusUpload = await uploadWithResume(file, {
        bucket: 'creative-uploads',
        path: storagePath,
        contentType: file.type || 'video/mp4',
        onProgress: (frac) => {
          // Reserve 0-70% for the actual byte upload, 70-100% for the
          // DB-row patches that follow.
          setUploadProgress(Math.round(frac * 70))
        },
        // Pass back a handle so handleCloseModal can call .abort()
        // on the underlying tus instance.
        registerHandle: (instance) => { uploadXhrRef.current = instance },
      })
      uploadXhrRef.current = null
      void tusUpload
      setUploadProgress(72)
      const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`

      // Thumbnail extraction for the new submission row. Pre-upload
      // File path first (< 500 MB fast path) then post-upload URL path
      // (HTTP-range, any size). Without this the submission card on
      // the EditTaskModal would render an empty preview box for the
      // editor's just-uploaded cut. Best-effort — null result is fine,
      // submission still saves.
      let submissionThumbUrl = null
      let thumbBlob = await captureVideoThumbnail(file)
      if (!thumbBlob) {
        thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
      }
      if (thumbBlob) {
        const thumbPath = `edited/${Date.now()}_${sanitized}_thumb.jpg`
        try {
          await uploadWithResume(thumbBlob, {
            bucket: 'creative-uploads',
            path: thumbPath,
            contentType: 'image/jpeg',
            upsert: true,
          })
          submissionThumbUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${thumbPath}`
        } catch { /* best-effort */ }
      }
      setUploadProgress(78)

      // Insert a NEW submission row (v1, v2, v3, …). version_number is
      // computed as (count of existing non-deleted submissions) + 1 so
      // the editor's revisions stack instead of overwriting each other.
      const nextVersion = (submissions.length || 0) + 1
      // Measure the cut's length so the Invoice tab can tally minutes
      // (editors are paid per finished minute). Best-effort — a codec we
      // can't decode leaves it null and the editor sets it manually.
      let durationSeconds = null
      try {
        const dims = await probeMediaDimensions(file)
        if (dims?.duration_s != null) durationSeconds = dims.duration_s
      } catch { /* unreadable metadata — manual fallback in Invoice tab */ }
      const { error: sErr } = await supabase.from('lib_task_submissions').insert({
        task_id: task.task_id,
        submitted_by_editor_id: task.editor_id || null,
        submitted_by_name: task.editor_name || null,
        file_url: publicUrl,
        file_storage_path: storagePath,
        thumbnail_url: submissionThumbUrl,
        version_number: nextVersion,
        duration_seconds: durationSeconds,
        duration_source: durationSeconds != null ? 'auto' : null,
      })
      if (sErr) throw sErr
      setUploadProgress(85)

      // Keep the source creative's final_cut_url pointing at the LATEST
      // submission so the library matrix / aux views still surface the
      // most recent cut. Approving an older version explicitly
      // (via the Approve button on the submissions list) overrides this.
      const { error: pErr } = await supabase.from('lib_creative_library')
        .update({ final_cut_url: publicUrl, final_cut_thumbnail_url: submissionThumbUrl, stage_final_cut: 'done' })
        .eq('id', task.creative_id)
      if (pErr) throw pErr
      setUploadProgress(95)

      // Auto-advance to review + set started_at if missing
      const { error: tErr } = await supabase.from('lib_editing_tasks')
        .update({ status: 'review', started_at: task.started_at || new Date().toISOString() })
        .eq('id', task.task_id)
      if (tErr) throw tErr
      setUploadProgress(100)
      setStatus('review')
      // Refresh the submissions list so the new v_n card appears
      await reloadSubmissions()
      setUploadFile(null)
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'upload failed')
      setUploadProgress(null)
    } finally {
      setBusy(false)
    }
  }, [task.task_id, task.creative_id, task.started_at, task.editor_id, task.editor_name, submissions.length, reloadSubmissions, onSaved])

  // Approve a specific submission — bumps the creative's final_cut_url
  // to point at that version and marks the submission as approved.
  const approveSubmission = useCallback(async (sub) => {
    setBusy(true); setErr(null)
    try {
      const { error: e1 } = await supabase.from('lib_task_submissions')
        .update({ approved_at: new Date().toISOString(), approved_by_name: 'admin' })
        .eq('id', sub.id)
      if (e1) throw e1
      if (sub.file_url) {
        // Merge the approved cut onto the source creative: final_cut_url holds
        // the edit (raw stays in preview_url), and status flips to 'edited' so
        // the library surfaces it as the edited version. The detail modal's
        // merged-view branch keeps the raw one click away (Ben 2026-06-27).
        const { error: e2 } = await supabase.from('lib_creative_library')
          .update({ final_cut_url: sub.file_url, final_cut_thumbnail_url: sub.thumbnail_url, stage_final_cut: 'done', status: 'edited' })
          .eq('id', task.creative_id)
        if (e2) throw e2
      }
      // Move task to 'done' on approval
      await supabase.from('lib_editing_tasks')
        .update({ status: 'done', completed_at: new Date().toISOString() })
        .eq('id', task.task_id)
      setStatus('done')
      // Notify the editor — they just got the green light on a submission.
      if (task.editor_id) {
        notifyEditor({
          editor_id: task.editor_id,
          kind: 'approved',
          task_id: task.task_id,
          submission_id: sub.id,
          creative_id: task.creative_id,
          title: `v${sub.version_number || 1} approved — ${taskDisplayName(task)}`,
          body: 'Admin approved your cut. Task moved to done.',
          link_path: `/editor-view?task=${task.task_id}`,
        })
      }
      await reloadSubmissions()
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'approve failed')
    } finally {
      setBusy(false)
    }
  }, [task.task_id, task.creative_id, task.editor_id, task.creative_canonical_name, task.creative_name, reloadSubmissions, onSaved])

  // Soft-delete a submission. File in storage is left alone (cheap;
  // operator can remove from the bucket via Supabase Studio if it
  // really matters). The row is hidden from the list and version
  // numbers DON'T renumber — so v1/v2 stay stable even after deletion.
  const deleteSubmission = useCallback(async (sub) => {
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.from('lib_task_submissions')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', sub.id)
      if (error) throw error
      await reloadSubmissions()
    } catch (e) {
      setErr(e.message || 'delete failed')
    } finally {
      setBusy(false)
    }
  }, [reloadSubmissions])

  // Close handler — aborts the in-flight upload (if any). uploadXhrRef
  // now holds a tus.Upload instance. tus-js-client's abort() halts the
  // chunked upload but does NOT fire onError (it guards on _aborted=true
  // inside _performUpload + _emitError), so startUpload's catch/finally
  // never runs and busy/progress would get stuck. Reset them explicitly
  // here so the modal returns to a clean state whether the editor stays
  // open or fully closes.
  const handleCloseModal = useCallback(async () => {
    if (uploadXhrRef.current) {
      try { uploadXhrRef.current.abort() } catch {}
      uploadXhrRef.current = null
      setBusy(false)
      setUploadProgress(null)
      setUploadFile(null)
    }
    // Flush any pending edits to lib_editing_tasks before unmounting so
    // changes to priority / editor / due date / notes never get dropped
    // if the coordinator clicks X / backdrop / Cancel instead of Save.
    // Only fires when something actually changed (dirtyRef) — opening
    // a task purely to look should NOT trigger a DB write.
    if (dirtyRef.current) {
      try { await save({ silent: true }) } catch { /* close anyway */ }
    }
    onClose?.()
  }, [onClose, save])

  // ── File to folder (Ben 2026-06-11) ──────────────────────────────────
  // Files the raw source into a library folder AND turns the latest
  // submitted edit into its OWN library row in that folder — two separate
  // clips, not one version family, so the batch view shows both.
  const [fileFolderOpen, setFileFolderOpen] = useState(false)
  const [taskFolders, setTaskFolders] = useState(null)
  const [filedNote, setFiledNote] = useState(null)

  // ── Folder rail field (Ben 2026-06-11 redesign) ──────────────────────
  // Shows where the source clip lives; "change" opens the picker and
  // moves the clip (with its version family) — no Library round-trip.
  // NOTE: must stay BELOW the taskFolders declaration above — the
  // useCallback deps read it at render time, and a const in TDZ crashes
  // the whole modal (shipped + reverted 2026-06-11, "Cannot access 'ke'
  // before initialization").
  const [creativeFolder, setCreativeFolder] = useState(undefined)  // undefined = loading, null = root
  const [folderAssignOpen, setFolderAssignOpen] = useState(false)
  useEffect(() => {
    let alive = true
    supabase.from('lib_creative_library')
      .select('folder_id, folder:folder_id (id, name)')
      .eq('id', task.creative_id).maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return
        if (error || !data) { setCreativeFolder(null); return }
        setCreativeFolder(data.folder ? { id: data.folder.id, name: data.folder.name } : null)
      })
    return () => { alive = false }
  }, [task.creative_id])
  const openFolderAssign = useCallback(async () => {
    if (taskFolders === null) {
      const { data } = await supabase.from('lib_creative_folders')
        .select('id,name,parent_id').order('name')
      setTaskFolders(data || [])
    }
    setFolderAssignOpen(true)
  }, [taskFolders])
  const assignFolder = useCallback(async (destId) => {
    const { data: row } = await supabase.from('lib_creative_library')
      .select('id,parent_id').eq('id', task.creative_id).maybeSingle()
    const root = row?.parent_id || task.creative_id
    const { error } = await supabase.from('lib_creative_library')
      .update({ folder_id: destId })
      .or(`id.eq.${root},parent_id.eq.${root}`)
    if (error) throw error
    setCreativeFolder(destId ? { id: destId, name: taskFolders?.find(f => f.id === destId)?.name || 'folder' } : null)
    setFolderAssignOpen(false)
  }, [task.creative_id, taskFolders])
  const openFileToFolder = useCallback(async () => {
    if (taskFolders === null) {
      const { data } = await supabase.from('lib_creative_folders')
        .select('id,name,parent_id').order('name')
      setTaskFolders(data || [])
    }
    setFileFolderOpen(true)
  }, [taskFolders])
  const fileToFolder = useCallback(async (destId) => {
    const { error: rErr } = await supabase.from('lib_creative_library')
      .update({ folder_id: destId }).eq('id', task.creative_id)
    if (rErr) throw rErr
    // Latest uploaded submission (list is version-desc; external links
    // have no file to surface in the library, so skip those).
    const latest = (submissions || []).find(s => s.file_url)
    if (latest) {
      const { error: iErr } = await supabase.from('lib_creative_library').insert({
        name: `${task.creative_name || 'Edit'} — edit v${latest.version_number}`,
        type: task.creative_type || 'Joined',
        status: 'edited',
        source_bucket: 'Filed from editing task',
        preview_url: latest.file_url,
        drive_url: latest.file_url,
        thumbnail_url: task.thumbnail_url || null,
        folder_id: destId,
        notes: `Filed from editing task (submission v${latest.version_number}).`,
      })
      if (iErr) throw iErr
    }
    setFileFolderOpen(false)
    setFiledNote(latest ? '✓ Filed raw + edit' : '✓ Filed raw (no uploaded edit yet)')
    setTimeout(() => setFiledNote(null), 4000)
  }, [task.creative_id, task.creative_name, task.creative_type, task.thumbnail_url, submissions])

  return (
    // lg (920px) matches the library detail modal so the two are 1:1 — same
    // width => same player size + layout (Ben 2026-06-28).
    <Modal open={true} onClose={handleCloseModal} size="lg"
      eyebrow="Edit task"
      title={task.creative_name}
      subtitle={`${task.creative_type || ''}${task.creative_creator ? ' · ' + task.creative_creator : ''}${task.v21_script_id ? ' · ' + task.v21_script_id : ''}`}
      footer={
        <>
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--down)', marginRight: 'auto' }}>Delete this task? It can't be undone.</span>
              <button onClick={() => setConfirmDel(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={remove} disabled={busy} style={{ ...primaryBtn, background: 'var(--down)', borderColor: 'var(--down)' }}>
                {busy ? 'Deleting…' : 'Delete task'}
              </button>
            </>
          ) : (
            <>
              {scope.canDeleteTask && (
                <button onClick={() => setConfirmDel(true)} disabled={busy} style={{
                  ...ghostBtn, color: 'var(--down)', borderColor: 'rgba(181,62,62,0.4)',
                }}>Delete</button>
              )}
              <button onClick={openFileToFolder} disabled={busy}
                title="File the raw source and the latest submitted edit into a library folder as two separate clips"
                style={{ ...ghostBtn, marginRight: 'auto' }}>
                {filedNote || 'File to folder…'}
              </button>
              <button onClick={handleCloseModal} style={ghostBtn}>
                {busy && uploadXhrRef.current ? 'Cancel upload' : 'Cancel'}
              </button>
              <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {fileFolderOpen && taskFolders !== null && (
          <FolderPickerModal
            title="File raw + edit to a folder"
            subtitle="The raw source moves into the folder; the latest submitted edit becomes its own clip there."
            folders={taskFolders}
            onClose={() => setFileFolderOpen(false)}
            onPick={fileToFolder}
          />
        )}
        {folderAssignOpen && taskFolders !== null && (
          <FolderPickerModal
            title="Move source clip to a folder"
            subtitle="The clip's other versions move with it."
            folders={taskFolders}
            currentId={creativeFolder === undefined ? undefined : (creativeFolder?.id ?? null)}
            onClose={() => setFolderAssignOpen(false)}
            onPick={assignFolder}
          />
        )}
        {/* Prominent status banner — shown when the task is in a state
            that's NOT the default "in progress" flow, so the operator
            sees at a glance that something changed (especially after
            clicking Request revision / Approve / marking blocked).
            Ben flagged that status changes were "difficult to see"
            after Request revision fired. */}
        {(status === 'needs_revision' || status === 'blocked' || status === 'done' || status === 'review') && (
          <div style={{
            padding: '12px 14px',
            background: status === 'needs_revision' ? '#fffaea'
              : status === 'blocked' ? 'rgba(181,62,62,0.08)'
              : status === 'done' ? 'rgba(62,138,94,0.08)'
              : '#f0f7fc',
            border: '1px solid ' + (
              status === 'needs_revision' ? '#e8b408'
              : status === 'blocked' ? 'rgba(181,62,62,0.35)'
              : status === 'done' ? 'rgba(62,138,94,0.35)'
              : 'rgba(62,126,186,0.35)'
            ),
            borderLeft: '3px solid ' + (
              status === 'needs_revision' ? '#d09c08'
              : status === 'blocked' ? 'var(--down)'
              : status === 'done' ? 'var(--up)'
              : '#3e7eba'
            ),
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{
              padding: '4px 10px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'white',
              background: status === 'needs_revision' ? '#d09c08'
                : status === 'blocked' ? 'var(--down)'
                : status === 'done' ? 'var(--up)'
                : '#3e7eba',
              borderRadius: 9,
            }}>{TASK_STATUS_LABEL[status] || status}</span>
            <span style={{
              fontFamily: 'var(--serif)', fontSize: 13.5, color: 'var(--ink-2)',
              lineHeight: 1.4,
            }}>
              {status === 'needs_revision' && 'Editor has been notified. The task moves back to in-progress when they upload a new version.'}
              {status === 'blocked' && 'Task is blocked. Update the status when the blocker clears.'}
              {status === 'done' && 'Task complete. Final cut is approved.'}
              {status === 'review' && 'Editor submitted a version. Review it below and Approve, Request revision, or Delete.'}
            </span>
          </div>
        )}
        {/* ── 2026-06-11 redesign (Ben: "really messy, tough to use") ──
            Review-first, two-column layout. LEFT = the work: source
            player, submitted versions, upload zone. RIGHT = a compact
            details rail: status, assignment, dates, folder, notes,
            script. auto-fit collapses to one column on narrow screens. */}
        <div style={{
          display: 'grid', gap: 20, alignItems: 'start',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        }}>
        {/* Left column only when there's media — an empty div would still
            claim an auto-fit track and render a blank half-modal for rows
            with no preview/source URL. */}
        {(task.preview_url || task.drive_url) && (
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        {/* Media — IDENTICAL structure to the library detail modal: a
            lead-version badge, the tall player, and a raw↔edit sidecar
            toggle (Ben 2026-06-27: "no congruency in the library or
            editing queue"). Leads with the latest edited submission; the
            raw source is one click away. */}
        {task.preview_url ? (() => {
          const leadSub = (submissions || []).find(s => s.file_url)
          const hasEdit = !!leadSub
          const editV = {
            src: leadSub?.preview_proxy_url || leadSub?.file_url || task.preview_proxy_url || task.preview_url,
            poster: leadSub?.thumbnail_url || task.thumbnail_url,
            dl: leadSub?.file_url || task.final_cut_url || task.drive_url || task.preview_url,
            label: leadSub?.version_number ? `Edited cut · v${leadSub.version_number}` : 'Edited cut',
            key: 'e-' + (leadSub?.id || task.task_id),
          }
          const rawV = {
            src: task.preview_proxy_url || task.preview_url,
            poster: task.thumbnail_url,
            dl: task.drive_url || task.preview_url,
            label: 'Raw source',
            key: 'r-' + task.task_id,
          }
          const showRaw = !hasEdit || taskViewRaw
          const lead = showRaw ? rawV : editV
          const other = showRaw ? editV : rawV
          return (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{
                  padding: '3px 10px', borderRadius: 999,
                  background: showRaw ? 'rgba(21,22,26,0.70)' : 'var(--up)', color: '#fff',
                  fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>{lead.label}</span>
                {hasEdit && (
                  <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)' }}>
                    {showRaw ? 'the original footage — edit at right' : 'the latest cut — raw at right'}
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: hasEdit ? '1fr 96px' : '1fr', gap: 10, alignItems: 'start' }}>
                <div style={{ background: 'var(--ink)', border: '1px solid var(--rule)', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ height: 'min(62vh, 540px)', background: 'black' }}>
                    <OptVideoPlayer key={lead.key} src={lead.src} compact
                      poster={lead.poster}
                      downloadUrl={lead.dl ? toDownloadUrl(lead.dl, task.creative_name) : undefined}
                      downloadName={task.creative_name || 'video.mp4'}
                      wrapperStyle={OPT_PLAYER_WRAP_STAGE} />
                  </div>
                </div>
                {hasEdit && (
                  <button type="button" onClick={() => setTaskViewRaw(v => !v)}
                    title={showRaw ? 'Back to the edited cut' : 'View the raw source'}
                    style={{
                      padding: 0, border: '1px solid var(--rule)', borderRadius: 10,
                      overflow: 'hidden', cursor: 'pointer', background: 'var(--ink)',
                      aspectRatio: '9 / 12', position: 'relative',
                    }}>
                    {other.poster
                      ? <img src={other.poster} alt="" loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      : <div style={{ width: '100%', height: '100%' }} />}
                    <span style={{
                      position: 'absolute', bottom: 5, left: 5,
                      padding: '2px 7px', borderRadius: 999,
                      background: showRaw ? 'var(--up)' : 'rgba(21,22,26,0.78)', color: '#fff',
                      fontFamily: 'var(--sans)', fontSize: 8.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>{showRaw ? 'Edit' : 'Raw'}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })() : task.drive_url ? (
          <div style={{
            padding: '14px 16px', background: 'var(--paper-2)',
            border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            {task.thumbnail_url && (
              <img src={task.thumbnail_url} alt="" loading="lazy"
                style={{ width: 80, height: 50, objectFit: 'cover', border: '1px solid var(--rule)' }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>
                No preview encoded
              </div>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)' }}>
                The compressed preview hasn't been generated for this creative yet. Open the original on Drive while it transcodes.
              </div>
            </div>
            <a href={task.drive_url} target="_blank" rel="noreferrer"
              style={{
                padding: '6px 12px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'var(--accent)', color: 'var(--ink)',
                border: 'none', cursor: 'pointer', textDecoration: 'none',
              }}>Open in Drive</a>
          </div>
        ) : null}

        </div>
        )}{/* end LEFT column (player) */}
        {/* ── RIGHT details rail ── */}
        <div style={{ display: 'grid', gap: 16, minWidth: 0, alignContent: 'start' }}>
        {/* Name first — mirrors the library detail modal's field order so the
            two rails line up (Ben 2026-06-28). */}
        <Field label="Name">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder={task.creative_canonical_name || 'Creative name'}
            style={{ ...inputStyle, fontFamily: 'var(--sans)' }} />
        </Field>
        {/* Status — wrapped in Field for the same label/spacing as every other
            field (was a bare chipLabelStyle div). */}
        <Field label="Status">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['queued', 'in_progress', 'review', 'needs_revision', 'done', 'blocked'].map(s => {
              const isOn = status === s
              const c = TASK_STATUS_COLOR[s] || 'var(--ink)'
              return (
                <button key={s} onClick={() => setStatus(s)} style={{
                  padding: '5px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: isOn ? c : 'var(--paper)',
                  color: isOn ? 'white' : 'var(--ink-2)',
                  border: '1px solid ' + (isOn ? c : 'var(--rule)'),
                  borderRadius: 9, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  {!isOn && <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />}
                  <span>{TASK_STATUS_LABEL[s] || s}</span>
                </button>
              )
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Editor">
            <EditorPicker value={editorId || null} editors={editors}
              onChange={(id) => setEditorId(id || '')}
              placeholder="— Unassigned" />
          </Field>
          <Field label="Priority">
            <OptionPicker value={priority} options={PRIORITY_OPTIONS}
              onChange={setPriority} />
          </Field>
          {/* Task-type picker removed 2026-06-11 (Ben) — taskType state
              stays so existing values round-trip through save untouched. */}
          <Field label="Start date">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>

        {/* Folder — where the source clip lives in the library. Inline so
            filing doesn't require a trip back to the Library tab. */}
        <Field label="Folder">
          <button type="button" onClick={openFolderAssign}
            title="Move the source clip (and its versions) into a library folder"
            style={{
              ...inputStyle, textAlign: 'left', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            }}>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: creativeFolder?.name ? 'var(--ink)' : 'var(--ink-3)',
            }}>
              {creativeFolder === undefined ? '…' : (creativeFolder?.name || 'Library root')}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>
              change ▾
            </span>
          </button>
        </Field>

        {/* Raw source — the original footage the editor works FROM. Lives
            here in the rail (not under the player) so the live edit stays
            the star. Download + copy + open-in-Drive in one compact row. */}
        {(task.drive_url || task.preview_url) && (
          <Field label="Raw source">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <a
                href={toDownloadUrl(task.drive_url || task.preview_url, task.creative_name)}
                download={task.creative_name || 'raw.mp4'}
                rel="noreferrer"
                title="Download the raw source file the editor works from"
                style={{
                  padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 10.5,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'var(--ink)', color: 'var(--paper)',
                  textDecoration: 'none', borderRadius: 9,
                }}>↓ Download raw</a>
              <CopyLinkButton
                url={task.drive_url || task.preview_url}
                label="Copy link"
                title="Copy a shareable link to the raw source" />
              {task.drive_url && (
                <a href={task.drive_url} target="_blank" rel="noreferrer"
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                    textDecoration: 'underline',
                  }}>Open in Drive ↗</a>
              )}
            </div>
          </Field>
        )}

        {/* Name moved to the top of the rail (Ben 2026-06-28) to match the
            library detail modal. */}

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Notes on this task — feedback, blockers, links to revisions…" />
        </Field>

        {/* Script the footage was shot from — read-only reference. */}
        {scriptText && scriptText.trim() && (
          <div>
            <div style={chipLabelStyle}>Script</div>
            <div style={{
              marginTop: 6, padding: '12px 14px',
              background: 'var(--paper-2)', border: '1px solid var(--rule)',
              borderLeft: '3px solid var(--accent)', borderRadius: 9,
              fontFamily: 'var(--sans)', fontSize: 13, lineHeight: 1.6,
              color: 'var(--ink-2)', whiteSpace: 'pre-wrap',
              maxHeight: 280, overflowY: 'auto',
            }}>{scriptText}</div>
          </div>
        )}
        </div>{/* end RIGHT rail */}
        </div>{/* end 2-col grid */}


        {/* Submitted work — stacked list of every upload (v1, v2, v3, …)
            from lib_task_submissions. Newest first. Each card has its
            own video preview, Approve button (admin), Delete button. */}
        <SubmissionsPanel
          submissions={submissions}
          commentsBySubId={commentsBySubId}
          canApprove={scope.canEditTask}
          canDelete={scope.canEditTask}
          // Anyone with access to the task modal can leave feedback —
          // admins comment, editors reply. Tracking who-by-role keeps
          // the conversation clear + drives notifyEditor() routing.
          canFeedback={true}
          // Opens the SubmissionPreviewModal (Frame.io-style review surface)
          // for a specific submission. State lives at EditTaskModal level
          // so the modal stacks above the task modal cleanly.
          onOpenReview={(sub) => setReviewingSub(sub)}
          currentUserName={scope.editorName || 'Admin'}
          // Detect role from the scope. isEditorView=true means we're
          // on /editor-view OR a token-share link. But an authenticated
          // admin browsing /editor-view shouldn't be tagged 'editor' —
          // detect by whether scope.editorId resolves to a real editor
          // row (admin-on-editor-view has no editor row).
          currentUserRole={(scope.isEditorView && scope.editorId) ? 'editor' : 'admin'}
          // SubmissionsPanel uses these to dispatch the notification
          // when an admin saves feedback — the assigned editor of the
          // task gets a notification + email (once Resend is wired).
          taskEditorId={task.editor_id}
          taskName={taskDisplayName(task)}
          busy={busy}
          onApprove={approveSubmission}
          onDelete={deleteSubmission}
          onFeedbackSaved={(subId, patch) => {
            // Optimistic local update so the card flips to the new
            // feedback text without a refetch.
            setSubmissions(curr => curr.map(s => s.id === subId ? { ...s, ...patch } : s))
          }}
          onRequestRevision={async (sub, feedbackText) => {
            // Admin clicked the per-version "Request revision" button.
            // SubmissionsPanel already saved any pending feedback draft
            // before invoking us. Here we flip the task status + notify
            // the editor. If the task update fails, surface the error to
            // the operator so they know the feedback saved but the status
            // change didn't land (editor won't see "needs revision").
            const { error } = await supabase.from('lib_editing_tasks')
              .update({ status: 'needs_revision' }).eq('id', task.task_id)
            if (error) {
              setErr(`Feedback saved but task status update failed: ${error.message}. The editor will see your feedback, but won't see the task marked as needing revision. Try again from the Status row above.`)
              return
            }
            setStatus('needs_revision')
            if (task.editor_id) {
              notifyEditor({
                editor_id: task.editor_id,
                kind: 'revision_requested',
                task_id: task.task_id,
                submission_id: sub.id,
                creative_id: task.creative_id,
                title: `Revision requested on v${sub.version_number || 1} — ${taskDisplayName(task)}`,
                body: feedbackText.length > 180 ? feedbackText.slice(0, 177) + '…' : feedbackText,
                link_path: `/editor-view?task=${task.task_id}`,
              })
            }
            // Tell the parent (QueueDashboard) to refresh — otherwise the
            // status pill in the Kanban / list view stays stale until the
            // modal closes + reopens. Same pattern as approveSubmission.
            onSaved?.()
          }}
        />

        {/* Upload edited version — editors drop their cut here. Upload
            starts IMMEDIATELY on file select / drop, no two-step click.
            The lib_creative_library row gets the new URL and the task
            auto-advances to 'review' so admin sees the submission.
            Hidden when the viewer can't upload (per-editor share links
            that aren't bound to this task's editor, or admin views that
            disabled uploads — but those don't open this modal anyway). */}
        {scope.canUpload && (
        <div style={{
          padding: '14px 16px', border: '1px solid var(--rule)', background: 'var(--paper-2)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
            marginBottom: 10,
          }}>
            <span>Upload edited version</span>
            {uploadProgress === 100 && (
              <span style={{ color: 'var(--up)' }}>Submitted for review</span>
            )}
          </div>
          <div
            onClick={() => !busy && uploadInputRef.current?.click()}
            onDrop={e => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f && !busy) startUpload(f)
            }}
            onDragOver={e => e.preventDefault()}
            style={{
              padding: 20, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
              border: '2px dashed ' + (busy ? 'var(--accent)' : 'var(--rule)'),
              background: uploadFile ? 'var(--paper)' : 'transparent',
              transition: 'border-color 0.2s',
            }}>
            <input ref={uploadInputRef} type="file" accept="video/*"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0]
                if (f && !busy) startUpload(f)
              }} />
            {uploadFile ? (
              <>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>{uploadFile.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 4 }}>
                  {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                  {busy && uploadProgress != null && ` · ${uploadProgress}%`}
                  {uploadProgress === 100 && ' · Done'}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                  Drop the edited version here
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 3 }}>
                  or click to select · uploads + flags for review automatically
                </div>
              </>
            )}
          </div>
          {uploadProgress != null && (
            <div style={{
              marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 9, overflow: 'hidden',
            }}>
              <div style={{
                width: `${uploadProgress}%`, height: '100%',
                background: uploadProgress === 100 ? 'var(--up)' : 'var(--accent)',
                transition: 'width 0.2s',
              }} />
            </div>
          )}
          {/* Inline error surface — same red treatment as the footer but
              right next to the drop zone so the editor doesn't miss it. */}
          {err && (
            <div style={{
              marginTop: 10, padding: '10px 12px',
              background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)',
              borderLeft: '3px solid var(--down)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--down)',
              lineHeight: 1.5,
            }}>
              <strong>Upload failed:</strong> {err}
            </div>
          )}
          {/* External-link submission DISABLED (Ben 2026-06-01 quality
              policy). Frame.io and Drive both serve compressed proxy
              videos by default — even though our ingest function never
              transcodes, the BYTES we pull from the proxy already have
              quality loss baked in vs the editor's original cut. The
              only path that guarantees full quality is TUS direct
              upload (the drop zone above), where the editor's local
              file bytes go straight to Supabase storage with zero
              re-encoding. Past submissions that came in via external_url
              are untouched. New submissions must use the drop zone. */}
          <div style={{
            marginTop: 10, padding: '10px 12px',
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            borderLeft: '3px solid var(--accent, #f4e14a)',
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
            lineHeight: 1.55, letterSpacing: '0.02em',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--ink-2)', marginBottom: 4,
            }}>Direct upload only</div>
            Drop the original file above. Frame.io / Drive submission
            links aren't accepted — those services serve compressed
            proxies that lose quality vs your original cut.
          </div>
        </div>
        )}

        {task.drive_url && !task.preview_url && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
            Source file: <a href={task.drive_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{task.drive_url.slice(0, 80)}…</a>
          </div>
        )}
      </div>
      {/* SubmissionPreviewModal stacks on top of this task modal when the
          operator clicks Review on a submission card. The Modal primitive's
          MODAL_DEPTH counter handles z-index, so we just render in the
          same React subtree.

          Approve + Request revision are wired here so the operator can
          act WITHIN the review modal (Ben's overhaul ask — "I can either
          go to approve or request revision from there"). Both handlers
          share the existing approveSubmission / status-flip + notify
          logic — we just write the revision feedback text first since
          the modal's revision composer collects it inline. */}
      <SubmissionPreviewModal
        submission={reviewingSub}
        currentUser={reviewIdentity}
        busy={busy}
        onApprove={async (sub) => {
          await approveSubmission(sub)
          setReviewingSub(null)
        }}
        onRequestRevision={async (sub, feedbackText) => {
          // Mirror SubmissionsPanel.submitRevisionPopup: write the feedback
          // text to the submission row, then run the same status-flip +
          // notify path the panel uses.
          setBusy(true)
          try {
            const patch = {
              feedback_text: feedbackText,
              feedback_at: new Date().toISOString(),
              feedback_by_name: reviewIdentity?.name || 'Admin',
              feedback_read_at: null,
            }
            const { error: fbErr } = await supabase.from('lib_task_submissions')
              .update(patch).eq('id', sub.id)
            if (fbErr) throw fbErr
            const { error: stErr } = await supabase.from('lib_editing_tasks')
              .update({ status: 'needs_revision' }).eq('id', task.task_id)
            if (stErr) throw stErr
            setStatus('needs_revision')
            if (task.editor_id) {
              notifyEditor({
                editor_id: task.editor_id,
                kind: 'revision_requested',
                task_id: task.task_id,
                submission_id: sub.id,
                creative_id: task.creative_id,
                title: `Revision requested on v${sub.version_number || 1} — ${taskDisplayName(task)}`,
                body: feedbackText.length > 180 ? feedbackText.slice(0, 177) + '…' : feedbackText,
                link_path: `/editor-view?task=${task.task_id}`,
              })
            }
            await reloadSubmissions()
            onSaved?.()
            setReviewingSub(null)
          } catch (e) {
            setErr(`Revision request failed: ${e.message || e}`)
          } finally {
            setBusy(false)
          }
        }}
        // Refresh the count chip in the underlying SubmissionsPanel the
        // moment a comment is posted / resolved / deleted, so the version
        // card stays in sync without waiting for the modal to close
        // (code-review P1, 2026-06-01).
        onCommentsChanged={reloadCommentCounts}
        onClose={() => setReviewingSub(null)} />
    </Modal>
  )
}

/* Submissions panel — stack of submission cards (v1, v2, v3, …) from
   lib_task_submissions, newest first. Each card has its own inline
   playable preview + per-version Approve / Delete buttons. Replaces
   the old single-slot SubmittedWorkPanel. */
function SubmissionsPanel({ submissions, commentsBySubId = {}, canApprove, canDelete, canFeedback = true, busy, onApprove, onDelete, onOpenReview, onFeedbackSaved, onRequestRevision, currentUserName, currentUserRole = 'admin', taskEditorId, taskName }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  // Per-card expand/collapse state. Default: only the LATEST (first
  // in the list) is expanded, older versions are collapsed so the
  // modal doesn't sprout three video players for a long revision
  // history. Click the card header to toggle.
  const [expanded, setExpanded] = useState(() => {
    const set = new Set()
    if (submissions && submissions[0]) set.add(submissions[0].id)
    return set
  })
  // Local draft state per submission for the feedback textarea. Stored
  // per-id so editing v1's feedback doesn't bleed into v2's editor.
  const [feedbackDrafts, setFeedbackDrafts] = useState({})
  const [feedbackEditingId, setFeedbackEditingId] = useState(null)
  const [feedbackSavingId, setFeedbackSavingId] = useState(null)
  // Dedicated state for the "Request revision" popup. When set,
  // renders a focused modal-over-modal that lets the admin type
  // feedback specifically for THIS revision request without having
  // to first scroll/click into the inline feedback editor below.
  // Previously the button just fired with whatever was in the inline
  // textarea (often empty) and the editor got a revision request
  // with no actual feedback. Ben flagged this as "real messy".
  const [revisionSub, setRevisionSub] = useState(null)
  const [revisionDraft, setRevisionDraft] = useState('')
  const [revisionSending, setRevisionSending] = useState(false)
  const [revisionErr, setRevisionErr] = useState(null)
  // Strip the legacy "(role)" suffix from feedback_by_name when
  // displaying. Older rows have "Admin (admin)" or "Dean (editor)"
  // baked in. Match ONLY the known role tokens — a broad \w+ pattern
  // would also strip legitimate trailing parens from a name like
  // "John Smith (Sr.)".
  const displayAuthor = (name) => {
    if (!name) return 'Anonymous'
    return name.replace(/\s*\((?:admin|editor|viewer)\)\s*$/i, '').trim() || name
  }
  // Open the dedicated revision-request popup. Pre-fills with any
  // existing feedback (or pending draft) so the admin can edit-in-place
  // rather than starting from scratch.
  const openRevisionPopup = (sub) => {
    const draft = (feedbackDrafts[sub.id] ?? '').trim()
    const existing = (sub.feedback_text || '').trim()
    setRevisionDraft(draft || existing)
    setRevisionErr(null)
    setRevisionSub(sub)
  }
  // Submit the popup: save the typed feedback to the submission row,
  // fire the parent's onRequestRevision to flip the task to
  // needs_revision + notify the editor, then close the popup.
  const submitRevisionPopup = async () => {
    if (!revisionSub) return
    const text = revisionDraft.trim()
    if (!text) {
      setRevisionErr('Add at least a line of feedback before requesting revision.')
      return
    }
    setRevisionSending(true); setRevisionErr(null)
    try {
      const sub = revisionSub
      const patch = {
        feedback_text: text,
        feedback_at: new Date().toISOString(),
        feedback_by_name: currentUserName || 'Admin',
        feedback_read_at: null,
      }
      const { error } = await supabase.from('lib_task_submissions')
        .update(patch).eq('id', sub.id)
      if (error) throw error
      // Optimistic local update so the version card reflects the new
      // feedback text the instant the popup closes — parent then
      // refetches via onRequestRevision -> onSaved.
      onFeedbackSaved?.(sub.id, patch)
      // Parent flips task.status to 'needs_revision' + fires the
      // revision_requested notification (with the feedback body in
      // the email preview).
      await onRequestRevision?.(sub, text)
      setRevisionSub(null)
      setRevisionDraft('')
    } catch (e) {
      setRevisionErr(e.message || 'Failed to save feedback')
    } finally {
      setRevisionSending(false)
    }
  }
  // Save feedback ONLY — no longer does the combined "save + flip status"
  // dance. Status changes (Approve / Request revision / Delete) live on
  // the version action row as separate buttons.
  const saveFeedback = async (sub) => {
    setFeedbackSavingId(sub.id)
    const text = (feedbackDrafts[sub.id] ?? sub.feedback_text ?? '').trim()
    const patch = {
      feedback_text: text || null,
      feedback_at: text ? new Date().toISOString() : null,
      // Plain display name — no "(role)" suffix. Role info is implicit
      // via who's logged in; we don't bake it into every display string.
      feedback_by_name: text ? (currentUserName || (currentUserRole === 'editor' ? 'Editor' : 'Admin')) : null,
      // Reset read state whenever feedback changes — the OTHER side
      // sees it as new again until they open the task. Editor opening
      // the task auto-marks read (EditTaskModal.reloadSubmissions).
      feedback_read_at: null,
    }
    const { error } = await supabase.from('lib_task_submissions')
      .update(patch).eq('id', sub.id)
    setFeedbackSavingId(null)
    if (!error) {
      setFeedbackEditingId(null)
      onFeedbackSaved?.(sub.id, patch)
      // Notify the editor whenever admin writes feedback. Editor-side
      // feedback (replies) doesn't ping admin — admin sees it via the
      // bell on next refresh.
      if (text && currentUserRole === 'admin' && taskEditorId) {
        notifyEditor({
          editor_id: taskEditorId,
          kind: 'feedback',
          task_id: sub.task_id,
          submission_id: sub.id,
          title: `${currentUserName || 'Admin'} left feedback on v${sub.version_number || 1}`,
          body: text.length > 140 ? text.slice(0, 137) + '…' : text,
          link_path: `/editor-view?task=${sub.task_id}`,
        })
      }
    }
  }
  const toggleExpanded = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  if (!submissions || submissions.length === 0) return null
  const approvedSub = submissions.find(s => s.approved_at)
  return (
    <div style={{
      padding: '14px 16px', border: '1px solid var(--rule)',
      background: 'var(--paper)', borderLeft: '3px solid var(--up)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--up)',
        marginBottom: 12,
      }}>
        <span>Submitted work · {submissions.length} version{submissions.length === 1 ? '' : 's'}</span>
        {approvedSub && (
          <span style={{ color: 'var(--ink-3)' }}>
            v{approvedSub.version_number} approved
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gap: 14 }}>
        {submissions.map(sub => {
          const isApproved = !!sub.approved_at
          const isExpanded = expanded.has(sub.id)
          return (
            <div key={sub.id} style={{
              border: '1px solid var(--rule)',
              borderLeft: isApproved ? '3px solid var(--up)' : '3px solid var(--ink-4)',
              background: isApproved ? 'rgba(62,138,94,0.04)' : 'var(--paper)',
            }}>
              <div
                onClick={() => toggleExpanded(sub.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderBottom: isExpanded ? '1px solid var(--rule)' : 'none',
                  background: 'var(--paper-2)',
                  cursor: 'pointer',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    fontSize: 10, color: 'var(--ink-4)',
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.12s',
                    display: 'inline-block', width: 10,
                  }}>▶</span>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                    padding: '3px 8px', borderRadius: 9,
                    background: isApproved ? 'var(--up)' : 'var(--ink-3)', color: 'var(--paper)',
                    letterSpacing: '0.06em',
                  }}>v{sub.version_number}</span>
                  {isApproved && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: 'var(--up)',
                    }}>Approved</span>
                  )}
                  {/* Ingest status — only renders if this submission came in
                      via an external URL that the edge function is still
                      pulling or failed on. Retry kicks the RPC + relies on
                      the next reloadSubmissions tick to refresh. */}
                  <IngestStatusChip
                    submission={sub}
                    onRetry={async (s) => {
                      await retryIngest(s.id)
                      reloadSubmissions?.()
                    }} />
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                  }}>
                    {sub.submitted_by_name || 'Unknown'} · {new Date(sub.created_at).toLocaleString()}
                  </span>
                  {/* Comment-count chip — surfaces lib_submission_comments
                      activity onto the version header so it's obvious at
                      a glance that this cut has been reviewed (Ben
                      2026-06-01: "right now there isn't any real way to
                      know"). Open count is red-ish if there are unresolved
                      timestamped comments, neutral if all resolved. */}
                  {(() => {
                    const cc = commentsBySubId[sub.id]
                    if (!cc || cc.total === 0) return null
                    const hasOpen = cc.open > 0
                    return (
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          if (onOpenReview && sub.file_url) onOpenReview(sub)
                        }}
                        title={hasOpen
                          ? `${cc.open} open · ${cc.total} total — click to open Review`
                          : `${cc.total} comment${cc.total === 1 ? '' : 's'} (all resolved) — click to open Review`}
                        style={{
                          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          padding: '3px 7px', borderRadius: 9, cursor: 'pointer',
                          background: hasOpen ? '#fff1f1' : 'rgba(62,138,94,0.08)',
                          color: hasOpen ? '#8b1f1f' : '#1f5a2f',
                          border: `1px solid ${hasOpen ? 'rgba(181,62,62,0.45)' : 'rgba(62,138,94,0.4)'}`,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}>
                        <span style={{ fontSize: 11 }}>💬</span>
                        {hasOpen ? `${cc.open} OPEN · ${cc.total}` : `${cc.total} RESOLVED`}
                      </span>
                    )
                  })()}
                </div>
                {/* Action row — collapsed to one primary + small quick actions.
                    Ben's overhaul ask: Review is the catch-all (opens player +
                    comments + approve/revision in the modal). Approve + Request
                    revision still live HERE as quick-paths for the "I only have
                    one comment / no comments" workflow. Open external link
                    deleted (Review covers playback; download is inside the
                    modal). Delete kept but de-emphasised. */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                  {canApprove && !isApproved && (
                    <button type="button" disabled={busy}
                      onClick={() => onApprove?.(sub)}
                      title="Approve this version. Use Review if you want to leave comments first."
                      style={{
                        padding: '4px 10px',
                        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: 'var(--up)',
                        border: '1px solid rgba(62,138,94,0.5)', borderRadius: 9,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}>Approve</button>
                  )}
                  {canFeedback && currentUserRole === 'admin' && !isApproved && (
                    <button type="button" disabled={busy || feedbackSavingId === sub.id}
                      onClick={() => openRevisionPopup(sub)}
                      title="Quick path: open a popup to type revision feedback. For per-timestamp comments, use Review."
                      style={{
                        padding: '4px 10px',
                        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: '#7a5800',
                        border: '1px solid rgba(208,156,8,0.5)', borderRadius: 9,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}>Revise</button>
                  )}
                  {canDelete && confirmDeleteId !== sub.id && (
                    <button type="button" disabled={busy}
                      onClick={() => setConfirmDeleteId(sub.id)}
                      title="Delete this submission (soft delete)"
                      style={{
                        padding: '4px 8px',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                        background: 'transparent', color: 'var(--ink-4)',
                        border: '1px solid transparent', borderRadius: 9,
                        cursor: busy ? 'not-allowed' : 'pointer', lineHeight: 1,
                      }}>×</button>
                  )}
                  {canDelete && confirmDeleteId === sub.id && (
                    <>
                      <button type="button" disabled={busy}
                        onClick={() => setConfirmDeleteId(null)}
                        style={{
                          padding: '4px 8px',
                          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: 'transparent', color: 'var(--ink-3)',
                          border: '1px solid var(--rule)', borderRadius: 9, cursor: 'pointer',
                        }}>Cancel</button>
                      <button type="button" disabled={busy}
                        onClick={() => { onDelete?.(sub); setConfirmDeleteId(null) }}
                        style={{
                          padding: '4px 8px',
                          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: 'var(--down)', color: 'var(--paper)',
                          border: 'none', borderRadius: 9, cursor: 'pointer',
                        }}>Confirm</button>
                    </>
                  )}
                  {/* Primary action — opens the OPT-branded review surface
                      with the custom player, scrubber-pinned comment
                      markers, and Approve / Request revision in the
                      modal footer. */}
                  <CopyLinkButton
                    url={sub.file_url || sub.external_url}
                    label="Copy link"
                    title="Copy a shareable link to this version"
                    style={{ marginLeft: 6 }} />
                  {onOpenReview && sub.file_url && (
                    <button type="button"
                      onClick={() => onOpenReview(sub)}
                      style={{
                        padding: '6px 14px',
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        border: 'none', cursor: 'pointer',
                        marginLeft: 6,
                      }}>Review ▶</button>
                  )}
                </div>
              </div>
              {/* Body only renders when expanded — avoids spinning up
                  N video <video> elements + N decoders just to show a
                  revision history. */}
              {isExpanded && sub.file_url && (
                <>
                  {/* Compact OPT player — same controls + same custom
                      marker tooltips as the Review modal, just sized for
                      the inline card. Markers come straight from
                      commentsBySubId.markers (already in OptVideoPlayer
                      shape — no per-render transform). The video area
                      is capped at 240px so the version stack doesn't
                      push CTA buttons below the fold. Ben 2026-06-01:
                      "the player still is not a custom one in this
                      preview here and across the board". */}
                  <OptVideoPlayer
                    src={sub.preview_proxy_url || sub.file_url}
                    poster={sub.thumbnail_url}
                    markers={commentsBySubId[sub.id]?.markers || []}
                    downloadUrl={toDownloadUrl(sub.file_url, `v${sub.version_number || 1}.mp4`)}
                    downloadName={`v${sub.version_number || 1}.mp4`}
                    compact
                    wrapperStyle={OPT_PLAYER_WRAP_320} />
                  <div style={{
                    padding: '6px 12px', background: 'var(--paper-2)',
                    borderTop: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
                  }}>
                    <a href={toDownloadUrl(sub.file_url, `v${sub.version_number || 1}.mp4`)}
                      download={`v${sub.version_number || 1}.mp4`}
                      rel="noreferrer"
                      title="Download this submitted cut"
                      style={{
                        padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        textDecoration: 'none', borderRadius: 9,
                      }}>Download</a>
                  </div>
                </>
              )}
              {isExpanded && sub.external_url && !sub.file_url && (
                <div style={{ padding: 14, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                  <a href={sub.external_url} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--ink)', textDecoration: 'underline' }}>
                    External link → {sub.external_url}
                  </a>
                </div>
              )}
              {isExpanded && sub.notes && (
                <div style={{
                  padding: '8px 12px', background: 'var(--paper-2)',
                  borderTop: '1px solid var(--rule)',
                  fontFamily: 'var(--serif)', fontSize: 12.5, color: 'var(--ink-2)',
                  fontStyle: 'italic',
                }}>Editor note: {sub.notes}</div>
              )}
              {/* Feedback section. Anyone with task access can leave
                  feedback (admins comment, editors reply). When the
                  recipient opens the task we auto-mark read so the
                  status flips from "waiting" to "seen". The empty
                  state is a big yellow "Leave feedback" call-to-action,
                  not a passive label, so it's impossible to miss. */}
              {isExpanded && (() => {
                const hasFeedback = !!sub.feedback_text
                const cc = commentsBySubId[sub.id] || { total: 0, open: 0 }
                const hasComments = cc.total > 0
                const hasOpenComments = cc.open > 0
                const isEditing = feedbackEditingId === sub.id
                const isUnread = hasFeedback && !sub.feedback_read_at
                // Status priority (highest first):
                //   unread feedback OR open comments -> red (action needed)
                //   has feedback OR resolved comments -> green (closed)
                //   empty -> yellow (waiting for input)
                const needsAction = isUnread || hasOpenComments
                const hasAny = hasFeedback || hasComments
                const accent = needsAction ? 'var(--down)' : hasAny ? 'var(--up)' : '#e8b408'
                const bg = needsAction ? '#fff1f1' : hasAny ? 'rgba(62,138,94,0.05)' : '#fffaea'
                const labelColor = needsAction ? '#8b1f1f' : hasAny ? '#1f5a2f' : '#7a4e08'
                // Build a status label that reflects ALL signals — feedback
                // text + comment activity — so the panel never lies about
                // whether anyone's said anything about this cut.
                let statusLabel
                if (!hasFeedback && !hasComments) statusLabel = 'No feedback yet'
                else if (needsAction) {
                  const bits = []
                  if (isUnread) bits.push('Feedback waiting')
                  if (hasOpenComments) bits.push(`${cc.open} open comment${cc.open === 1 ? '' : 's'}`)
                  statusLabel = bits.join(' · ')
                } else {
                  const bits = []
                  if (hasFeedback) bits.push('Feedback (seen)')
                  if (hasComments) bits.push(`${cc.total} comment${cc.total === 1 ? '' : 's'} resolved`)
                  statusLabel = bits.join(' · ')
                }
                return (
                  <div style={{
                    padding: '10px 12px',
                    borderTop: '1px solid var(--rule)',
                    background: bg,
                    borderLeft: `3px solid ${accent}`,
                    marginLeft: -3,
                  }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      color: labelColor,
                      marginBottom: hasFeedback ? 6 : 8,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    }}>
                      <span>{statusLabel}</span>
                      {hasFeedback && sub.feedback_at && (
                        <span style={{ color: 'var(--ink-3)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'none', fontWeight: 500 }}>
                          {displayAuthor(sub.feedback_by_name)} · {new Date(sub.feedback_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {/* Display mode */}
                    {hasFeedback && !isEditing && (
                      <div style={{
                        fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)',
                        lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: canFeedback ? 8 : 0,
                        padding: '8px 10px', background: 'var(--paper)', border: '1px solid var(--rule)',
                        borderRadius: 9,
                      }}>{sub.feedback_text}</div>
                    )}
                    {/* Edit mode */}
                    {canFeedback && isEditing && (
                      <>
                        <textarea
                          autoFocus
                          value={feedbackDrafts[sub.id] ?? sub.feedback_text ?? ''}
                          onChange={(e) => setFeedbackDrafts(d => ({ ...d, [sub.id]: e.target.value }))}
                          placeholder={currentUserRole === 'editor'
                            ? 'Reply to the feedback. Anything you write here is visible to the admin.'
                            : 'Feedback for this version — what\'s working, what needs to change, timestamps. The editor sees this exactly as written.'}
                          rows={4}
                          style={{
                            width: '100%', padding: '8px 10px',
                            fontFamily: 'var(--serif)', fontSize: 13,
                            background: 'var(--paper)', border: '1px solid var(--rule)',
                            borderRadius: 9, resize: 'vertical',
                          }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          <button type="button"
                            onClick={() => { setFeedbackEditingId(null); setFeedbackDrafts(d => { const n = { ...d }; delete n[sub.id]; return n }) }}
                            disabled={feedbackSavingId === sub.id}
                            style={{
                              padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                              fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                              background: 'transparent', color: 'var(--ink-3)',
                              border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 9,
                            }}>Cancel</button>
                          <button type="button"
                            onClick={() => saveFeedback(sub)}
                            disabled={feedbackSavingId === sub.id}
                            style={{
                              padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                              fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                              background: 'var(--ink)', color: 'var(--paper)',
                              border: 'none', cursor: 'pointer', borderRadius: 9,
                            }}>{feedbackSavingId === sub.id ? 'Saving…' : 'Save feedback'}</button>
                          {/* Request revision lives in the version action
                              row (next to Approve / Delete) per Ben's
                              workflow — saving feedback and flipping task
                              status are now two distinct actions. */}
                        </div>
                      </>
                    )}
                    {/* Action row — Open Comments + Leave/Edit feedback in
                        one flex row with matched padding so they stack
                        cleanly (no more uneven heights from mixed paddings,
                        Ben 2026-06-01: "the OPEN COMMENTS IN REVIEW padding
                        is a little bit messy"). */}
                    {!isEditing && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'stretch' }}>
                        {/* Open Comments in Review — only when there are
                            timestamped comments to jump into. Primary in
                            the action row when shown because per-timestamp
                            review is richer than free-text feedback. */}
                        {!hasFeedback && hasComments && onOpenReview && sub.file_url && (
                          <button type="button"
                            onClick={() => onOpenReview(sub)}
                            style={{
                              padding: '7px 12px',
                              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                              letterSpacing: '0.08em', textTransform: 'uppercase',
                              background: needsAction ? 'var(--down)' : 'var(--up)',
                              color: 'white', border: 'none', borderRadius: 9,
                              cursor: 'pointer', lineHeight: 1.2,
                            }}>Open comments in Review ▶</button>
                        )}
                        {/* Inline feedback trigger — same height as Open
                            Comments so the row visually balances. */}
                        {canFeedback && (
                          <button type="button"
                            onClick={() => setFeedbackEditingId(sub.id)}
                            style={{
                              padding: '7px 12px',
                              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                              letterSpacing: '0.08em', textTransform: 'uppercase',
                              // When there's already feedback, demote this to
                              // a ghost-style edit button. Otherwise primary
                              // yellow CTA (or secondary outline when paired
                              // with the Open Comments button).
                              background: hasFeedback
                                ? 'transparent'
                                : (hasComments ? 'transparent' : '#e8b408'),
                              color: hasFeedback
                                ? 'var(--ink-2)'
                                : (hasComments ? '#7a4e08' : '#3a2904'),
                              border: hasFeedback
                                ? '1px solid var(--rule)'
                                : (hasComments ? '1px solid #d09c08' : '1px solid #d09c08'),
                              cursor: 'pointer', borderRadius: 9, lineHeight: 1.2,
                            }}>
                            {hasFeedback
                              ? (currentUserRole === 'editor' ? 'Edit reply' : 'Edit feedback')
                              : (currentUserRole === 'editor' ? 'Reply with feedback' : 'Leave feedback')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
      {/* Request-revision popup. Renders over the EditTaskModal when
          the admin clicks "Request revision" on a submission row.
          Forces them to write the actual feedback before the task
          status flips, instead of the old behaviour of firing the
          revision request with whatever empty / stale text was sitting
          in the inline textarea. */}
      {revisionSub && createPortal(
        <div
          onClick={() => !revisionSending && setRevisionSub(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 250,
            background: 'rgba(10,10,10,0.55)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
          <div onClick={e => e.stopPropagation()} style={{
            maxWidth: 520, width: '100%',
            background: 'var(--paper)', border: '1px solid var(--rule)',
            borderTop: '3px solid #d09c08',
            boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
            padding: '24px 26px',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: '#a8650f', marginBottom: 6,
            }}>Request revision · v{revisionSub.version_number || 1}</div>
            <h2 style={{
              margin: '0 0 12px', fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500,
              lineHeight: 1.25, color: 'var(--ink)',
            }}>What needs to change?</h2>
            <p style={{
              margin: '0 0 12px', fontFamily: 'var(--serif)', fontSize: 13,
              color: 'var(--ink-3)', lineHeight: 1.5,
            }}>
              This message goes to the editor as a notification + email. The task moves to <strong>Needs revision</strong> when you send.
            </p>
            <textarea
              autoFocus
              value={revisionDraft}
              onChange={(e) => setRevisionDraft(e.target.value)}
              disabled={revisionSending}
              placeholder="e.g. Tighten the opening to under 4s — cut the wave-at-the-camera. Lower-third needs a bigger font."
              rows={6}
              style={{
                width: '100%', padding: '10px 12px',
                fontFamily: 'var(--serif)', fontSize: 14,
                background: 'var(--paper)', border: '1px solid var(--rule)',
                borderRadius: 9, resize: 'vertical', boxSizing: 'border-box',
              }}
            />
            {revisionErr && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)',
                color: 'var(--down)', fontFamily: 'var(--mono)', fontSize: 11.5,
              }}>{revisionErr}</div>
            )}
            <div style={{
              marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end',
            }}>
              <button type="button"
                onClick={() => setRevisionSub(null)}
                disabled={revisionSending}
                style={{
                  padding: '8px 14px',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--ink-2)',
                  border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 9,
                }}>Cancel</button>
              <button type="button"
                onClick={submitRevisionPopup}
                disabled={revisionSending || !revisionDraft.trim()}
                style={{
                  padding: '8px 14px',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: '#d09c08', color: '#3a2904',
                  border: 'none', cursor: revisionSending ? 'wait' : 'pointer', borderRadius: 9,
                }}>{revisionSending ? 'Sending…' : 'Send revision request'}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}


function TimelineView({ tasks, editors, onEdit, onMoveEditor, onUpdateAssignment, onAddTask }) {
  const [range, setRange] = useState(() => {
    try { return localStorage.getItem('queue.timelineRange') || 'month' } catch { return 'month' }
  })
  useEffect(() => { try { localStorage.setItem('queue.timelineRange', range) } catch {} }, [range])
  const [offsetDays, setOffsetDays] = useState(0)
  // Drag/drop state — which editor lane is currently a hover-drop target,
  // and the id of the task being dragged (so we can show a banner +
  // highlight every drop target while drag is in flight).
  const [dropOnId, setDropOnId] = useState(null)
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  // Calendar-style drag-to-create: click on a day cell, drag across N days,
  // release to open AddTask with editor + start/end dates pre-filled.
  // { editorId, startIdx, endIdx } or null.
  const [dragCreate, setDragCreate] = useState(null)
  // Resize state for "drag right edge to extend due date".
  // { taskId, startClientX, originalDueDate, originalAssignedAt, currentDelta }
  const [resizing, setResizing] = useState(null)
  // Survives the resizing-state cleanup. Set when a resize ends and
  // checked in the bar's onClick to suppress the post-mouseup "click"
  // event that would otherwise open the EditTaskModal.
  const justResizedRef = useRef(false)
  const [datePopover, setDatePopover] = useState(null)
  const tasksById = useMemo(() => Object.fromEntries(tasks.map(t => [t.task_id, t])), [tasks])
  const draggingTask = draggingTaskId ? tasksById[draggingTaskId] : null

  const handleTaskDragStart = (e, task) => {
    e.dataTransfer.setData('application/x-task-id', task.task_id)
    e.dataTransfer.setData('text/plain', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTaskId(task.task_id)
    setDatePopover(null)
  }
  const handleTaskDragEnd = () => {
    setDraggingTaskId(null)
    setDropOnId(null)
  }
  const handleLaneDragEnter = (e, editorId) => {
    if (!onMoveEditor) return
    e.preventDefault()
    if (dropOnId !== editorId) setDropOnId(editorId)
  }
  const handleLaneDragOver = (e, editorId) => {
    if (!onMoveEditor) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropOnId !== editorId) setDropOnId(editorId)
  }
  const handleLaneDragLeave = (e, editorId) => {
    // Only clear if leaving the row entirely (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dropOnId === editorId) setDropOnId(null)
  }
  const handleLaneDrop = (e, editorId) => {
    if (!onMoveEditor && !onUpdateAssignment) return
    e.preventDefault()
    setDropOnId(null)
    setDraggingTaskId(null)
    const taskId = e.dataTransfer.getData('application/x-task-id') || e.dataTransfer.getData('text/plain')
    if (!taskId) return
    const task = tasksById[taskId]
    if (!task) return
    const targetEditorId = editorId === 'unassigned' ? null : editorId

    // Compute the new start day from drop X relative to the lane container.
    // The row's left edge + 200px (editor info column) = lane's left edge.
    // Subtracting that from clientX gives lane-local X.
    const rowRect = e.currentTarget.getBoundingClientRect()
    const laneLeftPx = rowRect.left + 200
    const dropXInLane = e.clientX - laneLeftPx
    const newDayIdx = Math.max(0, Math.min(totalDays - 1, Math.floor(dropXInLane / dayWidth)))
    const newStart = dayLabel(newDayIdx)
    // Slice to YYYY-MM-DD — assigned_at is a DATE column; sending a full
    // UTC ISO string can drift one day backward when the operator is in a
    // UTC-positive timezone (e.g. NZ evening drags).
    const newStartISO = newStart.toISOString().slice(0, 10)

    // Preserve duration: if task had assigned_at + due_date, shift due_date
    // by the same delta. Otherwise just set assigned_at and leave due alone.
    let newDueDate
    if (task.assigned_at && task.due_date) {
      const oldStart = new Date(task.assigned_at); oldStart.setUTCHours(0,0,0,0)
      const oldDue   = new Date(task.due_date);    oldDue.setUTCHours(0,0,0,0)
      const durationDays = Math.max(0, Math.round((oldDue - oldStart) / 86400000))
      const newDue = new Date(newStart); newDue.setUTCDate(newDue.getUTCDate() + durationDays)
      newDueDate = newDue.toISOString().slice(0, 10)
    }

    // Detect no-op: same editor + same start day = nothing to do
    const editorChanged = (task.editor_id || null) !== (targetEditorId || null)
    const oldStartISO = task.assigned_at ? new Date(task.assigned_at).toISOString().slice(0, 10) : null
    const dateChanged = newStart.toISOString().slice(0, 10) !== oldStartISO
    if (!editorChanged && !dateChanged) return

    const patch = {}
    if (editorChanged) patch.editorId = targetEditorId
    if (dateChanged) {
      patch.assignedAt = newStartISO
      if (newDueDate) patch.dueDate = newDueDate
    }
    onUpdateAssignment?.(task, patch)
  }

  const today = new Date(); today.setHours(0,0,0,0)
  // Range = exact intended span. Week starts today, no back-padding.
  const RANGES = {
    week:    { days: 7,   back: 0,  width: 100 },
    month:   { days: 30,  back: 3,  width: 38 },
    '90days':{ days: 90,  back: 7,  width: 16 },
    '6months':{ days: 180, back: 14, width: 9 },
  }
  const cfg = RANGES[range] || RANGES.month
  const minDate = new Date(today); minDate.setDate(today.getDate() - cfg.back + offsetDays); minDate.setHours(0,0,0,0)
  const totalDays = cfg.days
  const dayWidth = cfg.width
  const totalWidth = totalDays * dayWidth

  // Bar resize — drag the right edge to extend the due_date. Uses mouse
  // events (not HTML5 drag) so it doesn't conflict with the bar's
  // drag-to-reassign HTML5 handlers. Placed after `dayWidth` so the
  // pixel-to-days conversion has the correct scale.
  const handleResizeStart = (e, task) => {
    if (!onUpdateAssignment) return
    e.stopPropagation()
    e.preventDefault()
    setResizing({
      taskId: task.task_id,
      startClientX: e.clientX,
      originalDueDate: task.due_date || task.assigned_at || new Date().toISOString().slice(0, 10),
      originalAssignedAt: task.assigned_at,
      currentDeltaDays: 0,
    })
  }
  useEffect(() => {
    if (!resizing) return
    const onMove = (e) => {
      const px = e.clientX - resizing.startClientX
      const deltaDays = Math.round(px / dayWidth)
      setResizing(r => (r && deltaDays !== r.currentDeltaDays) ? { ...r, currentDeltaDays: deltaDays } : r)
    }
    const onUp = () => {
      const finalDelta = resizing.currentDeltaDays
      if (finalDelta !== 0) {
        const orig = new Date(resizing.originalDueDate); orig.setUTCHours(0, 0, 0, 0)
        orig.setUTCDate(orig.getUTCDate() + finalDelta)
        const newDue = orig.toISOString().slice(0, 10)
        // Don't let due_date drop below assigned_at
        const assignedAt = resizing.originalAssignedAt ? resizing.originalAssignedAt.slice(0, 10) : null
        const finalDue = assignedAt && newDue < assignedAt ? assignedAt : newDue
        const task = tasksById[resizing.taskId]
        if (task) onUpdateAssignment?.(task, { dueDate: finalDue })
      }
      // Suppress the click event that fires immediately after mouseup —
      // it would otherwise bubble up to the bar's onClick and re-open
      // the EditTaskModal right after the operator finished resizing.
      justResizedRef.current = true
      setTimeout(() => { justResizedRef.current = false }, 300)
      setResizing(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing, dayWidth, tasksById, onUpdateAssignment])

  // Build editor rows (always show all active editors)
  const editorRows = editors.length ? editors : [{ id: 'unassigned', name: 'Unassigned', slug: 'unassigned' }]
  const tasksByEditor = new Map()
  for (const t of tasks) {
    const key = t.editor_slug || 'unassigned'
    if (!tasksByEditor.has(key)) tasksByEditor.set(key, [])
    tasksByEditor.get(key).push(t)
  }

  const dayLabel = (i) => {
    const d = new Date(minDate); d.setDate(minDate.getDate() + i)
    return d
  }
  const xForDate = (dateStr) => {
    const d = new Date(dateStr); d.setHours(0,0,0,0)
    return Math.round((d - minDate) / 86400000) * dayWidth
  }

  // Status stripe color (per task bar's left edge in the timeline)
  const STATUS_STRIPE = {
    queued: 'var(--ink-4)', in_progress: '#e0853e',
    review: '#3e7eba', done: 'var(--up)',
    blocked: 'var(--down)',
  }

  // Pack tasks into non-overlapping rows per editor (interval scheduling).
  // Each row gets a y-position based on which row it lands in. Row count
  // determines how tall the editor's lane needs to be.
  function packTasks(taskList) {
    const items = taskList
      .map(t => {
        const start = t.assigned_at ? new Date(t.assigned_at) : null
        const end = t.completed_at ? new Date(t.completed_at) : (t.due_date ? new Date(t.due_date) : new Date())
        if (!start) return null
        return { task: t, start: start.getTime(), end: end.getTime() }
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
    const rows = []  // each entry = end-of-last-task in that row
    const placed = []  // [{ task, rowIdx, start, end }]
    for (const it of items) {
      let rowIdx = rows.findIndex(endTs => endTs <= it.start)
      if (rowIdx === -1) { rows.push(it.end); rowIdx = rows.length - 1 }
      else { rows[rowIdx] = it.end }
      placed.push({ ...it, rowIdx })
    }
    return { placed, rowCount: rows.length || 1 }
  }

  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)', position: 'relative' }}>
      {/* Drag-in-flight banner — sticky across the top so Ben can confirm
          the drag is actually active and see what's being moved. */}
      {draggingTask && (
        <div style={{
          position: 'sticky', top: 64, zIndex: 50,
          padding: '8px 14px',
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
          <span>Dragging:</span>
          <span style={{ color: 'var(--accent)' }}>{draggingTask.creative_name}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>
            Drop on any highlighted editor row to reassign
          </span>
        </div>
      )}
      {/* Range controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 14px', borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
      }}>
        <span style={chipLabelStyle}>Zoom</span>
        <FilterChip active={range === 'week'}    onClick={() => { setRange('week'); setOffsetDays(0) }}>Week</FilterChip>
        <FilterChip active={range === 'month'}   onClick={() => { setRange('month'); setOffsetDays(0) }}>Month</FilterChip>
        <FilterChip active={range === '90days'}  onClick={() => { setRange('90days'); setOffsetDays(0) }}>90 days</FilterChip>
        <FilterChip active={range === '6months'} onClick={() => { setRange('6months'); setOffsetDays(0) }}>6 months</FilterChip>
        <span style={{ flex: 1 }} />
        <button onClick={() => setOffsetDays(o => o - (range === 'week' ? 7 : range === 'month' ? 14 : 30))} style={ghostBtn}>← Back</button>
        <button onClick={() => setOffsetDays(0)} style={ghostBtn}>Today</button>
        <button onClick={() => setOffsetDays(o => o + (range === 'week' ? 7 : range === 'month' ? 14 : 30))} style={ghostBtn}>Forward →</button>
      </div>

      <div style={{ overflow: 'auto' }}>
      <div style={{ minWidth: totalWidth + 200 }}>
        {/* Date header */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
          <div style={{ width: 200, padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
                        borderRight: '1px solid var(--rule)' }}>Editor</div>
          <div style={{ display: 'flex', flex: 1, position: 'relative' }}>
            {Array.from({ length: totalDays }, (_, i) => {
              const d = dayLabel(i)
              const isToday = d.getTime() === today.getTime()
              const dow = d.getDay()
              const weekend = dow === 0 || dow === 6
              return (
                <div key={i} style={{
                  width: dayWidth, padding: '6px 4px', textAlign: 'center',
                  fontFamily: 'var(--mono)', fontSize: 9.5,
                  color: isToday ? 'var(--ink)' : 'var(--ink-3)',
                  background: isToday ? 'rgba(244,225,74,0.25)' : weekend ? 'var(--paper-2)' : 'transparent',
                  borderRight: '1px solid var(--rule)',
                  fontWeight: isToday ? 600 : 400,
                }}>
                  <div>{d.toLocaleString('en', { weekday: 'short' }).slice(0,2)}</div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>{d.getDate()}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Rows */}
        {editorRows.map(editor => {
          const editorTasks = tasksByEditor.get(editor.slug) || []
          const color = editorColor(editor)
          const { placed, rowCount } = packTasks(editorTasks)
          // Taller bars (32px) so thumbnails are actually visible.
          // Previously 22px → thumbnail was ~14×14, basically invisible.
          const BAR_HEIGHT = 32
          const ROW_GAP = 6
          const PADDING = 10
          // Always give the lane enough vertical room to fit every packed
          // bar with a row of padding to spare. The -ROW_GAP from before
          // could tighten the last row against the bottom edge so a 3rd+
          // bar would clip into the next editor's lane when overflow:hidden
          // was on. Now we add ROW_GAP of buffer instead.
          const laneHeight = Math.max(72, PADDING * 2 + rowCount * (BAR_HEIGHT + ROW_GAP) + ROW_GAP)
          const isDropTarget = dropOnId === editor.id
          // Every row gets a visible "drop target" indicator while a drag
          // is in flight — even ones not currently hovered — so Ben can
          // tell at a glance which rows will accept the drop.
          const isPotentialTarget = !!draggingTaskId && !!onMoveEditor &&
            (draggingTask?.editor_id || null) !== (editor.id === 'unassigned' ? null : editor.id)
          return (
            <div key={editor.id}
              onDragEnter={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragEnter(e, editor.id) : undefined}
              onDragOver={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragOver(e, editor.id) : undefined}
              onDragLeave={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDragLeave(e, editor.id) : undefined}
              onDrop={(onMoveEditor || onUpdateAssignment) ? (e) => handleLaneDrop(e, editor.id) : undefined}
              style={{
                display: 'flex',
                borderBottom: '1px solid var(--rule)',
                minHeight: laneHeight,
                background: isDropTarget ? 'rgba(244,225,74,0.18)'
                          : isPotentialTarget ? 'rgba(244,225,74,0.04)'
                          : 'transparent',
                outline: isDropTarget ? '2px solid var(--accent)' : 'none',
                outlineOffset: '-2px',
                transition: 'background 0.1s',
              }}>
              <div style={{ width: 200, padding: '12px 14px',
                            borderRight: '1px solid var(--rule)', flexShrink: 0,
                            background: isDropTarget ? 'rgba(244,225,74,0.18)' : 'var(--paper-2)',
                            borderLeft: `4px solid ${color}`,
                            position: 'relative',
                          }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 9, background: color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{editor.name}</span>
                </div>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginTop: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span>{editorTasks.length} task{editorTasks.length === 1 ? '' : 's'}</span>
                  {onAddTask && editor.id !== 'unassigned' && (
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); onAddTask({ editorId: editor.id, due: '' }) }}
                      title={`Add a new task for ${editor.name}`}
                      style={{
                        padding: '3px 8px',
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        border: 'none', cursor: 'pointer', borderRadius: 9,
                      }}>+ Add</button>
                  )}
                </div>
              </div>
              <div style={{ position: 'relative', flex: 1, width: totalWidth, height: laneHeight, overflow: 'hidden' }}
                // Calendar-style drag-to-create: mousedown on an empty area,
                // drag across N days, release to open AddTask with editor +
                // start/end pre-filled. Skipped during a reassign-drag, on
                // the Unassigned row, or if onAddTask isn't wired.
                onMouseDown={(e) => {
                  if (draggingTaskId) return
                  if (!onAddTask || editor.id === 'unassigned') return
                  // Don't start drag-create if mousedown landed on a task bar
                  if (e.target.closest('[data-task-bar]')) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const idx = Math.max(0, Math.min(totalDays - 1, Math.floor((e.clientX - rect.left) / dayWidth)))
                  setDragCreate({ editorId: editor.id, startIdx: idx, endIdx: idx })
                }}
                onMouseMove={(e) => {
                  if (!dragCreate || dragCreate.editorId !== editor.id) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const idx = Math.max(0, Math.min(totalDays - 1, Math.floor((e.clientX - rect.left) / dayWidth)))
                  if (idx !== dragCreate.endIdx) setDragCreate({ ...dragCreate, endIdx: idx })
                }}
                onMouseUp={() => {
                  if (!dragCreate || dragCreate.editorId !== editor.id) return
                  const sIdx = Math.min(dragCreate.startIdx, dragCreate.endIdx)
                  const eIdx = Math.max(dragCreate.startIdx, dragCreate.endIdx)
                  const startISO = dayLabel(sIdx).toISOString().slice(0, 10)
                  const endISO = dayLabel(eIdx).toISOString().slice(0, 10)
                  onAddTask({ editorId: editor.id, due: endISO, start: startISO })
                  setDragCreate(null)
                }}
                onMouseLeave={() => {
                  // If they leave the lane mid-drag, cancel (avoids hung state)
                  if (dragCreate?.editorId === editor.id) setDragCreate(null)
                }}>
                {/* Drop-here hint shown on empty lanes during a drag */}
                {isDropTarget && editorTasks.length === 0 && (
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    color: 'var(--ink-3)', pointerEvents: 'none', zIndex: 3,
                  }}>Drop to assign to {editor.name}</div>
                )}
                {/* Day grid lines — purely visual now. Pointer events are
                    disabled so the lane-level mouse handlers see the events
                    directly and we can drag-create across cells. */}
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = dayLabel(i); const dow = d.getDay()
                  return (
                    <div key={i}
                      style={{
                        position: 'absolute', left: i * dayWidth, top: 0, bottom: 0,
                        width: dayWidth, borderRight: '1px solid var(--rule)',
                        background: dow === 0 || dow === 6 ? 'var(--paper-2)' : 'transparent',
                        pointerEvents: 'none',
                      }} />
                  )
                })}
                {/* Drag-create overlay — yellow rectangle while user is
                    dragging across days to define a new task's date range. */}
                {dragCreate && dragCreate.editorId === editor.id && (() => {
                  const sIdx = Math.min(dragCreate.startIdx, dragCreate.endIdx)
                  const eIdx = Math.max(dragCreate.startIdx, dragCreate.endIdx)
                  const left = sIdx * dayWidth
                  const width = (eIdx - sIdx + 1) * dayWidth
                  const startD = dayLabel(sIdx)
                  const endD = dayLabel(eIdx)
                  return (
                    <div style={{
                      position: 'absolute', left, top: 6, height: laneHeight - 12, width,
                      background: 'rgba(244,225,74,0.4)',
                      border: '2px solid var(--accent)',
                      borderRadius: 9, zIndex: 3, pointerEvents: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      color: 'var(--ink)',
                    }}>
                      {startD.getDate()}{sIdx !== eIdx ? ` → ${endD.getDate()}` : ''} · release to add task
                    </div>
                  )
                })()}
                {/* Today line */}
                <div style={{
                  position: 'absolute', left: xForDate(today.toISOString()),
                  top: 0, bottom: 0, width: 2, background: 'var(--accent)', zIndex: 2,
                }} />
                {/* Packed task bars */}
                {placed.map(({ task: t, rowIdx, start }) => {
                  const startStr = new Date(start).toISOString()
                  const endTs = t.completed_at ? new Date(t.completed_at).getTime() : (t.due_date ? new Date(t.due_date).getTime() : Date.now())
                  const x = xForDate(startStr)
                  // Apply in-flight resize delta visually before the DB write.
                  // Each `dayWidth` of cursor drag extends the bar by one day.
                  const isResizing = resizing?.taskId === t.task_id
                  const resizeDeltaPx = isResizing ? resizing.currentDeltaDays * dayWidth : 0
                  const baseW = Math.max(dayWidth - 2, xForDate(new Date(endTs).toISOString()) - x + dayWidth - 2)
                  const w = Math.max(dayWidth, baseW + resizeDeltaPx)
                  const y = PADDING + rowIdx * (BAR_HEIGHT + ROW_GAP)
                  // status='review' means the EDITOR has already submitted and
                  // the task is on the COORDINATOR's plate — it is NOT overdue
                  // from the editor's POV regardless of due date. Don't paint
                  // the bar or badge red for it. (Ben 2026-05-31: tasks were
                  // showing OVD when an editor had actually submitted, so it
                  // was impossible to tell who was blocking from the timeline.)
                  const editorIsBlocking = t.is_overdue && t.status !== 'review'
                  const stripe = editorIsBlocking ? 'var(--down)' : (STATUS_STRIPE[t.status] || 'var(--ink-4)')
                  const label = taskDisplayName(t)
                  const thumbVisible = !!t.thumbnail_url && w >= 80
                  // Status badge: show prominently for non-queued states.
                  //   review      → solid blue "REVIEW"
                  //   in_progress → solid orange "WIP"
                  //   done        → solid green "DONE" + bar dimmed
                  //   blocked     → solid red "BLOCKED"
                  // Overdue replaces the badge with "OVD" in red — but ONLY
                  // when the editor is actually blocking (status != review).
                  const STATUS_BADGE = {
                    review:      { label: 'REVIEW', bg: '#3e7eba' },
                    in_progress: { label: 'WIP',    bg: '#e0853e' },
                    done:        { label: 'DONE',   bg: 'var(--up)' },
                    blocked:     { label: 'BLOCK',  bg: 'var(--down)' },
                    needs_revision: { label: 'REVISE', bg: '#c47a1a' },
                  }
                  const badge = editorIsBlocking
                    ? { label: 'OVD', bg: 'var(--down)' }
                    : STATUS_BADGE[t.status] || null
                  const isDone = t.status === 'done'
                  return (
                    <div key={t.task_id}
                      data-task-bar="true"
                      onClick={(e) => {
                        if (isResizing || justResizedRef.current) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        setDatePopover({
                          task: t,
                          x: rect.left,
                          y: rect.bottom + 6,
                          startDate: t.assigned_at ? t.assigned_at.slice(0, 10) : '',
                          dueDate: t.due_date || '',
                        })
                      }}
                      draggable={!!(onMoveEditor || onUpdateAssignment) && !isResizing}
                      onDragStart={(e) => handleTaskDragStart(e, t)}
                      onDragEnd={handleTaskDragEnd}
                      title={`${label}${t.creative_canonical_name ? ' · ' + t.creative_name : ''} · ${t.status}${t.due_date ? ' · due ' + t.due_date : ''}${editorIsBlocking ? ' · OVERDUE' : ''}${t.status === 'review' && t.is_overdue ? ' · in review past due — coordinator must review' : ''}${(onMoveEditor || onUpdateAssignment) ? ' · drag the bar to reassign · drag the right edge to extend the due date' : ''}`}
                      style={{
                        position: 'absolute', left: x + 2, top: y,
                        width: w, height: BAR_HEIGHT,
                        background: color,
                        borderLeft: `4px solid ${stripe}`,
                        borderRadius: 9,
                        paddingLeft: thumbVisible ? 4 : 8, paddingRight: 6,
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
                        color: 'white',
                        overflow: 'hidden',
                        opacity: isDone ? 0.65 : 1,
                        textDecoration: isDone ? 'line-through' : 'none',
                        cursor: isResizing ? 'ew-resize'
                              : (onMoveEditor || onUpdateAssignment) ? 'grab'
                              : (onEdit ? 'pointer' : 'default'),
                        zIndex: isResizing ? 4 : 1,
                        boxShadow: isResizing
                          ? '0 2px 8px rgba(10,10,10,0.35)'
                          : '0 1px 2px rgba(0,0,0,0.15)',
                        outline: isResizing ? '2px solid var(--ink)' : 'none',
                      }}>
                      {thumbVisible && (
                        <img src={t.thumbnail_url} alt="" loading="lazy"
                          style={{
                            width: Math.min(28, BAR_HEIGHT - 8),
                            height: BAR_HEIGHT - 8,
                            objectFit: 'cover',
                            borderRadius: 9,
                            flexShrink: 0,
                            background: 'rgba(0,0,0,0.3)',
                          }} />
                      )}
                      <span style={{
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{label}</span>
                      {isResizing && resizing.currentDeltaDays !== 0 && (
                        <span style={{
                          fontSize: 9, padding: '1px 4px',
                          background: 'rgba(0,0,0,0.4)', borderRadius: 9,
                          fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                        }}>
                          {resizing.currentDeltaDays > 0 ? '+' : ''}{resizing.currentDeltaDays}d
                        </span>
                      )}
                      {!isResizing && badge && w >= 60 && (
                        <span style={{
                          fontSize: 9, padding: '2px 5px',
                          background: badge.bg, color: 'var(--paper)',
                          borderRadius: 9, fontWeight: 700,
                          letterSpacing: '0.08em', textTransform: 'uppercase',
                          textDecoration: 'none',
                          flexShrink: 0,
                          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                        }}>{badge.label}</span>
                      )}
                      {/* Right-edge resize handle — 6px wide, only visible
                          when onUpdateAssignment is wired. Uses mouse events
                          so it bypasses the bar's HTML5 drag handlers. */}
                      {!!onUpdateAssignment && (
                        <div
                          onMouseDown={(e) => handleResizeStart(e, t)}
                          onClick={(e) => e.stopPropagation()}
                          title="Drag to extend due date"
                          style={{
                            position: 'absolute', right: 0, top: 0, bottom: 0,
                            width: 8, cursor: 'ew-resize',
                            background: isResizing ? 'rgba(255,255,255,0.4)' : 'transparent',
                            transition: 'background 0.12s',
                          }}
                          onMouseEnter={e => { if (!isResizing) e.currentTarget.style.background = 'rgba(255,255,255,0.25)' }}
                          onMouseLeave={e => { if (!isResizing) e.currentTarget.style.background = 'transparent' }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      </div>
      {datePopover && (
        <DateEditPopover
          popover={datePopover}
          onClose={() => setDatePopover(null)}
          onSave={(newStart, newDue) => {
            const patch = {}
            const oldStart = datePopover.task.assigned_at ? datePopover.task.assigned_at.slice(0, 10) : ''
            if (newStart !== oldStart) patch.assignedAt = newStart
            if (newDue !== (datePopover.task.due_date || '')) patch.dueDate = newDue
            if (Object.keys(patch).length) onUpdateAssignment?.(datePopover.task, patch)
            setDatePopover(null)
          }}
          onFullEdit={() => { onEdit?.(datePopover.task); setDatePopover(null) }}
        />
      )}
    </div>
  )
}

/* ─────────────────────────── INBOX view ─────────────────────────── */

/* Inbox is the operator's "what needs my attention?" view. It surfaces:
   - Tasks awaiting review (an editor submitted; you need to approve/revise)
   - Overdue tasks (past due_date, not done/blocked)
   - Blocked tasks (something's stuck)
   Each is a click-through card with thumbnail, name, editor, last note,
   prominent status badge. Clicking opens the EditTaskModal where Ben
   can watch the submission, leave notes, advance status. */
function InboxView({ tasks, onEdit }) {
  // Bulk actions (Ben 2026-06-11): select cards → move the underlying
  // creatives into a library folder, or download their best-quality
  // files — without round-tripping through the Library tab.
  const [sel, setSel] = useState(() => new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [folders, setFolders] = useState(null)   // null = not fetched yet
  const [note, setNote] = useState(null)         // transient feedback
  const noteTimer = useRef(null)
  const flash = (msg) => {
    setNote(msg)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 3500)
  }
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  const toggleSel = useCallback((taskId) => {
    setSel(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId)
      return next
    })
  }, [])

  const selTasks = tasks.filter(t => sel.has(t.task_id))

  const openPicker = async () => {
    if (folders === null) {
      const { data } = await supabase.from('lib_creative_folders')
        .select('id,name,parent_id').order('name')
      setFolders(data || [])
    }
    setPickerOpen(true)
  }

  // Same family semantics as the Library's move: a clip travels with its
  // other versions, so "latest only" can't strand half a family.
  const moveSelectedToFolder = async (destId) => {
    const cids = [...new Set(selTasks.map(t => t.creative_id).filter(Boolean))]
    if (!cids.length) return
    const { data: fam, error: famErr } = await supabase.from('lib_creative_library')
      .select('id,parent_id').in('id', cids)
    if (famErr) throw famErr
    const roots = [...new Set((fam || []).map(r => r.parent_id || r.id))]
    const list = roots.join(',')
    const { error } = await supabase.from('lib_creative_library')
      .update({ folder_id: destId })
      .or(`id.in.(${list}),parent_id.in.(${list})`)
    if (error) throw error
    setPickerOpen(false)
    setSel(new Set())
    flash(`✓ Moved ${cids.length} video${cids.length === 1 ? '' : 's'} to ${destId ? (folders?.find(f => f.id === destId)?.name || 'folder') : 'the library root'}`)
  }

  // Best-quality URL first — same priority chain as the Library's bulk
  // download (final cut > original Drive ingest > preview/original TUS).
  const downloadSelected = () => {
    const urls = selTasks
      .map(t => t.final_cut_url || t.drive_url || t.preview_url)
      .filter(Boolean)
    urls.forEach((url, i) => {
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = url; a.download = ''
        document.body.appendChild(a); a.click(); a.remove()
      }, i * 180)
    })
    flash(`Downloading ${urls.length} file${urls.length === 1 ? '' : 's'}…`)
  }

  const sections = useMemo(() => {
    const review  = tasks.filter(t => t.status === 'review')
    const overdue = tasks.filter(t => t.is_overdue && t.status !== 'review')
    const blocked = tasks.filter(t => t.status === 'blocked' && !t.is_overdue)
    // Sort each section: most recently touched first. We don't have a
    // last_activity_at column so use due_date desc as a proxy — recently-due
    // tasks rise to the top.
    const byDueDesc = (a, b) => (b.due_date || '').localeCompare(a.due_date || '')
    return [
      { key: 'review',  label: 'Awaiting review',    color: 'var(--ink)',  items: review.sort(byDueDesc) },
      { key: 'overdue', label: 'Overdue',            color: 'var(--down)', items: overdue.sort(byDueDesc) },
      { key: 'blocked', label: 'Blocked',            color: 'var(--flat)', items: blocked.sort(byDueDesc) },
    ].filter(s => s.items.length > 0)
  }, [tasks])

  if (sections.length === 0) {
    return (
      <div style={{
        border: '1px dashed var(--rule)', borderRadius: 12, padding: 40, textAlign: 'center',
        background: 'var(--paper-2)',
      }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink-2)', marginBottom: 6 }}>
          Inbox zero
        </div>
        <p style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-3)' }}>
          Nothing awaiting review, no overdue tasks, nothing blocked. When an editor uploads a cut, it'll show up here.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      {/* Bulk bar — appears when ≥1 card is ticked */}
      {sel.size > 0 && (
        <div style={{
          position: 'sticky', top: 64, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: 'var(--ink)', color: 'var(--paper)',
          borderRadius: 10,
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>
            {sel.size} selected
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={downloadSelected} style={{
            padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'transparent', color: 'var(--paper)',
            border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer',
          }}>↓ Download {sel.size}</button>
          <button onClick={openPicker} style={{
            padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'var(--accent)', color: 'var(--ink)',
            border: 'none', cursor: 'pointer',
          }}>Move to folder</button>
          <button onClick={() => setSel(new Set())} style={{
            padding: '7px 10px', fontFamily: 'var(--mono)', fontSize: 10.5,
            background: 'transparent', color: 'rgba(255,255,255,0.7)',
            border: 'none', cursor: 'pointer',
          }}>✕</button>
        </div>
      )}
      {note && (
        <div style={{
          position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          zIndex: 120, padding: '10px 18px',
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
          letterSpacing: '0.05em', borderRadius: 9,
          boxShadow: '0 6px 24px rgba(10,10,10,0.35)', pointerEvents: 'none',
        }}>{note}</div>
      )}
      {sections.map(section => (
        <div key={section.key}>
          {/* Editorial section head — mono eyebrow with a coloured dash rule,
              serif tabular count, and a hairline filling the row. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
          }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-3)',
              display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap',
            }}>
              <span style={{ width: 18, height: 2, background: section.color }} />
              {section.label}
              <span style={{
                fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500,
                color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', letterSpacing: 0,
              }}>{section.items.length}</span>
            </span>
            <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {section.items.map(t => (
              <InboxCard key={t.task_id} task={t} onEdit={onEdit} sectionColor={section.color}
                selected={sel.has(t.task_id)} onToggle={toggleSel} />
            ))}
          </div>
        </div>
      ))}
      {pickerOpen && folders !== null && (
        <FolderPickerModal
          title={`Move ${sel.size} video${sel.size === 1 ? '' : 's'} to a folder`}
          subtitle="Files the underlying library clips (and their other versions). Tasks stay where they are."
          folders={folders}
          onClose={() => setPickerOpen(false)}
          onPick={moveSelectedToFolder}
        />
      )}
    </div>
  )
}

function InboxCard({ task: t, onEdit, sectionColor, selected = false, onToggle = null }) {
  const [hover, setHover] = useState(false)
  const [hoverPlay, setHoverPlay] = useState(false)
  useEffect(() => {
    if (!hover) { setHoverPlay(false); return }
    const tm = setTimeout(() => setHoverPlay(true), 120)
    return () => clearTimeout(tm)
  }, [hover])
  const editorCol = editorColor(t)
  const dueLabel = t.due_date
    ? (() => {
        const d = new Date(t.due_date); d.setHours(0,0,0,0)
        const today = new Date(); today.setHours(0,0,0,0)
        const days = Math.round((d - today) / 86400000)
        // status='review' means the editor submitted; the task is on the
        // coordinator. Don't paint the date as "overdue" in that case —
        // show "Submitted (1d past due)" so it's clear what's blocking.
        if (days < 0) {
          return t.status === 'review'
            ? `Submitted (${Math.abs(days)}d past due)`
            : `${Math.abs(days)}d overdue`
        }
        if (days === 0) return 'Due today'
        if (days === 1) return 'Due tomorrow'
        return `Due in ${days}d`
      })()
    : null
  return (
    <div
      onClick={() => onEdit?.(t)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: onToggle ? '22px 64px 1fr auto' : '64px 1fr auto',
        gap: 14,
        padding: '12px 16px', alignItems: 'center',
        background: selected ? 'var(--accent-soft)' : (hover ? 'var(--paper-2)' : 'var(--paper)'),
        border: selected ? '1px solid var(--accent)' : '1px solid var(--rule)',
        borderLeft: `3px solid ${sectionColor}`,
        borderRadius: 10, overflow: 'hidden',
        cursor: 'pointer', transition: 'background 0.12s',
      }}>
      {onToggle && (
        <div onClick={e => { e.stopPropagation(); onToggle(t.task_id) }}
          title={selected ? 'Deselect' : 'Select for bulk actions (move to folder / download)'}
          style={{
            width: 20, height: 20, borderRadius: 9,
            background: selected ? 'var(--accent)' : 'var(--paper)',
            border: '1.5px solid var(--ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: selected || hover ? 1 : 0.45, transition: 'opacity 0.12s',
          }}>
          {selected && (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      <div style={{
        width: 64, height: 40, background: '#000',
        border: '1px solid var(--rule)', borderRadius: 6, overflow: 'hidden', position: 'relative',
      }}>
        {t.thumbnail_url && !(hoverPlay && t.preview_url) && (
          <img src={t.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        {hoverPlay && t.preview_url && (
          <video src={t.preview_url} autoPlay muted loop playsInline preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div title={taskDisplayName(t)} style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{taskDisplayName(t)}</div>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-4)', marginTop: 2,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {t.editor_name && <span style={{ width: 7, height: 7, borderRadius: '50%', background: editorCol }} />}
            <span>{t.editor_name || 'Unassigned'}</span>
          </span>
          {dueLabel && (
            <>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span style={{ color: (t.is_overdue && t.status !== 'review') ? 'var(--down)' : 'var(--ink-4)' }}>{dueLabel}</span>
            </>
          )}
          {t.notes && (
            <>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span style={{
                color: 'var(--ink-3)', fontStyle: 'italic',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                maxWidth: 320,
              }}>{t.notes}</span>
            </>
          )}
        </div>
      </div>
      <div style={{
        padding: '4px 9px',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        background: TASK_STATUS_COLOR[t.status] || 'var(--ink-3)',
        color: 'white', borderRadius: 9,
        flexShrink: 0,
      }}>{TASK_STATUS_LABEL[t.status] || t.status}</div>
    </div>
  )
}

/* ─────────────────────────── KANBAN view ─────────────────────────── */

// Kanban columns — Ben 2026-05-31: "Queued / In progress / Review /
// Revision / Done". `needs_revision` joined the lineup so coordinator
// kick-backs are visible as a column instead of disappearing into one
// of the other buckets. `blocked` is intentionally OFF this view — it's
// rare, accessible via the status filter chip + List/Timeline views,
// and used to clutter the kanban whenever an editor went on PTO.
const KANBAN_COLS = ['queued', 'in_progress', 'review', 'needs_revision', 'done']
// Kanban-specific column labels (shorter than TASK_STATUS_LABEL so they
// fit in the column headers). Other surfaces keep the longer labels.
const KANBAN_LABEL = {
  queued:         'Queued',
  in_progress:    'In progress',
  review:         'Review',
  needs_revision: 'Revision',
  done:           'Done',
}

function KanbanView({ tasks, editors, onEdit, onMove, onReassignEditor, onAddInColumn }) {
  const cols = KANBAN_COLS
  const byCol = Object.fromEntries(cols.map(c => [c, tasks.filter(t => t.status === c)]))
  const taskById = useMemo(() => Object.fromEntries(tasks.map(t => [t.task_id, t])), [tasks])
  const [dragOver, setDragOver] = useState(null)

  const handleDragStart = (e, task) => {
    e.dataTransfer.setData('text/plain', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e, col) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOver !== col) setDragOver(col)
  }
  const handleDragLeave = (e, col) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dragOver === col) setDragOver(null)
  }
  const handleDrop = (e, col) => {
    e.preventDefault()
    setDragOver(null)
    const taskId = e.dataTransfer.getData('text/plain')
    const task = taskById[taskId]
    if (task && task.status !== col) onMove?.(task, col)
  }

  return (
    // Each column has a minimum width — once the parent can't fit them
    // all at the minimum, the container scrolls horizontally instead of
    // clipping the rightmost column off the screen edge (the bug Ben
    // flagged where DONE slid off-screen when everything was populated).
    // alignItems defaults to `stretch` so columns equal-height regardless
    // of card count.
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols.length}, minmax(240px, 1fr))`,
      gap: 10, overflowX: 'auto',
      // pb keeps the horizontal scrollbar from overlapping the last row
      paddingBottom: 4,
    }}>
      {cols.map(c => (
        <div key={c}
          onDragOver={e => handleDragOver(e, c)}
          onDragLeave={e => handleDragLeave(e, c)}
          onDrop={e => handleDrop(e, c)}
          style={{
            background: 'var(--paper)',
            border: dragOver === c ? `2px dashed ${TASK_STATUS_COLOR[c]}` : '1px solid var(--rule)',
            borderRadius: 12, overflow: 'hidden',
            minHeight: 200, transition: 'border-color 0.12s',
            display: 'flex', flexDirection: 'column',
          }}>
          <div style={{
            padding: '10px 14px', background: 'var(--paper-2)',
            borderBottom: '1px solid var(--rule)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                          letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 9, background: TASK_STATUS_COLOR[c] }} />
              {KANBAN_LABEL[c] || TASK_STATUS_LABEL[c]}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{byCol[c].length}</span>
              {onAddInColumn && (
                <button onClick={() => onAddInColumn(c)} title={`Add a task in ${KANBAN_LABEL[c] || TASK_STATUS_LABEL[c]}`}
                  style={{
                    background: 'var(--ink)', color: 'var(--paper)', border: 'none',
                    width: 22, height: 22, borderRadius: 9, cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, lineHeight: 1,
                  }}>+</button>
              )}
            </div>
          </div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            {byCol[c].map(t => (
              <QueueCard key={t.task_id} task={t}
                editors={editors}
                onClick={() => onEdit?.(t)}
                onReassignEditor={onReassignEditor}
                draggable={!!onMove}
                onDragStart={e => handleDragStart(e, t)} />
            ))}
            {/* Spacer absorbs leftover column height in shorter columns so
                the dashed drop-zone stays at the bottom and the column
                background fills evenly. */}
            <div style={{
              flex: 1, minHeight: 60, marginTop: byCol[c].length === 0 ? 0 : 4,
              border: dragOver === c ? '2px dashed var(--ink-4)' : '2px dashed transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              fontStyle: 'italic', transition: 'border-color 0.12s',
            }}>
              {dragOver === c ? 'Drop to move' : (byCol[c].length === 0 ? 'Empty' : '')}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* QueueCard — fixed-shape card used by the Kanban view.
   Layout (locked so every card is the same size regardless of content):
     - 96px thumbnail strip (object-fit: cover, no aspect drift)
     - Title line (mono, truncated to one line)
     - Subtitle line (creative_name fallback, truncated)
     - Editor pill row (clickable when `editors` + onReassignEditor are wired)
     - Status / priority / due footer row
   Total card height ≈ 188px so a column of cards reads as a clean stack
   instead of the random-tile mishmash Ben flagged. */
function QueueCard({ task, editors, onClick, onReassignEditor, draggable, onDragStart }) {
  const statusColor = TASK_STATUS_COLOR[task.status] || 'var(--ink-3)'
  const eColor = task.editor_slug ? editorColor(task) : null
  const editable = !!(editors && onReassignEditor)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerRect, setPickerRect] = useState(null)
  const pillRef = useRef(null)
  const popRef = useRef(null)
  useEffect(() => {
    if (!pickerOpen) return
    if (pillRef.current) setPickerRect(pillRef.current.getBoundingClientRect())
    const onDoc = (e) => {
      const inBtn = pillRef.current && pillRef.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setPickerOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setPickerOpen(false) }
    const onScroll = () => { if (pillRef.current) setPickerRect(pillRef.current.getBoundingClientRect()) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [pickerOpen])
  const coords = popoverCoords(pickerRect)

  return (
    <div onClick={onClick}
      draggable={!!draggable}
      onDragStart={onDragStart}
      style={{
        background: 'var(--paper)', border: '1px solid var(--rule)',
        borderLeft: `3px solid ${statusColor}`,
        borderRadius: 10, overflow: 'hidden',
        padding: '10px 12px',
        cursor: draggable ? 'grab' : (onClick ? 'pointer' : 'default'),
        transition: 'background 0.12s, opacity 0.12s',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => onClick && (e.currentTarget.style.background = 'white')}
      onDragStartCapture={e => { e.currentTarget.style.opacity = '0.5' }}
      onDragEnd={e => { e.currentTarget.style.opacity = '1' }}>
      {/* Locked 16:9 thumbnail strip. Always rendered (with a fallback
          glyph when no thumbnail) so the card heights line up regardless
          of which clips have previews. */}
      <div style={{
        width: '100%', aspectRatio: '16 / 9', background: '#0a0a0a',
        overflow: 'hidden', border: '1px solid var(--rule)', borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {task.thumbnail_url ? (
          <img src={task.thumbnail_url} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em' }}>NO PREVIEW</span>
        )}
      </div>
      <div title={taskDisplayName(task)} style={{
        fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{taskDisplayName(task)}</div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--ink-4)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        minHeight: 14,
      }}>{task.creative_canonical_name ? task.creative_name : ''}</div>
      {/* Editor pill — clickable when `editors` + onReassignEditor wired
          (Kanban view). Opens a portal-mounted EditorPicker so the
          operator can reassign without leaving the column. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          ref={pillRef}
          type="button"
          disabled={!editable}
          onClick={editable ? (e) => { e.stopPropagation(); setPickerOpen(v => !v) } : undefined}
          title={editable ? 'Reassign editor' : ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 7px', borderRadius: 999,
            background: eColor ? 'var(--paper)' : '#fffaea',
            border: `1px solid ${eColor || '#e8b408'}`,
            fontFamily: 'var(--mono)', fontSize: 9.5,
            color: eColor ? 'var(--ink-2)' : '#7a4e08',
            fontWeight: 500,
            cursor: editable ? 'pointer' : 'default',
          }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: eColor || '#e8b408' }} />
          {task.editor_name || 'Unassigned'}
          {editable && <span style={{ fontSize: 8, opacity: 0.55, marginLeft: 2 }}>▾</span>}
        </button>
      </div>
      <div style={{
        marginTop: 'auto', display: 'flex', gap: 6, alignItems: 'center',
        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-3)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span style={{ color: statusColor, fontWeight: 600 }}>{TASK_STATUS_LABEL[task.status] || task.status}</span>
        <span>·</span>
        <span>{task.priority}</span>
        {task.due_date && (
          <span style={{ marginLeft: 'auto', color: (task.is_overdue && task.status !== 'review') ? 'var(--down)' : 'var(--ink-4)' }}>
            {(task.is_overdue && task.status !== 'review') ? '⚠ ' : ''}{task.due_date}
          </span>
        )}
      </div>
      {pickerOpen && coords && createPortal(
        <div ref={popRef} style={{
          position: 'fixed',
          top: coords.top, left: coords.left, width: Math.max(180, coords.width),
          maxHeight: coords.maxHeight, overflowY: 'auto', zIndex: 9999,
          background: 'var(--paper)', border: '1px solid var(--ink)',
          boxShadow: '0 8px 24px rgba(10,10,10,0.25)', padding: 4,
        }}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onReassignEditor?.(task, null); setPickerOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 10px', background: !task.editor_id ? 'var(--paper-2)' : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: !task.editor_id ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            <span style={{ width: 10, height: 10, borderRadius: 9, background: 'var(--ink-4)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>Unassign</span>
          </button>
          {(editors || []).filter(e => e.active !== false).map(e => {
            const isOn = e.id === task.editor_id
            return (
              <button key={e.id} type="button"
                onClick={(ev) => { ev.stopPropagation(); onReassignEditor?.(task, e.id); setPickerOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 10px', background: isOn ? 'var(--paper-2)' : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: isOn ? 600 : 500,
                }}>
                <span style={{ width: 10, height: 10, borderRadius: 9, background: editorColor(e), flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{e.name}</span>
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

