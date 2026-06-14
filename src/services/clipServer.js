/*
  clipServer — client side of the server-side Clip Editor (2026-06-14).

  Drop-in replacement for services/clipSurgery.js (the browser
  ffmpeg.wasm path): SAME function signatures, so ClipEditorModal swaps
  with one import line. The actual cutting happens in the clip-worker
  container (real ffmpeg, full codecs incl. iPhone HEVC, no 32MB browser
  download).

  Flow per source file:
    1. upload the File once to the public creative-uploads bucket
       (cached per File object so re-cuts don't re-upload),
    2. POST its public URL + the edit to the worker with the user's
       Supabase JWT (no shared secret in the bundle),
    3. get the finished MP4 bytes back as a File.

  The worker is stateless — it never holds a service key; the browser
  owns all storage with its own login.
*/
import { supabase } from '../lib/supabase'

const WORKER_URL = (import.meta.env.VITE_CLIP_WORKER_URL || 'https://clip-worker-prbd.onrender.com').replace(/\/$/, '')
const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const BUCKET = 'creative-uploads'

// Server ffmpeg handles far more than the wasm heap; cap at 1GB to match
// the worker's MAX_SOURCE_BYTES.
export const MAX_INPUT_BYTES = 1024 * 1024 * 1024

// File → uploaded public URL, so a multi-segment split uploads the
// source once. WeakMap: entries vanish when the File is dropped.
const _srcCache = new WeakMap()

async function authHeader() {
  const { data } = await supabase.auth.getSession()
  const jwt = data?.session?.access_token
  return jwt ? { Authorization: `Bearer ${jwt}` } : {}
}

function safeName(name) {
  return (name || 'src').replace(/[^A-Za-z0-9._-]+/g, '_')
}

// Upload the source to a temp path and return its public URL (cached).
async function ensureSource(file, onStage) {
  if (_srcCache.has(file)) return _srcCache.get(file)
  onStage?.('Uploading source…')
  const path = `clip-src/${crypto.randomUUID()}_${safeName(file.name)}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true, contentType: file.type || 'video/mp4', cacheControl: '3600',
  })
  if (error) throw new Error(`Couldn't stage the video for cutting: ${error.message}`)
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
  _srcCache.set(file, url)
  return url
}

async function workerJSON(path, body, onStage) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = `worker ${res.status}`
    try { msg = (await res.json()).error || msg } catch { /* non-JSON */ }
    if (res.status === 401) msg = 'Not signed in — reload and try again.'
    throw new Error(msg)
  }
  return res
}

export async function detectTakeBoundaries(file, { onStage } = {}) {
  const sourceUrl = await ensureSource(file, onStage)
  onStage?.('Detecting takes…')
  const res = await workerJSON('/detect', { sourceUrl }, onStage)
  const { cuts } = await res.json()
  return Array.isArray(cuts) ? cuts : []
}

export async function renderSegment(file, { start, end, reencode = false, outName, onStage } = {}) {
  const sourceUrl = await ensureSource(file, onStage)
  onStage?.(reencode ? 'Trimming (frame-accurate)…' : 'Cutting…')
  const res = await workerJSON('/cut', {
    sourceUrl,
    in: start ?? null,
    out: end ?? null,
    reencode: !!reencode,
  }, onStage)
  const blob = await res.blob()
  return new File([blob], outName || 'segment.mp4', { type: 'video/mp4' })
}

export async function renderMerge(parts, { outName = 'merged.mp4', onStage } = {}) {
  // parts: [{ file, start, end, trimmed }]
  const resolved = []
  for (const p of parts) {
    const url = await ensureSource(p.file, onStage)
    resolved.push({ sourceUrl: url, in: p.start ?? null, out: p.end ?? null })
  }
  const reencode = parts.some(p => p.trimmed)
  onStage?.('Joining…')
  const res = await workerJSON('/merge', { parts: resolved, reencode }, onStage)
  const blob = await res.blob()
  return new File([blob], outName, { type: 'video/mp4' })
}
