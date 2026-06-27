/* Upload pipeline for the creative library — split out of
   AdsCreativeLibrary.jsx mechanically (step 2 of the library-file split).
   Everything below moved verbatim from the page file; no logic changes.

   Owns: filename rename scheme (RAW-YYMMDD-ACTOR-Sxx-NNN), bad-take
   heuristics, browser-side media probing + thumbnail capture, the
   resumable TUS uploader, the module-level background upload queue +
   per-file pipeline (insert row → TUS → thumbnail → transcribe → triage →
   identify-actor → describe), and the UploadModal UI (including its
   ClipEditorModal wiring). The page keeps UploadDock (it subscribes to
   uploadQueue/useUploadQueue exported from here). probeMediaDimensions /
   captureVideoThumbnail(/FromUrl) / uploadWithResume stay exported — the
   page's EditTaskModal submitted-work upload and source-replace flows
   call them too. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as tus from 'tus-js-client'
import { supabase } from '../../../lib/supabase'
import Modal from '../../../components/editorial/Modal'
import ClipEditorModal from '../../../components/ads/ClipEditorModal'
import { SUPABASE_URL, TYPES, primaryBtn, ghostBtn, selectStyle } from './shared'

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
export const MIN_SHORTEST_SIDE = 1080

// Bad-take heuristic regex (Layer 2 of the failed-take system). Matches
// any common shorthand editors / camera operators slap on a flubbed take
// before re-rolling: "_x", "_bad", "_NG", "-fail", "_scratch", "_trash",
// trailing "_X" or "X.mp4" (capital X is the Sony shorthand for void).
// If a filename matches this, the row inserts with is_bad_take=true and
// bad_take_source='heuristic' so it never reaches the editor.
export const BAD_TAKE_FILENAME_RE = /[_\-.](x|X|bad|ng|NG|fail|FAIL|scratch|trash|void)(\b|[_\-.\d])/

// Files shorter than this are flagged as "too short to be a usable take".
// Sony cameras sometimes write 1-2s clips when the operator taps record
// twice. Picked 3.0s because legit hook clips have been seen as short
// as 3.5s but never under 3s.
export const BAD_TAKE_MIN_DURATION_S = 3.0

// Token slug for the ACTOR slot in the rename scheme. Mirrors the same
// helper inside the creative-library-describe Edge Function so the
// pre-describe name and the post-describe display_name use the same
// actor token. Uppercase, alphanumerics only, no separators.
export function actorTokenForRename(creator) {
  const cleaned = (creator || '').toUpperCase().replace(/[^A-Z0-9]+/g, '')
  return cleaned || 'UNK'
}

// Compute the renamed RAW filename for an upload.
// Format: RAW-{YYMMDD}-{ACTOR}-S{batch_seq:02}-{file_seq:03}.{ext}
// Camera filename 20260524_C0858.MP4 + (TANYA, batch 3, file 1) becomes
// RAW-260524-TANYA-S03-001.mp4. Sony original is preserved on the row
// in `original_filename` for audit + re-keyed lookups.
export function renameForUpload({ originalName, actor, dateLocal, batchSeq, fileSeq }) {
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
export function badTakeHeuristic(file, dims) {
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
export async function probeMediaDimensions(file) {
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
export async function verifyUploaded(bucket, path) {
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

export async function uploadWithResume(file, { bucket, path, contentType, onProgress, upsert = false, registerHandle }) {
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
export async function captureVideoThumbnail(file, { seekSeconds = 1, maxWidth = 720, maxBytes = 500 * 1024 * 1024 } = {}) {
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
export async function captureVideoThumbnailFromUrl(url, { seekSeconds = 1, maxWidth = 720, timeoutMs = 30000 } = {}) {
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
export const uploadQueue = {
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
    batchCreator, uploadBatchId, batchFolderId, batchCategory,
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
    content_category: batchCategory === 'short' ? 'short' : 'ad',
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
    // perFileConfig.note carries Clip Editor lineage ("Merged from part 1:
    // …" / "Uncut multi-take source of …") so merges/splits stay traceable.
    notes: `Uploaded via /sales/ads/creative/library on ${stamp}.${markedBad ? ` Flagged as bad take at upload (${badSource || 'operator'}): ${badReason || ''}` : ''}${perFileConfig?.note ? ` ${perFileConfig.note}` : ''}`,
  }
  // Clip Editor outputs carry meaningful names (-HOOK01 / -MERGED) and a
  // type of their own; both override the batch defaults.
  if (perFileConfig?.typeOverride) fullInsert.type = perFileConfig.typeOverride
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
export function useUploadQueue() {
  const [items, setItems] = useState(() => [...uploadQueue.items])
  useEffect(() => uploadQueue.subscribe(setItems), [])
  return items
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
export function TopUploadProgressBar() {
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
          background: failed > 0 ? 'var(--down)' : 'var(--accent, #e8b408)',
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
export function RenameUnnamedButton({ rows, onComplete }) {
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
        background: busy ? 'var(--paper-2)' : 'var(--paper)',
        color: busy ? 'var(--ink-3)' : '#a86a08',
        border: '1px solid ' + (busy ? 'var(--rule)' : '#e8b408'),
        borderRadius: 9,
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

/* ─────────────────────────── UPLOAD MODAL ─────────────────────────── */

export function UploadModal({ onClose, onSaved, editors = [], offers = [], onOfferAdded, knownCreators = [], folderId = null, folders = [], onCreateFolder }) {
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
  // Ad vs short-form — drives the editing-queue Ads | Shorts toggle.
  const [batchCategory, setBatchCategory] = useState('ad')
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
  // Destination folder for the whole batch (Ben: "record 10 scripts for
  // an angle → upload all 10 → label with the angle → find them later").
  // Defaults to whatever folder was open. '__new__' reveals a name field
  // that creates a folder (the angle) at queue time.
  const [batchFolderId, setBatchFolderId] = useState(folderId)
  const [newFolderName, setNewFolderName] = useState('')
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
  // Clip Editor (cut/trim/merge before upload). editorTarget = { mode:
  // 'split'|'merge', indices: [file idx] }; editSel = indices ticked for
  // a multi-file merge session.
  const [editorTarget, setEditorTarget] = useState(null)
  const [editSel, setEditSel] = useState(() => new Set())
  // Stable items array for the editor — a fresh array each render would
  // make ClipEditorModal revoke + recreate its blob URLs mid-playback
  // whenever anything else re-renders the page (e.g. a finishing upload
  // batch refreshing the library).
  const editorItems = useMemo(
    () => (editorTarget ? editorTarget.indices.map(i => files[i]).filter(Boolean) : null),
    [editorTarget, files],
  )
  const inputRef = useRef(null)
  // Separate hidden input carrying `webkitdirectory` so "select a whole
  // folder" pulls every file inside (drag-drop of a folder is handled in
  // handleDrop via the entries API). Ben 2026-06-26 — "function for bulk
  // uploading things".
  const folderInputRef = useRef(null)
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
          // Soft block, not a hard reject: AI-generated + portrait clips
          // are legitimately 720p. Keep the file + dims so "Upload anyway"
          // can recover it (lowres=true). A genuine probe failure below
          // has no file and stays blocked.
          return {
            ok: false, lowres: true, file, dims,
            reason: `${dims.width}×${dims.height} — under 1080p (fine for AI/portrait clips; use “Upload anyway”)`,
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
      // Only sub-1080p rejects are recoverable — carry the file + dims so
      // "Upload anyway" can move them into the accepted list.
      lowres: !!p.lowres,
      file: p.lowres ? p.file : null,
      dims: p.lowres ? p.dims : null,
    }))
    if (accepted.length) setFiles(prev => [...prev, ...accepted])
    if (newlyRejected.length) setRejected(prev => [...prev, ...newlyRejected])
  }

  // "Upload anyway" — move a sub-1080p reject into the accepted file
  // list (still runs the bad-take heuristic so a genuinely short/garbage
  // clip can still flag). idx=null overrides ALL recoverable rejects.
  const uploadAnyway = (idx) => {
    setRejected(prev => {
      const recover = (r) => {
        if (!r?.lowres || !r.file) return null
        const heuristic = badTakeHeuristic(r.file, r.dims)
        return {
          file: r.file, dims: r.dims,
          markedBad: heuristic.flagged, badReason: heuristic.reason,
          badSource: heuristic.flagged ? 'heuristic' : null,
        }
      }
      const picked = idx == null ? prev : [prev[idx]]
      const accepted = picked.map(recover).filter(Boolean)
      if (accepted.length) setFiles(f => [...f, ...accepted])
      return idx == null
        ? prev.filter(r => !r.lowres)        // keep only the hard failures
        : prev.filter((_, i) => i !== idx)
    })
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

  // Per-file Type override. The batch Type applies to every file, but a
  // mixed drop (a folder of Hooks + Bodies) needs per-row control. The
  // pipeline already honours perFileConfig.typeOverride at insert time
  // (upload.jsx runUploadPipeline), so this just surfaces it in the UI.
  const setFileType = (idx, type) => {
    setFiles(prev => prev.map((it, i) => i === idx ? { ...it, typeOverride: type || null } : it))
  }

  // Recursively pull every File out of a dropped directory entry. The
  // plain `dataTransfer.files` list is EMPTY for folder drops — you have
  // to walk the webkitGetAsEntry() tree. readEntries returns in chunks of
  // ~100, so we keep calling until it yields an empty batch.
  const collectFilesFromEntry = (entry, out) => new Promise((resolve) => {
    if (!entry) { resolve(); return }
    if (entry.isFile) {
      entry.file(f => { out.push(f); resolve() }, () => resolve())
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) { resolve(); return }
          await Promise.all(entries.map(en => collectFilesFromEntry(en, out)))
          readBatch()
        }, () => resolve())
      }
      readBatch()
    } else { resolve() }
  })

  const handleDrop = async (e) => {
    e.preventDefault()
    // Capture entries synchronously — the DataTransfer is cleared the
    // moment this handler yields to an await.
    const items = e.dataTransfer.items
    const entries = items && items.length
      ? Array.from(items).map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean)
      : []
    if (entries.some(en => en.isDirectory)) {
      const out = []
      await Promise.all(entries.map(en => collectFilesFromEntry(en, out)))
      acceptFiles(out)
    } else {
      acceptFiles(e.dataTransfer.files)
    }
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
        // Clip Editor outputs keep their meaningful names (-HOOK01 /
        // -MERGED) instead of the RAW-… rename scheme.
        renamedName: item.keepName ? item.file.name : renameForUpload({
          originalName: item.file.name,
          actor: batch.actor_creator,
          dateLocal: batch.date_local,
          batchSeq: batch.batch_seq,
          fileSeq: idx + 1,
        }),
        note: item.note || null,
        typeOverride: item.typeOverride || null,
        markedBad: !!item.markedBad,
        badReason: item.badReason || null,
        badSource: item.badSource || (item.markedBad ? 'upload' : null),
      },
    }))

    // Resolve the batch's destination folder. '__new__' + a name creates
    // the folder (the angle label) now so the whole batch lands in it.
    let resolvedFolderId = batchFolderId === '__new__' ? null : batchFolderId
    if (batchFolderId === '__new__' && newFolderName.trim() && onCreateFolder) {
      try {
        const created = await onCreateFolder(newFolderName.trim())
        if (created?.id) resolvedFolderId = created.id
      } catch (e) {
        setErr(`Couldn't create the folder "${newFolderName.trim()}": ${e.message}`)
        return
      }
    }

    uploadQueue.enqueue(perFile.map(p => p.file), {
      batchType,
      batchCategory,
      batchStatus,
      batchEditorId,
      batchOfferSlug,
      batchCreator: batch.actor_creator,
      batchFolderId: resolvedFolderId,   // whole batch files into this folder
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
          {err && <span style={{ color: 'var(--down)', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
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
          {/* Format — ad vs short-form. Sets content_category on every file in
              the batch; drives the editing-queue Ads | Shorts toggle. */}
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Format</div>
            <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 999 }}>
              {[{ v: 'ad', label: 'Ad creative' }, { v: 'short', label: 'Short creative' }].map(opt => {
                const on = batchCategory === opt.v
                return (
                  <button key={opt.v} type="button" onClick={() => setBatchCategory(opt.v)} disabled={busy}
                    style={{
                      padding: '6px 14px', borderRadius: 999, cursor: busy ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
                      letterSpacing: '0.06em', textTransform: 'uppercase', border: 'none',
                      background: on ? 'var(--ink)' : 'transparent',
                      color: on ? 'var(--paper)' : 'var(--ink-3)',
                    }}>{opt.label}</button>
                )
              })}
            </div>
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
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--down)' }}>
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
          {/* Destination folder for the whole batch — Ben's "10 scripts for
              an angle → one upload → label with the angle → find them
              later". Pick an existing folder or create one (the angle). */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Save batch to folder (angle)
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={batchFolderId ?? ''} onChange={e => setBatchFolderId(e.target.value || null)} style={{ ...selectStyle, flex: '1 1 240px', maxWidth: 360 }} disabled={busy}>
                <option value="">— No folder (library root) —</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                <option value="__new__">+ New folder…</option>
              </select>
              {batchFolderId === '__new__' && (
                <input type="text" value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                  placeholder="Angle name — e.g. ‘Fire your agency’"
                  style={{ ...selectStyle, flex: '1 1 240px', maxWidth: 360 }} disabled={busy} autoFocus />
              )}
            </div>
            {files.length > 1 && (
              <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>
                All {files.length} files in this batch file into{batchFolderId === '__new__' ? ` the new folder “${newFolderName.trim() || '…'}”` : batchFolderId ? ` “${folders.find(f => f.id === batchFolderId)?.name || 'folder'}”` : ' the library root'}.
              </div>
            )}
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
          {/* Folder picker — webkitdirectory pulls every file in the
              chosen folder (and sub-folders) in one shot. */}
          <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple
            style={{ display: 'none' }}
            onChange={e => acceptFiles(e.target.files)} />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink-2)', marginBottom: 4 }}>
            Drop files or a whole folder here
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            click to select files (multi-select allowed) ·{' '}
            <span
              role="button" tabIndex={0}
              onClick={e => { e.stopPropagation(); folderInputRef.current?.click() }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); folderInputRef.current?.click() } }}
              style={{ textDecoration: 'underline', cursor: 'pointer', color: 'var(--ink-3)' }}>
              or select a whole folder
            </span>
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
            {/* Edit & merge bar — appears when 2+ videos are ticked */}
            {editSel.size >= 2 && (
              <div style={{
                position: 'sticky', top: 0, zIndex: 5,
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 12px', background: 'var(--ink)', color: 'var(--paper)',
              }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600 }}>
                  {editSel.size} selected
                </span>
                <span style={{ flex: 1 }} />
                <button type="button"
                  onClick={() => setEditorTarget({ mode: 'merge', indices: Array.from(editSel).sort((a, b) => a - b) })}
                  style={{
                    padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--accent)', color: 'var(--ink)', border: 'none', cursor: 'pointer',
                  }}>⧉ Edit &amp; merge into one</button>
                <button type="button" onClick={() => setEditSel(new Set())} style={{
                  background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)',
                  cursor: 'pointer', fontSize: 13, padding: 0,
                }}>✕</button>
              </div>
            )}
            {files.map((item, i) => {
              const f = item.file
              const dur = item.dims?.duration_s
              const isVideo = f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name)
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '18px 1fr auto 80px 104px auto 100px 30px',
                  gap: 10, alignItems: 'center',
                  padding: '8px 12px',
                  borderBottom: i === files.length - 1 ? 'none' : '1px solid var(--rule)',
                  background: item.markedBad ? 'rgba(181,62,62,0.05)' : (i % 2 === 0 ? 'transparent' : 'var(--paper-2)'),
                  borderLeft: item.markedBad ? '3px solid var(--down)' : '3px solid transparent',
                }}>
                  {/* merge-select checkbox (videos only) */}
                  {isVideo ? (
                    <input type="checkbox" checked={editSel.has(i)}
                      title="Select for Edit & merge"
                      onChange={() => setEditSel(prev => {
                        const next = new Set(prev)
                        if (next.has(i)) next.delete(i); else next.add(i)
                        return next
                      })}
                      style={{ accentColor: 'var(--ink)', cursor: 'pointer' }} />
                  ) : <span />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textDecoration: item.markedBad ? 'line-through' : 'none',
                      opacity: item.markedBad ? 0.6 : 1,
                    }} title={f.name}>{f.name}</div>
                    {item.note && (
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 9.5, color: '#b86a0c',
                        marginTop: 2, letterSpacing: '0.04em',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={item.note}>
                        {item.keepName ? 'CLIP EDITOR OUTPUT' : 'SOURCE'} · {item.note}
                      </div>
                    )}
                    {item.markedBad && item.badReason && (
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--down)',
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
                  {/* Per-file Type override. Defaults to "(batch)" which
                      means inherit the batch Type set above; pick a
                      specific type to override just this row. */}
                  <select
                    value={item.typeOverride || ''}
                    onChange={e => setFileType(i, e.target.value)}
                    title="Type for this file — leave on (batch) to use the batch Type above"
                    style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5,
                      padding: '3px 4px', borderRadius: 9,
                      border: '1px solid var(--rule)', background: 'var(--paper)',
                      color: item.typeOverride ? 'var(--ink-2)' : 'var(--ink-4)',
                      cursor: 'pointer', maxWidth: '100%',
                    }}>
                    <option value="">(batch)</option>
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {/* Keep/Bad toggle (Layer 1). Operator-driven mark for
                      takes the operator KNOWS are flubbed before upload
                      — restart, missed cue, audio fail, etc. Auto-flagged
                      items can be un-flagged with the same toggle. */}
                  {isVideo ? (
                    <button type="button"
                      onClick={() => setEditorTarget({ mode: 'split', indices: [i] })}
                      title="Open in the Clip Editor — cut into takes, trim stutters, preview"
                      style={{
                        padding: '3px 9px', borderRadius: 9,
                        background: 'var(--paper)', color: 'var(--ink-2)',
                        border: '1px solid var(--rule)',
                        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>✂ Edit</button>
                  ) : <span />}
                  <button onClick={() => toggleMarkedBad(i)} type="button"
                    title={item.markedBad ? 'Currently flagged as bad take — click to keep' : 'Mark as bad take (will be hidden from editor library)'}
                    style={{
                      padding: '3px 9px', borderRadius: 9,
                      background: item.markedBad ? 'var(--down)' : 'var(--paper)',
                      color: item.markedBad ? 'white' : 'var(--ink-3)',
                      border: '1px solid ' + (item.markedBad ? 'var(--down)' : 'var(--rule)'),
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}>{item.markedBad ? 'Bad take' : 'Keep'}</button>
                  <button onClick={() => {
                    setFiles(files.filter((_, j) => j !== i))
                    // editSel holds positional indices — remap so the
                    // ticks stay on the same FILES, not the same rows
                    // (stale indices merged the wrong videos / crashed
                    // when they ran past the shortened list).
                    setEditSel(prev => new Set(
                      [...prev].filter(j => j !== i).map(j => (j > i ? j - 1 : j))
                    ))
                  }} style={{
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
        {/* Clip Editor — cut / trim / merge before the queue ever sees
            the files. Outputs come back as new list items (keepName +
            typeOverride + lineage note); sources stay, annotated. */}
        {editorTarget && (
          <ClipEditorModal
            items={editorItems}
            mode={editorTarget.mode}
            onClose={() => setEditorTarget(null)}
            onDone={async ({ results, sourceNotes }) => {
              const newItems = await Promise.all(results.map(async (r) => {
                let dims = null
                try { dims = await probeMediaDimensions(r.file) } catch { /* probe is cosmetic here */ }
                return {
                  file: r.file, dims,
                  markedBad: false, badReason: null,
                  keepName: !!r.keepName, note: r.note || null,
                  typeOverride: r.typeOverride || null,
                }
              }))
              setFiles(curr => [
                ...curr.map(it => sourceNotes.has(it.file) ? { ...it, note: sourceNotes.get(it.file) } : it),
                ...newItems,
              ])
              setEditSel(new Set())
              setEditorTarget(null)
            }}
          />
        )}
        {rejected.length > 0 && (
          <div style={{
            marginTop: 12, border: '1px solid var(--down)', borderLeft: '3px solid var(--down)',
            background: 'rgba(181,62,62,0.04)',
          }}>
            <div style={{
              padding: '8px 12px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid rgba(181,62,62,0.25)',
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--down)',
              }}>
                {rejected.length} file{rejected.length === 1 ? '' : 's'} held back · under 1080p
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {rejected.some(r => r.lowres) && (
                  <button onClick={() => uploadAnyway(null)} style={{
                    padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--ink)', color: 'var(--paper)', border: 'none', cursor: 'pointer',
                  }}>Upload all anyway</button>
                )}
                <button onClick={() => setRejected([])} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--ink-4)', fontSize: 14, padding: 0,
                }}>×</button>
              </div>
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {rejected.map((r, i) => (
                <div key={i} style={{
                  padding: '6px 12px',
                  borderBottom: i === rejected.length - 1 ? 'none' : '1px solid rgba(181,62,62,0.15)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={r.name}>{r.name}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: r.lowres ? '#a86a08' : 'var(--down)', marginTop: 1 }}>
                      {r.reason}
                    </div>
                  </div>
                  {r.lowres && (
                    <button onClick={() => uploadAnyway(i)} style={{
                      flexShrink: 0, padding: '3px 9px',
                      fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: 'var(--paper)', color: 'var(--ink)',
                      border: '1px solid var(--ink-3)', cursor: 'pointer',
                    }}>Upload anyway</button>
                  )}
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
