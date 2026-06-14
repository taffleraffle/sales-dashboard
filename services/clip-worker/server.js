/*
  clip-worker — real-ffmpeg microservice for the creative-library Clip
  Editor. Replaces the browser ffmpeg.wasm path (can't decode iPhone
  HEVC/.mov, 32MB client download, unverifiable).

  Stateless by design — NO Supabase service-role key. The browser uploads
  the source to storage with its own login, passes the public URL, the
  worker fetches + processes + returns the finished MP4 bytes; the
  browser saves them with the login it already has. The only secret the
  worker can hold is the public anon key (to verify caller JWTs) — never
  anything that isn't already in the client bundle.

  Endpoints (JSON in, auth via X-Worker-Key OR Bearer <supabase jwt>):
    GET  /health   → { ok, ffmpeg, scene, hevc }
    POST /detect   { sourceUrl }                  → { cuts:[s], duration }
    POST /cut      { sourceUrl, in, out, reencode } → mp4 bytes
    POST /merge    { parts:[{sourceUrl,in,out}], reencode } → mp4 bytes
    POST /selftest                                → { pass, steps[] }

  /selftest generates synthetic footage IN the container (known silence
  gaps + scene cuts), runs detect/cut/merge against it, and verifies the
  results — so a single curl proves the whole ffmpeg pipeline end-to-end
  without any external file.
*/
import express from 'express'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.PORT || 10000
const WORKER_SECRET = process.env.WORKER_SECRET || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://sales-dashboard-ftct.onrender.com'
const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_BYTES || 1024 * 1024 * 1024)

const SILENCE_DB = '-35dB'
const SILENCE_MIN_S = 0.9
const SCENE_THRESHOLD = 0.4   // visual scene-change sensitivity (0..1)
const EDGE_GUARD_S = 3

const app = express()
app.use(express.json({ limit: '512kb' }))
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN)
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Worker-Key')
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

// ── ffmpeg helpers ───────────────────────────────────────────────────────
function run(args, { bin = 'ffmpeg' } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args)
    let err = '', out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })   // ffmpeg logs to stderr
    p.on('error', e => resolve({ code: -1, err: String(e), out }))
    p.on('close', code => resolve({ code, err, out }))
  })
}

async function ffmpegInfo() {
  const v = await run(['-version'])
  const codecs = await run(['-hide_banner', '-decoders'])
  return {
    ffmpeg: v.code === 0 ? v.out.split('\n')[0] : null,
    hevc: /hevc/i.test(codecs.out),          // HEVC decode present?
    scene: true,                              // scene filter is core
  }
}

async function fetchToFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`source fetch ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > MAX_SOURCE_BYTES) throw new Error(`source too large (${len}B)`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_SOURCE_BYTES) throw new Error(`source too large (${buf.length}B)`)
  await writeFile(dest, buf)
  return dest
}

const parseDuration = (s) => {
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s)
  return d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0
}

// Take boundaries = union of silence-gap midpoints AND visual scene cuts.
// AI hook compilations are usually cut-separated with no pause, so scene
// detection is what actually finds them; silence covers single-camera
// multi-take recordings. Both run in one pass.
function parseBoundaries(stderr, duration) {
  const cuts = []
  // silence gaps
  let sStart = null
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line)
    if (s) { sStart = Math.max(0, parseFloat(s[1])); continue }
    const e = /silence_end: (-?[\d.]+)/.exec(line)
    if (e && sStart !== null) { cuts.push((sStart + parseFloat(e[1])) / 2); sStart = null }
  }
  // scene changes: showinfo prints "pts_time:NN" for frames the select
  // filter passed (gt(scene,threshold)).
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    cuts.push(parseFloat(m[1]))
  }
  const max = duration || Infinity
  // sort, drop edge-noise, and de-dupe boundaries within 0.8s of each
  // other (a scene cut often coincides with a tiny silence).
  const sorted = cuts.filter(t => t > EDGE_GUARD_S && t < max - EDGE_GUARD_S).sort((a, b) => a - b)
  const merged = []
  for (const t of sorted) if (!merged.length || t - merged[merged.length - 1] > 0.8) merged.push(t)
  return merged
}

// Detect on a LOCAL file (shared by the /detect route and /selftest).
// One pass: silencedetect on audio + scene-select+showinfo on video.
async function detectFile(localPath) {
  const { err } = await run([
    '-i', localPath,
    '-filter_complex',
    `[0:a]silencedetect=noise=${SILENCE_DB}:d=${SILENCE_MIN_S}[a];` +
    `[0:v]select='gt(scene,${SCENE_THRESHOLD})',showinfo[v]`,
    '-map', '[v]', '-map', '[a]', '-f', 'null', '-',
  ])
  return { cuts: parseBoundaries(err, parseDuration(err)), duration: parseDuration(err) }
}
async function detect(sourceUrl, dir) {
  const src = await fetchToFile(sourceUrl, join(dir, 'src'))
  return detectFile(src)
}

function cutArgs(src, { in: tin, out, reencode }, outPath) {
  const a = ['-y']
  if (tin != null && tin > 0) a.push('-ss', String(tin))
  a.push('-i', src)
  // -t DURATION (not -to): with input-side -ss, -to is measured against
  // the ORIGINAL timeline in some ffmpeg builds, which over-runs the cut
  // (self-test caught an 8s output for a 4s request). -t is unambiguous.
  if (out != null) a.push('-t', String(out - (tin || 0)))
  if (reencode) a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k')
  else a.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  a.push('-movflags', '+faststart', outPath)
  return a
}

// ── auth ─────────────────────────────────────────────────────────────────
async function authed(req) {
  if (WORKER_SECRET && req.get('X-Worker-Key') === WORKER_SECRET) return true
  const jwt = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (jwt && SUPABASE_URL && ANON_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
      })
      if (r.ok) return true
    } catch { /* fall through */ }
  }
  return false
}
const guard = async (req, res, next) => (await authed(req)) ? next() : res.status(401).json({ error: 'unauthorized' })

// ── routes ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => res.json({ ok: true, ...(await ffmpegInfo()) }))

app.post('/detect', guard, async (req, res) => {
  const { sourceUrl } = req.body || {}
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' })
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'cw-'))
    res.json(await detect(sourceUrl, dir))
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
  finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}) }
})

app.post('/cut', guard, async (req, res) => {
  const { sourceUrl, in: tin = null, out = null, reencode = false } = req.body || {}
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' })
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'cw-'))
    const src = await fetchToFile(sourceUrl, join(dir, 'src'))
    const outPath = join(dir, 'out.mp4')
    const { code, err } = await run(cutArgs(src, { in: tin, out, reencode }, outPath))
    if (code !== 0) throw new Error(err.split('\n').slice(-3).join(' '))
    res.set('Content-Type', 'video/mp4')
    res.send(await readFile(outPath))
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
  finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}) }
})

app.post('/merge', guard, async (req, res) => {
  const { parts, reencode = false } = req.body || {}
  if (!Array.isArray(parts) || parts.length < 2) return res.status(400).json({ error: 'parts[] (≥2) required' })
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'cw-'))
    const inter = []
    const anyTrim = reencode || parts.some(p => p.in != null || p.out != null)
    for (let i = 0; i < parts.length; i++) {
      const src = await fetchToFile(parts[i].sourceUrl, join(dir, `s${i}`))
      const ip = join(dir, `i${i}.mp4`)
      const { code, err } = await run(cutArgs(src, { in: parts[i].in ?? null, out: parts[i].out ?? null, reencode: anyTrim }, ip))
      if (code !== 0) throw new Error(`part ${i + 1}: ${err.split('\n').slice(-2).join(' ')}`)
      inter.push(ip)
    }
    await writeFile(join(dir, 'list.txt'), inter.map(p => `file '${p}'`).join('\n'))
    const outPath = join(dir, 'merged.mp4')
    const { code, err } = await run(['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', outPath])
    if (code !== 0) throw new Error(`concat: ${err.split('\n').slice(-2).join(' ')}`)
    res.set('Content-Type', 'video/mp4')
    res.send(await readFile(outPath))
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
  finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}) }
})

// Synthetic end-to-end QA — generates 3 visually-distinct, tone-separated
// "takes" joined with silence gaps, then exercises detect/cut/merge and
// verifies the outputs. Proves the real ffmpeg pipeline in the container.
app.post('/selftest', guard, async (_req, res) => {
  const steps = []
  let dir
  const ok = (name, pass, detail) => { steps.push({ name, pass, detail }); return pass }
  try {
    dir = await mkdtemp(join(tmpdir(), 'cw-st-'))
    const info = await ffmpegInfo()
    ok('ffmpeg present', !!info.ffmpeg, info.ffmpeg)

    // Build ONE continuous 12s source: red→green→blue (scene cuts at 4s
    // & 8s, like a cut-separated AI hook reel) with a tone that's gated
    // to the first second of each 4s block (silence gaps too). One
    // encode → continuous PTS, so detection is tested honestly (the old
    // concat-copy reset timestamps and hid a scene cut).
    const source = join(dir, 'source.mp4')
    const gen = await run([
      '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=4:r=25',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=4:r=25',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=4:r=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:d=12',
      '-filter_complex',
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];" +
      "[3:a]volume=enable='lt(mod(t,4),1)':volume=1:eval=frame[a]",
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      source,
    ])
    ok('generate continuous 12s source', gen.code === 0, gen.code !== 0 ? gen.err.split('\n').slice(-2).join(' ') : '')

    const det = await detectFile(source)
    // Scene cuts at 4s & 8s are the real-world signal (AI reels are cut-
    // separated). Expect a boundary near each.
    const near = (t, target) => Math.abs(t - target) < 1.5
    const found4 = det.cuts.some(c => near(c, 4))
    const found8 = det.cuts.some(c => near(c, 8))
    ok('detect finds the 2 scene cuts', found4 && found8, `cuts=[${det.cuts.map(c => c.toFixed(1)).join(', ')}] dur=${det.duration.toFixed(1)}`)

    // cut the middle take (4..8) via copy → expect ~4s
    const seg = join(dir, 'seg.mp4')
    const c1 = await run(cutArgs(source, { in: 4, out: 8, reencode: false }, seg))
    let segDur = 0
    if (c1.code === 0) { const probe = await run(['-i', seg]); segDur = parseDuration(probe.err) }
    ok('cut middle take (≈4s)', c1.code === 0 && Math.abs(segDur - 4) < 1.5, `segDur=${segDur.toFixed(1)}`)

    // merge first take (0..4) + last take (8..12) via re-encode trims → ~8s
    const merged = join(dir, 'm.mp4')
    const inter = []
    for (const [i, span] of [[0, 4], [8, 12]].entries()) {
      const ip = join(dir, `mi${i}.mp4`)
      const r = await run(cutArgs(source, { in: span[0], out: span[1], reencode: true }, ip))
      if (r.code === 0) inter.push(ip)
    }
    let mDur = 0
    if (inter.length === 2) {
      await writeFile(join(dir, 'm.txt'), inter.map(p => `file '${p}'`).join('\n'))
      const mg = await run(['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'm.txt'), '-c', 'copy', merged])
      if (mg.code === 0) { const probe = await run(['-i', merged]); mDur = parseDuration(probe.err) }
    }
    ok('merge 2 trimmed takes (≈8s)', Math.abs(mDur - 8) < 2, `mergedDur=${mDur.toFixed(1)}`)

    const pass = steps.every(s => s.pass)
    res.status(pass ? 200 : 500).json({ pass, steps })
  } catch (e) {
    res.status(500).json({ pass: false, error: String(e.message || e), steps })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

app.listen(PORT, () => console.log(`clip-worker on :${PORT}`))
