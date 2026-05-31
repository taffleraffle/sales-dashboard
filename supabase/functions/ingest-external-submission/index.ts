// ingest-external-submission — Supabase Edge Function
//
// Triggered by:
//   1. AFTER INSERT trigger on lib_task_submissions (via pg_net) whenever
//      an editor submits a Frame.io / Drive / Dropbox / direct URL.
//   2. retry_external_ingest() RPC called by the dashboard's Retry button.
//
// Pulls the underlying video from the external host, uploads to the
// creative-uploads bucket under external-pulls/<submission_id>.<ext>,
// patches the submission row to set file_url (so existing in-place
// playback in SubmissionPreviewModal just works).
//
// Editor's original external_url is preserved for traceability — we
// never overwrite it. ingest_status tracks pending → success/failed.
//
// Auth model:
//   - Drive:    GOOGLE_SERVICE_ACCOUNT_KEY (JSON, base64-encoded) →
//               JWT → access_token via oauth2.googleapis.com/token.
//               Editors must share their files with the service account
//               email (one-time per editor or per folder).
//   - Frame.io: FRAMEIO_PAT (Personal Access Token, scope: assets.read).
//   - Dropbox:  no auth — public share links converted to dl=1 form.
//   - Direct:   no auth — content-type must start with video/.
//
// Failure path: ingest_status='failed' + ingest_error_text on the row,
// plus a lib_editor_notifications row for the editor (kind='ingest_failed')
// surfaced in the existing notification bell.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create as signJwt } from 'https://deno.land/x/djwt@v3.0.1/mod.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Hard cap on the upstream download size — fetched as a blob into memory
// before re-uploading, so larger than this risks OOMing the edge runtime
// (256MB ceiling). We check this TWICE: first against the upstream
// Content-Length header BEFORE buffering (the cheap, fast bail), then
// against the actual buffered byteLength (defence-in-depth for hosts
// that don't return Content-Length).
const MAX_BLOB_BYTES = 220 * 1024 * 1024  // 220 MB

// Helper: read Content-Length off a Response, parse to bytes. Returns
// null when the header is missing/unparseable (e.g. chunked transfers).
function declaredSize(resp: Response): number | null {
  const h = resp.headers.get('content-length')
  if (!h) return null
  const n = parseInt(h, 10)
  return isFinite(n) && n > 0 ? n : null
}

// Helper: throw a "file too large" error if the declared size exceeds
// the cap. Used by every fetcher right after the body fetch and BEFORE
// arrayBuffer() so we never materialise a multi-GB upstream payload.
function checkSize(declared: number | null): void {
  if (declared != null && declared > MAX_BLOB_BYTES) {
    throw new Error(`file too large (${Math.round(declared / 1024 / 1024)} MB > ${MAX_BLOB_BYTES / 1024 / 1024} MB cap) — upload via the dashboard's Upload button instead`)
  }
}

// Stream the upstream body into a Uint8Array with a hard memory cap.
// When the upstream uses Transfer-Encoding: chunked (Dropbox direct
// downloads do this routinely, and some S3 hosts do too), there is no
// Content-Length, so the cheap `checkSize(declaredSize(...))` check
// passes null → no-op → arrayBuffer() would happily buffer the whole
// thing and OOM the 256 MB Deno runtime on a multi-GB file.
//
// This reader-based approach accumulates chunks, counts bytes as they
// arrive, and aborts the upstream connection the moment we cross the
// cap — bounding memory at MAX_BLOB_BYTES regardless of whether the
// upstream declared a size.
async function readBoundedBody(resp: Response): Promise<Uint8Array> {
  if (!resp.body) {
    // No body stream available — fall back to arrayBuffer with the
    // cap enforced post-buffer (declaredSize check should have caught
    // this earlier but we're defence-in-depth).
    const buf = new Uint8Array(await resp.arrayBuffer())
    if (buf.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`file too large (${Math.round(buf.byteLength / 1024 / 1024)} MB streamed > ${MAX_BLOB_BYTES / 1024 / 1024} MB cap)`)
    }
    return buf
  }
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BLOB_BYTES) {
      // Cancel the upstream so we stop downloading bytes we'll never use.
      try { await reader.cancel() } catch { /* best-effort */ }
      throw new Error(`file too large (${Math.round(total / 1024 / 1024)} MB streamed > ${MAX_BLOB_BYTES / 1024 / 1024} MB cap) — upload via the dashboard's Upload button instead`)
    }
    chunks.push(value)
  }
  // Single allocation + copy beats Buffer.concat / repeated allocations.
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

interface SubmissionRow {
  id: string
  external_url: string | null
  file_url: string | null
  ingest_source: string | null
  ingest_attempt_count: number
  task_id: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  let submission_id: string | null = null
  try {
    const payload = await req.json()
    submission_id = payload.submission_id
  } catch {
    return jsonError('Invalid JSON body', 400)
  }
  if (!submission_id) {
    return jsonError('Missing submission_id', 400)
  }

  // Pull the row. Use service-role so we ignore RLS — pg_net's POST is
  // anonymous and the dashboard Retry button hits the RPC, never this
  // function directly with a user token.
  const { data: row, error: rowErr } = await supabase
    .from('lib_task_submissions')
    .select('id, external_url, file_url, ingest_source, ingest_attempt_count, task_id')
    .eq('id', submission_id)
    .maybeSingle<SubmissionRow>()
  if (rowErr || !row) {
    return jsonError(`submission lookup failed: ${rowErr?.message || 'not found'}`, 404)
  }
  if (!row.external_url) {
    return jsonError('submission has no external_url', 400)
  }
  if (row.file_url) {
    // Already ingested or TUS-uploaded — clear pending flag and bail.
    await supabase.from('lib_task_submissions')
      .update({ ingest_status: null, ingest_completed_at: new Date().toISOString() })
      .eq('id', row.id)
    return jsonOk({ skipped: 'already has file_url' })
  }

  try {
    const fetched = await fetchExternalVideo(row.external_url, row.ingest_source || 'direct')
    if (fetched.bytes.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`file too large (${Math.round(fetched.bytes.byteLength / 1024 / 1024)} MB > ${MAX_BLOB_BYTES / 1024 / 1024} MB cap)`)
    }
    const ext = pickExtension(fetched.contentType, fetched.suggestedName)
    const path = `external-pulls/${row.id}.${ext}`
    // Upsert so a retry overwrites a half-written previous attempt
    // instead of erroring with "object already exists".
    const { error: upErr } = await supabase.storage
      .from('creative-uploads')
      .upload(path, fetched.bytes, {
        contentType: fetched.contentType,
        upsert: true,
      })
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

    const { data: publicData } = supabase.storage
      .from('creative-uploads')
      .getPublicUrl(path)
    const file_url = publicData?.publicUrl
    if (!file_url) throw new Error('publicUrl resolution returned empty')

    await supabase.from('lib_task_submissions')
      .update({
        file_url,
        file_storage_path: path,
        ingest_status: 'success',
        ingest_completed_at: new Date().toISOString(),
        ingest_error_text: null,
      })
      .eq('id', row.id)

    return jsonOk({ file_url })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase.from('lib_task_submissions')
      .update({
        ingest_status: 'failed',
        ingest_completed_at: new Date().toISOString(),
        ingest_error_text: msg,
      })
      .eq('id', row.id)
    await notifyEditorOfFailure(supabase, row, msg).catch(() => { /* best-effort */ })
    return jsonError(`ingest failed: ${msg}`, 200)  // 200 so pg_net doesn't retry the whole insert
  }
})

// -----------------------------------------------------------------------
// Source dispatch
// -----------------------------------------------------------------------

interface FetchedVideo {
  bytes: Uint8Array
  contentType: string
  suggestedName: string | null
}

async function fetchExternalVideo(url: string, source: string): Promise<FetchedVideo> {
  switch (source) {
    case 'drive':   return await fetchFromDrive(url)
    case 'frameio': return await fetchFromFrameio(url)
    case 'dropbox': return await fetchFromDropbox(url)
    case 'direct':  return await fetchDirect(url)
    default:        return await fetchDirect(url)
  }
}

// -----------------------------------------------------------------------
// Google Drive
// -----------------------------------------------------------------------

async function fetchFromDrive(url: string): Promise<FetchedVideo> {
  const fileId = extractDriveFileId(url)
  if (!fileId) throw new Error('could not extract Drive file ID from URL')

  const keyJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured')
  let keyData: { client_email: string; private_key: string }
  try {
    keyData = JSON.parse(keyJson)
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON')
  }

  const accessToken = await mintDriveAccessToken(keyData)

  // GET the file metadata first to learn the name (used for extension guess).
  const metaResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!metaResp.ok) {
    const errText = await metaResp.text()
    if (metaResp.status === 404) {
      throw new Error(`Drive file not found or not shared with service account (${keyData.client_email})`)
    }
    throw new Error(`Drive metadata ${metaResp.status}: ${errText.slice(0, 200)}`)
  }
  const meta = await metaResp.json() as { name: string; mimeType: string }

  // Then the bytes.
  const fileResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!fileResp.ok) {
    const errText = await fileResp.text()
    throw new Error(`Drive download ${fileResp.status}: ${errText.slice(0, 200)}`)
  }
  // Pre-check size before buffering. Drive's Content-Length is reliable
  // because the metadata API also returns the file's size — but we use
  // the response header here since arrayBuffer() doesn't expose progress.
  checkSize(declaredSize(fileResp))
  const bytes = new Uint8Array(await fileResp.arrayBuffer())
  return { bytes, contentType: meta.mimeType || 'video/mp4', suggestedName: meta.name }
}

function extractDriveFileId(url: string): string | null {
  // Common share formats:
  //   https://drive.google.com/file/d/<ID>/view?...
  //   https://drive.google.com/open?id=<ID>
  //   https://drive.google.com/uc?id=<ID>&export=download
  //   https://docs.google.com/file/d/<ID>/edit
  const dMatch = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/)
  if (dMatch) return dMatch[1]
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/)
  if (idMatch) return idMatch[1]
  return null
}

async function mintDriveAccessToken(key: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  // djwt expects a CryptoKey for RS256. Import the PEM private key.
  const pem = key.private_key.replace(/\\n/g, '\n')
  const cryptoKey = await importPrivateKey(pem)
  const jwt = await signJwt({ alg: 'RS256', typ: 'JWT' }, claims, cryptoKey)

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!tokenResp.ok) {
    const errText = await tokenResp.text()
    throw new Error(`Google token exchange ${tokenResp.status}: ${errText.slice(0, 200)}`)
  }
  const tokenJson = await tokenResp.json() as { access_token: string }
  if (!tokenJson.access_token) throw new Error('Google token response missing access_token')
  return tokenJson.access_token
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM header/footer and decode the base64 body into raw DER bytes.
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0))
  return await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

// -----------------------------------------------------------------------
// Frame.io
// -----------------------------------------------------------------------

// Frame.io: Adobe killed the v2 API + Personal Access Tokens when they
// migrated to v4 with IMS OAuth2 in 2025. The v4 rebuild (Adobe Developer
// Console project, client_credentials grant via IMS, /v4/accounts/{id}/
// files endpoints) is intentionally NOT built — see
// docs/INGEST-AND-REVIEW-SETUP.md for the full reasoning.
//
// Supported workflow: editors copy the DIRECT media URL from Frame.io
// (right-click the playing video → "Copy video address" / "Copy media
// URL") and paste THAT into the submission form. Direct URLs on the
// Frame.io CDN domains pass through fetchDirect with no auth.
//
// The host check is anchored to Frame.io's actual CDN hostnames (not
// just any .mp4) so we don't accidentally swallow non-Frame.io URLs
// that an editor pastes while the submission is tagged 'frameio'.
const FRAMEIO_CDN_HOST_RE = /^https?:\/\/[^/]*(?:assets\.frame\.io|frameioassets\.com|frame\.io\/v\d+)/i

async function fetchFromFrameio(url: string): Promise<FetchedVideo> {
  if (FRAMEIO_CDN_HOST_RE.test(url)) {
    return await fetchDirect(url)
  }
  // Not a CDN URL — it's a share/review/app.frame.io URL that requires
  // v4 auth. Surface the workaround in the editor notification.
  throw new Error(
    'Frame.io share URLs aren\'t supported (Adobe migrated to v4 OAuth2 in 2025). ' +
    'Workaround: in Frame.io, right-click the video preview → "Copy media URL" → ' +
    'paste THAT URL here instead of the share link. Or use Drive / Dropbox.'
  )
}

// -----------------------------------------------------------------------
// Dropbox
// -----------------------------------------------------------------------

async function fetchFromDropbox(url: string): Promise<FetchedVideo> {
  // Convert ?dl=0 → ?dl=1 so Dropbox serves the raw file instead of the
  // HTML preview page. If the URL has no dl param at all, append dl=1.
  let directUrl: string
  if (/[?&]dl=0\b/.test(url))      directUrl = url.replace(/(\?|&)dl=0\b/, '$1dl=1')
  else if (/[?&]dl=1\b/.test(url)) directUrl = url
  else                              directUrl = url + (url.includes('?') ? '&' : '?') + 'dl=1'

  const resp = await fetch(directUrl, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`Dropbox fetch ${resp.status}`)
  const contentType = resp.headers.get('content-type') || 'video/mp4'
  if (contentType.includes('text/html')) {
    throw new Error('Dropbox returned HTML — link is probably private or revoked')
  }
  // Cheap pre-check from header (often missing on Dropbox redirects);
  // streaming check below is the real guarantee.
  checkSize(declaredSize(resp))
  const bytes = await readBoundedBody(resp)
  const suggestedName = extractFilenameFromDisposition(resp.headers.get('content-disposition'))
  return { bytes, contentType, suggestedName }
}

// -----------------------------------------------------------------------
// Direct / generic URL
// -----------------------------------------------------------------------

async function fetchDirect(url: string): Promise<FetchedVideo> {
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`direct fetch ${resp.status}`)
  const contentType = resp.headers.get('content-type') || ''
  if (!contentType.startsWith('video/') && !contentType.startsWith('application/octet-stream')) {
    throw new Error(`expected video/* content-type, got ${contentType}`)
  }
  // Cheap pre-check from header; streaming check is the real guarantee
  // (some CDNs use Transfer-Encoding: chunked with no Content-Length).
  checkSize(declaredSize(resp))
  const bytes = await readBoundedBody(resp)
  const suggestedName = extractFilenameFromDisposition(resp.headers.get('content-disposition'))
  return { bytes, contentType: contentType || 'video/mp4', suggestedName }
}

function extractFilenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const m = disposition.match(/filename(?:\*=UTF-8'')?="?([^";]+)"?/i)
  return m ? decodeURIComponent(m[1]) : null
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function pickExtension(contentType: string, name: string | null): string {
  if (name && /\.[a-z0-9]{2,5}$/i.test(name)) {
    return name.split('.').pop()!.toLowerCase()
  }
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-m4v': 'm4v',
  }
  return map[contentType.split(';')[0].trim().toLowerCase()] || 'mp4'
}

async function notifyEditorOfFailure(
  supabase: ReturnType<typeof createClient>,
  row: SubmissionRow,
  errorMessage: string,
) {
  // Resolve the assigned editor via the task. If unassigned, no-op.
  const { data: task } = await supabase
    .from('lib_editing_tasks')
    .select('editor_id, creative_id')
    .eq('id', row.task_id)
    .maybeSingle<{ editor_id: string | null; creative_id: string | null }>()
  if (!task?.editor_id) return
  await supabase.from('lib_editor_notifications').insert({
    editor_id: task.editor_id,
    kind: 'ingest_failed',
    task_id: row.task_id,
    creative_id: task.creative_id,
    submission_id: row.id,
    title: 'Submission link couldn\'t be pulled',
    body: errorMessage.slice(0, 280),
    link_path: `/editor-view?task=${row.task_id}`,
  })
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, ...body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}
