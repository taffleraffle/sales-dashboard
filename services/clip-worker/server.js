/*
  Clip-worker — ffmpeg microservice for the creative-library Clip Editor.

  Why this exists: the browser ffmpeg.wasm build can't decode iPhone
  HEVC/.mov and forces a 32MB client download. This runs REAL ffmpeg in
  a container (full codecs), so the frontend just POSTs a source URL +
  edit plan and gets finished clips back in Supabase storage.

  Endpoints (all JSON, all require X-Worker-Key matching WORKER_SECRET):
    GET  /health                       → { ok, ffmpeg }
    POST /detect  { sourceUrl }        → { cuts: [seconds] }
    POST /render  { sourceUrl, segments, merge, outBase }
                                       → { results: [{ path, url, kind }] }

  segments: [{ in|null, out|null, reencode|bool, label }]
    merge=true  → join the segments (in order) into ONE mp4
    merge=false → each segment becomes its own clip

  Render rules mirror the client design:
    - whole-file merge, no trims  → stream-copy concat (fast, lossless)
    - any trim                    → re-encode (libx264) for frame accuracy
    - untrimmed single-file cuts  → stream-copy

  Security: a shared secret header (not the Supabase service key) gates
  the API; the Supabase SERVICE ROLE key lives only in this server's env
  and never reaches the browser — which is the other reason to be here.
*/
import express from 'express'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const PORT = process.env.PORT || 10000
const WORKER_SECRET = process.env.WORKER_SECRET || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BUCKET = process.env.UPLOAD_BUCKET || 'creative-uploads'
const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_BYTES || 1024 * 1024 * 1024) // 1GB

const supabase = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null

const app = express()
app.use(express.json({ limit: '256kb' }))

// ── helpers ────────────────────────────────────────────────────────────
function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let out = '', err = ''
    if (capture) { p.stdout.on('data', d => { out += d }) }
    p.stderr.on('data', d => { err += d })   // ffmpeg logs to stderr
    p.on('error', reject)
    p.on('close', code => resolve({ code, out, err }))
  })
}

async function ffmpegVersion() {
  try { const { out } = await run('ffmpeg', ['-version'], { capture: true }); return out.split('\n')[0] }
  catch { return null }
}

async function fetchToFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`source fetch ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > MAX_SOURCE_BYTES) throw new Error(`source too large (${len} bytes)`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_SOURCE_BYTES) throw new Error(`source too large (${buf.length} bytes)`)
  await writeFile(dest, buf)
  return dest
}

// silencedetect → midpoints of silence gaps ≥0.9s, ≥3s from each end.
function parseSilenceCuts(stderr, duration) {
  const gaps = []
  let start = null
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line)
    if (s) { start = Math.max(0, parseFloat(s[1])); continue }
    const e = /silence_end: (-?[\d.]+)/.exec(line)
    if (e && start !== null) { gaps.push([start, parseFloat(e[1])]); start = null }
  }
  const max = duration || Infinity
  return gaps.map(([a, b]) => (a + b) / 2).filter(t => t > 3 && t < max - 3)
}

function parseDuration(stderr) {
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
  return d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0
}

async function uploadResult(localPath, destPath) {
  if (!supabase) throw new Error('storage not configured')
  const body = await readFile(localPath)
  const { error } = await supabase.storage.from(BUCKET).upload(destPath, body, {
    contentType: 'video/mp4', upsert: true, cacheControl: '2592000',
  })
  if (error) throw new Error(`upload: ${error.message}`)
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${destPath}`
}

// Auth: accept EITHER a service-to-service worker secret OR — for the
// browser — a valid Supabase user JWT (verified via the service client).
// The browser never holds a shared secret; only logged-in dashboard
// users can drive the worker, and the powerful service-role key stays
// server-side. CORS is open to the dashboard origin only.
const auth = async (req, res, next) => {
  if (WORKER_SECRET && req.get('X-Worker-Key') === WORKER_SECRET) return next()
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (bearer && supabase) {
    const { data, error } = await supabase.auth.getUser(bearer)
    if (!error && data?.user) return next()
  }
  return res.status(401).json({ error: 'unauthorized' })
}

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://sales-dashboard-ftct.onrender.com'
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN)
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Worker-Key')
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

// ── routes ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  res.json({ ok: true, ffmpeg: await ffmpegVersion(), storage: !!supabase })
})

app.post('/detect', auth, async (req, res) => {
  const { sourceUrl } = req.body || {}
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' })
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'clip-'))
    const src = await fetchToFile(sourceUrl, join(dir, 'src'))
    const { err } = await run('ffmpeg', ['-i', src, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.9', '-f', 'null', '-'])
    res.json({ cuts: parseSilenceCuts(err, parseDuration(err)) })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

app.post('/render', auth, async (req, res) => {
  const { sourceUrl, segments, merge, outBase } = req.body || {}
  if (!sourceUrl || !Array.isArray(segments) || !segments.length) {
    return res.status(400).json({ error: 'sourceUrl + segments[] required' })
  }
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'clip-'))
    const src = await fetchToFile(sourceUrl, join(dir, 'src.mp4'))
    const base = (outBase || 'clip').replace(/[^A-Za-z0-9._-]+/g, '_')
    const stamp = Date.now()

    const cutArgs = (seg, outPath) => {
      const a = ['-y']
      if (seg.in != null && seg.in > 0) a.push('-ss', String(seg.in))
      a.push('-i', src)
      if (seg.out != null) a.push('-to', String((seg.out - (seg.in || 0))))
      if (seg.reencode) a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k')
      else a.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
      a.push('-movflags', '+faststart', outPath)
      return a
    }

    const results = []

    if (merge && segments.length >= 2) {
      const anyTrim = segments.some(s => s.reencode || s.in != null || s.out != null)
      const parts = []
      for (let i = 0; i < segments.length; i++) {
        const outPath = join(dir, `part-${i}.mp4`)
        // Re-encode parts when any trim/cut exists so concat streams are
        // uniform; else copy whole files.
        const seg = anyTrim ? { ...segments[i], reencode: true } : { in: null, out: null, reencode: false }
        const { code, err } = await run('ffmpeg', cutArgs(seg, outPath))
        if (code !== 0) throw new Error(`part ${i + 1}: ${err.split('\n').slice(-3).join(' ')}`)
        parts.push(outPath)
      }
      const listPath = join(dir, 'list.txt')
      await writeFile(listPath, parts.map(p => `file '${p}'`).join('\n'))
      const joinPath = join(dir, 'merged.mp4')
      const { code, err } = await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', joinPath])
      if (code !== 0) throw new Error(`merge: ${err.split('\n').slice(-3).join(' ')}`)
      const dest = `incoming/${stamp}_${base}-MERGED.mp4`
      results.push({ kind: 'merge', path: dest, url: await uploadResult(joinPath, dest) })
    } else {
      let n = 0
      for (const seg of segments) {
        n++
        const outPath = join(dir, `seg-${n}.mp4`)
        const { code, err } = await run('ffmpeg', cutArgs(seg, outPath))
        if (code !== 0) throw new Error(`segment ${n}: ${err.split('\n').slice(-3).join(' ')}`)
        const label = (seg.label || `HOOK${String(n).padStart(2, '0')}`).replace(/[^A-Za-z0-9._-]+/g, '_')
        const dest = `incoming/${stamp}_${base}-${label}.mp4`
        results.push({ kind: 'segment', path: dest, url: await uploadResult(outPath, dest) })
      }
    }

    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

app.listen(PORT, () => console.log(`clip-worker on :${PORT}`))
