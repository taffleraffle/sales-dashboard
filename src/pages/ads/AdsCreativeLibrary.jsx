import { useEffect, useMemo, useState, useCallback, useRef, memo, useDeferredValue } from 'react'
import { createPortal } from 'react-dom'
import * as tus from 'tus-js-client'
import { supabase } from '../../lib/supabase'
import { SectionHead, Icon } from '../../components/editorial/atoms'
import Modal from '../../components/editorial/Modal'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'

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
async function uploadWithResume(file, { bucket, path, contentType, onProgress, upsert = false }) {
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
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      onError: (err) => reject(err),
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress) onProgress(bytesTotal > 0 ? bytesUploaded / bytesTotal : 0)
      },
      onSuccess: () => resolve({ path }),
    })
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
  queued:      'Queued',
  in_progress: 'In progress',
  review:      'In review',
  done:        'Done',
  blocked:     'Blocked',
}
const TASK_STATUS_COLOR = {
  queued:      'var(--ink-3)',
  in_progress: '#e0853e',
  review:      '#3e7eba',
  done:        '#3e8a5e',
  blocked:     '#b53e3e',
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

   This helper loads the file into an off-DOM <video>, seeks to ~1s
   (skips the typical black opening frame), draws to a <canvas>, and
   returns a JPEG Blob ready to upload alongside the video. Returns null
   on any failure so the upload can continue without blocking on it. */
async function captureVideoThumbnail(file, { seekSeconds = 1, maxWidth = 720, maxBytes = 500 * 1024 * 1024 } = {}) {
  // Hard guard: phone-camera MP4s often have the moov atom at the end,
  // which forces the browser to download the WHOLE file before it can
  // seek. For multi-hundred-MB files that stalls the entire upload queue
  // before a single byte is sent. We skip thumbnail capture above this
  // threshold and let an offline backfill job extract thumbnails later.
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
    const newItems = files.map((file) => ({
      id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
      file,
      config: { ...config, stamp },
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
      this.updateItem(next.id, { status: 'error', message: e?.message || 'failed', error: e?.message || 'failed' })
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
}

/* Per-file pipeline. Was inline in UploadModal.submit; extracted so the
   queue can drive it independent of any component. Mirrors the old
   bulk-upload submit() logic: create row → TUS upload → patch thumbnail
   → transcribe (video) → identify-actor → describe. `update(patch)`
   merges into the queue item so subscribers see live progress. */
async function runUploadPipeline(item, update) {
  const { file, config } = item
  const { batchType, batchStatus, batchEditorId, batchOfferSlug, stamp } = config
  update({ status: 'creating', message: 'creating row' })

  // 1. Insert library row
  const { data: inserted, error: insErr } = await supabase
    .from('lib_creative_library')
    .insert({
      name: file.name,
      type: batchType || 'Joined',
      size_mb: Math.round((file.size / 1024 / 1024) * 10) / 10,
      status: batchStatus,
      assigned_editor_id: batchEditorId || null,
      offer_slug: batchOfferSlug || null,
      source_bucket: 'Manual upload',
      notes: `Uploaded via /sales/ads/creative/library on ${stamp}.`,
    })
    .select('id')
    .single()
  if (insErr) throw new Error(insErr.message)
  const libraryId = inserted.id
  update({ libraryId })

  // 2. TUS upload
  const HARD_LIMIT = 10 * 1024 * 1024 * 1024
  const tooLarge = file.size > HARD_LIMIT
  const isImageFile = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)
  let storagePath = null
  if (!tooLarge) {
    storagePath = `incoming/${libraryId}_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
    const contentType = file.type || (isImageFile ? 'image/jpeg' : 'video/mp4')
    let lastPct = -1
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
    })
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`
    const postPatch = { preview_url: publicUrl }
    if (isImageFile) {
      postPatch.thumbnail_url = publicUrl
    } else {
      update({ status: 'thumbnailing', message: 'capturing thumbnail' })
      const thumbBlob = await captureVideoThumbnail(file)
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
  //    surface failures into the queue item's message).
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
  update({ status: 'identifying', message: 'identifying actor' })
  try {
    const { data, error } = await supabase.functions.invoke('identify-actor', {
      body: { library_ids: [libraryId] },
    })
    if (error) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id: ${error.message}`
    else if (data?.errors?.length > 0) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id: ${data.errors[0].error || 'unknown'}`
  } catch (e) { pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `actor-id threw: ${e.message}` }
  update({ status: 'describing', message: 'naming' })
  try {
    const { data, error } = await supabase.functions.invoke('creative-library-describe', {
      body: { library_ids: [libraryId] },
    })
    if (error) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe: ${error.message}`
    else if (data?.errors?.length > 0) pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe: ${data.errors[0].error || 'unknown'}`
  } catch (e) { pipelineErr = (pipelineErr ? pipelineErr + ' · ' : '') + `describe threw: ${e.message}` }

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
  const totalProg = items.reduce((s, i) => s + (i.progress || 0), 0) / items.length

  // Compact summary pill
  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} title="Upload progress"
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 95,
          padding: '10px 14px', minWidth: 220,
          background: 'var(--paper)', border: '1px solid var(--rule)',
          borderLeft: failed.length > 0 ? '3px solid #b53e3e' : '3px solid var(--accent, #e8b408)',
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
                {(isDone || isErr || it.status === 'too-large') && (
                  <button onClick={() => uploadQueue.dismiss(it.id)} title="Dismiss" style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--ink-4)', fontSize: 16, padding: 0,
                  }}>×</button>
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

/* Notification bell — floating button in the top-right of the Library
   tab. Click to open a right-side slider with the recent submissions
   feed. Unseen count (anything created since last open) shows as a
   red dot on the bell. */
function NotificationBell({ submissions }) {
  const [open, setOpen] = useState(false)
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
      {/* Floating bell — fixed in the top-right of the viewport so it
          doesn't fight for space in the toolbar. Red ping when there's
          activity since last open. */}
      <button onClick={handleOpen} title="Recent activity"
        style={{
          position: 'fixed', top: 12, right: 16, zIndex: 90,
          width: 38, height: 38, borderRadius: 999,
          background: 'var(--paper)', border: '1px solid var(--rule)',
          cursor: 'pointer', boxShadow: '0 2px 6px rgba(10,10,10,0.10)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>🔔</span>
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
      {open && createPortal(
        <>
          <div onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 200,
              background: 'rgba(10,10,10,0.32)', backdropFilter: 'blur(2px)',
            }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 'min(420px, 92vw)', zIndex: 201,
            background: 'var(--paper)',
            borderLeft: '1px solid var(--rule)',
            boxShadow: '-12px 0 32px rgba(10,10,10,0.15)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid var(--rule)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--paper-2)',
            }}>
              <div>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
                }}>Recent activity</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, marginTop: 4 }}>
                  {submissions.length} submission{submissions.length === 1 ? '' : 's'} this week
                  {pendingApproval > 0 && (
                    <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 12, color: '#7a4e08' }}>
                      · {pendingApproval} awaiting review
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => setOpen(false)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--ink-3)', fontSize: 22, padding: 4,
                  lineHeight: 1,
                }}>×</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
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
                  return (
                    <div key={s.id} style={{
                      display: 'grid', gridTemplateColumns: '52px 1fr',
                      gap: 12, alignItems: 'center',
                      padding: '8px 10px',
                      background: s.approved_at ? 'rgba(62,138,94,0.05)' : 'var(--paper)',
                      border: '1px solid ' + (isNew ? '#3e7eba' : 'var(--rule)'),
                      borderLeft: '3px solid ' + (s.approved_at ? '#3e8a5e' : '#3e7eba'),
                    }}>
                      <div style={{
                        width: 52, height: 34, background: '#000', overflow: 'hidden',
                      }}>
                        {s.thumbnail_url && (
                          <img src={s.thumbnail_url} alt="" loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        )}
                      </div>
                      <div style={{ minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{
                            padding: '1px 6px', background: 'var(--ink-3)', color: 'white',
                            borderRadius: 2, fontSize: 9.5, fontWeight: 700,
                          }}>v{s.version_number}</span>
                          <span style={{ fontWeight: 600 }}>{s.submitted_by_name || 'Unknown'}</span>
                          <span style={{ color: 'var(--ink-4)' }}>· {relTime(s.created_at)}</span>
                          {isNew && (
                            <span style={{
                              padding: '1px 5px', background: '#3e7eba', color: 'white',
                              borderRadius: 2, fontSize: 9, fontWeight: 700,
                              letterSpacing: '0.08em',
                            }}>NEW</span>
                          )}
                        </div>
                        <div style={{
                          marginTop: 4, display: 'flex', alignItems: 'center', gap: 10,
                          fontSize: 10.5, color: 'var(--ink-3)',
                        }}>
                          <span style={{
                            fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                            color: s.approved_at ? '#3e8a5e' : '#3e7eba',
                          }}>{s.approved_at ? 'Approved' : 'In review'}</span>
                          {(s.file_url || s.external_url) && (
                            <a href={s.file_url || s.external_url} target="_blank" rel="noreferrer"
                              style={{ color: 'var(--ink-2)', textDecoration: 'underline' }}>
                              Open ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}

/* Modal video preview with explicit teardown. The native <video> element
   sometimes stalls the main thread for hundreds of ms when unmounted
   mid-buffer (browser cleans up decoder + network connection). Pausing
   and clearing src in a useEffect cleanup forces immediate teardown so
   closing the detail modal feels instant instead of laggy. */
/* Frame.io / Drive / Dropbox link submission. Lets editors paste a
   review-tool URL as v_n instead of uploading the raw file. Same
   submission row, just with external_url instead of file_url. */
function ExternalLinkSubmitter({ taskId, editorId, editorName, currentVersionCount, onSubmitted }) {
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.from('lib_task_submissions').insert({
        task_id: taskId,
        submitted_by_editor_id: editorId || null,
        submitted_by_name: editorName || null,
        external_url: trimmed,
        notes: note.trim() || null,
        version_number: (currentVersionCount || 0) + 1,
      })
      if (error) throw error
      setUrl(''); setNote(''); setOpen(false)
      await onSubmitted?.()
    } catch (e) {
      setErr(e.message || 'submission failed')
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          flex: 1, height: 1, background: 'var(--rule)',
        }} />
        <button type="button" onClick={() => setOpen(true)}
          style={{
            padding: '5px 11px',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'white', color: 'var(--ink-2)',
            border: '1px dashed var(--rule)', borderRadius: 2, cursor: 'pointer',
          }}>+ Or paste a review link</button>
        <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
      </div>
    )
  }
  return (
    <div style={{
      marginTop: 10, padding: '12px 14px',
      border: '1px solid var(--rule)', background: 'white',
      borderLeft: '3px solid #3e7eba',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: '#3e7eba',
        marginBottom: 8,
      }}>
        <span>Submit a review link (Frame.io / Drive / Dropbox)</span>
        <button type="button" onClick={() => setOpen(false)}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--ink-4)', fontSize: 16, padding: 0,
          }}>×</button>
      </div>
      <input type="text" value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit() }}
        placeholder="https://f.io/abc123 or https://drive.google.com/…"
        autoFocus
        style={{
          width: '100%', padding: '7px 10px',
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
          border: '1px solid var(--rule)', borderRadius: 2,
          background: 'var(--paper-2)', outline: 'none',
          marginBottom: 8,
        }} />
      <textarea value={note} onChange={e => setNote(e.target.value)}
        placeholder="Optional note for Ben (what to look at, what's changed since last version)…"
        rows={2}
        style={{
          width: '100%', padding: '7px 10px',
          fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink)',
          border: '1px solid var(--rule)', borderRadius: 2,
          background: 'var(--paper-2)', outline: 'none',
          resize: 'vertical',
        }} />
      {err && (
        <div style={{
          marginTop: 8, padding: '7px 10px',
          background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)',
          fontFamily: 'var(--mono)', fontSize: 11, color: '#b53e3e',
        }}>{err}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" onClick={submit}
          disabled={busy || !url.trim()}
          style={{
            padding: '6px 14px',
            fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: busy || !url.trim() ? 'var(--ink-4)' : '#3e7eba',
            color: 'white', border: 'none', borderRadius: 2,
            cursor: busy || !url.trim() ? 'not-allowed' : 'pointer',
          }}>{busy ? 'Submitting…' : 'Submit review link'}</button>
      </div>
    </div>
  )
}

/* Common Whisper mishearings that pollute OPT's brand. Apply when
   rendering a transcript so the operator doesn't see "up digital"
   when a person clearly said "OPT digital". Case-insensitive matching,
   preserves trailing/leading whitespace. Add more rules here as they
   surface — Whisper biases toward common English words. */
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

function PreviewVideo({ src, poster, style }) {
  const ref = useRef(null)
  useEffect(() => {
    const v = ref.current
    return () => {
      if (v) {
        try { v.pause() } catch {}
        v.removeAttribute('src')
        try { v.load() } catch {}
      }
    }
  }, [src])
  return (
    <video
      ref={ref}
      src={src}
      controls
      preload="metadata"
      poster={poster || undefined}
      style={style || { width: '100%', height: '100%', display: 'block' }}
    />
  )
}

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
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem('lib.tab')
      return saved || (scope.isEditorView ? 'queue' : 'library')
    } catch { return scope.isEditorView ? 'queue' : 'library' }
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

      {tab === 'library' ? <LibraryTab scope={scope} /> : <EditingQueueTab scope={scope} />}
    </div>
  )
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px',
      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: active ? 'var(--ink)' : 'transparent',
      color: active ? 'var(--paper)' : 'var(--ink-3)',
      border: 'none', cursor: 'pointer',
    }}>{children}</button>
  )
}

/* ─────────────────────────── LIBRARY TAB ─────────────────────────── */

function LibraryTab({ scope = ADMIN_SCOPE }) {
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
  const [latestOnly, setLatestOnly] = useState(false)  // when true, hide non-latest versions
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
  const openDrawer = useCallback((row) => setDrawerRow(row), [])

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

  // Lean column list — everything EXCEPT `transcript` (which can be 5-16KB
  // per row and is only needed inside the detail modal). 200+ rows × ~3KB
  // of transcript = 600KB+ wasted on the first paint. Pulling without it
  // cuts the initial payload roughly in half. Transcripts get lazy-loaded
  // in a follow-up query after first paint so library search still works.
  const LIB_LEAN_COLS = 'id,name,canonical_name,description,type,creator,status,offer_slug,has_been_run,manually_marked_used,assigned_editor_id,parent_id,version_number,thumbnail_url,preview_url,drive_url,size_mb,duration_seconds,v21_script_id,derived_hook_id,derived_body_id,derivation_score,stage_rough_cut,stage_final_cut,stage_approved,stage_delivered,rough_cut_url,final_cut_url,approved_url,delivered_url,exclude_from_library,added_at,updated_at,notes,priority,source_bucket,drive_id'

  const load = useCallback(async (background = false) => {
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
    let rowsRes, edRes, ofRes
    try {
      ;[rowsRes, edRes, ofRes] = await Promise.race([
        Promise.all([
          supabase.from('lib_creative_library')
            .select(`${LIB_LEAN_COLS},assigned_editor:assigned_editor_id (id, name)`)
            .eq('exclude_from_library', false)
            .order('added_at', { ascending: false }),
          supabase.from('lib_creative_editors').select('*').eq('active', true).order('name'),
          supabase.from('offers').select('slug,name').eq('retired', false).order('slug'),
        ]),
        timeoutErr,
      ])
    } catch (e) {
      setErr(e.message || 'Load failed')
      setLoading(false)
      return
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
  const usedRawIds = useMemo(() => {
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
    // Type-based fast path — raw Hooks are "already used" by default
    // unless the operator explicitly overrode to RAW.
    for (const r of rows) {
      if (r.status === 'raw' && r.type === 'Hook' && !overridden.has(r.id)) used.add(r.id)
    }
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
    return used
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows
    const search = deferredQ.trim().toLowerCase()
    if (search) list = list.filter(r => {
      const blob = `${r.name} ${r.canonical_name || ''} ${r.description || ''} ${r.creator || ''} ${r.v21_script_id || ''} ${r.notes || ''} ${r.transcript || ''}`.toLowerCase()
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
        if (stageFilter.has('raw_unused') && r.status === 'raw' && !usedRawIds.has(r.id)) return true
        if (stageFilter.has('edited_seg') && r.status === 'edited') return true
        return false
      })
    }
    if (latestOnly) {
      // For each root (parent_id || id), keep only the row with the
      // highest version_number. Roots without children just stay.
      const latestByRoot = new Map()
      for (const r of rows) {
        const rootId = r.parent_id || r.id
        const v = r.version_number || 1
        const cur = latestByRoot.get(rootId)
        if (!cur || v > (cur.version_number || 1)) latestByRoot.set(rootId, r)
      }
      const keepIds = new Set(Array.from(latestByRoot.values()).map(r => r.id))
      list = list.filter(r => keepIds.has(r.id))
    }
    // Column sort (Matrix view) — applied last so it works on the filtered list
    if (sortKey) {
      const dir = sortDir === 'desc' ? -1 : 1
      const valueOf = (r) => {
        switch (sortKey) {
          case 'id':       return (r.canonical_name || r.name || '').toLowerCase()
          case 'desc':     return (r.description || r.name || '').toLowerCase()
          case 'type':     return (r.type || '').toLowerCase()
          case 'creator':  return (r.creator || '').toLowerCase()
          case 'editor':   return (r.assigned_editor_name || '').toLowerCase()
          case 'offer':    return (r.offer_slug || '').toLowerCase()
          case 'run':      return r.has_been_run ? 1 : 0
          case 'status':   return (r.status || '').toLowerCase()
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
  }, [rows, deferredQ, typeFilter, offerFilter, runFilter, stageFilter, latestOnly, sortKey, sortDir, usedRawIds])

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

  // Per-type counts for the chip badges (over ALL rows, ignoring current type filter)
  const typeCounts = useMemo(() => {
    const m = {}
    for (const r of rows) m[r.type] = (m[r.type] || 0) + 1
    return m
  }, [rows])

  const offerCounts = useMemo(() => {
    const m = { __none__: 0 }
    for (const r of rows) {
      if (r.offer_slug) m[r.offer_slug] = (m[r.offer_slug] || 0) + 1
      else m.__none__ += 1
    }
    return m
  }, [rows])

  const runCount    = useMemo(() => rows.filter(r => r.has_been_run).length, [rows])
  const notRunCount = useMemo(() => rows.filter(r => !r.has_been_run).length, [rows])
  // Stable reference for MatrixRow's editor dropdown — same memo concern
  // as openDrawer: avoid re-creating this array each render.
  const activeEditors = useMemo(() => editors.filter(e => e.active), [editors])
  // Status counts. 'Edited' includes Joined (since Joined is a sub-state of
  // edited). 'Merged' is a narrower filter showing only Joined.
  const stageCounts = useMemo(() => ({
    raw_used:   rows.filter(r => r.status === 'raw' && usedRawIds.has(r.id)).length,
    raw_unused: rows.filter(r => r.status === 'raw' && !usedRawIds.has(r.id)).length,
    edited_seg: rows.filter(r => r.status === 'edited').length,
  }), [rows, usedRawIds])

  // Section groups for the list view — used when no type filter, shows
  // Hooks/Bodies/Joined/Testimony as separate sections. With multi-select
  // type filter, still group by type so each selected type gets its own
  // section.
  const grouped = useMemo(() => {
    const order = ['Hook', 'Body', 'Full Video', 'Joined', 'Testimony', 'Retargeting']
    return order
      .map(t => ({ type: t, rows: filtered.filter(r => r.type === t) }))
      .filter(g => g.rows.length > 0)
  }, [filtered])

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
      n += 1
    }
    return n
  }, [rows, usedRawIds])

  // Recent submissions for the activity feed. Loads in the background
  // after first paint so the initial library render isn't blocked.
  const [recentSubmissions, setRecentSubmissions] = useState([])
  useEffect(() => {
    let mounted = true
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    supabase.from('lib_task_submissions')
      .select('id, task_id, version_number, submitted_by_name, file_url, external_url, thumbnail_url, approved_at, created_at')
      .gte('created_at', sevenDaysAgo)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => { if (mounted) setRecentSubmissions(data || []) })
    return () => { mounted = false }
  }, [])

  // Filter helper for clicking the unassigned banner — narrows the view
  // to raw + unassigned non-Testimony rows by setting the existing
  // filter chips.
  const focusUnassignedRaw = useCallback(() => {
    setStageFilter(new Set(['raw_unused']))
    setTypeFilter(new Set(['Hook', 'Body', 'Joined', 'Full Video', 'Retargeting']))
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
        name: r.canonical_name || r.name,
        url: r.final_cut_url || r.drive_url || r.preview_url,
      }))
      .filter(t => t.url)
    if (targets.length === 0) return
    targets.forEach((t, i) => {
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = t.url
        a.download = t.name || 'creative.mp4'
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 180)
    })
  }, [selected, rows])

  return (
    <>
      {/* Unassigned-raw banner — yellow alert at the very top so it's
          the first thing the operator sees on landing. Hidden when
          count is zero so the page is clean during normal operation. */}
      {unassignedRawCount > 0 && (
        <div onClick={focusUnassignedRaw}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px', marginBottom: 10,
            background: '#fffaea', border: '1px solid #e8b408',
            borderLeft: '3px solid #e8b408',
            cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 11.5,
            letterSpacing: '0.04em', color: '#7a4e08',
          }}
          title="Click to filter the library to just these rows">
          <span style={{ fontSize: 14 }}>⚠</span>
          <span style={{ fontWeight: 600 }}>{unassignedRawCount}</span>
          <span>raw creative{unassignedRawCount === 1 ? '' : 's'} need editor assignment</span>
          <span style={{ flex: 1 }} />
          <span style={{ textDecoration: 'underline' }}>Filter to these →</span>
        </div>
      )}

      {/* Notification bell — small icon, opens a right-side slider with
          the recent submissions feed. No banner space wasted at the
          top; ping shows the unseen count. */}
      <NotificationBell submissions={recentSubmissions} />

      {/* Upload dock — floating bottom-right indicator showing the
          background upload queue. Survives modal close + tab navigation.
          Refreshes the library list whenever the queue empties so new
          rows surface without a manual refresh. */}
      <UploadDock onRefresh={() => load(true)} />

      {/* Toolbar — compact, single block. No more 5-row chip stack. */}
      <div style={{
        padding: '10px 14px', background: 'var(--paper-2)',
        border: '1px solid var(--rule)', marginBottom: 14,
      }}>
        {/* Top row: search + view toggle + upload */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, description, transcript, notes…"
            style={{
              flex: '1 1 280px', maxWidth: 420,
              padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 12.5,
              background: 'white', border: '1px solid var(--rule)', outline: 'none',
            }} />
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
            {filtered.length} / {rows.length}
          </span>
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

        {/* Editorial inline filter strip — 4 groups, each on its own line,
            text-style instead of buttoned chips. Click the label/"All" to
            click the small button to open a popover with options. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
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
            allCount={rows.length}
            onChange={setStageFilter} />
          <FilterDropdown label="TYPE"
            selected={typeFilter}
            options={TYPES.map(t => ({ value: t, label: t.toUpperCase(), count: typeCounts[t] || 0, dot: typeColor(t).ink }))}
            allCount={rows.length}
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
            allCount={rows.length}
            onChange={setOfferFilter} />
          <FilterDropdown label="RUN"
            selected={runFilter}
            options={[
              { value: 'yes', label: 'RUN BEFORE', count: runCount,    dot: '#3e8a5e' },
              { value: 'no',  label: 'NOT YET',    count: notRunCount, dot: 'var(--ink-4)' },
            ]}
            allCount={rows.length}
            onChange={setRunFilter} />
          <button type="button"
            onClick={() => setLatestOnly(v => !v)}
            title="Show only the latest version of each clip (hide v1 when a v2 exists)"
            style={{
              padding: '5px 9px',
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              background: latestOnly ? 'var(--accent)' : 'white',
              color: 'var(--ink)',
              border: '1px solid ' + (latestOnly ? 'var(--ink)' : 'var(--rule)'),
              borderRadius: 2, cursor: 'pointer',
            }}>{latestOnly ? '☑ Latest only' : 'Latest only'}</button>
          {(stageFilter.size + typeFilter.size + offerFilter.size + runFilter.size > 0 || latestOnly) && (
            <button type="button"
              onClick={() => {
                setStageFilter(new Set()); setTypeFilter(new Set())
                setOfferFilter(new Set()); setRunFilter(new Set())
                setLatestOnly(false)
              }}
              style={{
                marginLeft: 4, padding: '4px 9px',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-3)',
                border: '1px solid var(--rule)', cursor: 'pointer',
              }}>Clear filters</button>
          )}
        </div>
      </div>

      {err && <ErrorBanner msg={err} onRetry={() => load(false)} />}

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
                      onToggleSelect={scope.canEditCreative ? toggleSelect : null} />
                  ))}
                </div>
              ) : view === 'list' ? (
                <CreativeListView
                  rows={group.rows}
                  usedRawIds={usedRawIds}
                  onClick={setDrawerRow}
                  onDelete={scope.canDelete ? setConfirmDelete : null}
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
          onClose={() => setDrawerRow(null)}
          onSaved={() => { setDrawerRow(null); load() }}
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
          onClose={() => setUploadOpen(false)}
          onSaved={() => { setUploadOpen(false); load() }}
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
const CreativeListView = memo(function CreativeListView({ rows, usedRawIds, onClick, onDelete }) {
  // 8 columns: thumb · name · type · creator · offer · run? · status · actions.
  // Dropped v21 + size — both available in the detail modal. Keeps the row
  // scannable without horizontal scroll on 1280px+ screens.
  const gridCols = '52px minmax(240px, 1.6fr) 90px 90px 140px 70px 80px 80px'
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: gridCols,
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
      }}>
        <div></div>
        <div>Name</div>
        <div>Type</div>
        <div>Creator</div>
        <div>Offer</div>
        <div>Run?</div>
        <div>Status</div>
        <div style={{ textAlign: 'right' }}>Actions</div>
      </div>
      {rows.map((r, i) => (
        <ListRow key={r.id} row={r} isLast={i === rows.length - 1}
          isUsed={usedRawIds?.has(r.id)}
          gridCols={gridCols}
          onClick={() => onClick(r)} onDelete={() => onDelete(r)} />
      ))}
    </div>
  )
})

function ListRow({ row: r, isLast, gridCols, isUsed, onClick, onDelete }) {
  // `onDelete` may be null when the viewer doesn't have delete permission
  const [hover, setHover] = useState(false)
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
            background: hover ? (tint?.hover || 'var(--paper-2)') : (tint?.base || 'transparent'),
            transition: 'background 0.12s',
            cursor: 'pointer',
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={onClick}>
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
            {r.thumbnail_url && !(hoverPlay && r.preview_url) && (
              <img src={r.thumbnail_url} alt="" loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {hoverPlay && r.preview_url && (
              <video src={r.preview_url} autoPlay muted loop playsInline preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
          </div>
          {/* Name */}
          <div style={{ minWidth: 0 }}>
            <div style={{
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
              {r.canonical_name || r.name}
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
const MATRIX_COLS_BASE = '38px minmax(110px, 0.85fr) minmax(180px, 1.8fr) 86px 70px 120px 120px 56px 76px 62px'
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
          <div onClick={toggleAll} title="Select / deselect all visible"
            style={{
              width: 16, height: 16, borderRadius: 2,
              border: '1.5px solid var(--ink-3)',
              background: allVisible ? 'var(--accent)' : (someVisible ? 'var(--paper-2)' : 'white'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}>
            {allVisible && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-8" stroke="var(--ink)" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someVisible && (
              <span style={{ width: 8, height: 2, background: 'var(--ink-3)' }} />
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
          style={{
            width: 16, height: 16, borderRadius: 2,
            border: selected ? '2px solid var(--ink)' : '1.5px solid var(--ink-3)',
            background: selected ? 'var(--accent)' : 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
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
      }} title={r.canonical_name || r.name}>
        {(r.status === 'raw' && isUsed) && (
          <span title="Already edited"
            style={{ color: '#3e8a5e', fontWeight: 600, flexShrink: 0 }}>✓</span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.canonical_name || r.name}
        </span>
      </div>
      {/* Description — read-only at this scope. Editing happens in the
          detail modal (click the row) so the matrix stays a clean
          scan-friendly grid instead of a sea of focusable inputs. */}
      <div style={{
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--ink-2)',
      }} title={r.description || r.name}>
        {r.description || r.name}
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
            {editors.filter(e => e.active).map(e => (
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
          {editors.filter(e => e.active !== false).map(e => {
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
      //    captureVideoThumbnail self-guards on files >500MB.
      setProgress('Capturing thumbnail…')
      let thumbnailUrl = null
      const thumbBlob = await captureVideoThumbnail(file)
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
          name: `v${nextVersion} of ${row.canonical_name || row.name}`,
          type: row.type,
          creator: row.creator,
          status: 'edited',
          offer_slug: row.offer_slug,
          assigned_editor_id: row.assigned_editor_id,
          parent_id: rootId,
          version_number: nextVersion,
          size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
          preview_url: publicUrl,
          thumbnail_url: thumbnailUrl,
          source_bucket: 'New version upload',
          notes: `v${nextVersion} of ${row.canonical_name || row.name}, uploaded ${new Date().toISOString().slice(0,10)}.`,
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
                  {v.canonical_name || v.name}
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
        <div style={{ fontWeight: 600 }}>{sourceRow.canonical_name || sourceRow.name}</div>
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
      const blob = `${r.name} ${r.canonical_name || ''} ${r.creator || ''}`.toLowerCase()
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
                      {r.canonical_name || r.name}
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
        <div style={{ fontWeight: 600 }}>{row.canonical_name || row.name}</div>
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
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{row.canonical_name || row.name}</div>
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

function CreativeCard({ row, isUsed = false, onClick, selected = false, selectionMode = false, onToggleSelect = null }) {
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
        {row.thumbnail_url && !(hoverPlay && row.preview_url) && (
          <img src={row.thumbnail_url} alt=""
            loading="lazy"
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block',
            }} />
        )}
        {hoverPlay && row.preview_url && (
          <video src={row.preview_url}
            autoPlay muted loop playsInline preload="metadata"
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
          {row.canonical_name || row.name}
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
  // Prefer props from the parent (avoid 3 extra network roundtrips
  // each time the modal opens). Fall back to local fetch if the
  // parent didn't pass them (e.g. modal opened standalone somewhere).
  const [editorsLocal, setEditorsLocal] = useState([])
  const [offersLocal, setOffersLocal] = useState([])
  const [knownCreatorsLocal, setKnownCreatorsLocal] = useState([])
  const editors = editorsProp && editorsProp.length > 0 ? editorsProp : editorsLocal
  const offers = offersProp && offersProp.length > 0 ? offersProp : offersLocal
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
    }
    const { error } = await supabase
      .from('lib_creative_library')
      .update(patch)
      .eq('id', row.id)
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
      eyebrow={edit.canonical_name || row.type || 'Creative'}
      title={row.canonical_name || row.name}
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
        {/* Video preview — explicit pause + src clear on unmount so the
            browser doesn't stall when the modal closes mid-stream (Ben
            flagged "click out of pop-up is super slow"). */}
        {playbackKind === 'video' && (
          <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
            <PreviewVideo src={row.preview_url} poster={row.thumbnail_url} />
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
              <a href={dl} download={row.canonical_name || row.name || 'creative.mp4'}
                target="_blank" rel="noreferrer"
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
        <Field label="Name">
          <input type="text" value={edit.canonical_name || ''}
            onChange={e => setEdit({ ...edit, canonical_name: e.target.value })}
            style={inputStyle} />
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
          </Field>
          <Field label="Assigned editor">
            <EditorPicker value={edit.assigned_editor_id}
              editors={editors}
              onChange={v => setEdit({ ...edit, assigned_editor_id: v || null })} />
          </Field>
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
                  <span style={{ marginLeft: 'auto', color: t.is_overdue ? '#b53e3e' : 'var(--ink-4)' }}>
                    {t.is_overdue ? '⚠ overdue ' : ''}{t.due_date || 'no due date'}
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

function UploadModal({ onClose, onSaved, editors = [], offers = [] }) {
  // The modal is now a thin shell: it collects files + batch config,
  // hands them off to the module-level upload queue, and closes. The
  // queue owns all upload state, runs in the background regardless of
  // whether this modal is mounted, and surfaces progress via UploadDock.
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
  const inputRef = useRef(null)
  // No `busy` state — the modal is never blocked once Upload is clicked
  // because the queue takes over. The button just dispatches + closes.
  const busy = false

  const acceptFiles = (incoming) => {
    // Accept videos AND images. Static image ads (banners, carousel
    // creatives) live in the same bucket — widened the bucket's
    // allowed_mime_types to match. Editor uploads from the queue still
    // expect videos, but bulk-add from the Library can be either.
    const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name)
    const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name)
    const added = Array.from(incoming || []).filter(f => isVideo(f) || isImage(f))
    if (added.length) setFiles(prev => [...prev, ...added])
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
  const submit = () => {
    if (!files.length) return
    setErr(null)
    uploadQueue.enqueue(files, {
      batchType,
      batchStatus,
      batchEditorId,
      batchOfferSlug,
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
        return `Drop video or image files — up to 10 GB each. Resumable uploads survive multi-GB clips. Transcripts + auto-tag fire in the background once the file lands.${sizeLabel ? ` · ${sizeLabel}` : ''}`
      })()}
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
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
                {editors.filter(e => e.active !== false).map(e => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Offer / niche</div>
              <select value={batchOfferSlug} onChange={e => setBatchOfferSlug(e.target.value)} style={selectStyle} disabled={busy}>
                <option value="">— None —</option>
                {offers.map(o => (
                  <option key={o.slug} value={o.slug}>{o.name || o.slug}</option>
                ))}
              </select>
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

        {files.length > 0 && (
          <div style={{
            marginTop: 14, border: '1px solid var(--rule)', maxHeight: 280, overflowY: 'auto',
          }}>
            {files.map((f, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 90px 30px',
                gap: 10, alignItems: 'center',
                padding: '8px 12px',
                borderBottom: i === files.length - 1 ? 'none' : '1px solid var(--rule)',
                background: i % 2 === 0 ? 'transparent' : 'var(--paper-2)',
              }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={f.name}>{f.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
                  {(f.size / 1024 / 1024).toFixed(1)} MB
                </div>
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--ink-4)', fontSize: 16, padding: 0,
                }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{
          marginTop: 12, padding: '8px 12px',
          background: 'var(--paper-2)', border: '1px solid var(--rule)',
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
          letterSpacing: '0.04em',
        }}>
          Uploads run in the background — close this modal once you hit Upload. Progress shows in the floating dock (bottom-right).
        </div>
      </div>
    </Modal>
  )
}

/* ─────────────────────────── EDITING QUEUE TAB ─────────────────────────── */

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
    try { return localStorage.getItem('queue.view') || 'list' } catch { return 'list' }
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
  // Status multi-select for filtering — empty = show all.
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set())

  const load = useCallback(async (background = false) => {
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

  // Group by editor (on filtered tasks). We also seed an entry for every
  // active editor — even if they have zero tasks — so they appear as a
  // drop target. Otherwise you couldn't drag a task TO an editor who
  // currently has no work.
  const byEditor = useMemo(() => {
    const m = new Map()
    // Always include "Unassigned" as a drop target
    m.set('unassigned', { editor_id: null, editor_name: 'Unassigned', tasks: [] })
    for (const e of editors.filter(e => e.active)) {
      m.set(e.slug || e.id, { editor_id: e.id, editor_name: e.name, tasks: [] })
    }
    for (const t of filteredTasks) {
      const key = t.editor_slug || 'unassigned'
      if (!m.has(key)) m.set(key, { editor_id: t.editor_id || null, editor_name: t.editor_name || 'Unassigned', tasks: [] })
      m.get(key).tasks.push(t)
    }
    return Array.from(m.entries()).map(([slug, v]) => ({ slug, ...v }))
  }, [filteredTasks, editors])

  const overdue = filteredTasks.filter(t => t.is_overdue).length
  const inProg  = filteredTasks.filter(t => t.status === 'in_progress').length
  const queued  = filteredTasks.filter(t => t.status === 'queued').length
  const done    = filteredTasks.filter(t => t.status === 'done').length

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
    }
  }, [editors])

  // Compatibility wrapper — existing callers (Editor Lanes view, etc.)
  // still call moveTaskToEditor(task, editorId).
  //
  // The caller (EditorLane) may pass a stub `{task_id, editor_id: null}`
  // when the task being dragged isn't in the destination lane's scoped
  // task list. Resolve to the full task from our complete tasks state
  // before checking the no-op guard, otherwise drag-to-Unassigned from
  // a populated lane is silently dropped (stub.editor_id === null ===
  // target null).
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
      {/* KPI bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18,
      }}>
        <KpiTile label="Overdue"     value={overdue} accent={overdue > 0 ? '#b53e3e' : null} />
        <KpiTile label="In progress" value={inProg} />
        <KpiTile label="Queued"      value={queued} />
        <KpiTile label="Done"        value={done} />
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
          {editors.filter(e => e.active).length} editor{editors.filter(e => e.active).length === 1 ? '' : 's'} · {filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'white' }}>
          <ViewBtn active={view === 'inbox'}    onClick={() => setView('inbox')}>Inbox</ViewBtn>
          <ViewBtn active={view === 'list'}     onClick={() => setView('list')}>List</ViewBtn>
          <ViewBtn active={view === 'lanes'}    onClick={() => setView('lanes')}>Editor lanes</ViewBtn>
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
              ...editors.filter(e => e.active).map(e => ({
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
              { value: 'queued',      label: 'Queued',      dot: TASK_STATUS_COLOR.queued,      count: tasks.filter(t => t.status === 'queued').length },
              { value: 'in_progress', label: 'In progress', dot: TASK_STATUS_COLOR.in_progress, count: tasks.filter(t => t.status === 'in_progress').length },
              { value: 'review',      label: 'In review',   dot: TASK_STATUS_COLOR.review,      count: tasks.filter(t => t.status === 'review').length },
              { value: 'done',        label: 'Done',        dot: TASK_STATUS_COLOR.done,        count: tasks.filter(t => t.status === 'done').length },
              { value: 'blocked',     label: 'Blocked',     dot: TASK_STATUS_COLOR.blocked,     count: tasks.filter(t => t.status === 'blocked').length },
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
        <QueueListView tasks={filteredTasks} editors={editors} onEdit={setEditingTask}
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
      ) : view === 'lanes' ? (
        <div style={{ display: 'grid', gap: 18 }}>
          {byEditor.map(({ slug, editor_id, editor_name, tasks: t }) => (
            <EditorLane key={slug}
              editor={editor_name}
              editorId={editor_id}
              editorRecord={editors.find(e => e.id === editor_id)}
              tasks={t}
              onEdit={setEditingTask}
              onMoveEditor={moveTaskToEditor} />
          ))}
        </div>
      ) : view === 'timeline' ? (
        <TimelineView tasks={filteredTasks} editors={editors.filter(e => e.active)}
          onEdit={setEditingTask} onMoveEditor={moveTaskToEditor}
          onUpdateAssignment={updateTaskAssignment}
          onAddTask={(pre) => { setAddTaskPrefill(pre); setAddTaskOpen(true) }} />
      ) : view === 'inbox' ? (
        <InboxView tasks={filteredTasks} onEdit={setEditingTask} />
      ) : (
        <KanbanView
          tasks={filteredTasks}
          editors={editors.filter(e => e.active)}
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
          editors={editors.filter(e => e.active)}
          onClose={() => setShareLinksOpen(false)}
        />
      )}
      {addTaskOpen && (
        <AddTaskModal
          editors={editors.filter(e => e.active)}
          prefillEditorId={addTaskPrefill.editorId}
          prefillDue={addTaskPrefill.due}
          prefillStart={addTaskPrefill.start}
          onClose={() => { setAddTaskOpen(false); setAddTaskPrefill({ editorId: '', due: '', start: '' }) }}
          onSaved={() => { setAddTaskOpen(false); setAddTaskPrefill({ editorId: '', due: '', start: '' }); load() }} />
      )}
      {editingTask && (
        <EditTaskModal
          task={editingTask}
          editors={editors}
          scope={scope}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); load() }}
          onDeleted={() => { setEditingTask(null); load() }} />
      )}
      {editingEditor && (
        <EditEditorModal
          editor={editingEditor}
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
  const sortedEditors = editors.filter(e => e.active)

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
function QueueListView({ tasks, editors, onEdit, onReorder }) {
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
  // 7-col grid: rank · thumb · creative · editor · status · task-type · due · priority · source
  const GRID = '40px 56px minmax(220px, 1.6fr) 130px 110px 110px 120px 90px 50px'
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: GRID,
        padding: '10px 14px', gap: 12,
        background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
      }}>
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
            onClick={() => onEdit(t)}
            style={{
              display: 'grid', gridTemplateColumns: GRID,
              padding: '10px 14px', gap: 12, alignItems: 'center',
              borderBottom: i === ordered.length - 1 ? 'none' : '1px solid var(--rule)',
              borderTop: isDropTarget && dropPosition === 'before' ? '2px solid var(--ink)' : '2px solid transparent',
              cursor: isDone ? 'pointer' : 'grab',
              transition: 'background 0.12s',
              opacity: isDragging ? 0.4 : (isDone ? 0.55 : 1),
              background: tint?.base || 'transparent',
              boxShadow: isDropTarget && dropPosition === 'after' ? 'inset 0 -2px 0 0 var(--ink)' : 'none',
            }}
            onMouseEnter={e => { if (!tint) e.currentTarget.style.background = 'var(--paper-2)' }}
            onMouseLeave={e => { if (!tint) e.currentTarget.style.background = 'transparent' }}>
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
              }}>{t.creative_canonical_name || t.creative_name}</div>
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
            <div><StatusPipBadge status={t.status} isOverdue={t.is_overdue} /></div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{t.task_type || '—'}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11,
                          color: t.is_overdue ? '#b53e3e' : 'var(--ink-3)' }}>
              {t.is_overdue && '⚠ '}{t.due_date || '—'}
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
const TASK_TYPE_OPTIONS = [
  { value: 'edit',     label: 'Edit' },
  { value: 'patch',    label: 'Patch' },
  { value: 'revision', label: 'Revision' },
]

/* Click any task anywhere → opens this modal. Change editor / status /
   priority / type / due date / notes. Or delete the task. */
function EditTaskModal({ task, editors, scope = ADMIN_SCOPE, onClose, onSaved, onDeleted }) {
  const [editorId, setEditorId] = useState(task.editor_id || '')
  const [status, setStatus] = useState(task.status || 'queued')
  const [priority, setPriority] = useState(task.priority || 'P2 - Medium')
  const [taskType, setTaskType] = useState(task.task_type || 'edit')
  const [due, setDue] = useState(task.due_date || '')
  const [notes, setNotes] = useState(task.notes || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDel, setConfirmDel] = useState(false)
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
  }, [task.task_id])
  useEffect(() => { reloadSubmissions() }, [reloadSubmissions])

  const save = async () => {
    setBusy(true); setErr(null)
    const patch = {
      editor_id: editorId || null,
      status, priority, task_type: taskType, due_date: due || null,
      notes: notes || null,
    }
    // Auto-set started_at when moving into in_progress
    if (status === 'in_progress' && !task.started_at) patch.started_at = new Date().toISOString()
    // Auto-set completed_at when moving to done
    if (status === 'done' && !task.completed_at) patch.completed_at = new Date().toISOString()
    const { error } = await supabase.from('lib_editing_tasks').update(patch).eq('id', task.task_id)
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
  }
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
  // version. One-step flow now: dropping or selecting a file kicks this
  // off immediately, no separate "Mark for review" button. Status moves to
  // 'review' in local state so the modal reflects the new state without
  // needing to close + reopen.
  const startUpload = useCallback(async (file) => {
    if (!file) return
    setUploadFile(file)
    setBusy(true); setErr(null); setUploadProgress(0)
    try {
      const sanitized = file.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const storagePath = `edited/${Date.now()}_${sanitized}`
      // Direct XHR upload to Supabase Storage REST API. The supabase-js
      // SDK's storage.upload() routes through fetch which doesn't expose
      // per-byte progress, so we'd be stuck showing a frozen 20% bar
      // until the whole file landed. XHR gives us real onprogress events
      // AND an abort() handle for the close-during-upload path.
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        uploadXhrRef.current = xhr
        const url = `${SUPABASE_URL}/storage/v1/object/creative-uploads/${storagePath}`
        xhr.open('POST', url)
        xhr.setRequestHeader('Authorization', `Bearer ${SUPABASE_KEY}`)
        xhr.setRequestHeader('apikey', SUPABASE_KEY)
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
        xhr.setRequestHeader('x-upsert', 'false')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Reserve 0-70% for the actual byte upload, 70-100% for the
            // DB-row patches that follow.
            setUploadProgress(Math.round((e.loaded / e.total) * 70))
          }
        }
        xhr.onload = () => {
          uploadXhrRef.current = null
          if (xhr.status >= 200 && xhr.status < 300) return resolve()
          let msg = `HTTP ${xhr.status}`
          try {
            const body = JSON.parse(xhr.responseText)
            if (body.error || body.message) msg = body.error || body.message
          } catch {}
          reject(new Error(msg))
        }
        xhr.onerror = () => { uploadXhrRef.current = null; reject(new Error('Network error during upload')) }
        xhr.onabort = () => { uploadXhrRef.current = null; reject(new Error('Upload cancelled')) }
        xhr.ontimeout = () => { uploadXhrRef.current = null; reject(new Error('Upload timed out (10 min)')) }
        xhr.timeout = 10 * 60 * 1000
        xhr.send(file)
      })
      setUploadProgress(75)
      const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`

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
      await reloadSubmissions()
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'approve failed')
    } finally {
      setBusy(false)
    }
  }, [task.task_id, task.creative_id, reloadSubmissions, onSaved])

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

  // Close handler — aborts the in-flight upload (if any) so the editor
  // can bail out of a stuck or unwanted upload. The XHR's onabort path
  // fires reject('Upload cancelled') and the cleanup branch in startUpload
  // unsets busy.
  const handleCloseModal = useCallback(() => {
    if (uploadXhrRef.current) {
      try { uploadXhrRef.current.abort() } catch {}
      uploadXhrRef.current = null
    }
    onClose?.()
  }, [onClose])

  return (
    <Modal open={true} onClose={handleCloseModal} size="lg"
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
                  ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
                }}>Delete</button>
              )}
              <button onClick={handleCloseModal} style={ghostBtn}>
                {busy && uploadXhrRef.current ? 'Cancel upload' : 'Cancel'}
              </button>
              <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Inline video preview — playable in the modal so the editor
            can watch the source without bouncing elsewhere. preview_url
            is the compressed 720p mp4 for OLD Drive-imported rows; for
            new TUS-uploaded rows it's the ORIGINAL full-quality file.
            The Download Original button always points at the highest-
            quality source we have: drive_url first (always original for
            old rows), then preview_url (only full-quality for new rows). */}
        {task.preview_url ? (
          <div style={{ background: '#000', border: '1px solid var(--rule)' }}>
            <PreviewVideo src={task.preview_url} poster={task.thumbnail_url}
              style={{ display: 'block', width: '100%', maxHeight: 360, objectFit: 'contain', background: '#000' }} />
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
                {(task.drive_url || task.preview_url) && (
                  <a
                    href={task.drive_url || task.preview_url}
                    download={task.creative_name || 'creative.mp4'}
                    target="_blank" rel="noreferrer"
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

        {/* Quick-action status row — colored pill per status when selected.
            Uses TASK_STATUS_COLOR/LABEL so display reads "In progress" not
            the raw "IN_PROGRESS" enum string. */}
        <div>
          <div style={chipLabelStyle}>Status</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {['queued', 'in_progress', 'review', 'done', 'blocked'].map(s => {
              const isOn = status === s
              const c = TASK_STATUS_COLOR[s] || 'var(--ink)'
              return (
                <button key={s} onClick={() => setStatus(s)} style={{
                  padding: '6px 12px',
                  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: isOn ? c : 'white',
                  color: isOn ? 'white' : 'var(--ink-2)',
                  border: '1px solid ' + (isOn ? c : 'var(--rule)'),
                  borderRadius: 2, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 7,
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
          <Field label="Task type">
            <OptionPicker value={taskType} options={TASK_TYPE_OPTIONS}
              onChange={setTaskType} />
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)' }}
            placeholder="Notes on this task — feedback, blockers, links to revisions…" />
        </Field>

        {/* Submitted work — stacked list of every upload (v1, v2, v3, …)
            from lib_task_submissions. Newest first. Each card has its
            own video preview, Approve button (admin), Delete button. */}
        <SubmissionsPanel
          submissions={submissions}
          canApprove={scope.canEditTask}
          canDelete={scope.canEditTask}
          busy={busy}
          onApprove={approveSubmission}
          onDelete={deleteSubmission}
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
          {/* Alternative: paste a review link instead of uploading the
              raw file. Useful for Frame.io / Drive review pages / Dropbox
              previews — editor doesn't have to wait for a multi-GB upload
              + Ben can leave comments inside the linked tool. */}
          <ExternalLinkSubmitter
            taskId={task.task_id}
            editorId={task.editor_id}
            editorName={task.editor_name}
            currentVersionCount={submissions.length}
            onSubmitted={async () => {
              await reloadSubmissions()
              // Move task to review (same effect as a file upload)
              await supabase.from('lib_editing_tasks')
                .update({ status: 'review', started_at: task.started_at || new Date().toISOString() })
                .eq('id', task.task_id)
              setStatus('review')
              onSaved?.()
            }}
          />
        </div>
        )}

        {task.drive_url && !task.preview_url && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
            Source file: <a href={task.drive_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{task.drive_url.slice(0, 80)}…</a>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* Submissions panel — stack of submission cards (v1, v2, v3, …) from
   lib_task_submissions, newest first. Each card has its own inline
   playable preview + per-version Approve / Delete buttons. Replaces
   the old single-slot SubmittedWorkPanel. */
function SubmissionsPanel({ submissions, canApprove, canDelete, busy, onApprove, onDelete }) {
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
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                  }}>
                    {sub.submitted_by_name || 'Unknown'} · {new Date(sub.created_at).toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                  {(sub.file_url || sub.external_url) && (
                    <a href={sub.file_url || sub.external_url} target="_blank" rel="noreferrer"
                      style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)', textDecoration: 'underline' }}>
                      Open ↗
                    </a>
                  )}
                  {canApprove && !isApproved && (
                    <button type="button" disabled={busy}
                      onClick={() => onApprove?.(sub)}
                      style={{
                        padding: '3px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: '#3e8a5e', color: 'white',
                        border: 'none', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer',
                      }}>Approve</button>
                  )}
                  {canDelete && confirmDeleteId !== sub.id && (
                    <button type="button" disabled={busy}
                      onClick={() => setConfirmDeleteId(sub.id)}
                      style={{
                        padding: '3px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'transparent', color: '#b53e3e',
                        border: '1px solid rgba(181,62,62,0.35)', borderRadius: 2,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}>Delete</button>
                  )}
                  {canDelete && confirmDeleteId === sub.id && (
                    <>
                      <button type="button" disabled={busy}
                        onClick={() => setConfirmDeleteId(null)}
                        style={{
                          padding: '3px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                          fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: 'transparent', color: 'var(--ink-3)',
                          border: '1px solid var(--rule)', borderRadius: 2, cursor: 'pointer',
                        }}>Cancel</button>
                      <button type="button" disabled={busy}
                        onClick={() => { onDelete?.(sub); setConfirmDeleteId(null) }}
                        style={{
                          padding: '3px 9px', fontFamily: 'var(--mono)', fontSize: 10,
                          fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                          background: '#b53e3e', color: 'white',
                          border: 'none', borderRadius: 2, cursor: 'pointer',
                        }}>Confirm delete</button>
                    </>
                  )}
                </div>
              </div>
              {/* Body only renders when expanded — avoids spinning up
                  N video <video> elements + N decoders just to show a
                  revision history. */}
              {isExpanded && sub.file_url && (
                <>
                  <PreviewVideo src={sub.file_url} poster={sub.thumbnail_url}
                    style={{ display: 'block', width: '100%', maxHeight: 280, background: '#000', objectFit: 'contain' }} />
                  <div style={{
                    padding: '6px 12px', background: 'var(--paper-2)',
                    borderTop: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
                  }}>
                    <a href={sub.file_url}
                      download={`v${sub.version_number || 1}.mp4`}
                      target="_blank" rel="noreferrer"
                      title="Download this submitted cut"
                      style={{
                        padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                        fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                        background: 'var(--ink)', color: 'var(--paper)',
                        textDecoration: 'none', borderRadius: 2,
                      }}>↓ Download</a>
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
                }}>{sub.notes}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* Dedicated Manage Editors modal — centralized roster view + add new +
   row-level edit click-through. Replaces the inline ✎ chip pattern. */
function ManageEditorsModal({ editors, tasks, onClose, onEditorAdded, onEditorPatched, onEditorsRemoved, onOpenEditor }) {
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const toggleSel = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(editors.map(e => e.id)))
  const clearSel = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    setBusy(true); setErr(null)
    const ids = Array.from(selectedIds)
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
    setBusy(true); setErr(null)
    const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { data, error } = await supabase.from('lib_creative_editors')
      .insert({ name: newName.trim(), slug })
      .select()
      .single()
    setBusy(false)
    if (error) setErr(error.message)
    else {
      setNewName('')
      if (data) onEditorAdded?.(data)
    }
  }

  const toggleActive = async (e) => {
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
      subtitle="Roster of short-form editors. Add new ones, deactivate inactive ones, click any row to edit details + share links."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} disabled={busy} style={primaryBtn}>Done</button>
        </>
      }>
      <div style={{ padding: '20px 28px', display: 'grid', gap: 14 }}>
        {/* Add new editor */}
        <div style={{
          padding: '12px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={chipLabelStyle}>Add new</span>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addEditor() }}
            placeholder="Editor name (e.g. Sarah)"
            style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addEditor} disabled={!newName.trim() || busy} style={primaryBtn}>
            {busy ? '…' : '+ Add'}
          </button>
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
            gridTemplateColumns: '24px 32px minmax(160px, 1fr) 90px 90px 100px 80px',
            gap: 10, padding: '10px 14px',
            background: 'var(--paper-2)', borderBottom: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>
            <div></div>
            <div></div>
            <div>Name</div>
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
                gridTemplateColumns: '24px 32px minmax(160px, 1fr) 90px 90px 100px 80px',
                gap: 10, padding: '10px 14px', alignItems: 'center',
                borderBottom: i === editors.length - 1 ? 'none' : '1px solid var(--rule)',
                cursor: 'pointer', transition: 'background 0.12s',
                opacity: e.active ? 1 : 0.55,
                background: isSel ? 'rgba(244,225,74,0.15)' : 'transparent',
              }}
                onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = 'transparent' }}>
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
                <span style={{ width: 18, height: 18, borderRadius: 3, background: color }} />
                <div style={{ fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
                  {e.name}
                  {!e.active && <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>(inactive)</span>}
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>{c.open}</div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>{c.done}</div>
                <div>
                  <label onClick={ev => ev.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={e.active}
                      onChange={() => toggleActive(e)} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)' }}>
                      {e.active ? 'Active' : 'Off'}
                    </span>
                  </label>
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                  Edit ↗
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

function EditEditorModal({ editor, onClose, onSavedPatch, onDeleted }) {
  const [name, setName] = useState(editor.name || '')
  const [active, setActive] = useState(editor.active !== false)
  const [notes, setNotes] = useState(editor.notes || '')
  const [color, setColor] = useState(editor.color || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)
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
    const patch = { name: name.trim(), active, notes: notes || null, color: color || null }
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
              <button onClick={() => setConfirmDeactivate(true)} disabled={busy} style={{
                ...ghostBtn, color: 'var(--ink-3)', borderColor: 'var(--rule)', marginRight: 4,
              }}>Deactivate</button>
              <button onClick={() => setConfirmHardDelete(true)} disabled={busy} style={{
                ...ghostBtn, color: '#b53e3e', borderColor: 'rgba(181,62,62,0.4)', marginRight: 'auto',
              }}>Delete forever</button>
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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { error } = await supabase.from('lib_creative_editors').insert({ name: name.trim(), slug })
    setBusy(false)
    if (error) setErr(error.message)
    else onSaved?.()
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
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }>
      <div style={{ padding: '20px 28px' }}>
        <Field label="Name">
          <input type="text" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Sarah" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </Field>
      </div>
    </Modal>
  )
}

function AddTaskModal({ editors, onClose, onSaved, prefillEditorId = '', prefillDue = '', prefillStart = '' }) {
  const [mode, setMode] = useState('pick')   // 'pick' or 'upload'
  const [creatives, setCreatives] = useState([])
  const [search, setSearch] = useState('')
  // Selected creative(s) — Set of ids. UI toggles between single and multi:
  // checkbox per row + a "Select all visible" affordance.
  const [creativeIds, setCreativeIds] = useState(() => new Set())
  // Upload-mode state
  const [uploadFile, setUploadFile] = useState(null)
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
    supabase.from('lib_creative_library')
      .select('id,name,canonical_name,type,creator,thumbnail_url,description')
      .eq('exclude_from_library', false)
      .order('canonical_name', { ascending: true })
      .limit(500)
      .then(({ data }) => setCreatives(data || []))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return creatives.slice(0, 50)
    return creatives.filter(c =>
      (c.canonical_name || c.name).toLowerCase().includes(q) ||
      (c.name || '').toLowerCase().includes(q)
    ).slice(0, 50)
  }, [creatives, search])

  const onFilePick = (file) => {
    if (!file) return
    setUploadFile(file)
    // Auto-fill name from filename (strip extension)
    if (!uploadName) setUploadName(file.name.replace(/\.[^.]+$/, ''))
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      let cids = []
      // Upload mode: upload file → insert library row → single creative id
      if (mode === 'upload') {
        if (!uploadFile || !uploadName.trim()) {
          setErr('Pick a file and give it a name'); setBusy(false); return
        }
        setUploadProgress(10)
        const sanitized = uploadFile.name.replace(/[^A-Za-z0-9._-]+/g, '_')
        const storagePath = `edited/${Date.now()}_${sanitized}`
        const { error: upErr } = await supabase.storage
          .from('creative-uploads')
          .upload(storagePath, uploadFile, { upsert: false })
        if (upErr) throw upErr
        setUploadProgress(60)
        const publicUrl = `https://kjfaqhmllagbxjdxlopm.supabase.co/storage/v1/object/public/creative-uploads/${storagePath}`
        const { data: newRow, error: insErr } = await supabase.from('lib_creative_library')
          .insert({
            name: uploadName.trim() + (uploadFile.name.match(/\.[^.]+$/) || [''])[0],
            type: uploadType,
            size_mb: Math.round(uploadFile.size / 1024 / 1024 * 10) / 10,
            status: 'review',
            source_bucket: 'Editor upload (via Add task)',
            preview_url: publicUrl,
            drive_url: publicUrl,
            notes: `Uploaded ${new Date().toISOString().slice(0,10)} alongside a new task. Pending review + assignment.`,
          })
          .select()
          .single()
        if (insErr) throw insErr
        cids = [newRow.id]
        setUploadProgress(85)
      } else {
        cids = Array.from(creativeIds)
      }
      if (cids.length === 0) { setErr('Pick one or more creatives or upload a new file'); setBusy(false); return }

      // Optional: bulk-rename the picked creatives to a shared project name.
      // Format: "<projectName> 1", "<projectName> 2", ... so each row has
      // a unique canonical_name (no DB unique constraint, but Ben wants
      // them visually distinct in lists).
      if (projectName.trim() && mode === 'pick') {
        const proj = projectName.trim()
        const updates = cids.map((id, i) => ({ id, canonical_name: cids.length === 1 ? proj : `${proj} ${i + 1}` }))
        // Bulk update via individual writes — Supabase doesn't have a clean
        // 'upsert different values per row' API. N is small (selected count)
        // so this is fine.
        for (const u of updates) {
          const { error: rnErr } = await supabase.from('lib_creative_library')
            .update({ canonical_name: u.canonical_name })
            .eq('id', u.id)
          if (rnErr) throw rnErr
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
      const { error: taskErr } = await supabase.from('lib_editing_tasks').insert(rows)
      if (taskErr) throw taskErr
      setUploadProgress(100)
      onSaved?.()
    } catch (e) {
      setErr(e.message || 'failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'pick'
    ? creativeIds.size > 0
    : !!uploadFile && !!uploadName.trim()
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
              : (mode === 'upload' ? 'Upload + add task' : 'Add task')}
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
                        }}>{c.canonical_name || c.name}</div>
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
            {/* Project rename — applies the same project name to all selected
                creatives (auto-numbered when there's more than one). */}
            {creativeIds.size > 0 && (
              <Field label={creativeIds.size === 1 ? 'Optional: rename this creative' : `Optional: rename all ${creativeIds.size} as a project`}>
                <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)}
                  placeholder={creativeIds.size === 1 ? 'New name (leave blank to keep current)' : 'e.g. HAMMER campaign — will become "HAMMER campaign 1", "HAMMER campaign 2"…'}
                  style={inputStyle} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Upload your finished file">
              <div
                onClick={() => !busy && uploadInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); onFilePick(e.dataTransfer.files?.[0]) }}
                onDragOver={e => e.preventDefault()}
                style={{
                  padding: 24, textAlign: 'center', cursor: busy ? 'not-allowed' : 'pointer',
                  border: '2px dashed var(--rule)',
                  background: uploadFile ? 'white' : 'var(--paper-2)',
                }}>
                <input ref={uploadInputRef} type="file" accept="video/*"
                  style={{ display: 'none' }}
                  onChange={e => onFilePick(e.target.files?.[0])} />
                {uploadFile ? (
                  <>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500 }}>{uploadFile.name}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                      {(uploadFile.size / 1024 / 1024).toFixed(1)} MB · click to change
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)' }}>
                      Drop your finished file here
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 4 }}>
                      or click to select
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
              <Field label="Name this creative">
                <input type="text" value={uploadName} onChange={e => setUploadName(e.target.value)}
                  placeholder="e.g. 'Eric direct call breakthrough — final cut'"
                  style={inputStyle} />
              </Field>
              <Field label="Type">
                <select value={uploadType} onChange={e => setUploadType(e.target.value)} style={selectStyle}>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          </>
        )}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
          <Field label="Editor (optional)">
            <select value={editorId} onChange={e => setEditorId(e.target.value)} style={selectStyle}>
              <option value="">— Unassigned</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          <Field label="Task type">
            <select value={taskType} onChange={e => setTaskType(e.target.value)} style={selectStyle}>
              <option value="edit">Edit</option>
              <option value="patch">Patch</option>
              <option value="revision">Revision</option>
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
              <option>P1 - High</option>
              <option>P2 - Medium</option>
              <option>P3 - Low</option>
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
          </Field>
        </div>
        {/* Optional start date — appears auto-filled when user dragged
            across days in Timeline. Lets them tweak before saving. */}
        {(startDate || prefillStart) && (
          <Field label="Start date (drag-created task)">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

/* ─────────────────────── TIMELINE (Gantt-style) ─────────────────────── */

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
  const tasksById = useMemo(() => Object.fromEntries(tasks.map(t => [t.task_id, t])), [tasks])
  const draggingTask = draggingTaskId ? tasksById[draggingTaskId] : null

  const handleTaskDragStart = (e, task) => {
    e.dataTransfer.setData('application/x-task-id', task.task_id)
    e.dataTransfer.setData('text/plain', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTaskId(task.task_id)
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
                  const stripe = t.is_overdue ? '#b53e3e' : (STATUS_STRIPE[t.status] || '#999')
                  const label = t.creative_canonical_name || t.creative_name
                  const thumbVisible = !!t.thumbnail_url && w >= 80
                  // Status badge: show prominently for non-queued states.
                  //   review      → solid blue "REVIEW"
                  //   in_progress → solid orange "WIP"
                  //   done        → solid green "DONE" + bar dimmed
                  //   blocked     → solid red "BLOCKED"
                  // Overdue replaces the badge with "OVD" in red.
                  const STATUS_BADGE = {
                    review:      { label: 'REVIEW', bg: '#3e7eba' },
                    in_progress: { label: 'WIP',    bg: '#e0853e' },
                    done:        { label: 'DONE',   bg: '#3e8a5e' },
                    blocked:     { label: 'BLOCK',  bg: '#b53e3e' },
                  }
                  const badge = t.is_overdue
                    ? { label: 'OVD', bg: '#b53e3e' }
                    : STATUS_BADGE[t.status] || null
                  const isDone = t.status === 'done'
                  return (
                    <div key={t.task_id}
                      data-task-bar="true"
                      onClick={() => {
                        // Suppress the click that fires right after a resize
                        // mouseup — otherwise releasing the resize handle
                        // opens the modal every time.
                        if (isResizing || justResizedRef.current) return
                        onEdit?.(t)
                      }}
                      draggable={!!(onMoveEditor || onUpdateAssignment) && !isResizing}
                      onDragStart={(e) => handleTaskDragStart(e, t)}
                      onDragEnd={handleTaskDragEnd}
                      title={`${label}${t.creative_canonical_name ? ' · ' + t.creative_name : ''} · ${t.status}${t.due_date ? ' · due ' + t.due_date : ''}${t.is_overdue ? ' · OVERDUE' : ''}${(onMoveEditor || onUpdateAssignment) ? ' · drag the bar to reassign · drag the right edge to extend the due date' : ''}`}
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
            {section.items.map(t => <InboxCard key={t.task_id} task={t} onEdit={onEdit} sectionColor={section.color} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function InboxCard({ task: t, onEdit, sectionColor }) {
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
        if (days < 0) return `${Math.abs(days)}d overdue`
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
        display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 14,
        padding: '12px 16px', alignItems: 'center',
        background: hover ? 'var(--paper-2)' : 'var(--paper)',
        border: '1px solid var(--rule)', borderLeft: `4px solid ${sectionColor}`,
        cursor: 'pointer', transition: 'background 0.12s',
      }}>
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
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{t.creative_canonical_name || t.creative_name}</div>
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
              <span style={{ color: t.is_overdue ? '#b53e3e' : 'var(--ink-4)' }}>{dueLabel}</span>
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

function KanbanView({ tasks, editors, onEdit, onMove, onReassignEditor, onAddInColumn }) {
  const cols = ['queued', 'in_progress', 'review', 'blocked', 'done']
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
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`,
      gap: 10, alignItems: 'flex-start',
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
              {TASK_STATUS_LABEL[c]}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{byCol[c].length}</span>
              {onAddInColumn && (
                <button onClick={() => onAddInColumn(c)} title={`Add a task in ${TASK_STATUS_LABEL[c]}`}
                  style={{
                    background: 'var(--ink)', color: 'var(--paper)', border: 'none',
                    width: 22, height: 22, borderRadius: 2, cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, lineHeight: 1,
                  }}>+</button>
              )}
            </div>
          </div>
          <div style={{ padding: 8, display: 'grid', gap: 8 }}>
            {byCol[c].map(t => (
              <QueueCard key={t.task_id} task={t}
                editors={editors}
                onClick={() => onEdit?.(t)}
                onReassignEditor={onReassignEditor}
                draggable={!!onMove}
                onDragStart={e => handleDragStart(e, t)} />
            ))}
            {byCol[c].length === 0 && (
              <div style={{
                padding: '20px 12px', textAlign: 'center',
                fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                border: dragOver === c ? '2px dashed var(--ink-4)' : '2px dashed transparent',
                fontStyle: 'italic', transition: 'border-color 0.12s',
              }}>{dragOver === c ? 'Drop to move' : 'Empty'}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function EditorLane({ editor, editorId, editorRecord, tasks, onEdit, onMoveEditor }) {
  const [dragOver, setDragOver] = useState(false)
  // Prefer the operator's saved color override (editorRecord.color),
  // fall back to slug-hash from the editor name when no record is wired.
  const eColor = editorId
    ? (editorRecord?.color || editorColor(editor?.toLowerCase().replace(/\s+/g, '-') || ''))
    : '#999'

  // Cache the task lookup once per render via a tasks-map on the parent
  // would be cleaner, but parsing the drag payload here is fine — it's
  // just an id roundtrip. We use a custom payload prefix so we don't
  // accidentally accept drops from the Kanban view.
  const handleDragStart = (e, task) => {
    e.dataTransfer.setData('text/plain', `lane:${task.task_id}`)
    e.dataTransfer.setData('application/x-task-id', task.task_id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }
  const handleDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    if (dragOver) setDragOver(false)
  }
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/x-task-id') || e.dataTransfer.getData('text/plain')
    if (!raw) return
    const taskId = raw.startsWith('lane:') ? raw.slice(5) : raw
    // Find the task across ALL lanes by searching props.tasks first; if
    // not in this lane, parent's onMoveEditor will still work because we
    // pass a task-shaped object with editor_id for diff.
    const task = tasks.find(t => t.task_id === taskId)
      || { task_id: taskId, editor_id: null }  // shallow stub — parent has full state
    onMoveEditor?.(task, editorId)
  }

  return (
    <div
      onDragOver={onMoveEditor ? handleDragOver : undefined}
      onDragLeave={onMoveEditor ? handleDragLeave : undefined}
      onDrop={onMoveEditor ? handleDrop : undefined}
      style={{
        background: 'var(--paper)',
        border: dragOver ? `2px dashed ${eColor}` : '1px solid var(--rule)',
        transition: 'border-color 0.1s',
      }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--paper-2)',
      }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Editor
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, marginTop: 2 }}>{editor}</div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </div>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 10, padding: 12, minHeight: 80,
      }}>
        {tasks.map(t => (
          <QueueCard key={t.task_id} task={t}
            onClick={() => onEdit?.(t)}
            draggable={!!onMoveEditor}
            onDragStart={e => handleDragStart(e, t)} />
        ))}
        {tasks.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            padding: '12px', textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            fontStyle: 'italic',
          }}>
            {dragOver ? 'Drop to assign' : 'No tasks · drag a card here to assign'}
          </div>
        )}
      </div>
    </div>
  )
}

/* QueueCard — fixed-shape card used by EditorLane + Kanban.
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
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{task.creative_canonical_name || task.creative_name}</div>
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
          <span style={{ marginLeft: 'auto', color: task.is_overdue ? '#b53e3e' : 'var(--ink-4)' }}>
            {task.is_overdue ? '⚠ ' : ''}{task.due_date}
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

function KpiTile({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--rule)',
      padding: '14px 18px',
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--sans)', fontSize: 32, fontWeight: 500,
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
