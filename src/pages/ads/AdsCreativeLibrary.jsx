import { useEffect, useMemo, useState, useCallback, useRef, memo, useDeferredValue, startTransition, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import * as tus from 'tus-js-client'
import { supabase } from '../../lib/supabase'
import { SectionHead, Icon, PALETTE } from '../../components/editorial/atoms'
import Modal from '../../components/editorial/Modal'
import OfferConfigModal from '../../components/ads/OfferConfigModal'
import { FolderBar, FolderPickerModal, subtreeIds } from '../../components/ads/CreativeFolders'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'

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
async function notifyEditor({ editor_id, kind, task_id, creative_id, submission_id, title, body, link_path }) {
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

/* Best-effort editor invite. Fires the invite-editor Edge Function which
   emails the new editor an OPT-branded welcome pointing at /editor-login.
   Call AFTER the lib_creative_editors row is inserted (the function only
   mails addresses on the active roster). Returns:
     'sent'    - Resend accepted the email
     'failed'  - function errored / roster lookup missed / Resend rejected
     'skipped' - no email supplied (editor can be invited later)
   Never throws — the row already exists; the email is a nudge the editor
   can self-serve at /editor-login if it doesn't land. */
async function sendEditorInvite(email, name) {
  if (!email) return 'skipped'
  try {
    const { data, error } = await supabase.functions.invoke('invite-editor', {
      body: { email, name: name || '' },
    })
    if (error) return 'failed'
    return data?.sent ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

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

// Display priority for a creative-library row. Reads the new display_name
// first (set by creative-library-describe post-migration 103), then falls
// back to the pre-overhaul canonical_name, then the upload filename. This
// is the SINGLE source of truth for what an operator or editor sees in
// any list, kanban card, modal title, timeline bar, or download filename.
//
// Pass the row whichever object shape you have; the helper handles both
// the lib_creative_library row shape and the lib_editing_queue task row
// shape (whose columns are prefixed with `creative_`).
function rowDisplayName(r) {
  if (!r) return ''
  // INTENTIONAL: inline fallback chain, NOT a recursive call. An earlier
  // bulk replace_all of `r.canonical_name || r.name` -> `rowDisplayName(r)`
  // also rewrote this function body and produced infinite recursion. Keep
  // the chain literal here.
  return r.display_name || r.canonical_name || r.name || ''
}
function taskDisplayName(t) {
  if (!t) return ''
  return t.creative_display_name || t.creative_canonical_name || t.creative_name || ''
}

/* Resumable upload via TUS. Supabase's standard storage `.upload()` is a
   single-shot POST that buffers the whole file in memory — it falls over
   at the project's per-request limit (was 50MB until we bumped it to 5GB
   yesterday) and gives zero progress feedback for the multi-minute uploads
   needed for raw camera MP4s.

   This helper streams the file in 6MB chunks (Supabase TUS requirement),
   reports progress as 0-1, retries on transient failures, and survives
   browser tab switches. Use for ANY file larger than ~6MB; the small-file
   `.upload()` path is fine for thumbnails.

   `onProgress(fraction)` is called frequently — debounce in the caller
   if it's wired straight into setState. */
// Minimum media dimensions for upload acceptance. 1080p floor — covers
// both landscape 1920x1080 long-form and 1080x1920 shorts. We check
// shortest_side >= 1080 so any orientation passes as long as the resolution
// is genuinely 1080p+. Below this we hard-reject pre-upload (no override) —
// the editor team can't do anything useful with sub-1080 footage anyway.
const MIN_SHORTEST_SIDE = 1080

// Bad-take heuristic regex (Layer 2 of the failed-take system). Matches
// any common shorthand editors / camera operators slap on a flubbed take
// before re-rolling: "_x", "_bad", "_NG", "-fail", "_scratch", "_trash",
// trailing "_X" or "X.mp4" (capital X is the Sony shorthand for void).
// If a filename matches this, the row inserts with is_bad_take=true and
// bad_take_source='heuristic' so it never reaches the editor.
const BAD_TAKE_FILENAME_RE = /[_\-.](x|X|bad|ng|NG|fail|FAIL|scratch|trash|void)(\b|[_\-.\d])/

// Files shorter than this are flagged as "too short to be a usable take".
// Sony cameras sometimes write 1-2s clips when the operator taps record
// twice. Picked 3.0s because legit hook clips have been seen as short
// as 3.5s but never under 3s.
const BAD_TAKE_MIN_DURATION_S = 3.0

// Token slug for the ACTOR slot in the rename scheme. Mirrors the same
// helper inside the creative-library-describe Edge Function so the
// pre-describe name and the post-describe display_name use the same
// actor token. Uppercase, alphanumerics only, no separators.
function actorTokenForRename(creator) {
  const cleaned = (creator || '').toUpperCase().replace(/[^A-Z0-9]+/g, '')
  return cleaned || 'UNK'
}

// Compute the renamed RAW filename for an upload.
// Format: RAW-{YYMMDD}-{ACTOR}-S{batch_seq:02}-{file_seq:03}.{ext}
// Camera filename 20260524_C0858.MP4 + (TANYA, batch 3, file 1) becomes
// RAW-260524-TANYA-S03-001.mp4. Sony original is preserved on the row
// in `original_filename` for audit + re-keyed lookups.
function renameForUpload({ originalName, actor, dateLocal, batchSeq, fileSeq }) {
  // Pull extension from the original filename — accepts .mp4 / .MP4 / etc.
  const m = (originalName || '').match(/\.([a-z0-9]{2,5})$/i)
  const ext = m ? '.' + m[1].toLowerCase() : '.mp4'
  // dateLocal is a YYYY-MM-DD string; shrink to YYMMDD (no dashes)
  const ymd = (dateLocal || '').slice(2).replace(/-/g, '')
  const a = actorTokenForRename(actor)
  const bs = String(batchSeq).padStart(2, '0')
  const fs = String(fileSeq).padStart(3, '0')
  return `RAW-${ymd}-${a}-S${bs}-${fs}${ext}`
}

// Apply the Layer-2 heuristic to a probed file. Returns
// { flagged: boolean, reason: string|null }. The caller writes this
// to the row at insert time via is_bad_take + bad_take_source='heuristic'.
function badTakeHeuristic(file, dims) {
  if (BAD_TAKE_FILENAME_RE.test(file.name || '')) {
    return { flagged: true, reason: `filename pattern (${file.name})` }
  }
  if (dims && dims.kind === 'video' && dims.duration_s != null && dims.duration_s < BAD_TAKE_MIN_DURATION_S) {
    return { flagged: true, reason: `duration ${dims.duration_s.toFixed(1)}s under ${BAD_TAKE_MIN_DURATION_S}s floor` }
  }
  return { flagged: false, reason: null }
}

/* Probe a File's intrinsic dimensions browser-side using the object URL +
   a hidden <video> or <img>. Returns { width, height, kind } or throws
   with a human message. 10s timeout so a broken codec doesn't hang forever
   — operator gets a clear reject instead of an indefinite spinner. */
async function probeMediaDimensions(file) {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)
  if (!isVideo && !isImage) throw new Error('not a video or image')

  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('took >10s to read dimensions (codec unsupported?)'))
      }, 10_000)
      if (isVideo) {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.muted = true
        v.onloadedmetadata = () => {
          clearTimeout(timeout)
          const w = v.videoWidth, h = v.videoHeight
          // Duration in seconds — used by the bad-take heuristic
          // (Layer 2): clips shorter than 3s are auto-flagged as
          // failed/scratch takes at upload time. Infinity/NaN guarded.
          const dur = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : null
          if (!w || !h) reject(new Error('zero-dimension video (corrupt file?)'))
          else resolve({ width: w, height: h, duration_s: dur, kind: 'video' })
        }
        v.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('browser could not decode video metadata'))
        }
        v.src = url
      } else {
        const img = new Image()
        img.onload = () => {
          clearTimeout(timeout)
          const w = img.naturalWidth, h = img.naturalHeight
          if (!w || !h) reject(new Error('zero-dimension image'))
          else resolve({ width: w, height: h, kind: 'image' })
        }
        img.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('browser could not decode image'))
        }
        img.src = url
      }
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Confirm an uploaded object is actually fetchable before the caller trusts
// it enough to write a preview_url. Assumes a PUBLIC bucket (every caller in
// this module uses creative-uploads). One retry rides out storage
// read-after-write propagation. This is the backstop that guarantees a row
// can never reference an object that 404s — independent of *why* it might be
// missing (resume cross-wire, partial finalize, mid-flight deletion).
async function verifyUploaded(bucket, path) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
  for (let attempt = 0; attempt < 2; attempt++) {
    // Timeout the verify request itself — without this, a hung CDN response
    // would stall onSuccess forever and leave the user stuck at 100%.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal })
      if (r.ok) return true // 200 / 206
    } catch { /* timeout or transient network error — fall through to retry */ } finally {
      clearTimeout(timer)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

async function uploadWithResume(file, { bucket, path, contentType, onProgress, upsert = false, registerHandle }) {
  const session = (await supabase.auth.getSession()).data.session
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Not signed in — cannot upload')
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': upsert ? 'true' : 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: contentType || file.type || 'application/octet-stream',
        // 30 days + immutable. Edited cuts never change after upload, so
        // browsers + Cloudflare can serve repeat downloads from cache with
        // zero revalidation round-trips. Previous 1-hour cache forced a
        // revalidation every browser session — every reviewer paid the
        // round-trip on every visit (Ben 2026-06-10: "downloading from the
        // platform is super super slow"). The matching existing-file
        // backfill ran via SQL on storage.objects.metadata at the same time.
        cacheControl: 'public, max-age=2592000, immutable',
      },
      // Fingerprint MUST include the target objectName. tus-js-client's
      // default fingerprint keys only on file identity (name+size+mtime+
      // endpoint), so re-dropping the SAME file into a NEW library row
      // resumed the PRIOR row's upload: bytes landed under the old path
      // while the new row's onSuccess wrote a preview_url pointing at a
      // path that never received bytes -> orphaned object + 404 download.
      // Scoping to bucket+path means resume only ever continues an upload
      // to the exact same destination. (Incident 2026-05-24: C0855/C0848.)
      fingerprint: (f) => Promise.resolve(
        ['tus', bucket, path, f.name, f.size, f.lastModified].join('-')
      ),
      chunkSize: 6 * 1024 * 1024,
      onError: (err) => reject(err),
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress) onProgress(bytesTotal > 0 ? bytesUploaded / bytesTotal : 0)
      },
      onSuccess: () => {
        // tus reported a finalize — but verify the bytes are really there
        // before letting the caller persist a link to them. Never resolve
        // (and thus never write a preview_url) for a missing object.
        verifyUploaded(bucket, path)
          .then((ok) => ok
            ? resolve({ path })
            : reject(new Error(`Upload finalized but object is missing at ${path} — refusing to write a broken link. Please re-upload.`)))
          .catch(reject)
      },
    })
    // Hand the tus instance back to the caller so it can call
    // upload.abort() if the user closes the modal mid-transfer.
    if (registerHandle) registerHandle(upload)
    // Resume if we have a prior attempt for this exact file fingerprint.
    upload.findPreviousUploads().then((prev) => {
      if (prev.length > 0) upload.resumeFromPreviousUpload(prev[0])
      upload.start()
    }).catch(() => upload.start())
  })
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

const TYPES = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']
const STATUSES = ['raw', 'edited']
const STATUS_LABEL = {
  raw: 'Raw',
  edited: 'Edited',
}
const STATUS_COLOR = {
  raw: '#b53e3e',      // red — needs attention / not yet edited
  edited: '#3e8a5e',   // green — done
}

// Task-status (lib_editing_tasks.status) is separate from creative-status.
// Friendly labels — no underscores in display — paired with colors used
// in pill buttons, timeline badges, and the queue's status filter.
const TASK_STATUS_LABEL = {
  queued:          'Queued',
  in_progress:     'In progress',
  review:          'In review',
  needs_revision:  'Needs revision',
  done:            'Done',
  blocked:         'Blocked',
}
const TASK_STATUS_COLOR = {
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
function offerColor(slug) {
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
function typeColor(t) {
  return TYPE_COLOR[t] || { ink: 'var(--ink-3)', soft: 'var(--paper-2)', border: 'var(--rule)' }
}

// Per-stage indicator values for the Matrix view
const STAGE_VALUES = [
  { v: null,           label: '—',          color: '#ccc',   bg: 'transparent' },
  { v: 'done',         label: 'X',          color: 'white',  bg: '#3e8a5e' },
  { v: 'in_progress',  label: 'In progress', color: '#7a4e08', bg: 'rgba(232,180,8,0.25)' },
  { v: 'blocked',      label: 'Blocked',    color: 'white',  bg: '#b53e3e' },
  { v: 'skip',         label: 'Skip',       color: 'var(--ink-3)', bg: 'rgba(0,0,0,0.05)' },
]
function stageStyle(value) {
  const v = STAGE_VALUES.find(s => s.v === value) || STAGE_VALUES[0]
  return v
}

// Stable distinct color per editor (hash of slug → 10-color palette).
// Used everywhere the editor needs a visual identity (selector chips,
// queue cards, timeline bars, list-view dot).
const EDITOR_COLORS = [
  '#3e7eba', '#e0853e', '#5fa55a', '#a05fa5', '#c44b6e',
  '#3eb2a8', '#b8893e', '#7e3eb8', '#5b8a3e', '#b83e3e',
]
function editorColor(slugOrEditorOrTask) {
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

/* Browser-side first-frame capture for video uploads. Manually-uploaded
   videos arrive with no thumbnail (transcribe-library-clip doesn't extract
   one, and there's no ffmpeg in the bucket). Without a thumbnail, the
   identify-actor Edge Function silently no-ops because it has no image to
   send to Claude Vision.

   Two flavours:
     captureVideoThumbnail(File)   — local File-object path, runs PRE
       upload. Limited to 500 MB because the browser would have to read
       the whole File to seek, stalling the TUS upload before a byte
       lands.
     captureVideoThumbnailFromUrl(url) — server-URL path, runs POST
       upload. Browser issues HTTP range requests, only downloads the
       few MB it needs to find a keyframe — works for any size. Use
       this as the post-upload backfill so big Sony XAVC files no
       longer ship without a thumbnail.

   Both return a JPEG Blob ready to upload, or null on any failure so
   the pipeline can continue without blocking. */
async function captureVideoThumbnail(file, { seekSeconds = 1, maxWidth = 720, maxBytes = 500 * 1024 * 1024 } = {}) {
  // Hard guard: phone-camera MP4s often have the moov atom at the end,
  // which forces the browser to download the WHOLE file before it can
  // seek. For multi-hundred-MB files that stalls the entire upload queue
  // before a single byte is sent. We skip thumbnail capture above this
  // threshold and let the post-upload URL path (captureVideoThumbnailFromUrl)
  // handle it once TUS completes.
  if (file.size > maxBytes) return null
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    let settled = false
    const finish = (blob) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(blob)
    }
    video.onloadedmetadata = () => {
      const target = Math.min(seekSeconds, Math.max(0, (video.duration || 0) - 0.1))
      video.currentTime = target
    }
    video.onseeked = () => {
      try {
        const w = Math.min(maxWidth, video.videoWidth || maxWidth)
        const scale = w / (video.videoWidth || w)
        const h = Math.round((video.videoHeight || 405) * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, w, h)
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82)
      } catch { finish(null) }
    }
    video.onerror = () => finish(null)
    // Safety net — never hang the upload more than 8s on thumbnail capture
    setTimeout(() => finish(null), 8000)
    video.src = url
  })
}

/* Post-upload thumbnail extraction. Uses the just-uploaded server URL
   (not the local File) so the browser can HTTP-range-request just the
   metadata + first keyframe instead of reading the whole 600 MB+ File
   off disk. No size cap. Used in the upload pipeline as a fallback
   when the pre-upload File-based capture was skipped. */
async function captureVideoThumbnailFromUrl(url, { seekSeconds = 1, maxWidth = 720, timeoutMs = 30000 } = {}) {
  if (!url) return null
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    // 'metadata' preload + crossOrigin='anonymous' lets the browser
    // issue range requests against the public Supabase bucket without
    // tainting the canvas. Without crossOrigin set, canvas.toBlob
    // throws SecurityError when the source is a different origin.
    video.preload = 'metadata'
    video.crossOrigin = 'anonymous'
    let settled = false
    const finish = (blob) => {
      if (settled) return
      settled = true
      resolve(blob)
    }
    video.onloadedmetadata = () => {
      const target = Math.min(seekSeconds, Math.max(0, (video.duration || 0) - 0.1))
      video.currentTime = target
    }
    video.onseeked = () => {
      try {
        const w = Math.min(maxWidth, video.videoWidth || maxWidth)
        const scale = w / (video.videoWidth || w)
        const h = Math.round((video.videoHeight || 405) * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, w, h)
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82)
      } catch { finish(null) }
    }
    video.onerror = () => finish(null)
    // Generous timeout — moov-at-end files can take a while as the
    // browser scans for the moov atom via range requests. 30s is the
    // cap before we give up and let the cron backfill catch it.
    setTimeout(() => finish(null), timeoutMs)
    video.src = url
  })
}

/* ──────────────────── BACKGROUND UPLOAD QUEUE ──────────────────── */
/* Module-level singleton. Outlives any modal mount/unmount, so the
   operator can hit Upload, close the modal, navigate around the tab,
   and the uploads keep going. The floating UploadDock at the page
   root subscribes for progress. Any component can subscribe via the
   useUploadQueue() hook below.

   Why a singleton instead of context: contexts re-mount with the
   component tree, and the UploadModal is conditionally rendered
   (uploadOpen toggles it). The instant the modal unmounts, any state
   it owned would die. We need state that survives.

   Items live in `uploadQueue.items` and get notified on every change.
   Completed/failed items stick around until the operator dismisses
   them so the dock shows the final state. */
const uploadQueue = {
  items: [],
  listeners: new Set(),
  isProcessing: false,
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
  notify() {
    const snapshot = [...this.items]
    this.listeners.forEach((fn) => { try { fn(snapshot) } catch {} })
  },
  updateItem(id, patch) {
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx >= 0) {
      this.items[idx] = { ...this.items[idx], ...patch }
      this.notify()
    }
  },
  enqueue(files, config) {
    const stamp = new Date().toISOString().slice(0, 10)
    // Per-file config (rename slot, markedBad, etc.) lives on the item
    // so each file in the batch can render its own state in the dock.
    // perFile is index-aligned with files; we pop it off so the batch-
    // level `config` stays clean for everything else.
    const perFile = Array.isArray(config?.perFile) ? config.perFile : null
    const baseConfig = { ...config, stamp }
    if (perFile) delete baseConfig.perFile
    const newItems = files.map((file, idx) => ({
      id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
      file,
      config: baseConfig,
      perFileConfig: perFile ? perFile[idx] || {} : null,
      status: 'queued',
      progress: 0,
      message: 'queued',
      error: null,
      libraryId: null,
      addedAt: Date.now(),
    }))
    this.items.push(...newItems)
    this.notify()
    if (!this.isProcessing) this.processNext()
  },
  async processNext() {
    const next = this.items.find((i) => i.status === 'queued')
    if (!next) {
      this.isProcessing = false
      window.dispatchEvent(new CustomEvent('upload-queue-idle'))
      return
    }
    this.isProcessing = true
    try {
      await runUploadPipeline(next, (patch) => this.updateItem(next.id, patch))
    } catch (e) {
      // Skip the error status if the item was cancelled — cancel() already
      // dropped it from the queue and updateItem would be a no-op anyway.
      if (!next.cancelled) {
        this.updateItem(next.id, { status: 'error', message: e?.message || 'failed', error: e?.message || 'failed' })
      }
    }
    // Yield to event loop so React can paint, then move on.
    setTimeout(() => this.processNext(), 50)
  },
  clearCompleted() {
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'error')
    this.notify()
  },
  dismiss(id) {
    this.items = this.items.filter((i) => i.id !== id)
    this.notify()
  },
  // Cancel an in-flight (or queued) item. If the TUS upload is currently
  // running we abort the tus.Upload handle to free the socket; if the
  // lib_creative_library row was already inserted at step 1 of the
  // pipeline we also delete it so cancelled uploads don't leave behind
  // orphan rows with no asset. Removed from items either way so it
  // disappears from the dock immediately.
  cancel(id) {
    const item = this.items.find((i) => i.id === id)
    if (!item) return
    if (item.tusHandle) {
      try { item.tusHandle.abort() } catch {}
    }
    item.cancelled = true
    if (item.libraryId) {
      // Fire-and-forget — the row is no longer wanted. Errors swallowed
      // because there's nothing actionable: the row will appear in the
      // library as untitled, the operator can delete it manually.
      supabase.from('lib_creative_library').delete().eq('id', item.libraryId).then(() => {})
    }
    this.items = this.items.filter((i) => i.id !== id)
    this.notify()
  },
  // Cancel-all: abort everything still in flight + drop the whole queue.
  // Done/error items get dropped too — this is a hard reset of the dock.
  // Any rows already inserted into lib_creative_library get deleted too
  // so we don't leave orphan rows behind.
  cancelAll() {
    const idsToDelete = []
    for (const it of this.items) {
      if (it.tusHandle) { try { it.tusHandle.abort() } catch {} }
      it.cancelled = true
      if (it.libraryId) idsToDelete.push(it.libraryId)
    }
    if (idsToDelete.length > 0) {
      supabase.from('lib_creative_library').delete().in('id', idsToDelete).then(() => {})
    }
    this.items = []
    this.notify()
  },
}

/* Per-file pipeline. Was inline in UploadModal.submit; extracted so the
   queue can drive it independent of any component. Mirrors the old
   bulk-upload submit() logic: create row → TUS upload → patch thumbnail
   → transcribe (video) → identify-actor → describe. `update(patch)`
   merges into the queue item so subscribers see live progress. */
async function runUploadPipeline(item, update) {
  const { file, config, perFileConfig } = item
  const {
    batchType, batchStatus, batchEditorId, batchOfferSlug, stamp,
    batchCreator, uploadBatchId, batchFolderId,
  } = config
  // Per-file config from the rename allocator. Falls back to safe
  // defaults if the modal didn't supply it (very old enqueue path).
  const renamedName = perFileConfig?.renamedName || file.name
  const markedBad   = !!perFileConfig?.markedBad
  const badReason   = perFileConfig?.badReason || null
  const badSource   = perFileConfig?.badSource || null

  // Bail early if the operator already cancelled this item before processing
  // reached it. cancel() sets item.cancelled before removing from the queue,
  // so this guard covers the brief window when processNext() was scheduled.
  if (item.cancelled) return
  update({ status: 'creating', message: 'creating row', renamedName })

  // Duplicate check (warn-but-allow): a take with the same filename already
  // in the library is very likely a re-upload. Surface a warning on the item
  // but DON'T block — per the chosen behaviour, the operator still decides.
  // Best-effort: never let a dedup hiccup stop a real upload.
  // Migration 104+: dupes are detected by ORIGINAL filename (the camera
  // name), since the new name we generate is by design unique per batch.
  try {
    const { data: dupes } = await supabase
      .from('lib_creative_library')
      .select('canonical_name,name,display_name,original_filename')
      .or(`original_filename.eq.${file.name},name.eq.${file.name}`)
      .eq('exclude_from_library', false)
      .limit(1)
    if (dupes && dupes.length) {
      update({ duplicateWarning: `Possible duplicate of "${dupes[0].display_name || dupes[0].canonical_name || dupes[0].name}" — uploaded anyway` })
    }
  } catch { /* dedup is advisory only */ }

  // 1. Insert library row. Renamed `name` lives in the column the rest of
  //    the app reads as the primary identifier; the camera's original
  //    filename is preserved in `original_filename` for audit. Bad-take
  //    fields (Layer 1 operator toggle OR Layer 2 heuristic) ride along
  //    so the row never appears in the main matrix in the first place.
  //    Self-heal pattern: if migration 104 hasn't been applied, the new
  //    columns 42703 and we strip them + retry so the upload still lands.
  const fullInsert = {
    name: renamedName,
    original_filename: file.name,
    type: batchType || 'Joined',
    size_mb: Math.round((file.size / 1024 / 1024) * 10) / 10,
    status: batchStatus,
    assigned_editor_id: batchEditorId || null,
    offer_slug: batchOfferSlug || null,
    creator: batchCreator || null,
    // Uploads started while inside a folder file straight into it —
    // Drive behaviour. The 42703 strip-loop below keeps this safe if
    // migration 146 isn't applied yet.
    folder_id: batchFolderId || null,
    upload_batch_id: uploadBatchId || null,
    is_bad_take: markedBad,
    bad_take_reason: markedBad ? badReason : null,
    bad_take_source: markedBad ? (badSource || 'upload') : null,
    source_bucket: 'Manual upload',
    notes: `Uploaded via /sales/ads/creative/library on ${stamp}.${markedBad ? ` Flagged as bad take at upload (${badSource || 'operator'}): ${badReason || ''}` : ''}`,
  }
  let working = { ...fullInsert }
  let insertRes = await supabase.from('lib_creative_library').insert(working).select('id').single()
  let guard = 0
  // PGRST204 = PostgREST's "column not in schema cache" for INSERT bodies;
  // 42703 is what SELECTs return. The loop must accept both or it never
  // fires for inserts and the self-heal promise is dead code.
  while ((insertRes.error?.code === '42703' || insertRes.error?.code === 'PGRST204') && guard < Object.keys(fullInsert).length) {
    guard++
    const missing = Object.keys(working).find(k => (insertRes.error.message || '').includes(k))
    if (!missing) break
    delete working[missing]
    insertRes = await supabase.from('lib_creative_library').insert(working).select('id').single()
  }
  const { data: inserted, error: insErr } = insertRes
  if (insErr) throw new Error(insErr.message)
  const libraryId = inserted.id
  update({ libraryId })
  if (item.cancelled) return

  // 2. TUS upload
  const HARD_LIMIT = 10 * 1024 * 1024 * 1024
  const tooLarge = file.size > HARD_LIMIT
  const isImageFile = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)
  let storagePath = null
  if (!tooLarge) {
    // Storage key uses the RENAMED filename (RAW-YYMMDD-ACTOR-Sxx-NNN.ext)
    // so the bucket browser shows structured names instead of camera
    // shorthand. libraryId still prefixes the path so re-uploads / version
    // bumps for the same row don't overwrite each other.
    storagePath = `incoming/${libraryId}_${renamedName.replace(/[^A-Za-z0-9._-]/g, '_')}`
    const contentType = file.type || (isImageFile ? 'image/jpeg' : 'video/mp4')
    let lastPct = -1
    try {
      await uploadWithResume(file, {
        bucket: 'creative-uploads',
        path: storagePath,
        contentType,
        onProgress: (frac) => {
          const pct = Math.floor(frac * 20) * 5
          if (pct !== lastPct) {
            lastPct = pct
            update({ status: 'uploading', progress: frac, message: `uploading ${pct}%` })
          }
        },
        // Stash the tus handle so uploadQueue.cancel() can abort mid-chunk.
        // We clear it after the upload settles so cancel() during the
        // post-upload pipeline doesn't try to abort a finished tus.Upload.
        registerHandle: (handle) => { item.tusHandle = handle },
      })
    } catch (e) {
      if (item.cancelled) return  // tus.abort() rejects the promise; swallow
      throw e
    } finally {
      item.tusHandle = null
    }
    if (item.cancelled) return
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`
    const postPatch = { preview_url: publicUrl }
    if (isImageFile) {
      postPatch.thumbnail_url = publicUrl
    } else {
      update({ status: 'thumbnailing', message: 'capturing thumbnail' })
      // Try pre-upload File-based capture first (fast path for files
      // under 500 MB). If it skips because of the size guard OR fails,
      // fall back to the post-upload URL-based capture which uses HTTP
      // range requests against the just-uploaded file — works for any
      // size without stalling the upload. This is the path Sony XAVC
      // files (600 MB - 1 GB) take, and is why they used to land
      // without a thumbnail before today.
      let thumbBlob = await captureVideoThumbnail(file)
      if (!thumbBlob) {
        thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
      }
      if (thumbBlob) {
        const thumbPath = `incoming/${libraryId}_thumb.jpg`
        try {
          await uploadWithResume(thumbBlob, {
            bucket: 'creative-uploads',
            path: thumbPath,
            contentType: 'image/jpeg',
            upsert: true,
          })
          postPatch.thumbnail_url = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${thumbPath}`
        } catch { /* thumbnail best-effort */ }
      }
    }
    if (batchStatus === 'edited') {
      postPatch.final_cut_url = publicUrl
      postPatch.stage_final_cut = 'done'
    }
    await supabase.from('lib_creative_library').update(postPatch).eq('id', libraryId)
  } else {
    update({ status: 'too-large', message: 'file >10GB · row created without upload' })
    return
  }

  // 3. Transcribe → identify-actor → describe (background, but we still
  //    surface failures into the queue item's message). Cancellation is
  //    checked between each stage so cancel() during the post-upload
  //    pipeline still short-circuits — we can't abort a running Edge
  //    Function but we can skip the next ones.
  //
  //    SKIP for marked-bad takes: they're hidden from the library by
  //    default and no editor will ever look at them, so spending Whisper
  //    + Claude budget transcribing + naming them is wasted spend. The
  //    Triage tab still shows them; if the coordinator later un-flags
  //    one, they can run describe manually from the detail modal.
  if (markedBad) {
    update({ status: 'done', progress: 1, message: 'done · flagged as bad take, naming pipeline skipped' })
    return
  }
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)
  let pipelineErr = null
  if (isVideo) {
    update({ status: 'transcribing', message: 'transcribing' })
    try {
      const { data, error } = await supabase.functions.invoke('transcribe-library-clip', {
        body: { library_id: libraryId, storage_path: storagePath },
      })
      if (error) pipelineErr = `transcribe: ${error.message}`
      else if (data?.error) pipelineErr = `transcribe: ${data.error}`
    } catch (e) { pipelineErr = `transcribe threw: ${e.message}` }
  }
  if (item.cancelled) return
  // Layer 3: AI scratch-take detection. Runs AFTER transcribe (needs the
  // transcript) but BEFORE identify-actor + describe so flagged rows
  // don't burn budget on naming pipelines they don't need. Best-effort:
  // if the function isn't deployed yet or errors, we just skip and let
  // the human triage queue handle it. Skipped on images (Claude has no
  // good signal from a visual_description alone for "is this scratch").
  if (isVideo) {
    update({ status: 'triaging', message: 'reviewing for scratch take' })
    try {
      const { data, error } = await supabase.functions.invoke('triage-detect-bad-take', {
        body: { library_ids: [libraryId] },
      })
      if (error) {
        // Function not deployed yet OR runtime error — non-fatal.
        pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `triage: ${error.message}`
      } else if (data?.rows?.[0]?.bad) {
        // AI flagged this as a bad take. Surface to the queue item AND
        // skip the rest of the pipeline (identify-actor + describe) since
        // the row is now hidden from the editor library.
        update({
          status: 'done', progress: 1,
          message: `done · AI flagged as bad take (${data.rows[0].reason || 'no reason'})`,
        })
        return
      }
    } catch (e) {
      pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `triage threw: ${e.message}`
    }
  }
  if (item.cancelled) return
  update({ status: 'identifying', message: 'identifying actor' })
  try {
    const { data, error } = await supabase.functions.invoke('identify-actor', {
      body: { library_ids: [libraryId] },
    })
    if (error) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id: ${error.message}`
    else if (data?.errors?.length > 0) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id: ${data.errors[0].error || 'unknown'}`
  } catch (e) { pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id threw: ${e.message}` }
  if (item.cancelled) return
  update({ status: 'describing', message: 'naming' })
  try {
    const { data, error } = await supabase.functions.invoke('creative-library-describe', {
      body: { library_ids: [libraryId] },
    })
    if (error) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe: ${error.message}`
    else if (data?.errors?.length > 0) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe: ${data.errors[0].error || 'unknown'}`
  } catch (e) { pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe threw: ${e.message}` }
  if (item.cancelled) return

  update({
    status: 'done',
    progress: 1,
    message: pipelineErr ? `done · ${pipelineErr}` : 'done',
    error: pipelineErr,
  })
}

/* React hook: subscribe a component to the queue. Re-renders on any
   item-level change. Returns the current snapshot. */
function useUploadQueue() {
  const [items, setItems] = useState(() => [...uploadQueue.items])
  useEffect(() => uploadQueue.subscribe(setItems), [])
  return items
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
            ? '3px solid #b53e3e'
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
            background: failed.length > 0 ? '#b53e3e' : 'var(--ink)',
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
                  background: 'transparent', border: '1px solid #b53e3e', padding: '4px 8px',
                  fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', color: '#b53e3e',
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
            const color = isErr ? '#b53e3e' : isDone ? '#3e8a5e' : 'var(--ink-3)'
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
                        cursor: 'pointer', color: '#b53e3e', padding: '2px 6px',
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

/* Thin progress bar pinned to the very top of the viewport while there's
   at least one upload in flight. Mirrors the YouTube/GitHub pattern —
   ambient signal that "something is uploading" without taking up real
   estate. Aggregate progress across the whole queue. Mounted via portal
   so it sits above the app's sticky header / sidebar / modals at z-index
   9999 but doesn't intercept clicks (pointer-events: none).

   Disappears the instant the queue drains (or is cancelled). The
   floating UploadDock owns the per-file detail; this is just the
   peripheral-vision indicator. */
function TopUploadProgressBar() {
  const items = useUploadQueue()
  const inFlight = items.filter((i) => i.status !== 'done' && i.status !== 'error' && i.status !== 'too-large')
  if (inFlight.length === 0) return null
  const failed = items.filter((i) => i.status === 'error').length
  // Average progress across every item currently in the dock, not just
  // the in-flight ones — so the bar advances smoothly as items finish
  // rather than snapping back to 0% when the next file starts.
  const totalProg = items.length > 0
    ? items.reduce((s, i) => s + (i.progress || 0), 0) / items.length
    : 0
  return createPortal(
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 3,
        zIndex: 9999, pointerEvents: 'none',
        background: 'transparent',
      }}
      aria-hidden="true"
    >
      <div
        style={{
          height: '100%',
          width: `${Math.max(2, Math.round(totalProg * 100))}%`,
          background: failed > 0 ? '#b53e3e' : 'var(--accent, #e8b408)',
          transition: 'width 0.25s ease',
          boxShadow: '0 0 6px rgba(232,180,8,0.6)',
        }}
      />
    </div>,
    document.body,
  )
}

/* Bulk admin action: re-fire identify-actor + describe on every row in
   the current library list that's missing a canonical_name. Surfaces the
   most common upload failure mode — the rename pipeline silently skipped
   because transcribe + actor-id both came back empty — and gives the
   operator a one-click way to retry.

   Runs in batches of 10 to stay under the Edge Function CPU budget +
   not hammer Anthropic rate limits. Progress shown inline on the button. */
function RenameUnnamedButton({ rows, onComplete }) {
  const unnamed = (rows || []).filter(r => !r.canonical_name)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  if (unnamed.length === 0) return null
  const run = async () => {
    if (busy) return
    setBusy(true)
    setProgress({ done: 0, total: unnamed.length, errors: 0 })
    const BATCH = 10
    for (let i = 0; i < unnamed.length; i += BATCH) {
      const slice = unnamed.slice(i, i + BATCH).map(r => r.id)
      try {
        // Re-fire identify-actor first so any visual_description that
        // never landed gets populated. Then describe — which needs
        // EITHER transcript OR visual_description to produce a name.
        await supabase.functions.invoke('identify-actor', { body: { library_ids: slice } })
        const { data } = await supabase.functions.invoke('creative-library-describe', { body: { library_ids: slice } })
        const errCount = (data?.errors?.length || 0)
        setProgress(p => ({ done: Math.min((p?.done || 0) + slice.length, unnamed.length), total: unnamed.length, errors: (p?.errors || 0) + errCount }))
      } catch (e) {
        setProgress(p => ({ done: (p?.done || 0) + slice.length, total: unnamed.length, errors: (p?.errors || 0) + slice.length }))
      }
    }
    setBusy(false)
    onComplete?.()
    // Leave the final count visible briefly so the operator sees the
    // result, then clear so the button reverts to its default label.
    setTimeout(() => setProgress(null), 4000)
  }
  return (
    <button
      onClick={run}
      disabled={busy}
      title={`Re-fire AI naming on ${unnamed.length} clip${unnamed.length === 1 ? '' : 's'} that never got a canonical name`}
      style={{
        padding: '6px 10px',
        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: busy ? 'var(--paper-2)' : 'white',
        color: busy ? 'var(--ink-3)' : '#a86a08',
        border: '1px solid ' + (busy ? 'var(--rule)' : '#e8b408'),
        borderRadius: 2,
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      {busy && progress
        ? `Renaming ${progress.done}/${progress.total}${progress.errors > 0 ? ` · ${progress.errors} err` : ''}…`
        : progress && !busy
          ? `Done · ${progress.done - progress.errors}/${progress.total} renamed`
          : `Re-name ${unnamed.length} unnamed`}
    </button>
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
          border: '1px solid rgba(232,180,8,0.45)', borderRadius: 2,
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
        border: '1px solid rgba(181,62,62,0.4)', borderRadius: 2,
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
            background: '#b53e3e', color: 'white',
            border: 'none', borderRadius: 2,
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
    new_upload_needs_assignment: { label: 'Needs editor',   color: '#b53e3e' },
    ingest_failed:               { label: 'Ingest failed',  color: '#b53e3e' },
    revision_requested:          { label: 'Revision asked', color: '#d09c08' },
    submission_comment:          { label: 'New comment',    color: '#3e7eba' },
    feedback:                    { label: 'Feedback',       color: '#e8b408' },
    assignment:                  { label: 'New tasks',      color: '#3e7eba' },
    reassignment:                { label: 'Reassigned',     color: '#3e7eba' },
    source_replaced:             { label: 'Source updated', color: '#a05810' },
    approved:                    { label: 'Approved',       color: '#3e8a5e' },
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
          height: 38, padding: '0 14px', borderRadius: 2,
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
            background: '#b53e3e', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            padding: '0 5px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}>{unseenCount > 99 ? '99+' : unseenCount}</span>
        )}
      </button>
      {/* Centered Modal popup — replaces the right-side slide drawer
          (per Ben 2026-05-31 + 2026-05-18 design preference logged in
          Modal.jsx). No overlap with page content; backdrop click + Esc
          to close, same as every other modal in the codebase. */}
      <Modal open={open} onClose={() => setOpen(false)} size="sm"
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
                        display: 'block', width: '100%',
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
  border: '1px solid var(--rule)', borderRadius: 2,
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
          height: 38, padding: '0 14px', borderRadius: 2,
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
            background: '#b53e3e', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            padding: '0 5px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}>{unseenCount > 99 ? '99+' : unseenCount}</span>
        )}
      </button>
      {/* Centered Modal popup — replaces the right-side slide drawer
          (Ben 2026-05-31 + earlier 2026-05-18 design preference). */}
      <Modal open={open} onClose={() => setOpen(false)} size="lg"
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
                  borderRadius: 2,
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
            fontFamily: 'var(--serif)', fontStyle: 'italic',
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
                        borderLeft: '3px solid ' + (s.approved_at ? '#3e8a5e' : '#3e7eba'),
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
                            padding: '1px 5px', background: 'var(--ink-3)', color: 'white',
                            borderRadius: 2, fontSize: 9, fontWeight: 700,
                          }}>v{s.version_number}</span>
                          <span style={{ fontWeight: 600, fontSize: 10.5, color: 'var(--ink-2)' }}>{s.submitted_by_name || 'Unknown'}</span>
                          <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>· {relTime(s.created_at)}</span>
                          {creativeCreator && (
                            <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>· {creativeCreator}</span>
                          )}
                          {isNew && (
                            <span style={{
                              padding: '1px 5px', background: '#3e7eba', color: 'white',
                              borderRadius: 2, fontSize: 9, fontWeight: 700,
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
                            color: s.approved_at ? '#3e8a5e' : '#3e7eba',
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

/* OPT-branded video player. Replaces the native <video controls> on
   the review surface so we can:
   - Put comment markers ON the actual scrubber (not a separate strip
     below the video). The native controls bar wouldn't expose its
     DOM, so we built our own.
   - Apply the editorial design language consistently (yellow accent,
     mono labels, paper-on-black) instead of whatever the browser
     decided to ship.
   - Add Frame.io-style affordances: click anywhere on the scrubber to
     seek, hover the scrubber to preview a time, click a marker to
     jump to that comment's timestamp.

   Public API: pass `src`, an array of `markers` ({ id, ts, color,
   title }), and an `onSeek(seconds)` callback. The player owns its
   <video> ref and surfaces play state + currentTime upward via
   `onState` so the parent's comment composer can stamp "comment at
   N:NN" using the live time.

   Keyboard: space = play/pause, ← / → = ±5s, F = fullscreen. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

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
// Per-row lowercased search text, keyed by row object identity (see the
// filter pipeline for why this must NOT live as a property on the row).
const SEARCH_BLOBS = new WeakMap()

const OPT_PLAYER_WRAP_360 = { height: 360, maxHeight: 'min(56vh, 360px)' }
const OPT_PLAYER_WRAP_320 = { height: 300, maxHeight: 'min(48vh, 320px)' }

// memo-wrapped so SubmissionPreviewModal's 1Hz state ticks don't cascade
// into a player re-render unless an actual prop changes (markers,
// hoveredMarkerId, etc.). All callbacks passed by the parent are
// useCallback-stable; markers is useMemo-stable. Together they let the
// player stay completely idle during normal playback.
const OptVideoPlayer = memo(forwardRef(function OptVideoPlayer(
  { src, markers = [], onSeek, onState, hoveredMarkerId, onMarkerHoverChange,
    // `compact` switches the player into inline-card mode: no min-height
    // floor, no autoplay (so expanding multiple version cards doesn't
    // dogpile audio), smaller play overlay + tighter controls. Used by
    // SubmissionsPanel so the inline player has the exact same OPT
    // chrome as the Review modal (Ben 2026-06-01: "needs to be pretty
    // congruent across the board").
    compact = false,
    // Outer wrapper styles — lets the caller cap maxHeight in compact
    // mode so the player doesn't push the surrounding card off-screen.
    wrapperStyle,
    autoPlay,
  },
  parentRef,
) {
  const videoRef = useRef(null)
  const wrapRef = useRef(null)
  const scrubberRef = useRef(null)
  // Refs for direct DOM updates on the scrubber + time display. The
  // previous implementation kept currentTime/buffered in React state and
  // setState'd on every video tick (4-30Hz depending on the browser),
  // which re-rendered the whole player tree — markers, tooltips,
  // controls bar — every tick. With ~10 comment markers + a memoized
  // SubmissionPreviewModal still subscribing via onState, the combined
  // cost made the player feel sluggish from the moment the modal opened
  // (Ben 2026-06-01: "everything now is very, very slow, so please
  // review this in depth"). Now: timeupdate writes width/left/textContent
  // directly to these DOM nodes and React never reconciles for time
  // progression. Marker positions depend on duration (not currentTime)
  // so they're stable across ticks.
  const progressFillRef = useRef(null)
  const bufferedFillRef = useRef(null)
  const playheadRef = useRef(null)
  const timeDisplayRef = useRef(null)
  const currentTimeRef = useRef(0)
  const bufferedRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  // Volume 0..1. Stored separately from `muted` so the user can mute
  // (drop audio to 0) and then unmute back to the same level without
  // the slider snapping to 100%. Mirrors the YouTube/Vimeo pattern.
  const [volume, setVolume] = useState(1)
  const [duration, setDuration] = useState(0)
  const [hoverPct, setHoverPct] = useState(null)  // 0..1
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Local marker-hover state — used to show a styled tooltip near the
  // marker. Separate from onMarkerHoverChange because the parent might
  // not care, but the player still wants to render the tooltip.
  const [localHoverMarkerId, setLocalHoverMarkerId] = useState(null)
  // External hover (from the sidebar pointing at this marker) takes
  // precedence over local hover so the marker pulses even without
  // direct mouse-over.
  const effectiveHoverId = hoveredMarkerId ?? localHoverMarkerId

  // Expose play/pause/seek to parent (used by comment markers in the
  // sidebar — clicking a comment seeks the video).
  useImperativeHandle(parentRef, () => ({
    seekTo: (seconds) => {
      const v = videoRef.current
      if (!v) return
      try { v.currentTime = Math.max(0, Math.min(seconds, v.duration || seconds)) } catch {}
      try { v.play() } catch {}
    },
    play: () => { try { videoRef.current?.play() } catch {} },
    pause: () => { try { videoRef.current?.pause() } catch {} },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  }), [])

  // Push state up to parent. currentTime is NOT pushed on every tick —
  // the parent only needs it to label the "+ Comment at X:XX" button,
  // which can read live time from playerRef.current.getCurrentTime() at
  // click time (and already does — line 2804). We push at 1Hz while
  // playing so any UI that DOES want to display live time can; the
  // button label refreshes once per second which matches the visible
  // resolution of fmtTime anyway. Pushes on play/pause/duration changes
  // happen immediately via the second effect.
  useEffect(() => {
    if (typeof onState !== 'function' || !playing) return
    const i = setInterval(() => {
      onState({
        currentTime: videoRef.current?.currentTime ?? 0,
        duration,
        playing: true,
      })
    }, 1000)
    return () => clearInterval(i)
  }, [playing, duration, onState])
  useEffect(() => {
    if (typeof onState === 'function') {
      onState({ currentTime: videoRef.current?.currentTime ?? 0, duration, playing })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration])

  // Direct-DOM timeupdate handler — replaces setCurrentTime/setBuffered.
  // Reads videoRef once per tick, writes style.width / style.left /
  // textContent directly. No React reconciliation.
  const onVideoTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime
    currentTimeRef.current = t
    const d = v.duration && isFinite(v.duration) ? v.duration : duration
    if (d > 0) {
      const pct = (t / d) * 100
      if (progressFillRef.current) progressFillRef.current.style.width = `${pct}%`
      if (playheadRef.current) playheadRef.current.style.left = `${pct}%`
    }
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = `${fmtTime(t)} / ${fmtTime(d)}`
    }
    const b = v.buffered
    if (b && b.length > 0) {
      const bEnd = b.end(b.length - 1)
      bufferedRef.current = bEnd
      if (d > 0 && bufferedFillRef.current) {
        bufferedFillRef.current.style.width = `${Math.min(100, (bEnd / d) * 100)}%`
      }
    }
  }, [duration])

  // Teardown — same cleanup pattern as the rest of the codebase.
  useEffect(() => {
    if (!src) return
    const v = videoRef.current
    return () => {
      if (!v) return
      try { v.pause() } catch {}
      try { v.removeAttribute('src'); v.load() } catch {}
    }
  }, [src])

  // Keyboard shortcuts. Modal-only — when multiple compact inline
  // players are mounted in a SubmissionsPanel (one per expanded
  // version card), a single window-level keydown would dispatch to
  // all of them, e.g. spacebar would play/pause every video at once.
  // The modal is the only context where there's a single, focused
  // player that owns the keyboard.
  useEffect(() => {
    if (compact) return
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const v = videoRef.current
      if (!v) return
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault()
        v.paused ? v.play() : v.pause()
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - (e.key === 'j' ? 10 : 5))
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        e.preventDefault()
        v.currentTime = Math.min(v.duration || 0, v.currentTime + (e.key === 'l' ? 10 : 5))
      } else if (e.key === 'f') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === 'm') {
        e.preventDefault()
        v.muted = !v.muted
        setMuted(v.muted)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact])

  // Fullscreen state sync — the browser can leave fullscreen on Esc
  // without us telling it to, so we need to listen for the change event.
  // Document-level events fire for ANY element entering/exiting
  // fullscreen, including OTHER OptVideoPlayer instances mounted in
  // the same SubmissionsPanel. Without the wrapRef containment check,
  // player A entering fullscreen would flip isFullscreen=true on
  // players B/C/D too (code-review P1, 2026-06-01). Now each player
  // only flips its own state when ITS wrapper is the fullscreen
  // element (or when leaving fullscreen entirely).
  useEffect(() => {
    const onFs = () => {
      const fsEl = document.fullscreenElement
      const isOurs = fsEl === wrapRef.current
      // Update only if this changes OUR state — either we're now
      // fullscreen (fsEl === our wrap) or we're not (anything else).
      setIsFullscreen(prev => isOurs !== prev ? isOurs : prev)
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) {
      try { document.exitFullscreen() } catch {}
    } else {
      try { el.requestFullscreen() } catch {}
    }
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.paused ? v.play() : v.pause()
  }, [])

  // Scrubber interactions. We use pointer events so a click-drag on
  // the bar scrubs smoothly. The scrubber has a generous hit area
  // (12px) but renders as a 4px bar with a 12px thumb on hover.
  const scrubberToSeconds = useCallback((clientX) => {
    const el = scrubberRef.current
    if (!el || !duration) return 0
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return pct * duration
  }, [duration])

  const onScrubberPointerDown = useCallback((e) => {
    e.preventDefault()
    const v = videoRef.current
    if (!v) return
    v.currentTime = scrubberToSeconds(e.clientX)
    const move = (ev) => { v.currentTime = scrubberToSeconds(ev.clientX) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [scrubberToSeconds])

  const onScrubberPointerMove = useCallback((e) => {
    const el = scrubberRef.current
    if (!el || !duration) { setHoverPct(null); return }
    const rect = el.getBoundingClientRect()
    setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }, [duration])

  const onMarkerClick = useCallback((e, marker) => {
    e.stopPropagation()
    if (marker.ts == null) return
    const v = videoRef.current
    if (!v) return
    try { v.currentTime = marker.ts; v.play() } catch {}
    onSeek?.(marker.ts)
  }, [onSeek])

  return (
    <div ref={wrapRef} className="opt-player"
      style={{
        position: 'relative', width: '100%',
        // Hard ceiling so vertical (9:16) submissions can never blow
        // past the viewport even if a caller forgets to pass a
        // height-capped wrapperStyle. Individual call sites can
        // override via wrapperStyle.maxHeight if they want larger.
        maxHeight: 'min(60vh, 520px)',
        background: '#000', color: 'white',
        display: 'flex', flexDirection: 'column',
        userSelect: 'none',
        ...wrapperStyle,
      }}>
      {/* Video element with native controls killed. Click toggles
          play/pause; double-click toggles fullscreen. The video FILLS
          the container with object-fit: contain — vertical (9:16)
          videos pillar-box with black bars on the sides, square (1:1)
          videos pillar-box less, horizontal (16:9) fills edge-to-edge.
          Container is flex-grow so it eats every spare vertical pixel
          inside the modal — that's what keeps the player size
          consistent regardless of source aspect ratio (Ben 2026-06-01:
          "make sure that if I'm doing it in a short form, like 9:16,
          it is still going to keep the current size that it has and
          the bars will just be black"). In compact mode (inline card)
          we drop the 400px floor so the player can be ~240px tall
          inside an EditTaskModal submission card. */}
      <div style={{
        flex: '1 1 auto', minHeight: compact ? 0 : 400, position: 'relative',
        background: '#000', display: 'flex',
        justifyContent: 'center', alignItems: 'center',
        overflow: 'hidden',
      }}>
        {src ? (
          <video ref={videoRef} src={src} preload="metadata"
            autoPlay={autoPlay !== undefined ? autoPlay : !compact}
            playsInline
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => { try { if (videoRef.current) videoRef.current.dataset.buffering = '1' } catch {} }}
            onCanPlay={() => { try { if (videoRef.current) videoRef.current.dataset.buffering = '0' } catch {} }}
            onLoadedMetadata={() => {
              const v = videoRef.current
              if (v && isFinite(v.duration)) setDuration(v.duration)
              if (v) {
                setMuted(v.muted)
                setVolume(v.volume)
              }
            }}
            onTimeUpdate={onVideoTimeUpdate}
            onVolumeChange={() => {
              const v = videoRef.current
              if (!v) return
              setMuted(v.muted)
              setVolume(v.volume)
            }}
            onRateChange={() => setPlaybackRate(videoRef.current?.playbackRate ?? 1)}
            style={{
              width: '100%', height: '100%',
              objectFit: 'contain',
              display: 'block', cursor: 'pointer',
              background: '#000',
            }} />
        ) : (
          <div style={{
            padding: 60, fontFamily: 'var(--mono)', fontSize: 12,
            color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}>No playable file</div>
        )}
        {/* Center play button overlay when paused */}
        {src && !playing && (
          <button onClick={togglePlay} aria-label="Play"
            style={{
              position: 'absolute', inset: 0, margin: 'auto',
              width: compact ? 52 : 76, height: compact ? 52 : 76, borderRadius: '50%',
              background: 'rgba(244,225,74,0.92)',
              border: 'none', cursor: 'pointer',
              color: '#0a0a0a', fontSize: compact ? 20 : 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}>▶</button>
        )}
      </div>

      {/* Custom controls bar */}
      <div style={{
        background: 'rgba(10,10,10,0.95)', padding: '8px 14px 10px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {/* Scrubber row */}
        <div
          ref={scrubberRef}
          onPointerDown={onScrubberPointerDown}
          onPointerMove={onScrubberPointerMove}
          onPointerLeave={() => setHoverPct(null)}
          style={{
            position: 'relative', height: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center',
          }}>
          {/* Track (background) */}
          <div style={{
            position: 'absolute', left: 0, right: 0, height: 4,
            background: 'rgba(255,255,255,0.15)', borderRadius: 2,
          }} />
          {/* Buffered range — width driven by onVideoTimeUpdate via ref */}
          <div ref={bufferedFillRef} style={{
            position: 'absolute', left: 0, width: '0%',
            height: 4, background: 'rgba(255,255,255,0.35)',
            borderRadius: 2,
          }} />
          {/* Progress fill — width driven by onVideoTimeUpdate via ref */}
          <div ref={progressFillRef} style={{
            position: 'absolute', left: 0, width: '0%',
            height: 4, background: '#f4e14a', borderRadius: 2,
          }} />
          {/* Hover preview marker */}
          {hoverPct != null && (
            <>
              <div style={{
                position: 'absolute', left: `${hoverPct * 100}%`,
                top: -22, transform: 'translateX(-50%)',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                background: 'rgba(0,0,0,0.85)', color: 'white',
                padding: '2px 6px', borderRadius: 2, whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}>{fmtTime(hoverPct * duration)}</div>
              <div style={{
                position: 'absolute', left: `${hoverPct * 100}%`,
                top: 0, height: 4,
                width: 1, background: 'rgba(255,255,255,0.4)',
                pointerEvents: 'none',
              }} />
            </>
          )}
          {/* Comment markers on the scrubber itself — the killer feature
              over the previous below-video strip. Hover scales the marker
              up and shows a styled tooltip above with author + preview. */}
          {markers.filter(m => m.ts != null && duration > 0).map(m => {
            const left = (m.ts / duration) * 100
            const color = m.color || '#f4e14a'
            const isHovered = effectiveHoverId === m.id
            return (
              <div key={m.id}
                onClick={(e) => onMarkerClick(e, m)}
                onMouseEnter={() => {
                  setLocalHoverMarkerId(m.id)
                  onMarkerHoverChange?.(m.id)
                }}
                onMouseLeave={() => {
                  setLocalHoverMarkerId(null)
                  onMarkerHoverChange?.(null)
                }}
                style={{
                  position: 'absolute', left: `${left}%`,
                  top: isHovered ? -6 : -4, transform: 'translateX(-50%)',
                  width: isHovered ? 16 : 12,
                  height: isHovered ? 16 : 12,
                  borderRadius: '50%',
                  background: color, border: '2px solid #0a0a0a',
                  cursor: 'pointer', zIndex: 2,
                  boxShadow: isHovered
                    ? '0 0 0 4px rgba(244,225,74,0.25), 0 1px 3px rgba(0,0,0,0.5)'
                    : '0 1px 3px rgba(0,0,0,0.5)',
                  transition: 'all 120ms ease',
                }} />
            )
          })}
          {/* Custom marker tooltip — replaces the native title attr
              (which has 1+ second delay and unstyled). Renders above
              the scrubber when a marker is being hovered (locally OR
              via the sidebar). Pointer-events: none so it never
              blocks marker clicks. */}
          {effectiveHoverId != null && (() => {
            const m = markers.find(x => x.id === effectiveHoverId)
            if (!m || m.ts == null || duration <= 0) return null
            const left = Math.max(8, Math.min(92, (m.ts / duration) * 100))
            return (
              <div style={{
                position: 'absolute', left: `${left}%`,
                bottom: 22, transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.92)',
                color: 'white', padding: '8px 10px',
                fontFamily: 'var(--sans)', fontSize: 12,
                maxWidth: 280, minWidth: 160,
                lineHeight: 1.4, pointerEvents: 'none',
                border: '1px solid rgba(244,225,74,0.4)',
                boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
                zIndex: 5,
                animation: 'optTooltipIn 80ms ease-out',
              }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: '#f4e14a', marginBottom: 4,
                }}>{m.authorName ? `${m.authorName} · ${fmtTime(m.ts)}` : fmtTime(m.ts)}</div>
                <div style={{
                  whiteSpace: 'normal', wordBreak: 'break-word',
                  maxHeight: 80, overflow: 'hidden',
                }}>{(m.title || '').slice(0, 240)}</div>
              </div>
            )
          })()}
          {/* Playhead thumb — left driven by onVideoTimeUpdate via ref */}
          <div ref={playheadRef} style={{
            position: 'absolute', left: '0%',
            width: 12, height: 12, borderRadius: '50%',
            background: '#f4e14a', transform: 'translateX(-50%)',
            boxShadow: '0 2px 6px rgba(244,225,74,0.5)',
            pointerEvents: 'none',
          }} />
        </div>

        {/* Buttons row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: 'var(--mono)', fontSize: 11,
        }}>
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'white', fontSize: 16, padding: '0 2px',
              minWidth: 18,
            }}>{playing ? '⏸' : '▶'}</button>
          {/* Mute + volume slider — clicking the speaker toggles mute
              while preserving the slider's last value (YouTube-style).
              Dragging the slider sets volume, auto-unmutes when the
              user nudges it above 0, auto-mutes at exactly 0. Speaker
              icon reflects level so the visual matches the audio. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => {
                const v = videoRef.current
                if (!v) return
                // Silent-unmute guard: if the slider was dragged to 0
                // (which auto-mutes), clicking the speaker would
                // otherwise unmute a volume=0 track — visually
                // appears playing but no sound (code-review P0,
                // 2026-06-01). When unmuting from volume=0, bump
                // back to 0.5 so the user actually hears audio.
                if (v.muted && v.volume === 0) {
                  v.volume = 0.5
                  setVolume(0.5)
                }
                v.muted = !v.muted
                setMuted(v.muted)
              }}
              aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'white', fontSize: 14, padding: '0 2px',
                minWidth: 18,
              }}>{muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}</button>
            <input
              type="range" min="0" max="1" step="0.01"
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = videoRef.current
                if (!v) return
                const newVol = parseFloat(e.target.value)
                v.volume = newVol
                v.muted = newVol === 0
                // onVolumeChange handler syncs state, but set explicitly
                // here too so the slider stays in sync even if the
                // browser doesn't fire the event (some Safari versions).
                setVolume(newVol)
                setMuted(newVol === 0)
              }}
              aria-label="Volume"
              style={{
                width: compact ? 56 : 72,
                accentColor: '#f4e14a',
                cursor: 'pointer',
                verticalAlign: 'middle',
              }}
            />
          </div>
          {/* Read currentTime from ref so re-renders (play/pause/hover)
              don't clobber the live textContent written by
              onVideoTimeUpdate. Ref read at render time → React writes
              the latest known time; next tick writes the next. They
              converge without flashing back to 0:00. */}
          <span ref={timeDisplayRef}
            style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
            {fmtTime(currentTimeRef.current)} / {fmtTime(duration)}
          </span>
          <span style={{ flex: 1 }} />
          {/* Playback rate — custom popup. Native <select> renders OS-
              level dropdowns we can't style, which gave a white-on-white
              option list in dark mode and unreadable contrast (Ben
              2026-06-01). */}
          <OptSpeedMenu value={playbackRate} onChange={(r) => {
            const v = videoRef.current
            if (v) { v.playbackRate = r; setPlaybackRate(r) }
          }} />
          <button onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title="F — fullscreen"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'white', fontSize: 14, padding: '0 4px',
              minWidth: 18,
            }}>{isFullscreen ? '⤡' : '⛶'}</button>
        </div>
      </div>
      <style>{`
        @keyframes optTooltipIn {
          from { opacity: 0; transform: translate(-50%, 4px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes optSlideInUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes optPulse {
          0%   { box-shadow: 0 0 0 0 rgba(244,225,74,0.5); }
          70%  { box-shadow: 0 0 0 8px rgba(244,225,74,0); }
          100% { box-shadow: 0 0 0 0 rgba(244,225,74,0); }
        }
      `}</style>
    </div>
  )
}))

// Custom playback-speed picker. Renders the current speed as a small
// pill; click opens a styled popup with the rate options. Replaces the
// native <select> which had OS-default styling we couldn't override.
function OptSpeedMenu({ value, onChange }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          background: 'rgba(255,255,255,0.1)', color: 'white',
          border: '1px solid rgba(255,255,255,0.18)',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
          padding: '3px 9px', cursor: 'pointer', outline: 'none',
          letterSpacing: '0.04em', minWidth: 38,
          transition: 'background 120ms ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}>
        {value}×
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
          <div style={{
            position: 'absolute', right: 0, bottom: 'calc(100% + 6px)',
            background: 'rgba(15,15,15,0.97)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column',
            minWidth: 70, zIndex: 101,
            animation: 'optSlideInUp 100ms ease-out',
          }}>
            {PLAYBACK_RATES.map(r => {
              const active = r === value
              return (
                <button key={r}
                  onClick={() => { onChange(r); setOpen(false) }}
                  style={{
                    background: active ? '#f4e14a' : 'transparent',
                    color: active ? '#0a0a0a' : 'white',
                    border: 'none',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                    padding: '7px 12px', cursor: 'pointer',
                    textAlign: 'right',
                    letterSpacing: '0.04em',
                  }}
                  onMouseEnter={e => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  }}
                  onMouseLeave={e => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}>
                  {r}×
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// Format seconds as M:SS or H:MM:SS.
function fmtTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return '0:00'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

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
  const url = submission.file_url
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
    <Modal open={!!submission} onClose={onClose} size="full"
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
          <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
            <OptVideoPlayer ref={playerRef}
              src={url}
              markers={playerMarkers}
              onState={onPlayerState}
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
                fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 14,
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
                        background: 'white', border: '1px solid var(--rule)',
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
            color: '#3e8a5e',
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
              background: parentBusy ? 'var(--ink-4)' : '#3e8a5e',
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
              background: 'white', border: '1px solid var(--rule)',
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
            : comment.resolved_at ? '#3e8a5e' : '#3e7eba'
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
            color: comment.author_kind === 'admin' ? '#2f5a8a' : '#3e8a5e',
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
                  color: r.author_kind === 'admin' ? '#2f5a8a' : '#3e8a5e',
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
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: comment.resolved_at ? '#b8893e' : '#3e8a5e' }}>
            {comment.resolved_at ? 'Re-open' : 'Resolve'}
          </button>
        )}
        {isAuthor && (
          <button onClick={() => { if (confirm('Delete this comment?')) onDelete?.(comment) }}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: '#b53e3e', marginLeft: 'auto' }}>Delete</button>
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

// Soft full-row background tint for library / queue rows so Ben can
// scan status at a glance:
//   green  = edited (creative is done)
//   yellow = raw + assigned to an editor (work in progress)
//   red    = raw + unassigned + still needs editing (i.e. not auto-used Hooks)
function rowStatusTint(r, isUsed) {
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
function rowStatusTintForTask(t) {
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
const PAGE_CACHE = {
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
const ADMIN_SCOPE = {
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

export default function AdsCreativeLibrary({ editorScope }) {
  const scope = editorScope || ADMIN_SCOPE
  // In editor-view mode, default to the Editing Queue tab since that's why
  // they came (to see their assignments). Admins land on Library.
  // Ben (2026-06-10) cut the Triage and Launch queue views to de-clutter —
  // two sub-views only, so a saved 'triage'/'launch' from before the cut
  // falls back to the default.
  const [tab, setTab] = useState(() => {
    const fallback = scope.isEditorView ? 'queue' : 'library'
    try {
      const saved = localStorage.getItem('lib.tab')
      return (saved === 'library' || saved === 'queue') ? saved : fallback
    } catch { return fallback }
  })
  useEffect(() => { try { localStorage.setItem('lib.tab', tab) } catch {} }, [tab])

  return (
    <div style={{ padding: '12px 0 60px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
        }}>
          {scope.isEditorView ? 'Editor portal · ' : ''}{tab === 'library' ? 'Library' : 'Editing queue'}
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
          <TabBtn active={tab === 'library'} onClick={() => setTab('library')}>Library</TabBtn>
          <TabBtn active={tab === 'queue'}   onClick={() => setTab('queue')}>Editing queue</TabBtn>
        </div>
      </div>

      {/* Both tabs stay mounted — toggle visibility instead of mount/unmount.
          Why: unmounting a tab destroys all of its state (filters, scroll
          position, expanded rows, in-flight fetches) and the next switch
          back has to re-mount and re-fetch from scratch. With 200+ library
          rows + a dozen useMemo computations, that re-mount alone is ~400ms
          of paint time. Keeping both mounted means switching is a
          near-instant visibility flip and the user's filters survive. */}
      <div style={{ display: tab === 'library' ? 'block' : 'none' }}>
        <LibraryTab scope={scope} />
      </div>
      <div style={{ display: tab === 'queue' ? 'block' : 'none' }}>
        <EditingQueueTab scope={scope} />
      </div>
    </div>
  )
}

// badgeTone='alert' (default) = red — for "needs action" counts like
// untriaged uploads. badgeTone='ready' = yellow — for "ready to ship"
// counts where the number being big is a positive signal of inventory.
function TabBtn({ active, onClick, children, badge, badgeTone = 'alert' }) {
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

function LibraryTab({ scope = ADMIN_SCOPE, pendingOpen = null }) {
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
  const hasFolders = folders.length > 0
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
  const LIB_LEAN_COLS = 'id,name,canonical_name,description,type,creator,status,offer_slug,has_been_run,manually_marked_used,assigned_editor_id,parent_id,version_number,thumbnail_url,preview_url,drive_url,size_mb,duration_seconds,v21_script_id,derived_hook_id,derived_body_id,derivation_score,stage_rough_cut,stage_final_cut,stage_approved,stage_delivered,rough_cut_url,final_cut_url,approved_url,delivered_url,exclude_from_library,added_at,updated_at,notes,priority,source_bucket,drive_id,is_low_quality,low_quality_reason,low_quality_actual_mb,is_bad_take,bad_take_reason,folder_id'

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


  const filtered = useMemo(() => {
    let list = rows
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
    const rawQueueView = stageFilter.size === 1 && stageFilter.has('raw_unused')
    if (!search) {
      if (folderId) list = list.filter(r => r.folder_id === folderId)
      else if (hasFolders && !rawQueueView) list = list.filter(r => !r.folder_id)
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
    if (stageFilter.size > 0) {
      list = list.filter(r => {
        if (stageFilter.has('raw_used') && r.status === 'raw' && usedRawIds.has(r.id)) return true
        // raw_unused must mirror the banner exactly: raw + not yet used + no editor + not Testimony.
        // Without the editor/Testimony checks, the "Filter to these →" view showed rows the operator
        // had already assigned (Mohamed/Ahmed/Dean in the wild), which defeated the whole banner.
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
  }, [rows, deferredQ, typeFilter, offerFilter, runFilter, stageFilter, hideLowQuality, hideBadTakes, sortKey, sortDir, usedRawIds, folderId, hasFolders])

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
  const visibleRows = useMemo(
    () => rows.filter(r => !r.is_low_quality && !r.is_bad_take),
    [rows],
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

  const runCount    = useMemo(() => visibleRows.filter(r => r.has_been_run).length, [visibleRows])
  const notRunCount = useMemo(() => visibleRows.filter(r => !r.has_been_run).length, [visibleRows])
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
    raw_used:   visibleRows.filter(r => r.status === 'raw' && usedRawIds.has(r.id)).length,
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
    stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size

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
              background: 'white', border: '1px solid var(--rule)', outline: 'none',
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
                border: '1.5px solid #d68f00', borderRadius: 2, cursor: 'pointer',
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
              background: filtersOpen || activeFilterCount > 0 ? 'var(--ink)' : 'white',
              color: filtersOpen || activeFilterCount > 0 ? 'var(--paper)' : 'var(--ink)',
              border: '1px solid ' + (filtersOpen || activeFilterCount > 0 ? 'var(--ink)' : 'var(--rule)'),
              cursor: 'pointer',
            }}>
            Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''} {filtersOpen ? '▴' : '▾'}
          </button>
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
            <ViewBtn active={view === 'tile'}   onClick={() => setView('tile')}>Tiles</ViewBtn>
            <ViewBtn active={view === 'list'}   onClick={() => setView('list')}>List</ViewBtn>
            <ViewBtn active={view === 'matrix'} onClick={() => setView('matrix')}>Matrix</ViewBtn>
          </div>
          {scope.canUpload && (
            <button onClick={() => setUploadOpen(true)} style={primaryBtn}>
              + Upload creative
            </button>
          )}
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
              // Three states matching Ben's mental model:
              //   RAW         = needs editing (not used in any composite yet)
              //   EDITED RAW  = raw clip already merged into a composite
              //   EDITED      = a finished cut (status='edited' in the DB)
              // The filter matcher below maps these to the existing
              // raw_unused / raw_used / edited_seg internal values.
              { value: 'raw_unused', label: 'RAW',        sublabel: 'needs editing',           count: stageCounts.raw_unused, dot: '#b53e3e' },
              { value: 'raw_used',   label: 'EDITED RAW', sublabel: 'already used in a cut',   count: stageCounts.raw_used,   dot: '#999' },
              { value: 'edited_seg', label: 'EDITED',     sublabel: 'finished cut',            count: stageCounts.edited_seg, dot: '#3e8a5e' },
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
          <FilterDropdown label="RUN"
            selected={runFilter}
            options={[
              { value: 'yes', label: 'RUN BEFORE', count: runCount,    dot: '#3e8a5e' },
              { value: 'no',  label: 'NOT YET',    count: notRunCount, dot: 'var(--ink-4)' },
            ]}
            allCount={visibleRows.length}
            onChange={setRunFilter} />
          {/* Uploaded-date filter, latest-only and the low-quality / bad-take
              show/hide toggles removed 2026-06-11 (Ben: too much noise).
              Flagged clips are now simply always hidden; their state vars
              keep their defaults so the filter pipeline is unchanged. */}
          {(stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size > 0) && (
            <button type="button"
              onClick={() => {
                setStageFilter(new Set()); setTypeFilter(new Set())
                setOfferFilter(new Set()); setRunFilter(new Set())
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
                background: '#fff', color: 'var(--ink)',
                border: '1.5px dashed var(--ink-3)', cursor: 'pointer',
                borderRadius: 2,
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
      <FolderBar
        folders={folders}
        currentFolderId={folderId}
        onNavigate={navigateFolder}
        clipCounts={folderClipCounts}
        searching={Boolean(deferredQ.trim())}
        canManage={scope.canEditCreative}
        onCreate={createFolder}
        onRename={renameFolder}
        onDelete={deleteFolder}
        onMoveFolder={reparentFolder}
        onDropClips={dropClipsToFolder}
        dropReady={dragActive}
        onError={setErr}
      />

      {/* Move-confirmation pill — fixed bottom-center, Drive-style */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          zIndex: 120, padding: '10px 18px',
          background: 'var(--ink)', color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600,
          letterSpacing: '0.05em', borderRadius: 3,
          boxShadow: '0 6px 24px rgba(10,10,10,0.35)',
          pointerEvents: 'none',
        }}>{toast}</div>
      )}

      {/* Bulk selection bar — sticky, appears when ≥1 tile is selected */}
      {selected.size > 0 && scope.canEditCreative && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          marginBottom: 14, padding: '10px 14px',
          background: 'var(--ink)', color: 'white',
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
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all visible ({filtered.length})</button>
          <button onClick={clearSelection}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
          <span style={{ flex: 1 }} />
          <button onClick={bulkDownload} disabled={bulkBusy}
            title="Trigger a browser download of each selected file (final cut ▸ preview ▸ drive)"
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer',
            }}>↓ Download {selected.size}</button>
          <button onClick={() => setMoveFolderOpen(true)} disabled={bulkBusy}
            title="Move the selected clips (and their other versions) into a folder"
            style={{
              padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
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
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
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

      {uploadOpen && (
        <UploadModal
          editors={editors}
          offers={offers}
          knownCreators={knownCreators}
          folderId={folderId}
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
      background: active ? 'var(--ink)' : 'white',
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
      background: active ? 'var(--ink)' : 'white',
      color: active ? 'var(--paper)' : 'var(--ink-2)',
      border: '1px solid ' + (active ? 'var(--ink)' : 'var(--rule)'),
      borderRadius: 2, cursor: 'pointer',
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
        background: '#3e8a5e',
      }} />
      <span style={{
        position: 'absolute', inset: -3, borderRadius: '50%',
        background: '#3e8a5e', opacity: 0.4,
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
        color: '#3e8a5e',
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
              width: 18, height: 18, borderRadius: 3,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'white'),
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
    const t = setTimeout(() => setHoverPlay(true), 320)
    return () => clearTimeout(t)
  }, [hover])
  const offerName = r.offer_slug ? r.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '') : null
  const oc = offerColor(r.offer_slug)
  // Left stripe color matches Matrix view: red = raw needs editing,
  // grey = raw already merged, green = edited, orange = merged final
  const stripeColor =
    (r.type === 'Joined' && r.status === 'edited') ? '#b86a0c'
    : (r.status === 'edited')                       ? '#3e8a5e'
    : (r.status === 'raw' && isUsed)                ? '#999'
    :                                                 '#b53e3e'
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
                width: 16, height: 16, borderRadius: 2,
                border: selected ? '2px solid var(--ink)' : (hover ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)'),
                background: selected ? 'var(--accent)' : 'white',
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
                  style={{ color: '#3e8a5e', fontWeight: 600, marginRight: 5 }}>✓</span>
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
              borderRadius: 2,
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
                border: '1px solid ' + oc.border, borderRadius: 2,
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
                background: 'rgba(62,138,94,0.10)', color: '#3e8a5e',
                border: '1px solid rgba(62,138,94,0.35)', borderRadius: 2,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3e8a5e' }} />
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
            {onDelete && (
              <button onClick={e => { e.stopPropagation(); onDelete() }} style={{
                padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'transparent', color: '#b53e3e',
                border: '1px solid #b53e3e', cursor: 'pointer',
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
              width: 18, height: 18, borderRadius: 3,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'white'),
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
    : (r.status === 'edited')                       ? '#3e8a5e'     // edited (green)
    : (r.status === 'raw' && isUsed)                ? '#999'        // raw + used (muted)
    :                                                 '#b53e3e'     // raw + unused (red — needs attention)
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
            width: 16, height: 16, borderRadius: 2,
            // Selected: solid dark border. Hovered row: dark border so it
            // pops as discoverable. Otherwise: visible but muted.
            border: selected ? '2px solid var(--ink)' : (hover ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)'),
            background: selected ? 'var(--accent)' : 'white',
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
            style={{ color: '#3e8a5e', fontWeight: 600, flexShrink: 0 }}>✓</span>
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
              background: '#b53e3e', color: 'white',
              fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              borderRadius: 2,
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
                background: bg, color: 'white',
                fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                borderRadius: 2,
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
              border: '1px solid ' + tc.border, borderRadius: 2,
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
              borderRadius: 2,
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
              borderRadius: 2, cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              color: r.has_been_run ? '#3e8a5e' : 'var(--ink-4)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
            {r.has_been_run ? 'Yes' : '—'}
          </button>
        ) : (
          <span style={{ color: r.has_been_run ? '#3e8a5e' : 'var(--ink-4)' }}>
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
              color: '#3e8a5e', textDecoration: 'none',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              borderRadius: 2,
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
            background: value === 'done' ? '#3e8a5e' : '#1f4e8f',
            color: 'white',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            borderRadius: 2,
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
            <span style={{ width: 10, height: 10, borderRadius: 2,
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
          background: 'white', border: '1px solid var(--ink)',
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
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--ink-4)', flexShrink: 0 }} />
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
                <span style={{ width: 10, height: 10, borderRadius: 2, background: editorColor(e), flexShrink: 0 }} />
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
              border: '1px solid var(--rule)', borderRadius: 2,
              background: 'white',
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
                  background: 'white', border: '1px solid var(--rule)', borderRadius: 2,
                  cursor: matchCount === 0 ? 'default' : 'pointer', color: 'var(--ink-3)',
                }}>‹</button>
              <button onClick={() => setCurrentMatch(m => matchCount === 0 ? 0 : (m + 1) % matchCount)}
                disabled={matchCount === 0} title="Next match"
                style={{
                  padding: '2px 7px', fontFamily: 'var(--mono)', fontSize: 12,
                  background: 'white', border: '1px solid var(--rule)', borderRadius: 2,
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
              color: copied ? '#3e8a5e' : 'var(--ink-3)',
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
        fontFamily: 'var(--serif)', fontSize: 13.5, lineHeight: 1.55,
        color: 'var(--ink)',
        whiteSpace: 'pre-wrap',
      }}>
        {text
          ? segments.map((s, i) => s.highlight
              ? <mark key={i} data-match={s.matchIdx} style={{
                  background: s.matchIdx === currentMatch ? '#f4e14a' : 'rgba(244,225,74,0.45)',
                  color: 'var(--ink)',
                  padding: '0 2px', borderRadius: 2,
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
function VersionsPanel({ row, onReload }) {
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
        <div style={{ padding: '6px 10px', background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)', color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 6 }}>
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
          return (
            <div key={v.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px',
              background: isCurrent ? 'rgba(244,225,74,0.18)' : 'var(--paper-2)',
              border: isCurrent ? '1px solid var(--ink)' : '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
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
              <span style={{ color: v.status === 'edited' ? '#3e8a5e' : '#b53e3e', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
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
          fontFamily: 'var(--serif)', fontStyle: 'italic',
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
            border: 'none', cursor: 'pointer', borderRadius: 2,
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
          border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 2,
        }}>Replace</button>
      <button onClick={onClear} disabled={busy} type="button"
        title="Clear this link"
        style={{
          padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'transparent', color: '#b53e3e',
          border: '1px solid rgba(181,62,62,0.35)', cursor: 'pointer', borderRadius: 2,
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
            border: '1px solid var(--rule)', borderRadius: 2,
            background: 'white', outline: 'none',
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
                    background: isCurrent ? 'rgba(244,225,74,0.15)' : 'white',
                    border: '1px solid ' + (isCurrent ? 'var(--accent)' : 'var(--rule)'),
                    cursor: 'pointer', borderRadius: 2,
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
                      background: 'var(--accent)', padding: '2px 6px', borderRadius: 2,
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
        color: row.status === 'edited' ? '#3e8a5e' : 'var(--ink-4)',
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
            ? { background: s.bg === 'transparent' ? 'var(--ink)' : s.bg, color: s.color === '#ccc' ? 'white' : s.color }
            : { background: 'white', color: 'var(--ink-3)' }
          return (
            <button key={String(s.v)} onClick={() => onChange(s.v)} style={{
              padding: '4px 8px',
              fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              border: '1px solid ' + (active ? 'transparent' : 'var(--rule)'),
              borderRadius: 2, cursor: 'pointer',
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
    if (statusChoice === 'raw_unused') { p.status = 'raw';    p.manually_marked_used = false }
    if (statusChoice === 'raw_used')   { p.status = 'raw';    p.manually_marked_used = true  }
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
    textTransform: 'uppercase', fontWeight: 600, borderRadius: 2 }

  return (
    <Modal open={true} onClose={onClose} size="md"
      eyebrow={`BULK EDIT · ${ids.length} CLIP${ids.length === 1 ? '' : 'S'}`}
      title="Reorganise selected creatives"
      subtitle="Click a field's value to set it. Anything left as KEEP EXISTING stays unchanged."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
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
                    borderRadius: 2, cursor: 'pointer',
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
              { v: 'raw_unused', label: 'RAW',        color: '#b53e3e' },
              { v: 'raw_used',   label: 'EDITED RAW', color: '#999'    },
              { v: 'edited',     label: 'EDITED',     color: '#3e8a5e' },
            ].map(opt => {
              const isOn = statusChoice === opt.v
              return (
                <button key={opt.v} type="button" onClick={() => setStatusChoice(opt.v)}
                  style={{
                    padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: isOn ? opt.color : 'white',
                    color: isOn ? 'white' : opt.color,
                    border: '1px solid ' + opt.color,
                    borderRadius: 2, cursor: 'pointer',
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
                background: hasBeenRun === true ? '#3e8a5e' : 'white',
                color: hasBeenRun === true ? 'white' : '#3e8a5e',
                border: '1px solid #3e8a5e',
                borderRadius: 2, cursor: 'pointer',
              }}>Yes — run before</button>
            <button onClick={() => setHasBeenRun(false)} type="button"
              style={{
                padding: '5px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: hasBeenRun === false ? 'var(--ink)' : 'white',
                color: hasBeenRun === false ? 'white' : 'var(--ink-3)',
                border: '1px solid var(--rule)',
                borderRadius: 2, cursor: 'pointer',
              }}>No — not yet</button>
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Field label="Creator">
            <select value={creator === null ? '__KEEP__' : creator || ''}
              onChange={e => {
                const v = e.target.value
                if (v === '__KEEP__') setCreator(null)
                else if (v === '__ADD__') {
                  const next = prompt('New creator name')
                  if (next?.trim()) setCreator(next.trim().toUpperCase())
                } else setCreator(v)
              }}
              style={selectStyle}>
              <option value="__KEEP__">— KEEP EXISTING —</option>
              {knownCreators.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__ADD__">+ Add new…</option>
            </select>
          </Field>
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
                  border: '1px solid var(--ink)', borderRadius: 2, cursor: 'pointer',
                } : {
                  padding: '5px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--ink-4)',
                  border: '1px dashed var(--rule)', borderRadius: 2, cursor: 'pointer',
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

  const confirm = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase
      .from('lib_creative_library')
      .delete()
      .eq('id', row.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.()
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Delete"
      title="Remove this creative?"
      subtitle="This removes the database row from your library. The file in Drive is NOT deleted — you can re-add it later by uploading again."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={confirm} disabled={busy} style={{
            ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e',
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

const chipLabelStyle = {
  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'var(--ink-3)', marginRight: 6,
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
          background: isAll ? 'white' : 'var(--accent)',
          color: 'var(--ink)',
          border: '1px solid ' + (isAll ? 'var(--rule)' : 'var(--ink)'),
          borderRadius: 2, cursor: 'pointer',
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
          background: 'white', border: '1px solid var(--ink)',
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
              width: 16, height: 16, borderRadius: 2,
              border: isAll ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
              background: isAll ? 'var(--accent)' : 'white',
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
                  width: 16, height: 16, borderRadius: 2,
                  border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                  background: isOn ? 'var(--accent)' : 'white',
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
    const t = setTimeout(() => setHoverPlay(true), 320)
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
            borderRadius: 3,
            background: selected ? 'var(--accent)' : 'rgba(255,255,255,0.92)',
            border: selected ? '2px solid var(--ink)' : '1.5px solid var(--ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            opacity: (selected || hover || selectionMode) ? 1 : 0.55,
            transition: 'opacity 0.12s, background 0.12s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}
          title={selected ? 'Deselect' : 'Select for bulk edit'}>
          {selected && (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      {/* Thumbnail */}
      <div style={{
        aspectRatio: '16 / 9',
        background: row.thumbnail_url
          ? '#000'   // black behind the image to hide letterbox for portrait
          : 'linear-gradient(135deg, var(--paper-2) 0%, var(--rule) 100%)',
        position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {/* draggable={false} on the media: browsers start a NATIVE image
            drag when the grab lands on an <img> (which covers most of the
            tile), hijacking the card's drag and dropping our clip payload
            on the floor. The card div must own every drag. */}
        {row.thumbnail_url && !(hoverPlay && row.preview_url) && (
          <img src={row.thumbnail_url} alt=""
            loading="lazy"
            draggable={false}
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {hoverPlay && row.preview_url && (
          <video src={row.preview_url}
            autoPlay muted loop playsInline preload="metadata"
            draggable={false}
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {!row.thumbnail_url && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            No thumbnail
          </span>
        )}
        {/* Type pill — top-left, color-coded per type */}
        {row.type && row.type !== 'unknown' && (() => {
          const tc = typeColor(row.type)
          return (
            <span style={{
              position: 'absolute', top: 6, left: 6,
              padding: '2px 7px',
              background: tc.ink, color: 'white',
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
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
      </div>
      {/* Body */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
          color: 'var(--ink)', lineHeight: 1.35,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: (row.status === 'raw' && isUsed) ? 'line-through' : 'none',
          opacity: (row.status === 'raw' && isUsed) ? 0.7 : 1,
        }} title={row.name}>
          {(row.status === 'raw' && isUsed) && (
            <span title="Already edited"
              style={{ color: '#3e8a5e', marginRight: 4 }}>✓</span>
          )}
          {rowDisplayName(row)}
        </div>
        <div style={{
          marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {row.creator && <span>{row.creator}</span>}
          {row.offer_slug && (() => {
            const oc = offerColor(row.offer_slug)
            const short = row.offer_slug.replace(/^opt-/, '').replace(/-stub$/, '').replace(/-template$/, '')
            return (
              <span style={{
                padding: '1px 5px',
                background: oc.soft, color: oc.ink,
                border: '1px solid ' + oc.border, borderRadius: 2,
                fontWeight: 600,
              }}>{short}</span>
            )
          })()}
          {row.has_been_run && (
            <span title="Run before"
              style={{ width: 7, height: 7, borderRadius: '50%', background: '#3e8a5e' }} />
          )}
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={row.status} /></span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── DETAIL MODAL (click row) ─────────────────────── */

function CreativeDetailModal({ row, isUsed = false, scope = ADMIN_SCOPE, editors: editorsProp, offers: offersProp, knownCreators: knownCreatorsProp, onOpenRow, onClose, onSaved, onRowPatched, onDeleted }) {
  const [edit, setEdit] = useState(row)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle') // idle | saving | saved | error
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
      has_been_run: !!edit.has_been_run,
      // The third STATUS button (EDITED RAW) writes both status='raw'
      // AND manually_marked_used=true, so include the flag in every
      // save. Otherwise the override is lost on the next auto-save.
      manually_marked_used: !!edit.manually_marked_used,
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

  // Pick the best playback URL — self-hosted preview > drive iframe
  const playbackKind = row.preview_url ? 'video' : row.drive_url ? 'iframe' : 'none'

  return (
    <Modal open={true} onClose={handleClose} size="lg"
      eyebrow={edit.display_name || edit.canonical_name || row.type || 'Creative'}
      title={rowDisplayName(row)}
      subtitle={row.canonical_name ? row.name : `${row.source_bucket || ''}${row.size_mb ? ' · ' + Math.round(row.size_mb) + ' MB' : ''}`}
      footer={
        confirmDelete ? (
          <>
            <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto', fontFamily: 'var(--mono)' }}>
              Delete this creative permanently? Can't be undone.
            </span>
            <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={ghostBtn}>Cancel</button>
            <button onClick={deleteCreative} disabled={deleting}
              style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
              {deleting ? 'Deleting…' : 'Delete forever'}
            </button>
          </>
        ) : (
          <>
            {scope.canEditCreative && (
              <span style={{
                fontSize: 11, fontFamily: 'var(--mono)', marginRight: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                color: autoSaveStatus === 'error' ? '#b53e3e'
                     : autoSaveStatus === 'saving' ? 'var(--ink-3)'
                     : autoSaveStatus === 'saved' ? '#3e8a5e'
                     : 'var(--ink-4)',
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: autoSaveStatus === 'error' ? '#b53e3e'
                            : autoSaveStatus === 'saving' ? '#e8b408'
                            : autoSaveStatus === 'saved' ? '#3e8a5e'
                            : 'var(--ink-4)',
                }} />
                {autoSaveStatus === 'saving' ? 'Saving…'
                  : autoSaveStatus === 'saved' ? 'Saved'
                  : autoSaveStatus === 'error' ? (err || 'Save failed')
                  : 'Changes save automatically'}
              </span>
            )}
            {err && !scope.canEditCreative && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
            {scope.canDelete && onDeleted && (
              <button onClick={() => setConfirmDelete(true)}
                style={{ ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)' }}>
                Delete
              </button>
            )}
            <button onClick={handleClose} style={ghostBtn}>Close</button>
            {scope.canEditCreative && (
              <button onClick={() => save()} disabled={saving} style={primaryBtn}>
                {saving ? 'Saving…' : 'Save now'}
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
            background: '#fff1f1', border: '1px solid #b53e3e',
            borderLeft: '3px solid #b53e3e',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: '#b53e3e',
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
                padding: '6px 10px', background: 'white', border: '1px solid var(--rule)',
                fontFamily: 'var(--mono)', fontSize: 11, color: replaceProgress.startsWith('error') ? '#b53e3e' : 'var(--ink-2)',
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
                    border: 'none', cursor: 'pointer', borderRadius: 2,
                  }}>↑ Replace original</button>
              </div>
            )}
          </div>
        )}

        {/* Video preview — uses the compact OPT player so the chrome
            matches the Review modal + the inline SubmissionsPanel
            player (Ben 2026-06-01: "needs to be pretty congruent
            across the board"). */}
        {playbackKind === 'video' && (
          <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
            <OptVideoPlayer src={row.preview_url} compact
              wrapperStyle={OPT_PLAYER_WRAP_FILL} />
          </div>
        )}
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
              letterSpacing: '0.05em', borderRadius: 2,
            }}>
              Drive-hosted preview · self-hosted version still processing
            </div>
          </div>
        )}
        {playbackKind === 'none' && (
          <div style={{
            aspectRatio: '16 / 9', background: 'var(--paper-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
          }}>
            No playback available
          </div>
        )}

        {/* Download bar — points at the highest-quality URL available.
            final_cut_url > drive_url > preview_url. Important: drive_url
            comes BEFORE preview_url because for old Drive-imported rows
            preview_url is a 720p transcode (looks dog shit on download). */}
        {(() => {
          const dl = row.final_cut_url || row.drive_url || row.preview_url
          if (!dl) return null
          return (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-3)',
            }}>
              <span>Original file</span>
              <a href={toDownloadUrl(dl, rowDisplayName(row))}
                download={rowDisplayName(row) || 'creative.mp4'}
                rel="noreferrer"
                title="Download the highest-quality version of this creative"
                style={{
                  padding: '4px 10px', fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'var(--ink)', color: 'var(--paper)',
                  textDecoration: 'none', borderRadius: 2,
                }}>↓ Download original</a>
            </div>
          )
        })()}

        {/* Slim form — only the fields Ben actually uses to organise creatives.
            Notes, v21 script, and original filename are tucked into the
            'Advanced' disclosure below. */}
        <Field label="Display name (auto)">
          {/* Read-only. The display_name is built by creative-library-describe
              from offer + messaging_angle + creator + take_number. Editing it
              directly used to produce the messy 5-token strings (Ben 2026-05-31).
              To change what appears here, edit the Messaging angle field below
              (free-text) or the Offer / Creator dropdowns. */}
          <input type="text" readOnly
            value={rowDisplayName(edit) || ''}
            title={rowDisplayName(edit) || ''}
            style={{
              ...inputStyle,
              color: 'var(--ink-3)',
              background: 'var(--paper-2)',
              cursor: 'default',
            }} />
        </Field>
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
                    borderRadius: 2, cursor: 'pointer',
                    transition: 'all 0.1s',
                  }}>
                  {t}
                </button>
              )
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Status">
            {/* Three buttons matching the Library STATUS filter +
                Bulk Edit modal. Selected-state uses the SAME isUsed
                calculation as the filter (manually_marked_used OR
                Hook fast-path OR transcript overlap), so a row that
                lands in the EDITED RAW filter bucket also shows the
                EDITED RAW button highlighted. Clicking writes a tri-
                state value to manually_marked_used:
                  RAW         → false (explicit override of heuristic)
                  EDITED RAW  → true  (force into used set)
                  EDITED      → status='edited' (flag left alone) */}
            <div style={{ display: 'flex', gap: 5 }}>
              {[
                { v: 'raw_unused', label: 'RAW',        color: '#b53e3e',
                  isOn: edit.status === 'raw' && !isUsed && edit.manually_marked_used !== true,
                  apply: () => setEdit({ ...edit, status: 'raw',    manually_marked_used: false }) },
                { v: 'raw_used',   label: 'EDITED RAW', color: '#999',
                  isOn: edit.status === 'raw' && (isUsed || edit.manually_marked_used === true),
                  apply: () => setEdit({ ...edit, status: 'raw',    manually_marked_used: true  }) },
                { v: 'edited',     label: 'EDITED',     color: '#3e8a5e',
                  isOn: edit.status === 'edited',
                  apply: () => setEdit({ ...edit, status: 'edited' }) },
              ].map(opt => (
                <button key={opt.v} type="button"
                  onClick={opt.apply}
                  style={{
                    flex: 1, padding: '8px 14px',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: opt.isOn ? opt.color : 'white',
                    color: opt.isOn ? 'white' : opt.color,
                    border: '1px solid ' + opt.color,
                    cursor: 'pointer', borderRadius: 2,
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Run before?">
            <button type="button"
              onClick={() => setEdit({ ...edit, has_been_run: !edit.has_been_run })}
              style={{
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                background: edit.has_been_run ? '#3e8a5e' : 'white',
                color: edit.has_been_run ? 'white' : 'var(--ink-3)',
                border: edit.has_been_run ? '1px solid #3e8a5e' : '1px solid var(--rule)',
                cursor: 'pointer', textAlign: 'center', width: '100%',
              }}>
              {edit.has_been_run ? 'Yes — run before' : 'No — not yet'}
            </button>
          </Field>
        </div>

        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <Field label="Creator">
            <CreatorPicker value={edit.creator || ''}
              known={knownCreators}
              onChange={v => setEdit({ ...edit, creator: v || null })} />
          </Field>
          <Field label="Offer / niche">
            <select value={edit.offer_slug || ''}
              onChange={e => setEdit({ ...edit, offer_slug: e.target.value || null })}
              style={selectStyle}>
              <option value="">— Pick offer —</option>
              {offers.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
            </select>
            {scope.canEditCreative && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" onClick={() => setOfferModal({ existing: null })}
                  style={{
                    flex: 1, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'white', color: 'var(--ink-3)', border: '1px solid var(--rule)',
                    borderRadius: 2, cursor: 'pointer',
                  }}>+ New offer</button>
                <button type="button" disabled={!edit.offer_slug}
                  onClick={async () => {
                    const { data } = await supabase.from('offers').select('*').eq('slug', edit.offer_slug).maybeSingle()
                    setOfferModal({ existing: data || { slug: edit.offer_slug } })
                  }}
                  style={{
                    flex: 1, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'white', color: 'var(--ink-3)', border: '1px solid var(--rule)',
                    borderRadius: 2, opacity: edit.offer_slug ? 1 : 0.4,
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
            <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.4 }}>
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

        {/* Versions — show v1/v2/v3... if this clip has siblings linked
            via parent_id. Includes an Upload-new-version button. */}
        <VersionsPanel row={row} onReload={() => onSaved?.()} />

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
                  <span style={{ marginLeft: 'auto', color: (t.is_overdue && t.status !== 'review') ? '#b53e3e' : 'var(--ink-4)' }}>
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

/* ─────────────────────────── UPLOAD MODAL ─────────────────────────── */

function UploadModal({ onClose, onSaved, editors = [], offers = [], onOfferAdded, knownCreators = [], folderId = null }) {
  // The modal is now a thin shell: it collects files + batch config,
  // hands them off to the module-level upload queue, and closes. The
  // queue owns all upload state, runs in the background regardless of
  // whether this modal is mounted, and surfaces progress via UploadDock.
  // files now holds richer items: { file, dims, markedBad, badReason }
  // so the per-file Layer-1 toggle (Keep/Bad) and the Layer-2 heuristic
  // result can both round-trip into the upload queue config.
  const [files, setFiles] = useState([])
  const [err, setErr] = useState(null)
  const [batchType, setBatchType] = useState('Joined')
  // batchStatus: 'raw' = needs editing (default), 'edited' = the file
  // is already a finished cut. Edited uploads also get final_cut_url +
  // stage_final_cut='done' so the library matrix surfaces them as done
  // and migration 087's trigger doesn't spawn an editing task.
  const [batchStatus, setBatchStatus] = useState('raw')
  const [batchEditorId, setBatchEditorId] = useState('')
  const [batchOfferSlug, setBatchOfferSlug] = useState('')
  // Actor / creator for the whole batch. Drives the rename scheme
  // (RAW-YYMMDD-ACTOR-S03-001.mp4) and the per-actor-per-day batch_seq
  // allocation. Empty -> UNK actor + the batch goes into the UNK bucket.
  const [batchCreator, setBatchCreator] = useState('')
  // Inline "+ Add new niche" form state. Any team member can add a niche
  // — public.offers has allow-all RLS (migration 059). Slug auto-derives
  // from the display name (lowercase, dashed, opt- prefix) but is
  // editable. The new offer is selected as the batch offer on success.
  const [addingNiche, setAddingNiche] = useState(false)
  const [newNicheName, setNewNicheName] = useState('')
  const [newNicheSlug, setNewNicheSlug] = useState('')
  const [newNicheBusy, setNewNicheBusy] = useState(false)
  const [newNicheErr, setNewNicheErr] = useState(null)
  // Resolution-rejected files. Each entry: { name, size, reason }.
  // Shown inline so the operator sees exactly what got blocked and why
  // — Ben's "surface errors, never swallow" rule.
  const [rejected, setRejected] = useState([])
  const [probing, setProbing] = useState(false)
  const inputRef = useRef(null)
  // No `busy` state — the modal is never blocked once Upload is clicked
  // because the queue takes over. The button just dispatches + closes.
  const busy = false

  const acceptFiles = async (incoming) => {
    // Accept videos AND images. Static image ads (banners, carousel
    // creatives) live in the same bucket — widened the bucket's
    // allowed_mime_types to match. Editor uploads from the queue still
    // expect videos, but bulk-add from the Library can be either.
    const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name)
    const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name)
    const candidates = Array.from(incoming || []).filter(f => isVideo(f) || isImage(f))
    if (!candidates.length) return

    // Resolution preflight. We probe each file browser-side BEFORE the
    // TUS upload starts so anything below 1080p gets rejected here —
    // no bandwidth wasted, no garbage rows in lib_creative_library.
    // Runs in parallel; rejected files surface with reasons in the UI.
    setProbing(true)
    const probes = await Promise.all(candidates.map(async (file) => {
      try {
        const dims = await probeMediaDimensions(file)
        const shortest = Math.min(dims.width, dims.height)
        if (shortest < MIN_SHORTEST_SIDE) {
          return {
            ok: false,
            file,
            reason: `${dims.width}×${dims.height} — below 1080p floor (shortest side must be ≥${MIN_SHORTEST_SIDE}px)`,
          }
        }
        return { ok: true, file, dims }
      } catch (e) {
        return {
          ok: false,
          file,
          reason: e?.message || 'could not read dimensions',
        }
      }
    }))
    setProbing(false)

    // Layer 2 heuristics run as soon as we have dims. Items can land in
    // the file list pre-flagged — operator sees a red badge + reason, can
    // un-flag via the Keep/Bad toggle if it was a false positive.
    const accepted = probes.filter(p => p.ok).map(p => {
      const heuristic = badTakeHeuristic(p.file, p.dims)
      return {
        file: p.file,
        dims: p.dims,
        markedBad: heuristic.flagged,
        badReason: heuristic.reason,
        badSource: heuristic.flagged ? 'heuristic' : null,
      }
    })
    const newlyRejected = probes.filter(p => !p.ok).map(p => ({
      name: p.file.name,
      size: p.file.size,
      reason: p.reason,
    }))
    if (accepted.length) setFiles(prev => [...prev, ...accepted])
    if (newlyRejected.length) setRejected(prev => [...prev, ...newlyRejected])
  }

  // Toggle the per-file Layer-1 flag. Operator-driven (vs heuristic which
  // is auto). When operator flips an auto-flag back to Keep, we change
  // badSource to null so the row never lands with a stale heuristic note.
  const toggleMarkedBad = (idx) => {
    setFiles(prev => prev.map((item, i) => {
      if (i !== idx) return item
      const next = !item.markedBad
      return {
        ...item,
        markedBad: next,
        badSource: next ? (item.badSource || 'upload') : null,
        badReason: next ? (item.badReason || 'flagged at upload') : null,
      }
    }))
  }

  const handleDrop = (e) => {
    e.preventDefault()
    acceptFiles(e.dataTransfer.files)
  }

  // Hand the batch to the module-level queue and close. The queue
  // owns the per-file pipeline (TUS upload → thumbnail → transcribe →
  // identify-actor → describe) and survives modal unmount, so the
  // operator can close this modal, navigate around, and uploads
  // continue with progress shown in the floating UploadDock.
  // Migration 104: allocate a per-actor-per-day batch via the RPC,
  // then enqueue each file with its rename-ready slot info.
  const submit = async () => {
    if (!files.length) return
    setErr(null)

    // Allocate the upload batch FIRST so all files in this batch share
    // the same batch_seq + date_local. RPC handles race-safe allocation
    // (advisory lock keyed by actor+date) so two concurrent uploads
    // can't collide on batch_seq.
    let batch
    try {
      const actor = actorTokenForRename(batchCreator)
      const { data, error } = await supabase.rpc('next_upload_batch', {
        p_actor_creator: actor,
        p_uploaded_by_label: null,
        p_uploaded_by_user: null,
        p_tz: 'Pacific/Auckland',
      })
      if (error) throw error
      batch = data
    } catch (e) {
      // If migration 104 hasn't landed yet, the RPC will 42883 (function
      // doesn't exist). Fall back to a client-allocated batch so the
      // upload doesn't die — rename still happens, just with batch_seq=1
      // and no upload_batch_id FK. Once 104 lands the RPC wins.
      console.warn('next_upload_batch RPC unavailable — falling back to client-side batch:', e?.message)
      batch = {
        id: null,
        actor_creator: actorTokenForRename(batchCreator),
        date_local: new Date().toISOString().slice(0, 10),
        batch_seq: 1,
      }
    }

    // Per-file payload: the rename gets computed at enqueue time so
    // the floating UploadDock can show the renamed filename instead of
    // the original Sony shorthand.
    const perFile = files.map((item, idx) => ({
      file: item.file,
      perFileConfig: {
        fileSeq: idx + 1,
        renamedName: renameForUpload({
          originalName: item.file.name,
          actor: batch.actor_creator,
          dateLocal: batch.date_local,
          batchSeq: batch.batch_seq,
          fileSeq: idx + 1,
        }),
        markedBad: !!item.markedBad,
        badReason: item.badReason || null,
        badSource: item.badSource || (item.markedBad ? 'upload' : null),
      },
    }))

    uploadQueue.enqueue(perFile.map(p => p.file), {
      batchType,
      batchStatus,
      batchEditorId,
      batchOfferSlug,
      batchCreator: batch.actor_creator,
      batchFolderId: folderId,   // file uploads into the folder that was open
      uploadBatchId: batch.id,
      uploadBatchSeq: batch.batch_seq,
      uploadBatchDate: batch.date_local,
      perFile: perFile.map(p => p.perFileConfig),  // index-aligned with files
    })
    // Clear the modal's local file list so re-opening doesn't show
    // the same files queued again, and close immediately.
    setFiles([])
    onClose?.()
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="md"
      eyebrow="Upload"
      title={`Add ${files.length || ''} new creative${files.length === 1 ? '' : 's'}`}
      subtitle={(() => {
        const totalBytes = files.reduce((s, f) => s + (f?.size || 0), 0)
        const gb = totalBytes / (1024 * 1024 * 1024)
        const sizeLabel = totalBytes > 0
          ? (gb >= 1 ? `${gb.toFixed(2)} GB total` : `${(totalBytes / (1024 * 1024)).toFixed(1)} MB total`)
          : ''
        return `Drop video or image files — up to 10 GB each, 1080p minimum (shortest side ≥ 1080px). Resumable uploads survive multi-GB clips. Transcripts + auto-rename fire in the background once the file lands.${sizeLabel ? ` · ${sizeLabel}` : ''}`
      })()}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {/* "Close" instead of "Cancel" — uploads, once queued, keep
              running in the background regardless of this modal's state.
              Naming it Cancel implied the uploads would die, which is
              not what happens. */}
          <button onClick={onClose} style={ghostBtn}>Close</button>
          <button onClick={submit} disabled={!files.length} style={primaryBtn}>
            {`Queue ${files.length || ''} for upload`}
          </button>
        </>
      }>
      <div style={{ padding: 28 }}>
        {/* Bulk-assign row — apply Type / Editor / Offer to every
            file in this batch. Operator sets these once instead of
            uploading then selecting + bulk-editing later. */}
        <div style={{
          marginBottom: 14, padding: '12px 14px',
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
            marginBottom: 8,
          }}>Apply to all files in this batch</div>
          {/* Actor / Creator picker — drives the rename scheme. Renames
              cameras-original filenames to RAW-YYMMDD-ACTOR-Sxx-NNN.{ext}
              at insert. The actor token shows up in display_name later
              too, so picking it here saves an edit pass post-describe. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Actor / creator (drives filename + batch grouping)
            </div>
            <input list="upload-actor-suggest" type="text"
              value={batchCreator} onChange={e => setBatchCreator(e.target.value)}
              placeholder="e.g. TANYA · leave blank for UNK"
              style={selectStyle} disabled={busy} />
            <datalist id="upload-actor-suggest">
              {(knownCreators || []).filter(Boolean).map(c => <option key={c} value={c} />)}
            </datalist>
            {files.length > 0 && (
              <div style={{
                marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                letterSpacing: '0.04em',
              }}>
                Preview: <strong>RAW-{new Date().toISOString().slice(2, 10).replace(/-/g, '')}-{actorTokenForRename(batchCreator)}-S??-001.{(files[0]?.file?.name || '').match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'mp4'}</strong>
                {' '}<span style={{ color: 'var(--ink-4)' }}>(batch number assigned at queue time)</span>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Type</div>
              <select value={batchType} onChange={e => setBatchType(e.target.value)} style={selectStyle} disabled={busy}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Status</div>
              <select value={batchStatus} onChange={e => setBatchStatus(e.target.value)} style={selectStyle} disabled={busy}>
                <option value="raw">Raw · needs editing</option>
                <option value="edited">Edited · finished cut</option>
              </select>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Assign to editor</div>
              <select value={batchEditorId} onChange={e => setBatchEditorId(e.target.value)} style={selectStyle} disabled={busy}>
                <option value="">— Leave unassigned —</option>
                {editors.filter(e => e.active !== false && e.tier !== 'admin').map(e => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                marginBottom: 4,
              }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Offer / niche</div>
                {!addingNiche && (
                  <button
                    type="button"
                    onClick={() => { setAddingNiche(true); setNewNicheErr(null) }}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 9.5,
                      letterSpacing: '0.06em', textTransform: 'uppercase', padding: 0,
                      textDecoration: 'underline',
                    }}
                    title="Add a new niche — visible to everyone"
                  >+ Add</button>
                )}
              </div>
              {addingNiche ? (
                <div style={{
                  border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent, #e8b408)',
                  padding: 8, background: 'var(--paper)',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <input
                    type="text"
                    placeholder="Niche name (e.g. OPT Accounting)"
                    value={newNicheName}
                    onChange={e => {
                      const name = e.target.value
                      setNewNicheName(name)
                      // Auto-derive slug from name on the fly until the
                      // operator manually edits the slug. Strip non-alphanum
                      // and prefix opt- to match the existing convention.
                      const auto = 'opt-' + name.toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-+|-+$/g, '')
                        .replace(/^opt-/, '')
                      setNewNicheSlug(prev => (prev === '' || prev.startsWith('opt-')) ? auto : prev)
                    }}
                    style={{
                      padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 11,
                      border: '1px solid var(--rule)', background: 'var(--paper)',
                    }}
                    autoFocus
                  />
                  <input
                    type="text"
                    placeholder="slug (auto)"
                    value={newNicheSlug}
                    onChange={e => setNewNicheSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    style={{
                      padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 10.5,
                      border: '1px solid var(--rule)', background: 'var(--paper-2)',
                      color: 'var(--ink-3)',
                    }}
                  />
                  {newNicheErr && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#b53e3e' }}>
                      {newNicheErr}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingNiche(false)
                        setNewNicheName('')
                        setNewNicheSlug('')
                        setNewNicheErr(null)
                      }}
                      disabled={newNicheBusy}
                      style={{
                        background: 'transparent', border: '1px solid var(--rule)',
                        padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10,
                        cursor: 'pointer', color: 'var(--ink-3)',
                      }}
                    >Cancel</button>
                    <button
                      type="button"
                      disabled={newNicheBusy || !newNicheName.trim() || !newNicheSlug.trim()}
                      onClick={async () => {
                        setNewNicheBusy(true)
                        setNewNicheErr(null)
                        const slug = newNicheSlug.trim()
                        const name = newNicheName.trim()
                        // Derive a vertical from the slug (strip opt- prefix
                        // + stub/template suffixes). Matches the convention
                        // in migration 059's seed rows. Vertical is NOT NULL
                        // in the schema, so we always pass something.
                        const vertical = slug
                          .replace(/^opt-/, '')
                          .replace(/-stub$/, '')
                          .replace(/-template$/, '')
                          || 'generic'
                        const { data, error } = await supabase
                          .from('offers')
                          .insert({ slug, name, vertical })
                          .select('slug,name')
                          .single()
                        setNewNicheBusy(false)
                        if (error) {
                          // Most common failure: duplicate slug. Surface the
                          // actual message — Ben's "surface errors, never
                          // swallow" rule.
                          setNewNicheErr(error.message || 'failed to add niche')
                          return
                        }
                        onOfferAdded?.(data)
                        setBatchOfferSlug(data.slug)
                        setAddingNiche(false)
                        setNewNicheName('')
                        setNewNicheSlug('')
                      }}
                      style={{
                        background: 'var(--ink)', color: 'var(--paper)', border: 'none',
                        padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                        cursor: newNicheBusy ? 'wait' : 'pointer',
                        opacity: (newNicheBusy || !newNicheName.trim() || !newNicheSlug.trim()) ? 0.5 : 1,
                      }}
                    >{newNicheBusy ? 'Adding…' : 'Add niche'}</button>
                  </div>
                </div>
              ) : (
                <select value={batchOfferSlug} onChange={e => setBatchOfferSlug(e.target.value)} style={selectStyle} disabled={busy}>
                  <option value="">— None —</option>
                  {offers.map(o => (
                    <option key={o.slug} value={o.slug}>{o.name || o.slug}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: 32, textAlign: 'center', cursor: 'pointer',
            border: '2px dashed var(--rule)',
            background: files.length ? 'var(--paper-2)' : 'var(--paper)',
            transition: 'border-color 0.12s, background 0.12s',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--ink)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--rule)'}>
          <input ref={inputRef} type="file" accept="video/*,image/*" multiple
            style={{ display: 'none' }}
            onChange={e => acceptFiles(e.target.files)} />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 4 }}>
            Drop video or image files here
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            or click to select (multi-select allowed)
          </div>
        </div>

        {probing && (
          <div style={{
            marginTop: 12, padding: '8px 12px',
            background: 'var(--paper-2)', border: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
          }}>
            Reading resolution of selected files…
          </div>
        )}
        {files.length > 0 && (
          <div style={{
            marginTop: 14, border: '1px solid var(--rule)', maxHeight: 320, overflowY: 'auto',
          }}>
            {files.map((item, i) => {
              const f = item.file
              const dur = item.dims?.duration_s
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr auto 80px 100px 30px',
                  gap: 10, alignItems: 'center',
                  padding: '8px 12px',
                  borderBottom: i === files.length - 1 ? 'none' : '1px solid var(--rule)',
                  background: item.markedBad ? 'rgba(181,62,62,0.05)' : (i % 2 === 0 ? 'transparent' : 'var(--paper-2)'),
                  borderLeft: item.markedBad ? '3px solid #b53e3e' : '3px solid transparent',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textDecoration: item.markedBad ? 'line-through' : 'none',
                      opacity: item.markedBad ? 0.6 : 1,
                    }} title={f.name}>{f.name}</div>
                    {item.markedBad && item.badReason && (
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 9.5, color: '#b53e3e',
                        marginTop: 2, letterSpacing: '0.04em',
                      }}>
                        BAD{item.badSource === 'heuristic' ? ' (auto)' : ' (operator)'} · {item.badReason}
                      </div>
                    )}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>
                    {dur != null ? `${dur.toFixed(1)}s` : '—'}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </div>
                  {/* Keep/Bad toggle (Layer 1). Operator-driven mark for
                      takes the operator KNOWS are flubbed before upload
                      — restart, missed cue, audio fail, etc. Auto-flagged
                      items can be un-flagged with the same toggle. */}
                  <button onClick={() => toggleMarkedBad(i)} type="button"
                    title={item.markedBad ? 'Currently flagged as bad take — click to keep' : 'Mark as bad take (will be hidden from editor library)'}
                    style={{
                      padding: '3px 9px', borderRadius: 2,
                      background: item.markedBad ? '#b53e3e' : 'var(--paper)',
                      color: item.markedBad ? 'white' : 'var(--ink-3)',
                      border: '1px solid ' + (item.markedBad ? '#b53e3e' : 'var(--rule)'),
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}>{item.markedBad ? 'Bad take' : 'Keep'}</button>
                  <button onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--ink-4)', fontSize: 16, padding: 0,
                  }}>×</button>
                </div>
              )
            })}
            {/* Footer: count of items flagged so the operator sees how
                many won't reach the editor before clicking Queue. */}
            {(() => {
              const badCount = files.filter(it => it.markedBad).length
              if (!badCount) return null
              return (
                <div style={{
                  padding: '6px 12px', background: 'var(--paper-2)',
                  borderTop: '1px solid var(--rule)',
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  {badCount} of {files.length} flagged as bad — will upload but hide from editor library
                </div>
              )
            })()}
          </div>
        )}
        {rejected.length > 0 && (
          <div style={{
            marginTop: 12, border: '1px solid #b53e3e', borderLeft: '3px solid #b53e3e',
            background: 'rgba(181,62,62,0.04)',
          }}>
            <div style={{
              padding: '8px 12px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid rgba(181,62,62,0.25)',
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase', color: '#b53e3e',
              }}>
                {rejected.length} file{rejected.length === 1 ? '' : 's'} rejected · below 1080p
              </div>
              <button onClick={() => setRejected([])} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--ink-4)', fontSize: 14, padding: 0,
              }}>×</button>
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {rejected.map((r, i) => (
                <div key={i} style={{
                  padding: '6px 12px',
                  borderBottom: i === rejected.length - 1 ? 'none' : '1px solid rgba(181,62,62,0.15)',
                }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={r.name}>{r.name}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#b53e3e', marginTop: 1 }}>
                    {r.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{
          marginTop: 12, padding: '8px 12px',
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          borderLeft: '3px solid var(--accent, #e8b408)',
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
          letterSpacing: '0.04em', lineHeight: 1.5,
        }}>
          Uploads run in the background — once you hit <b>Queue for upload</b> you can
          close this modal (or leave the page entirely) and uploads keep going.
          A thin progress bar shows at the top of the screen, and full per-file progress
          shows in the floating dock (bottom-right). Cancel any upload from the dock.
        </div>
      </div>
    </Modal>
  )
}

function EditingQueueTab({ scope = ADMIN_SCOPE }) {
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
    let out = tasks
    if (selectedEditors.size > 0) {
      out = out.filter(t => selectedEditors.has(t.editor_id) || (t.editor_id == null && selectedEditors.has('unassigned')))
    }
    if (selectedStatuses.size > 0) {
      out = out.filter(t => selectedStatuses.has(t.status))
    }
    return out
  }, [tasks, selectedEditors, selectedStatuses])

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
            <button onClick={() => setShareLinksOpen(true)} style={{ ...ghostBtn, color: '#a86a08', borderColor: '#a86a08' }}>
              ↗ Share with editor
            </button>
            <button onClick={() => setManageEditorsOpen(true)} style={ghostBtn}>Manage editors</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {editors.filter(e => e.active && e.tier !== 'admin').length} editor{editors.filter(e => e.active && e.tier !== 'admin').length === 1 ? '' : 's'} · {filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
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
              { value: 'unassigned', label: 'Unassigned', dot: '#999',
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
          position: 'sticky', top: 0, zIndex: 50,
          marginBottom: 14, padding: '10px 14px',
          background: 'var(--ink)', color: 'white',
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
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all visible ({filteredTasks.length})</button>
          <button onClick={clearTaskSelection}
            style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
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
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'white', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
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
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'white', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
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
              style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5, background: 'white', color: 'var(--ink)', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer' }}>
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
    { v: 'done',        label: 'Done',        color: '#3e8a5e' },
    { v: 'blocked',     label: 'Blocked',     color: '#b53e3e' },
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
          background: selected.size === 0 ? 'var(--ink)' : 'white',
          color: selected.size === 0 ? 'var(--paper)' : 'var(--ink-2)',
          border: '1px solid ' + (selected.size === 0 ? 'var(--ink)' : 'var(--rule)'),
          borderRadius: 2,
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
              background: isOn ? s.color : 'white',
              color: isOn ? 'white' : 'var(--ink-2)',
              border: '1px solid ' + (isOn ? s.color : 'var(--rule)'),
              borderRadius: 2, cursor: 'pointer',
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
          background: selected.size === 0 ? 'var(--ink)' : 'white',
          color: selected.size === 0 ? 'var(--paper)' : 'var(--ink-2)',
          border: '1px solid ' + (selected.size === 0 ? 'var(--ink)' : 'var(--rule)'),
          borderRadius: 2,
          cursor: selected.size === 0 ? 'default' : 'pointer',
        }}>All editors</button>
      {sortedEditors.map(e => {
        const isSelected = selected.has(e.id)
        const color = editorColor(e)
        const count = taskCountByEditorId[e.id] || 0
        return (
          <span key={e.id} style={{
            display: 'inline-flex', alignItems: 'stretch', borderRadius: 2,
            border: '1px solid ' + (isSelected ? color : 'var(--rule)'),
            background: isSelected ? color : 'white',
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
              width: 18, height: 18, borderRadius: 3,
              border: '2px solid var(--ink)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'white'),
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
                  width: 16, height: 16, borderRadius: 2,
                  border: selected?.has(t.task_id) ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                  background: selected?.has(t.task_id) ? 'var(--accent)' : 'white',
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
                      borderRadius: 2,
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
              {t.editor_name && <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />}
              <span style={{ color: t.editor_name ? 'var(--ink)' : 'var(--ink-4)' }}>{t.editor_name || 'Unassigned'}</span>
            </div>
            <div><StatusPipBadge status={t.status} isOverdue={t.is_overdue && t.status !== 'review'} /></div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{t.task_type || '—'}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11,
                          color: (t.is_overdue && t.status !== 'review') ? '#b53e3e' : 'var(--ink-3)' }}>
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
        background: 'rgba(181,62,62,0.1)', color: '#b53e3e',
        border: '1px solid rgba(181,62,62,0.3)', borderRadius: 2,
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
              ? (isOverdue ? '#b53e3e' : (s === 'done' ? '#3e8a5e' : '#3e7eba'))
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
            {current.color && <span style={{ width: 10, height: 10, borderRadius: 2, background: current.color, flexShrink: 0 }} />}
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
          background: 'white', border: '1px solid var(--ink)',
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
                {o.color && <span style={{ width: 10, height: 10, borderRadius: 2, background: o.color, flexShrink: 0 }} />}
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
  { value: 'P1 - High',   label: 'P1 · High',   color: '#b53e3e' },
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
    if (!silent) setBusy(false)
    if (error) {
      if (!silent) setErr(error.message)
    } else {
      // Reset dirty so closing the modal twice doesn't fire a redundant
      // silent write. Manual Save also wins this flag back for the user.
      dirtyRef.current = false
      if (!silent) onSaved?.()
    }
  }, [editorId, status, priority, taskType, due, startDate, notes, task.task_id, task.started_at, task.completed_at, onSaved])
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
      const { error: sErr } = await supabase.from('lib_task_submissions').insert({
        task_id: task.task_id,
        submitted_by_editor_id: task.editor_id || null,
        submitted_by_name: task.editor_name || null,
        file_url: publicUrl,
        file_storage_path: storagePath,
        thumbnail_url: submissionThumbUrl,
        version_number: nextVersion,
      })
      if (sErr) throw sErr
      setUploadProgress(85)

      // Keep the source creative's final_cut_url pointing at the LATEST
      // submission so the library matrix / aux views still surface the
      // most recent cut. Approving an older version explicitly
      // (via the Approve button on the submissions list) overrides this.
      const { error: pErr } = await supabase.from('lib_creative_library')
        .update({ final_cut_url: publicUrl, stage_final_cut: 'done' })
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
        await supabase.from('lib_creative_library')
          .update({ final_cut_url: sub.file_url, stage_final_cut: 'done' })
          .eq('id', task.creative_id)
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
    <Modal open={true} onClose={handleCloseModal} size="xl"
      eyebrow="Edit task"
      title={task.creative_name}
      subtitle={`${task.creative_type || ''}${task.creative_creator ? ' · ' + task.creative_creator : ''}${task.v21_script_id ? ' · ' + task.v21_script_id : ''}`}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Delete this task? It can't be undone.</span>
              <button onClick={() => setConfirmDel(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={remove} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? 'Deleting…' : 'Delete task'}
              </button>
            </>
          ) : (
            <>
              {scope.canDeleteTask && (
                <button onClick={() => setConfirmDel(true)} disabled={busy} style={{
                  ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)',
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
              : status === 'blocked' ? '#b53e3e'
              : status === 'done' ? '#3e8a5e'
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
                : status === 'blocked' ? '#b53e3e'
                : status === 'done' ? '#3e8a5e'
                : '#3e7eba',
              borderRadius: 2,
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
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        }}>
        {/* Left column only when there's media — an empty div would still
            claim an auto-fit track and render a blank half-modal for rows
            with no preview/source URL. */}
        {(task.preview_url || task.drive_url) && (
        <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
        {/* Inline video preview — playable in the modal so the editor
            can watch the source without bouncing elsewhere. preview_url
            is the compressed 720p mp4 for OLD Drive-imported rows; for
            new TUS-uploaded rows it's the ORIGINAL full-quality file.
            The Download Original button always points at the highest-
            quality source we have: drive_url first (always original for
            old rows), then preview_url (only full-quality for new rows). */}
        {task.preview_url ? (
          <div style={{ background: '#000', border: '1px solid var(--rule)' }}>
            <OptVideoPlayer src={task.preview_url} compact
              wrapperStyle={OPT_PLAYER_WRAP_360} />
            <div style={{
              padding: '8px 12px', background: 'var(--paper-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-3)',
            }}>
              <span>Source file</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {task.drive_url && (
                  <a href={task.drive_url} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--ink-2)', textDecoration: 'underline' }}>
                    Open in Drive ↗
                  </a>
                )}
                {(task.final_cut_url || task.drive_url || task.preview_url) && (
                  <a
                    href={toDownloadUrl(task.final_cut_url || task.drive_url || task.preview_url, task.creative_name)}
                    download={task.creative_name || 'creative.mp4'}
                    rel="noreferrer"
                    title="Download the original full-quality file"
                    style={{
                      padding: '4px 10px',
                      fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: 'var(--ink)', color: 'var(--paper)',
                      textDecoration: 'none', borderRadius: 2,
                    }}>↓ Download original</a>
                )}
              </div>
            </div>
          </div>
        ) : task.drive_url ? (
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
        <div style={{ display: 'grid', gap: 14, minWidth: 0, alignContent: 'start' }}>
        {/* Quick-action status row — colored pill per status when selected. */}
        <div>
          <div style={chipLabelStyle}>Status</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {['queued', 'in_progress', 'review', 'needs_revision', 'done', 'blocked'].map(s => {
              const isOn = status === s
              const c = TASK_STATUS_COLOR[s] || 'var(--ink)'
              return (
                <button key={s} onClick={() => setStatus(s)} style={{
                  padding: '5px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: isOn ? c : 'white',
                  color: isOn ? 'white' : 'var(--ink-2)',
                  border: '1px solid ' + (isOn ? c : 'var(--rule)'),
                  borderRadius: 2, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  {!isOn && <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />}
                  <span>{TASK_STATUS_LABEL[s] || s}</span>
                </button>
              )
            })}
          </div>
        </div>

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
              borderLeft: '3px solid var(--accent)', borderRadius: 2,
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
              <span style={{ color: '#3e8a5e' }}>Submitted for review</span>
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
              background: uploadFile ? 'white' : 'transparent',
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
              marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden',
            }}>
              <div style={{
                width: `${uploadProgress}%`, height: '100%',
                background: uploadProgress === 100 ? '#3e8a5e' : 'var(--accent)',
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
              borderLeft: '3px solid #b53e3e',
              fontFamily: 'var(--mono)', fontSize: 11, color: '#b53e3e',
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
      background: 'white', borderLeft: '3px solid #3e8a5e',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: '#3e8a5e',
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
              borderLeft: isApproved ? '3px solid #3e8a5e' : '3px solid var(--ink-4)',
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
                    padding: '3px 8px', borderRadius: 2,
                    background: isApproved ? '#3e8a5e' : 'var(--ink-3)', color: 'white',
                    letterSpacing: '0.06em',
                  }}>v{sub.version_number}</span>
                  {isApproved && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: '#3e8a5e',
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
                          padding: '3px 7px', borderRadius: 2, cursor: 'pointer',
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
                        background: 'transparent', color: '#3e8a5e',
                        border: '1px solid rgba(62,138,94,0.5)', borderRadius: 2,
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
                        border: '1px solid rgba(208,156,8,0.5)', borderRadius: 2,
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
                        border: '1px solid transparent', borderRadius: 2,
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
                          border: '1px solid var(--rule)', borderRadius: 2, cursor: 'pointer',
                        }}>Cancel</button>
                      <button type="button" disabled={busy}
                        onClick={() => { onDelete?.(sub); setConfirmDeleteId(null) }}
                        style={{
                          padding: '4px 8px',
                          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: '#b53e3e', color: 'white',
                          border: 'none', borderRadius: 2, cursor: 'pointer',
                        }}>Confirm</button>
                    </>
                  )}
                  {/* Primary action — opens the OPT-branded review surface
                      with the custom player, scrubber-pinned comment
                      markers, and Approve / Request revision in the
                      modal footer. */}
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
                    src={sub.file_url}
                    markers={commentsBySubId[sub.id]?.markers || []}
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
                        textDecoration: 'none', borderRadius: 2,
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
                const accent = needsAction ? '#b53e3e' : hasAny ? '#3e8a5e' : '#e8b408'
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
                        padding: '8px 10px', background: 'white', border: '1px solid var(--rule)',
                        borderRadius: 2,
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
                            background: 'white', border: '1px solid var(--rule)',
                            borderRadius: 2, resize: 'vertical',
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
                              border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 2,
                            }}>Cancel</button>
                          <button type="button"
                            onClick={() => saveFeedback(sub)}
                            disabled={feedbackSavingId === sub.id}
                            style={{
                              padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                              fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                              background: 'var(--ink)', color: 'var(--paper)',
                              border: 'none', cursor: 'pointer', borderRadius: 2,
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
                              background: needsAction ? '#b53e3e' : '#3e8a5e',
                              color: 'white', border: 'none', borderRadius: 2,
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
                              cursor: 'pointer', borderRadius: 2, lineHeight: 1.2,
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
                background: 'white', border: '1px solid var(--rule)',
                borderRadius: 2, resize: 'vertical', boxSizing: 'border-box',
              }}
            />
            {revisionErr && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)',
                color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11.5,
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
                  border: '1px solid var(--rule)', cursor: 'pointer', borderRadius: 2,
                }}>Cancel</button>
              <button type="button"
                onClick={submitRevisionPopup}
                disabled={revisionSending || !revisionDraft.trim()}
                style={{
                  padding: '8px 14px',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: '#d09c08', color: '#3a2904',
                  border: 'none', cursor: revisionSending ? 'wait' : 'pointer', borderRadius: 2,
                }}>{revisionSending ? 'Sending…' : 'Send revision request'}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/* Small badges for editor format (shorts / long / both) and tier
   (admin / editor). Used in the Manage Editors roster + anywhere else
   we want to show at a glance which editors do what. */
function FormatBadge({ format }) {
  const f = format || 'both'
  const label = f === 'shorts' ? 'Shorts' : f === 'long' ? 'Long' : 'Both'
  const color = f === 'shorts' ? '#7a4eb3' : f === 'long' ? '#0f7a8c' : 'var(--ink-3)'
  const bg    = f === 'shorts' ? 'rgba(122,78,179,0.10)' : f === 'long' ? 'rgba(15,122,140,0.10)' : 'var(--paper-2)'
  return (
    <span style={{
      padding: '2px 8px', display: 'inline-block',
      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color, background: bg, border: `1px solid ${color}`, borderRadius: 2,
    }}>{label}</span>
  )
}
function TierBadge({ tier }) {
  const t = tier || 'editor'
  const isAdmin = t === 'admin'
  return (
    <span style={{
      padding: '2px 8px', display: 'inline-block',
      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color: isAdmin ? '#a8650f' : 'var(--ink-3)',
      background: isAdmin ? '#fffaea' : 'var(--paper-2)',
      border: `1px solid ${isAdmin ? '#d09c08' : 'var(--rule)'}`,
      borderRadius: 2,
    }}>{isAdmin ? 'Admin' : 'Editor'}</span>
  )
}

/* Dedicated Manage Editors modal — centralized roster view + add new +
   row-level edit click-through. */
function ManageEditorsModal({ editors, tasks, selfEditorId, onClose, onEditorAdded, onEditorPatched, onEditorsRemoved, onOpenEditor }) {
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [addStatus, setAddStatus] = useState(null)  // { color, text } after a quick-add
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // Self-lockout guard: a coordinator managing the roster from the portal
  // (selfEditorId set) can't select / delete / deactivate their own row.
  // Ben on the dashboard has selfEditorId=null so no row is protected.
  const isSelf = (id) => selfEditorId != null && id === selfEditorId
  const toggleSel = (id) => {
    if (isSelf(id)) return
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(editors.filter(e => !isSelf(e.id)).map(e => e.id)))
  const clearSel = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    setBusy(true); setErr(null)
    const ids = Array.from(selectedIds).filter(id => !isSelf(id))
    const { error } = await supabase.from('lib_creative_editors')
      .delete().in('id', ids)
    setBusy(false)
    if (error) setErr(error.message)
    else { setSelectedIds(new Set()); setConfirmBulkDelete(false); onEditorsRemoved?.(ids) }
  }

  // Task counts per editor (active + overall)
  const counts = useMemo(() => {
    const m = {}
    for (const t of tasks) {
      const id = t.editor_id || '__unassigned'
      if (!m[id]) m[id] = { open: 0, done: 0 }
      if (t.status === 'done') m[id].done++
      else m[id].open++
    }
    return m
  }, [tasks])

  const addEditor = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr(null); setAddStatus(null)
    const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const cleanEmail = newEmail.trim() ? newEmail.trim().toLowerCase() : null
    const { data, error } = await supabase.from('lib_creative_editors')
      .insert({ name: newName.trim(), slug, email: cleanEmail })
      .select()
      .single()
    if (error) { setBusy(false); setErr(error.message); return }
    // Auto-send the welcome invite (best-effort) so the new editor knows
    // to log in. Row exists now → the function's roster guard finds it.
    const inviteStatus = await sendEditorInvite(cleanEmail, newName.trim())
    setBusy(false)
    const added = newName.trim()
    setNewName(''); setNewEmail('')
    if (data) onEditorAdded?.(data)
    setAddStatus(
      inviteStatus === 'sent'    ? { color: '#3e8a5e', text: `Added ${added} · invite emailed to ${cleanEmail}` }
      : inviteStatus === 'skipped' ? { color: 'var(--ink-3)', text: `Added ${added} · no email, so no invite sent (add one via the row to enable login)` }
      :                            { color: '#a8650f', text: `Added ${added} · invite email didn't send — they can still log in at /editor-login` }
    )
  }

  const toggleActive = async (e) => {
    if (isSelf(e.id)) return  // can't deactivate yourself
    const next = !e.active
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: next }).eq('id', e.id)
    if (error) setErr(error.message)
    else onEditorPatched?.(e.id, { active: next })
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="Settings"
      title="Manage editors"
      subtitle="Roster of editors. Add new ones, set their format + tier, deactivate inactive ones, click any row to edit details + share links."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Add new editor — name + email so the invite can go out. */}
        <div style={{
          padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
          display: 'grid', gap: 8,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={chipLabelStyle}>Add new</span>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
              placeholder="Editor name (e.g. Sarah)"
              style={{ ...inputStyle, flex: 1 }} />
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
              placeholder="email (sends invite)"
              style={{ ...inputStyle, flex: 1 }} />
            <button onClick={addEditor} disabled={!newName.trim() || busy} style={primaryBtn}>
              {busy ? '…' : '+ Add + invite'}
            </button>
          </div>
          {addStatus && (
            <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: addStatus.color, lineHeight: 1.4 }}>
              {addStatus.text}
            </div>
          )}
        </div>

        {/* Bulk selection bar — sticky when any editor is selected */}
        {selectedIds.size > 0 && (
          <div style={{
            padding: '10px 14px', background: 'var(--ink)', color: 'white',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em' }}>
              {selectedIds.size} SELECTED
            </span>
            <button onClick={selectAll} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Select all ({editors.length})</button>
            <button onClick={clearSel} style={{
              padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'white',
              border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
            }}>Clear</button>
            <span style={{ flex: 1 }} />
            {confirmBulkDelete ? (
              <>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ffb4b4' }}>
                  Delete {selectedIds.size} editor{selectedIds.size === 1 ? '' : 's'} forever? Their tasks become Unassigned.
                </span>
                <button onClick={() => setConfirmBulkDelete(false)} disabled={busy} style={{
                  padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: 'transparent', color: 'white',
                  border: '1px solid rgba(255,255,255,0.5)', cursor: 'pointer',
                }}>Cancel</button>
                <button onClick={bulkDelete} disabled={busy} style={{
                  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: '#b53e3e', color: 'white', border: 'none', cursor: 'pointer',
                }}>{busy ? 'Deleting…' : 'Delete forever'}</button>
              </>
            ) : (
              <button onClick={() => setConfirmBulkDelete(true)} style={{
                padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'var(--accent)', color: 'var(--ink)',
                border: 'none', cursor: 'pointer',
              }}>Delete {selectedIds.size}</button>
            )}
          </div>
        )}

        {/* Roster table */}
        <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '24px 32px minmax(140px, 1fr) 70px 70px 70px 70px 80px 60px',
            gap: 10, padding: '10px 14px',
            background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>
            <div></div>
            <div></div>
            <div>Name</div>
            <div>Format</div>
            <div>Tier</div>
            <div style={{ textAlign: 'right' }}>Open</div>
            <div style={{ textAlign: 'right' }}>Done</div>
            <div>Active</div>
            <div></div>
          </div>
          {editors.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
              No editors yet — add one above.
            </div>
          )}
          {editors.map((e, i) => {
            const c = counts[e.id] || { open: 0, done: 0 }
            const color = editorColor(e)
            const isSel = selectedIds.has(e.id)
            return (
              <div key={e.id} onClick={() => onOpenEditor(e)} style={{
                display: 'grid',
                gridTemplateColumns: '24px 32px minmax(140px, 1fr) 70px 70px 70px 70px 80px 60px',
                gap: 10, padding: '10px 14px', alignItems: 'center',
                borderBottom: i === editors.length - 1 ? 'none' : '1px solid var(--rule)',
                cursor: 'pointer', transition: 'background 0.12s',
                opacity: e.active ? 1 : 0.55,
                background: isSel ? 'rgba(244,225,74,0.15)' : 'transparent',
              }}
                onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = 'transparent' }}>
                {isSelf(e.id) ? (
                  <div title="This is you — you can't remove your own access"
                    style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="var(--ink-4)" strokeWidth="1.5" />
                      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="var(--ink-4)" strokeWidth="1.5" />
                    </svg>
                  </div>
                ) : (
                  <div onClick={ev => { ev.stopPropagation(); toggleSel(e.id) }}
                    style={{
                      width: 16, height: 16, borderRadius: 2,
                      border: isSel ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                      background: isSel ? 'var(--accent)' : 'white',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer',
                    }}>
                    {isSel && (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )}
                <span style={{ width: 18, height: 18, borderRadius: 3, background: color }} />
                <div style={{ fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
                  {e.name}
                  {!e.active && <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>(inactive)</span>}
                </div>
                <div>
                  <FormatBadge format={e.format} />
                </div>
                <div>
                  <TierBadge tier={e.tier} />
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>{c.open}</div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>{c.done}</div>
                <div>
                  <label onClick={ev => ev.stopPropagation()}
                    title={isSelf(e.id) ? "You can't deactivate yourself" : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: isSelf(e.id) ? 'not-allowed' : 'pointer' }}>
                    <input type="checkbox" checked={e.active} disabled={isSelf(e.id)}
                      onChange={() => toggleActive(e)} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                      {e.active ? 'Active' : 'Off'}
                    </span>
                  </label>
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                  Edit
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

/* Dedicated share-with-editor modal — opens straight from the toolbar so
   Ben doesn't have to dig through Manage Editors → click row → scroll.
   Two link types:
     1. TEAM-WIDE link (no editor_id binding) — anyone can see the whole queue
     2. Per-editor links (editor_id bound) — filtered to one editor's tasks */
function ShareLinksModal({ editors, onClose }) {
  const [links, setLinks] = useState({})   // editor_id -> link row
  const [teamLink, setTeamLink] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyEditor, setBusyEditor] = useState(null)
  const [busyTeam, setBusyTeam] = useState(false)
  const [copyOk, setCopyOk] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          setErr('Migration 077 not yet applied — share links unavailable')
        } else {
          const m = {}
          let team = null
          for (const link of (data || [])) {
            if (link.editor_id) {
              if (!m[link.editor_id]) m[link.editor_id] = link
            } else if (!team) {
              team = link  // most recent team-wide link
            }
          }
          setLinks(m)
          setTeamLink(team)
        }
        setLoading(false)
      })
    return () => { mounted = false }
  }, [])

  const generateTeamLink = async () => {
    setBusyTeam(true); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: null,
        label: 'Team-wide link',
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyTeam(false)
    if (error) setErr(error.message)
    else setTeamLink(data)
  }
  const revokeTeamLink = async () => {
    if (!teamLink) return
    setBusyTeam(true)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', teamLink.id)
    setTeamLink(null)
    setBusyTeam(false)
  }

  const generate = async (editor) => {
    setBusyEditor(editor.id); setErr(null)
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    setBusyEditor(null)
    if (error) setErr(error.message)
    else setLinks({ ...links, [editor.id]: data })
  }

  const revoke = async (link) => {
    setBusyEditor(link.editor_id); setErr(null)
    await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', link.id)
    const next = { ...links }
    delete next[link.editor_id]
    setLinks(next)
    setBusyEditor(null)
  }

  const buildUrl = (token) => `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    try {
      await navigator.clipboard.writeText(buildUrl(token))
      setCopyOk(token); setTimeout(() => setCopyOk(null), 1800)
    } catch {}
  }

  return (
    <Modal open={true} onClose={onClose} size="lg"
      eyebrow="Share"
      title="Share the editor portal"
      subtitle="One link the whole team uses, OR per-editor links. No login required for either."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        {loading ? (
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* Team-wide link — the primary CTA. One link, everyone sees
                everything, can upload their own finished work, can update
                their own task status. */}
            <div style={{
              padding: '16px 18px', marginBottom: 20,
              background: '#fffaea', border: '2px solid #e8b408',
              borderRadius: 2,
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7a4e08',
                marginBottom: 4,
              }}>Team-wide link · recommended</div>
              <div style={{
                fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500,
                color: 'var(--ink)', marginBottom: 12,
              }}>
                One link for the whole editing team
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center',
              }}>
                {teamLink ? (
                  <>
                    <div style={{
                      padding: '8px 12px', background: 'white', border: '1px solid var(--rule)',
                      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={buildUrl(teamLink.token)}>{buildUrl(teamLink.token)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => copyLink(teamLink.token)} style={{
                        padding: '8px 16px',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: copyOk === teamLink.token ? '#3e8a5e' : '#e8b408',
                        color: copyOk === teamLink.token ? 'white' : '#3a2a08',
                        border: 'none', cursor: 'pointer',
                      }}>{copyOk === teamLink.token ? '✓ Copied' : '↗ Copy link'}</button>
                      <button onClick={revokeTeamLink} disabled={busyTeam} style={{
                        padding: '8px 12px',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: '#b53e3e',
                        border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                      }}>Revoke</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
                      No team-wide link yet
                    </span>
                    <button onClick={generateTeamLink} disabled={busyTeam} style={{
                      padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: '#e8b408', color: '#3a2a08',
                      border: 'none', cursor: 'pointer',
                    }}>{busyTeam ? '…' : '+ Generate team link'}</button>
                  </>
                )}
              </div>
              <p style={{
                marginTop: 10, fontFamily: 'var(--serif)', fontSize: 12.5,
                color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.45, margin: '10px 0 0',
              }}>
                Anyone with this link sees the whole queue (all editors' tasks), the full creative
                library, and can <strong>upload finished work</strong> — even without an assigned task.
                You review + assign it from your admin view. They can't delete creatives or manage
                editors.
              </p>
            </div>

            {/* Per-editor links — secondary */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
              marginBottom: 10,
            }}>Per-editor links (optional)</div>
            {editors.length === 0 ? (
              <div style={{
                padding: 16, textAlign: 'center', border: '1px dashed var(--rule)',
                fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12,
              }}>
                No active editors. Add one in Manage editors first.
              </div>
            ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {editors.map(e => {
              const link = links[e.id]
              const color = editorColor(e)
              return (
                <div key={e.id} style={{
                  padding: '12px 14px', background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 14, alignItems: 'center',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: color }} />
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{e.name}</span>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    {link ? (
                      <div style={{
                        padding: '6px 10px', background: 'var(--paper-2)',
                        border: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={buildUrl(link.token)}>{buildUrl(link.token)}</div>
                    ) : (
                      <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12 }}>
                        No active link yet
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {link ? (
                      <>
                        <button onClick={() => copyLink(link.token)} style={{
                          padding: '6px 12px',
                          fontFamily: 'var(--mono)', fontSize: 10.5,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: copyOk === link.token ? '#3e8a5e' : 'var(--ink)',
                          color: copyOk === link.token ? 'white' : 'var(--paper)',
                          border: 'none', cursor: 'pointer',
                        }}>{copyOk === link.token ? '✓ Copied' : '↗ Copy link'}</button>
                        <button onClick={() => revoke(link)}
                          disabled={busyEditor === e.id} style={{
                            padding: '6px 10px',
                            fontFamily: 'var(--mono)', fontSize: 10,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: 'transparent', color: '#b53e3e',
                            border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                          }}>Revoke</button>
                      </>
                    ) : (
                      <button onClick={() => generate(e)}
                        disabled={busyEditor === e.id} style={primaryBtn}>
                        {busyEditor === e.id ? '…' : 'Generate'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p style={{
          marginTop: 14, fontFamily: 'var(--serif)', fontSize: 12.5,
          color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.5,
        }}>
          Per-editor links narrow the view to that editor's tasks only. Use these
          if you want a contractor to see exactly what they're working on and nothing else.
        </p>
          </>
        )}
      </div>
    </Modal>
  )
}

function EditEditorModal({ editor, selfEditorId, onClose, onSavedPatch, onDeleted }) {
  const [name, setName] = useState(editor.name || '')
  const [email, setEmail] = useState(editor.email || '')
  const [active, setActive] = useState(editor.active !== false)
  const [notes, setNotes] = useState(editor.notes || '')
  const [color, setColor] = useState(editor.color || '')
  const [format, setFormat] = useState(editor.format || 'both')
  const [tier, setTier] = useState(editor.tier || 'editor')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)
  // Self-lockout guard: a coordinator editing their own row from the
  // portal can't deactivate / delete / demote themselves. selfEditorId is
  // null for Ben on the dashboard, so nothing is blocked there.
  const isSelf = selfEditorId != null && editor.id === selfEditorId
  // Share links state — load existing + allow generate / revoke
  const [links, setLinks] = useState([])
  const [linksLoading, setLinksLoading] = useState(true)
  const [copyOk, setCopyOk] = useState(null)

  const [linksAvailable, setLinksAvailable] = useState(true)
  useEffect(() => {
    let mounted = true
    supabase.from('lib_editor_share_links')
      .select('*')
      .eq('editor_id', editor.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          // Migration 077 hasn't been applied yet — degrade gracefully
          setLinksAvailable(false)
        } else {
          setLinks(data || [])
        }
        setLinksLoading(false)
      })
    return () => { mounted = false }
  }, [editor.id])

  const generateLink = async () => {
    // Random URL-safe token, 28 chars
    const arr = new Uint8Array(21)
    crypto.getRandomValues(arr)
    const token = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const { data, error } = await supabase.from('lib_editor_share_links')
      .insert({
        token, editor_id: editor.id,
        label: `${editor.name}'s share link`,
        created_by: 'admin',
      })
      .select()
      .single()
    if (error) setErr(error.message)
    else setLinks([data, ...links])
  }
  const revokeLink = async (id) => {
    const { error } = await supabase.from('lib_editor_share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
    if (error) setErr(error.message)
    else setLinks(links.map(l => l.id === id ? { ...l, revoked_at: new Date().toISOString() } : l))
  }
  const buildUrl = (token) =>
    `${window.location.origin}/editor-view/${token}`
  const copyLink = async (token) => {
    try {
      await navigator.clipboard.writeText(buildUrl(token))
      setCopyOk(token); setTimeout(() => setCopyOk(null), 1800)
    } catch {}
  }

  const save = async () => {
    setBusy(true); setErr(null)
    const patch = {
      name: name.trim(),
      // email enables magic-link login on /editor-login. Store lowercased
      // for case-insensitive matching against auth.user.email.
      email: email.trim() ? email.trim().toLowerCase() : null,
      active, notes: notes || null, color: color || null,
      format, tier,
    }
    const { error } = await supabase.from('lib_creative_editors')
      .update(patch).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSavedPatch?.(patch)  // parent merges in place; no full refetch
  }
  const deactivate = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .update({ active: false }).eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSavedPatch?.({ active: false })  // soft-deactivate, keep editor in roster
  }
  // Hard delete — removes the row entirely. Editing tasks that referenced
  // this editor get editor_id=NULL via ON DELETE SET NULL (per migration 075).
  const hardDelete = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('lib_creative_editors')
      .delete().eq('id', editor.id)
    setBusy(false)
    if (error) setErr(error.message)
    else onDeleted?.(editor.id)
  }
  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="Edit editor"
      title={editor.name}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          {confirmDeactivate ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>Deactivate this editor? Their existing tasks stay.</span>
              <button onClick={() => setConfirmDeactivate(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={deactivate} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Deactivate'}
              </button>
            </>
          ) : confirmHardDelete ? (
            <>
              <span style={{ fontSize: 12, color: '#b53e3e', marginRight: 'auto' }}>
                Permanently delete? Their existing tasks become Unassigned. Can't be undone.
              </span>
              <button onClick={() => setConfirmHardDelete(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={hardDelete} disabled={busy} style={{ ...primaryBtn, background: '#b53e3e', borderColor: '#b53e3e' }}>
                {busy ? '…' : 'Delete forever'}
              </button>
            </>
          ) : (
            <>
              {isSelf ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)', marginRight: 'auto', fontStyle: 'italic' }}>
                  This is you — you can't deactivate, delete, or change your own permission.
                </span>
              ) : (
                <>
                  <button onClick={() => setConfirmDeactivate(true)} disabled={busy} style={{
                    ...ghostBtn, color: 'var(--ink-3)', borderColor: 'var(--rule)', marginRight: 4,
                  }}>Deactivate</button>
                  <button onClick={() => setConfirmHardDelete(true)} disabled={busy} style={{
                    ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
                  }}>Delete forever</button>
                </>
              )}
              <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={save} disabled={!name.trim() || busy} style={primaryBtn}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        <Field label="Name">
          <input type="text" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Email — enables magic-link login at /editor-login">
          <input type="email" value={email}
            placeholder="dean@opt.co.nz"
            onChange={e => setEmail(e.target.value)}
            style={inputStyle} />
          <div style={{
            marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10,
            color: editor.auth_user_id ? '#3e8a5e' : 'var(--ink-4)',
            letterSpacing: '0.04em',
          }}>
            {editor.auth_user_id
              ? 'This editor has logged in at least once'
              : email.trim()
                ? 'Send them /editor-login — they enter this email + get a magic link'
                : 'Without an email, this editor can only access via legacy share-link token'}
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Format">
            <select value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
              <option value="shorts">Shorts</option>
              <option value="long">Long-form</option>
              <option value="both">Both</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              What this editor primarily cuts. Used to filter assignment pickers.
            </div>
          </Field>
          <Field label="Permission">
            <select value={tier} onChange={e => setTier(e.target.value)} disabled={isSelf} style={inputStyle}>
              <option value="editor">Editor</option>
              <option value="admin">Admin (manages editors)</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              {isSelf
                ? "You can't change your own permission."
                : 'Admins can invite, remove + set permissions for editors from the portal. Does not grant sales-dashboard access.'}
            </div>
          </Field>
        </div>
        <Field label="Color">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Reset to auto (hash-derived) */}
            <button type="button" onClick={() => setColor('')}
              title="Use the auto color (hash from name)"
              style={{
                width: 28, height: 28, borderRadius: 4,
                background: 'repeating-linear-gradient(45deg, var(--paper), var(--paper) 4px, var(--rule) 4px, var(--rule) 6px)',
                border: !color ? '2px solid var(--ink)' : '1px solid var(--rule)',
                cursor: 'pointer',
              }} />
            {EDITOR_COLORS.map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                title={c}
                style={{
                  width: 28, height: 28, borderRadius: 4,
                  background: c,
                  border: color === c ? '2px solid var(--ink)' : '1px solid rgba(0,0,0,0.15)',
                  cursor: 'pointer',
                }} />
            ))}
            <input type="color" value={color || editorColor({ slug: editor.slug, color: null })}
              onChange={e => setColor(e.target.value)}
              title="Pick a custom hex color"
              style={{ width: 28, height: 28, border: '1px solid var(--rule)', borderRadius: 4, cursor: 'pointer', background: 'white', padding: 0 }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            {color ? `Custom: ${color}` : 'Auto (hash of name)'}
          </div>
        </Field>
        <Field label="Active">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--sans)', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            Editor is currently working on the team
          </label>
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Internal notes about this editor (specialty, working hours, etc.)" />
        </Field>

        {/* Share links — for giving editors a public /editor-view URL */}
        <Field label="Share link">
          {linksLoading ? (
            <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>Loading…</div>
          ) : !linksAvailable ? (
            <div style={{
              padding: '10px 12px', background: 'rgba(184,106,12,0.08)',
              border: '1px solid rgba(184,106,12,0.3)',
              fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-2)',
            }}>
              <strong>Pending migration 077.</strong> Apply <code style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'white', padding: '1px 5px' }}>supabase/migrations/077_editor_share_links.sql</code> in Supabase Studio → SQL Editor to enable share links. Existing functionality is unaffected.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {links.filter(l => !l.revoked_at).map(l => (
                <div key={l.id} style={{
                  padding: '8px 12px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{buildUrl(l.token)}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginTop: 2 }}>
                      Created {new Date(l.created_at).toLocaleDateString()}
                      {l.last_used_at && ` · last used ${new Date(l.last_used_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button onClick={() => copyLink(l.token)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: copyOk === l.token ? '#3e8a5e' : 'white',
                    color: copyOk === l.token ? 'white' : 'var(--ink-2)',
                    border: '1px solid ' + (copyOk === l.token ? '#3e8a5e' : 'var(--rule)'),
                    cursor: 'pointer',
                  }}>{copyOk === l.token ? 'Copied' : 'Copy'}</button>
                  <button onClick={() => revokeLink(l.id)} style={{
                    padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: 'transparent', color: '#b53e3e',
                    border: '1px solid rgba(181,62,62,0.4)', cursor: 'pointer',
                  }}>Revoke</button>
                </div>
              ))}
              <button onClick={generateLink} style={{
                ...ghostBtn, justifySelf: 'flex-start',
              }}>+ Generate share link</button>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                Anyone with the link can view {editor.name}'s queue + the creative library, and update
                task status. They can't delete creatives, change canonical names, or manage editors.
                Revoke to kill access.
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  )
}

function AddEditorModal({ onClose, onSaved }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [format, setFormat] = useState('both')  // shorts | long | both
  const [tier, setTier] = useState('editor')    // editor | admin
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // After a successful add we show a confirmation (incl. invite outcome)
  // instead of closing, so the admin can see whether the welcome email
  // went out and add another in one sitting. { name, email, inviteStatus }
  const [result, setResult] = useState(null)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const cleanEmail = email.trim() ? email.trim().toLowerCase() : null
    const { error } = await supabase.from('lib_creative_editors').insert({
      name: name.trim(),
      slug,
      // Email enables magic-link login. Lowercased for case-insensitive
      // matching against auth.user.email. Optional — editor can be
      // added without one and gets onboarded via legacy share-link.
      email: cleanEmail,
      format,
      tier,
    })
    if (error) { setBusy(false); setErr(error.message); return }
    // Auto-send the branded welcome invite (best-effort). The row exists
    // now, so the Edge Function's active-roster guard will find it.
    const inviteStatus = await sendEditorInvite(cleanEmail, name.trim())
    setBusy(false)
    setResult({ name: name.trim(), email: cleanEmail, inviteStatus })
  }
  const addAnother = () => {
    setResult(null); setName(''); setEmail(''); setFormat('both'); setTier('editor'); setErr(null)
  }
  // onSaved closes + reloads the parent roster. Used by Done after the
  // confirmation, so freshly-added editors show up on close.
  const finish = () => onSaved?.()

  if (result) {
    const { inviteStatus } = result
    const inviteLine =
      inviteStatus === 'sent'    ? { color: '#3e8a5e', text: `Invite emailed to ${result.email}. They log in at /editor-login — no password needed.` }
      : inviteStatus === 'skipped' ? { color: 'var(--ink-3)', text: 'No email yet — add one via Edit to enable their login + send an invite.' }
      :                            { color: '#a8650f', text: `Couldn't send the invite email. ${result.name} can still log in at /editor-login with ${result.email || 'their email'} — or resend later.` }
    return (
      <Modal open={true} onClose={finish} size="sm"
        eyebrow="Editor added"
        title={result.name}
        footer={
          <>
            <button onClick={addAnother} style={ghostBtn}>Add another</button>
            <button onClick={finish} style={primaryBtn}>Done</button>
          </>
        }>
        <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
          <div style={{
            padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
            borderLeft: '3px solid var(--accent)',
            fontFamily: 'var(--sans)', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.5,
          }}>
            <strong>{result.name}</strong> is now on the editor roster.
          </div>
          <div style={{
            fontFamily: 'var(--sans)', fontSize: 13, color: inviteLine.color, lineHeight: 1.5,
          }}>
            {inviteLine.text}
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="sm"
      eyebrow="New editor"
      title="Add an editor"
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || busy} style={primaryBtn}>
            {busy ? 'Adding…' : 'Add + invite'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        <Field label="Name">
          <input type="text" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Sarah" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </Field>
        <Field label="Email — sends a login invite (recommended)">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="sarah@opt.co.nz" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
            With an email we send a branded welcome + they log in at /editor-login. Without one, they can only be reached via a legacy share link.
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Format">
            <select value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
              <option value="shorts">Shorts</option>
              <option value="long">Long-form</option>
              <option value="both">Both</option>
            </select>
          </Field>
          <Field label="Permission">
            <select value={tier} onChange={e => setTier(e.target.value)} style={inputStyle}>
              <option value="editor">Editor</option>
              <option value="admin">Admin (manages editors)</option>
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', marginTop: 6 }}>
              Admins can invite, remove + set permissions for editors from the portal. Does not grant sales-dashboard access.
            </div>
          </Field>
        </div>
      </div>
    </Modal>
  )
}

function AddTaskModal({ editors, onClose, onSaved, prefillEditorId = '', prefillDue = '', prefillStart = '', existingTaskCreativeIds = null }) {
  const [mode, setMode] = useState('pick')   // 'pick' or 'upload'
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  // Default: only show creatives that need editing (status='raw'),
  // hide stuff that's already been edited (Body/Hook/Joined-edited
  // sitting in the library as finished outputs). Ben asked for this
  // because the modal was firehosing 50 already-edited Body files
  // before the operator could find a raw clip to assign.
  const [statusFilter, setStatusFilter] = useState('raw')  // 'raw' | 'all'
  // Default: hide creatives that already have an open editing task —
  // no point re-assigning something that's already in someone's queue.
  const [hideAssigned, setHideAssigned] = useState(true)
  // Selected creative(s) — Set of ids. UI toggles between single and multi:
  // checkbox per row + a "Select all visible" affordance.
  const [creativeIds, setCreativeIds] = useState(() => new Set())
  // Upload-mode state. Multi-file: dropping N files creates N library
  // rows + N tasks in one go (Ben 2026-06-11 — "bulk upload isn't
  // available here"). With one file the name stays editable; with
  // several, names derive from the filenames.
  const [uploadFiles, setUploadFiles] = useState([])
  const [uploadName, setUploadName] = useState('')
  const [uploadType, setUploadType] = useState('Joined')
  const [uploadProgress, setUploadProgress] = useState(null)
  const uploadInputRef = useRef(null)
  // Common state — accept pre-fill from Timeline drag
  const [editorId, setEditorId] = useState(prefillEditorId || '')
  const [taskType, setTaskType] = useState('edit')
  const [priority, setPriority] = useState('P2 - Medium')
  const [due, setDue] = useState(prefillDue || '')
  // Optional start date — if user dragged across multiple days in the
  // timeline, we capture the first day as the task's assigned_at.
  const [startDate, setStartDate] = useState(prefillStart || '')
  // Optional project name applied as canonical_name prefix when assigning
  // multiple creatives at once — Ben asked to "rename the project for
  // multiple videos" in one shot from this modal.
  const [projectName, setProjectName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    // Pull status + manually_marked_used too so we can client-side
    // filter to "raw / needs editing" without a second query when the
    // operator flips the toggle.
    supabase.from('lib_creative_library')
      .select('id,name,canonical_name,type,creator,thumbnail_url,description,status,manually_marked_used')
      .eq('exclude_from_library', false)
      .order('canonical_name', { ascending: true })
      .limit(500)
      .then(({ data }) => setCreatives(data || []))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const assignedSet = existingTaskCreativeIds instanceof Set
      ? existingTaskCreativeIds
      : new Set(existingTaskCreativeIds || [])
    const matchesStatus = (c) => {
      if (statusFilter === 'all') return true
      // 'raw' = needs editing. Library uses status='raw' to mark the
      // pre-edited source, status='edited' for finished outputs.
      // manually_marked_used=true means the operator has flagged an
      // otherwise-raw clip as already-used elsewhere (don't reassign).
      return c.status === 'raw' && c.manually_marked_used !== true
    }
    const matchesSearch = (c) => {
      if (!q) return true
      return (rowDisplayName(c) || '').toLowerCase().includes(q)
          || (c.name || '').toLowerCase().includes(q)
    }
    const matchesAssigned = (c) => {
      if (!hideAssigned) return true
      return !assignedSet.has(c.id)
    }
    return creatives
      .filter(c => matchesStatus(c) && matchesAssigned(c) && matchesSearch(c))
      .slice(0, 50)
  }, [creatives, search, statusFilter, hideAssigned, existingTaskCreativeIds])

  // Counts so the operator sees what each filter is doing.
  const rawCount     = useMemo(() => creatives.filter(c => c.status === 'raw' && c.manually_marked_used !== true).length, [creatives])
  const editedCount  = useMemo(() => creatives.length - rawCount, [creatives, rawCount])

  const onFilePick = (fileList) => {
    const files = Array.from(fileList || []).filter(f => f && f.size > 0)
    if (!files.length) return
    setUploadFiles(files)
    // Single file: auto-fill the editable name from the filename.
    if (files.length === 1 && !uploadName) setUploadName(files[0].name.replace(/\.[^.]+$/, ''))
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      let cids = []
      // Upload mode: upload each file → insert a library row each → one
      // task per row. Sequential per file (TUS chunks parallelise within
      // a file already); overall progress maps file i of N onto 10-85%.
      if (mode === 'upload') {
        if (!uploadFiles.length || (uploadFiles.length === 1 && !uploadName.trim())) {
          setErr('Pick at least one file (and a name for a single file)'); setBusy(false); return
        }
        const n = uploadFiles.length
        const span = 75 / n   // each file's slice of the 10-85% window
        for (let i = 0; i < n; i++) {
          const file = uploadFiles[i]
          const base = 10 + i * span
          setUploadProgress(Math.floor(base))
          const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
          const storagePath = `edited/${Date.now()}_${sanitized}`
          // Resumable upload (TUS) — single-POST .upload() silently failed
          // on multi-hundred-MB files routed through "+ Add task". 6MB
          // chunks, retries, fingerprinted by (bucket,path), and refuses
          // to resolve unless verifyUploaded confirms the object exists.
          let lastUploadPct = -1
          await uploadWithResume(file, {
            bucket: 'creative-uploads',
            path: storagePath,
            contentType: file.type || 'video/mp4',
            onProgress: (frac) => {
              const pct = Math.floor(base + frac * span * 0.7)
              if (pct !== lastUploadPct) { lastUploadPct = pct; setUploadProgress(pct) }
            },
          })
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`

          // Thumbnail: pre-upload File path first (fast, < 500 MB) then
          // post-upload URL path (HTTP-range, any size) — without it the
          // new row lands as a black square on the kanban.
          let thumbnailUrl = null
          let thumbBlob = await captureVideoThumbnail(file)
          if (!thumbBlob) {
            thumbBlob = await captureVideoThumbnailFromUrl(publicUrl)
          }
          if (thumbBlob) {
            const thumbPath = `edited/${Date.now()}_${sanitized}_thumb.jpg`
            const { error: thumbErr } = await supabase.storage
              .from('creative-uploads')
              .upload(thumbPath, thumbBlob, { upsert: true, contentType: 'image/jpeg' })
            if (!thumbErr) {
              thumbnailUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${thumbPath}`
            }
          }

          const ext = (file.name.match(/\.[^.]+$/) || [''])[0]
          const rowName = n === 1
            ? uploadName.trim() + ext
            : file.name   // bulk: filenames are the names
          const { data: newRow, error: insErr } = await supabase.from('lib_creative_library')
            .insert({
              name: rowName,
              type: uploadType,
              size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
              status: 'review',
              source_bucket: 'Editor upload (via Add task)',
              preview_url: publicUrl,
              drive_url: publicUrl,
              thumbnail_url: thumbnailUrl,
              notes: `Uploaded ${new Date().toISOString().slice(0,10)} alongside a new task. Pending review + assignment.`,
            })
            .select()
            .single()
          if (insErr) throw insErr
          cids.push(newRow.id)
        }
        setUploadProgress(85)
      } else {
        cids = Array.from(creativeIds)
      }
      if (cids.length === 0) { setErr('Pick one or more creatives or upload a new file'); setBusy(false); return }

      // Optional: tag the picked creatives with a shared project name.
      // PRE-2026-05-31 BEHAVIOUR was to overwrite canonical_name with
      // "<projectName> 1", "<projectName> 2", ... — that produced messes
      // like JOINED-OSO-ERIC-GOOGLERANKINGRES-T01.mp4 that don't match
      // the auto-generated bulletproof format and made the editor view
      // unreadable. The shared tag now lives in project_tag (filterable,
      // groupable) and the display_name stays untouched.
      // Self-heal pattern: if migration 103 hasn't been applied yet, the
      // project_tag column won't exist and a 42703 error would kill the
      // whole assign-creative flow. Catch the column-missing error and
      // continue silently — the rest of the task assignment still lands.
      if (projectName.trim() && mode === 'pick') {
        const proj = projectName.trim()
        for (const id of cids) {
          const { error: rnErr } = await supabase.from('lib_creative_library')
            .update({ project_tag: proj })
            .eq('id', id)
          if (rnErr && rnErr.code !== '42703') throw rnErr
          if (rnErr && rnErr.code === '42703') {
            // Migration 103 not applied yet. Log once + stop trying the
            // remaining IDs — they'd all hit the same error.
            console.warn('project_tag column missing — apply migration 103 to enable project tagging. Skipping tag write.')
            break
          }
        }
      }

      // Insert ONE task per selected creative
      // If the user dragged across days in Timeline, startDate is set —
      // we use it as assigned_at so the bar in Timeline spans from start
      // to due_date instead of from "now" to due.
      const assignedAt = startDate ? new Date(startDate + 'T00:00:00Z').toISOString() : null
      const rows = cids.map(creative_id => ({
        creative_id,
        editor_id: editorId || null,
        task_type: taskType, priority, due_date: due || null,
        ...(assignedAt ? { assigned_at: assignedAt } : {}),
        status: editorId ? 'queued' : 'review',
      }))
      // Insert + return the new rows joined as they appear in
      // lib_editing_queue so the parent can optimistically prepend
      // them to its state. Without this, the parent has to refetch
      // and the new task doesn't visibly land in the queue until the
      // refetch returns (or the user reloads). Ben flagged this as
      // "kind of annoying" 2026-05-23.
      const { data: insertedIds, error: taskErr } = await supabase
        .from('lib_editing_tasks')
        .insert(rows)
        .select('id')
      if (taskErr) throw taskErr
      // Pull the queue-view rows for the just-inserted task ids so the
      // shape matches what the parent already has in state.
      let newQueueRows = []
      if (insertedIds && insertedIds.length) {
        const ids = insertedIds.map(r => r.id)
        const { data: viewRows } = await supabase
          .from('lib_editing_queue')
          .select('*')
          .in('task_id', ids)
        if (viewRows) newQueueRows = viewRows
      }
      setUploadProgress(100)
      onSaved?.(newQueueRows)
    } catch (e) {
      setErr(e.message || 'failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'pick'
    ? creativeIds.size > 0
    : uploadFiles.length > 0 && (uploadFiles.length > 1 || !!uploadName.trim())
  const toggleCreative = (id) => {
    setCreativeIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} size="lg"
      eyebrow="New task"
      title="Add a task"
      subtitle="Either pick an existing creative to assign, or upload your finished output and we'll create a new library row for it."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit || busy} style={primaryBtn}>
            {busy
              ? (mode === 'upload' ? `Uploading… ${uploadProgress || 0}%` : 'Adding…')
              : (mode === 'upload'
                  ? (uploadFiles.length > 1 ? `Upload ${uploadFiles.length} + add tasks` : 'Upload + add task')
                  : 'Add task')}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Mode tabs */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
          <button onClick={() => setMode('pick')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'pick' ? 'var(--ink)' : 'transparent',
            color: mode === 'pick' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>Pick existing</button>
          <button onClick={() => setMode('upload')} style={{
            padding: '8px 18px', flex: 1,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: mode === 'upload' ? 'var(--ink)' : 'transparent',
            color: mode === 'upload' ? 'var(--paper)' : 'var(--ink-3)',
            border: 'none', cursor: 'pointer',
          }}>↗ Upload new file</button>
        </div>

        {mode === 'pick' ? (
          <>
            <Field label={`Creatives ${creativeIds.size > 0 ? `· ${creativeIds.size} selected` : ''}`}>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name…" style={{ ...inputStyle, marginBottom: 8 }} />
              {/* Two-tab status filter: default to RAW (needs editing).
                  Without this the modal firehoses 50 already-edited Body
                  files at the top and the operator has to scroll to find
                  a raw clip. Ben's ask 2026-05-23. */}
              <div style={{
                display: 'flex', gap: 4, marginBottom: 8,
                border: '1px solid var(--rule)', padding: 3,
              }}>
                {[
                  { value: 'raw', label: `Needs editing · ${rawCount}` },
                  { value: 'all', label: `All · ${rawCount + editedCount}` },
                ].map(opt => {
                  const selected = statusFilter === opt.value
                  return (
                    <button key={opt.value} type="button"
                      onClick={() => setStatusFilter(opt.value)}
                      style={{
                        flex: 1, padding: '6px 8px', cursor: 'pointer',
                        fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: selected ? 'var(--ink)' : 'transparent',
                        color: selected ? 'var(--paper)' : 'var(--ink-3)',
                        border: 'none',
                      }}>{opt.label}</button>
                  )
                })}
              </div>
              {/* Hide-assigned toggle. Prevents the operator from picking
                  a creative that's already in someone else's task queue. */}
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginBottom: 8, cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
              }}>
                <input type="checkbox" checked={hideAssigned}
                  onChange={e => setHideAssigned(e.target.checked)} />
                Hide creatives already in an open task
              </label>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginBottom: 6, gap: 8,
              }}>
                <button type="button"
                  onClick={() => setCreativeIds(new Set(filtered.map(c => c.id)))}
                  style={{
                    padding: '4px 9px',
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                    textTransform: 'uppercase', background: 'transparent',
                    border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-2)',
                  }}>Select all visible ({filtered.length})</button>
                {creativeIds.size > 0 && (
                  <button type="button" onClick={() => setCreativeIds(new Set())}
                    style={{
                      padding: '4px 9px',
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                      textTransform: 'uppercase', background: 'transparent',
                      border: '1px solid var(--rule)', cursor: 'pointer', color: 'var(--ink-3)',
                    }}>Clear</button>
                )}
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--rule)' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 12, fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 12 }}>
                    No matches.
                  </div>
                )}
                {filtered.map(c => {
                  const isOn = creativeIds.has(c.id)
                  return (
                    <div key={c.id}
                      onClick={() => toggleCreative(c.id)}
                      style={{
                        padding: '6px 10px', cursor: 'pointer',
                        background: isOn ? 'rgba(244,225,74,0.18)' : 'transparent',
                        borderBottom: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 11.5,
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                      <span style={{
                        width: 16, height: 16, borderRadius: 2,
                        border: isOn ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
                        background: isOn ? 'var(--accent)' : 'white',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {isOn && (
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                              strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {/* Thumbnail — visual ID for cryptic canonical names */}
                      <div style={{
                        width: 48, height: 32, background: '#000',
                        border: '1px solid var(--rule)',
                        overflow: 'hidden', flexShrink: 0,
                      }}>
                        {c.thumbnail_url ? (
                          <img src={c.thumbnail_url} alt="" loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        ) : (
                          <div style={{
                            width: '100%', height: '100%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                          }}>—</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontWeight: 500,
                        }}>{rowDisplayName(c)}</div>
                        {c.description && (
                          <div style={{
                            fontFamily: 'var(--sans)', fontSize: 10.5, color: 'var(--ink-3)',
                            marginTop: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{c.description}</div>
                        )}
                      </div>
                      <span style={{ color: 'var(--ink-4)', fontSize: 10 }}>{c.type}</span>
                    </div>
                  )
                })}
              </div>
            </Field>
            {/* Project tag — applies a shared project_tag to all selected
                creatives WITHOUT touching their display_name. Lets you
                group / filter by project ("HAMMER campaign") without
                trashing the bulletproof name format. */}
            {creativeIds.size > 0 && (
              <Field label={creativeIds.size === 1 ? 'Optional: project tag' : `Optional: tag all ${creativeIds.size} with a project name`}>
                <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)}
                  placeholder='e.g. HAMMER campaign'
                  style={inputStyle} />
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 4 }}>
                  Filter by this tag in the library. Display names stay intact.
                </div>
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Upload your finished files">
              <div
                onClick={() => !busy && uploadInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); onFilePick(e.dataTransfer.files) }}
                onDragOver={e => e.preventDefault()}
                style={{
                  padding: 24, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
                  border: '2px dashed var(--rule)',
                  background: uploadFiles.length ? 'white' : 'var(--paper-2)',
                }}>
                <input ref={uploadInputRef} type="file" accept="video/*" multiple
                  style={{ display: 'none' }}
                  onChange={e => onFilePick(e.target.files)} />
                {uploadFiles.length > 0 ? (
                  <>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>
                      {uploadFiles.length === 1
                        ? uploadFiles[0].name
                        : `${uploadFiles.length} files — one task each`}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                      {(uploadFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB total · click to change
                    </div>
                    {uploadFiles.length > 1 && (
                      <div style={{
                        marginTop: 8, textAlign: 'left', maxHeight: 110, overflowY: 'auto',
                        fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', lineHeight: 1.7,
                      }}>
                        {uploadFiles.map(f => <div key={f.name}>· {f.name}</div>)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                      Drop your finished file(s) here
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 4 }}>
                      or click to select · multiple files = one task each
                    </div>
                  </>
                )}
              </div>
              {uploadProgress != null && (
                <div style={{ marginTop: 8, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${uploadProgress}%`, height: '100%',
                    background: uploadProgress === 100 ? '#3e8a5e' : 'var(--accent)',
                    transition: 'width 0.2s',
                  }} />
                </div>
              )}
            </Field>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '2fr 1fr' }}>
              {uploadFiles.length <= 1 ? (
                <Field label="Name this creative">
                  <input type="text" value={uploadName} onChange={e => setUploadName(e.target.value)}
                    placeholder="e.g. 'Eric direct call breakthrough — final cut'"
                    style={inputStyle} />
                </Field>
              ) : (
                <Field label="Names">
                  <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                    Taken from each filename
                  </div>
                </Field>
              )}
              <Field label="Type">
                <select value={uploadType} onChange={e => setUploadType(e.target.value)} style={selectStyle}>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          </>
        )}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Field label="Editor (optional)">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">— Unassigned</option>
              {editors.filter(e => e.tier !== 'admin').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          {/* Task-type select removed 2026-06-11 (Ben) — new tasks default
              to 'edit'; the column and existing values are untouched. */}
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Start date">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────────────────── TIMELINE (Gantt-style) ─────────────────────── */

function DateEditPopover({ popover, onClose, onSave, onFullEdit }) {
  const [start, setStart] = useState(popover.startDate)
  const [due, setDue] = useState(popover.dueDate)
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey  = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = Math.min(popover.x, window.innerWidth - 256)
  const top  = Math.min(popover.y, window.innerHeight - 180)
  const inp  = { display: 'block', width: '100%', marginTop: 3, padding: '5px 8px',
                 background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3,
                 fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', boxSizing: 'border-box' }
  return (
    <div ref={ref} style={{
      position: 'fixed', left, top, zIndex: 1200, width: 236,
      background: 'var(--paper)', border: '1px solid var(--rule)',
      borderRadius: 4, padding: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'var(--ink-3)', marginBottom: 10,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {popover.task.creative_name || 'Set dates'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
          Start date<input type="date" value={start} onChange={e => setStart(e.target.value)} style={inp} />
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
          Due date<input type="date" value={due} onChange={e => setDue(e.target.value)} style={inp} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => onSave(start, due)}
          style={{ flex: 1, padding: '6px 0', background: 'var(--ink)', color: 'var(--paper)',
                   border: 'none', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11,
                   fontWeight: 600, cursor: 'pointer', letterSpacing: '0.06em' }}>Save</button>
        <button onClick={onFullEdit}
          style={{ padding: '6px 10px', background: 'transparent', color: 'var(--ink-3)',
                   border: '1px solid var(--rule)', borderRadius: 3, fontFamily: 'var(--mono)',
                   fontSize: 10, cursor: 'pointer' }}>Full edit</button>
      </div>
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
    queued: '#999', in_progress: '#e0853e',
    review: '#3e7eba', done: '#3e8a5e',
    blocked: '#b53e3e',
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
          position: 'sticky', top: 0, zIndex: 50,
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
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
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
                        border: 'none', cursor: 'pointer', borderRadius: 2,
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
                      borderRadius: 2, zIndex: 3, pointerEvents: 'none',
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
                  const stripe = editorIsBlocking ? '#b53e3e' : (STATUS_STRIPE[t.status] || '#999')
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
                    done:        { label: 'DONE',   bg: '#3e8a5e' },
                    blocked:     { label: 'BLOCK',  bg: '#b53e3e' },
                    needs_revision: { label: 'REVISE', bg: '#c47a1a' },
                  }
                  const badge = editorIsBlocking
                    ? { label: 'OVD', bg: '#b53e3e' }
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
                        borderRadius: 2,
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
                            borderRadius: 2,
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
                          background: 'rgba(0,0,0,0.4)', borderRadius: 2,
                          fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                        }}>
                          {resizing.currentDeltaDays > 0 ? '+' : ''}{resizing.currentDeltaDays}d
                        </span>
                      )}
                      {!isResizing && badge && w >= 60 && (
                        <span style={{
                          fontSize: 9, padding: '2px 5px',
                          background: badge.bg, color: 'white',
                          borderRadius: 2, fontWeight: 700,
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
      { key: 'review',  label: 'Awaiting review',    color: '#3e7eba', items: review.sort(byDueDesc) },
      { key: 'overdue', label: 'Overdue',            color: '#b53e3e', items: overdue.sort(byDueDesc) },
      { key: 'blocked', label: 'Blocked',            color: '#7a4e08', items: blocked.sort(byDueDesc) },
    ].filter(s => s.items.length > 0)
  }, [tasks])

  if (sections.length === 0) {
    return (
      <div style={{
        border: '1px dashed var(--rule)', padding: 40, textAlign: 'center',
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
          position: 'sticky', top: 0, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: 'var(--ink)', color: 'white',
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>
            {sel.size} selected
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={downloadSelected} style={{
            padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'transparent', color: 'white',
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
          letterSpacing: '0.05em', borderRadius: 3,
          boxShadow: '0 6px 24px rgba(10,10,10,0.35)', pointerEvents: 'none',
        }}>{note}</div>
      )}
      {sections.map(section => (
        <div key={section.key}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase',
              color: section.color,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: section.color }} />
              {section.label}
              <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>· {section.items.length}</span>
            </div>
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
    const tm = setTimeout(() => setHoverPlay(true), 320)
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
        background: selected ? 'rgba(244,225,74,0.12)' : (hover ? 'var(--paper-2)' : 'var(--paper)'),
        border: selected ? '1px solid var(--accent)' : '1px solid var(--rule)',
        borderLeft: `4px solid ${sectionColor}`,
        cursor: 'pointer', transition: 'background 0.12s',
      }}>
      {onToggle && (
        <div onClick={e => { e.stopPropagation(); onToggle(t.task_id) }}
          title={selected ? 'Deselect' : 'Select for bulk actions (move to folder / download)'}
          style={{
            width: 20, height: 20, borderRadius: 3,
            background: selected ? 'var(--accent)' : 'white',
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
        border: '1px solid var(--rule)', overflow: 'hidden', position: 'relative',
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
              <span style={{ color: (t.is_overdue && t.status !== 'review') ? '#b53e3e' : 'var(--ink-4)' }}>{dueLabel}</span>
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
        color: 'white', borderRadius: 2,
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
              <span style={{ width: 7, height: 7, borderRadius: 2, background: TASK_STATUS_COLOR[c] }} />
              {KANBAN_LABEL[c] || TASK_STATUS_LABEL[c]}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{byCol[c].length}</span>
              {onAddInColumn && (
                <button onClick={() => onAddInColumn(c)} title={`Add a task in ${KANBAN_LABEL[c] || TASK_STATUS_LABEL[c]}`}
                  style={{
                    background: 'var(--ink)', color: 'var(--paper)', border: 'none',
                    width: 22, height: 22, borderRadius: 2, cursor: 'pointer',
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
        background: 'white', border: '1px solid var(--rule)',
        borderLeft: `3px solid ${statusColor}`,
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
        overflow: 'hidden', border: '1px solid var(--rule)',
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
            background: eColor ? 'white' : '#fffaea',
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
          <span style={{ marginLeft: 'auto', color: (task.is_overdue && task.status !== 'review') ? '#b53e3e' : 'var(--ink-4)' }}>
            {(task.is_overdue && task.status !== 'review') ? '⚠ ' : ''}{task.due_date}
          </span>
        )}
      </div>
      {pickerOpen && coords && createPortal(
        <div ref={popRef} style={{
          position: 'fixed',
          top: coords.top, left: coords.left, width: Math.max(180, coords.width),
          maxHeight: coords.maxHeight, overflowY: 'auto', zIndex: 9999,
          background: 'white', border: '1px solid var(--ink)',
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
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--ink-4)', flexShrink: 0 }} />
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
                <span style={{ width: 10, height: 10, borderRadius: 2, background: editorColor(e), flexShrink: 0 }} />
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

/* ─────────────────────────── Shared bits ─────────────────────────── */

function KpiTile({ label, value, accent, onClick, active }) {
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

function Field({ label, children }) {
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

function LoadingState() {
  return (
    <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
      Loading…
    </div>
  )
}

function EmptyState() {
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

function ErrorBanner({ msg, onRetry }) {
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

const primaryBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
}
const ghostBtn = {
  padding: '7px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule)', cursor: 'pointer',
}
const inputStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--mono)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
}
const selectStyle = {
  width: '100%', padding: '8px 11px',
  fontFamily: 'var(--sans)', fontSize: 12,
  background: 'white', border: '1px solid var(--rule)', outline: 'none',
  cursor: 'pointer',
}
