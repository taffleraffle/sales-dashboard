/*
  Clip surgery — cut / trim / merge video files in the browser at upload
  time (Clip Editor, 2026-06-12). Ben's two workflows:

   1. AI body content arrives as part 1 + part 2 → merge into ONE MP4.
   2. One camera file holds several hook takes (often with a stuttered
      first second) → detect the takes, trim each one's in/out, save
      each as its own clip.

  Everything runs on the shared single-threaded ffmpeg.wasm core
  (ffmpegCore.js). Rendering rules:

   - Whole-file merge with no trims → lossless stream-copy concat
     (instant). Same-session camera/AI parts share codecs, so this is
     the common path. If the concat demuxer rejects the mix, fall back
     to a uniform re-encode.
   - Any TRIMMED segment re-encodes. Stream-copy cuts snap to keyframes
     (±1-2s) — that would reintroduce the exact stutter the trim is
     removing. libx264 veryfast/crf18 keeps quality visually lossless.
   - Untrimmed split segments stream-copy (cut points sit in silence;
     keyframe snap is invisible there).

  Memory: ffmpeg.wasm holds files in an in-memory FS under a wasm32
  heap. Inputs + outputs must coexist, so total INPUT size is capped —
  beyond that the tab dies an unstylish OOM death.
*/

import { getFFmpeg, onFFmpegProgress } from './ffmpegCore'

export const MAX_INPUT_BYTES = 800 * 1024 * 1024  // wasm32 MEMFS ceiling

// Silence-gap auto-detection tunables. 0.9s of ≤-35dB audio is a take
// boundary on talking-head footage; gaps inside speech (breaths, beat
// pauses) run shorter.
const SILENCE_DB = '-35dB'
const SILENCE_MIN_S = 0.9
const EDGE_GUARD_S = 3 // ignore "boundaries" within 3s of either end

function memCheck(files) {
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > MAX_INPUT_BYTES) {
    const mb = Math.round(total / 1024 / 1024)
    throw new Error(
      `These files total ${mb}MB — more than the ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB the in-browser editor can hold. ` +
      'Process fewer/smaller files at once.'
    )
  }
}

async function writeInput(ffmpeg, file, name) {
  const { fetchFile } = await import('@ffmpeg/util')
  await ffmpeg.writeFile(name, await fetchFile(file))
}

async function cleanup(ffmpeg, names) {
  for (const n of names) {
    try { await ffmpeg.deleteFile(n) } catch { /* already gone */ }
  }
}

const fileExt = (name) => (/\.([a-z0-9]{2,5})$/i.exec(name || '')?.[1] || 'mp4').toLowerCase()

/*
  Detect take boundaries in one file via the silencedetect filter on an
  audio-only decode (fast — no video decode). Returns cut points in
  seconds (midpoints of qualifying silence gaps), ready to seed the
  editor's markers. Empty array = one take.
*/
export async function detectTakeBoundaries(file, { onStage } = {}) {
  memCheck([file])
  const ffmpeg = await getFFmpeg(onStage)
  const inName = `det.${fileExt(file.name)}`

  onStage?.('Reading file…')
  await writeInput(ffmpeg, file, inName)

  // silencedetect reports via the log stream, not an output file.
  const silences = []
  let pendingStart = null
  const logHandler = ({ message }) => {
    // -?: AAC priming / edit lists make leading silence start slightly
    // negative (silence_start: -0.003) — without the sign the paired
    // silence_end is orphaned and the whole gap silently dropped.
    const s = /silence_start: (-?[\d.]+)/.exec(message)
    if (s) { pendingStart = parseFloat(s[1]); return }
    const e = /silence_end: (-?[\d.]+)/.exec(message)
    if (e && pendingStart !== null) {
      silences.push({ start: Math.max(0, pendingStart), end: parseFloat(e[1]) })
      pendingStart = null
    }
  }
  ffmpeg.on('log', logHandler)

  onStage?.('Listening for take boundaries…')
  let duration = 0
  const durHandler = ({ message }) => {
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(message)
    if (d) duration = (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3])
  }
  ffmpeg.on('log', durHandler)

  let code
  try {
    code = await ffmpeg.exec([
      '-i', inName,
      '-vn',
      '-af', `silencedetect=noise=${SILENCE_DB}:d=${SILENCE_MIN_S}`,
      '-f', 'null', '-',
    ])
  } finally {
    ffmpeg.off('log', logHandler)
    ffmpeg.off('log', durHandler)
    await cleanup(ffmpeg, [inName])
  }
  // A decode failure with zero detections must NOT read as "no takes
  // found" — that sends the operator scrubbing a file we never analysed.
  if (code !== 0) {
    throw new Error('Could not analyse this file (unsupported codec?). Cut takes manually with "Cut at playhead".')
  }

  const maxT = duration || Infinity
  return silences
    .map(g => (g.start + g.end) / 2)
    .filter(t => t > EDGE_GUARD_S && t < maxT - EDGE_GUARD_S)
}

/*
  Render one segment of a file. { start, end } in seconds; either may be
  null (= file edge). reencode=true for frame-accurate trims; otherwise
  stream-copy (instant, keyframe-snapped).
*/
export async function renderSegment(file, { start, end, reencode = false, outName, onStage, onProgress } = {}) {
  memCheck([file])
  const ffmpeg = await getFFmpeg(onStage)
  const inName = `seg-in.${fileExt(file.name)}`
  const out = 'seg-out.mp4'

  onStage?.('Reading file…')
  await writeInput(ffmpeg, file, inName)

  const args = ['-y']
  // Fast input seek (before -i) jumps near the in-point; with re-encode
  // the decoder then trims frame-accurately. With stream copy the cut
  // snaps to the previous keyframe — fine for silence-gap boundaries.
  if (start != null && start > 0) args.push('-ss', start.toFixed(3))
  args.push('-i', inName)
  if (end != null) args.push('-to', ((end - (start || 0))).toFixed(3))
  if (reencode) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k')
  } else {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  }
  args.push('-movflags', '+faststart', out)

  onStage?.(reencode ? 'Re-encoding for frame-accurate trim…' : 'Cutting…')
  const offProgress = onProgress ? onFFmpegProgress(ffmpeg, onProgress) : () => {}
  try {
    const code = await ffmpeg.exec(args)
    if (code !== 0) {
      throw new Error(`Cut failed (ffmpeg exit ${code}) — the file may use an unsupported codec.`)
    }
    const data = await ffmpeg.readFile(out)
    return new File([data.buffer], outName || 'segment.mp4', { type: 'video/mp4' })
  } finally {
    // Sweeps on success AND on exec rejection — a thrown exec used to
    // leak the input in MEMFS for the rest of the session.
    offProgress()
    await cleanup(ffmpeg, [inName, out])
  }
}

/*
  Merge ordered parts into one MP4.
  parts: [{ file, start, end, trimmed, dims }] — start/end null = whole
  file; dims = {width,height} when known (the upload modal probes them).

  Three tiers, picked per job:
   1. LOSSLESS whole-file concat — only when EVERY part is a whole file
      (no start/end at all) AND the parts plausibly share a format (same
      source file, or identical probed dimensions). The concat demuxer
      exits 0 even on mismatched codecs and just writes a broken file,
      so "try it and check the exit code" is NOT a safe gate — the
      pre-check is.
   2. COPY-CUT intermediates — parts have cut boundaries but no
      frame-accurate trims: each part is stream-copy cut (instant,
      keyframe-snapped) and the uniform same-source intermediates
      concat-copy cleanly.
   3. RE-ENCODE intermediates — any trimmed part (or mixed formats):
      every part renders through libx264 so the streams are uniform by
      construction.
*/
export async function renderMerge(parts, { outName = 'merged.mp4', onStage, onProgress } = {}) {
  memCheck(parts.map(p => p.file))
  const ffmpeg = await getFFmpeg(onStage)

  const anyTrim = parts.some(p => p.trimmed)
  const anyCut = parts.some(p => p.start != null || p.end != null)
  const distinctFiles = new Set(parts.map(p => p.file)).size
  const dimsKnown = parts.every(p => p.dims?.width && p.dims?.height)
  const dimsMatch = dimsKnown && new Set(parts.map(p => `${p.dims.width}x${p.dims.height}`)).size === 1
  const formatsPlausiblyMatch = distinctFiles === 1 || dimsMatch

  // Every temp name ever written lands here; the finally sweeps them all
  // so a mid-job failure can't pin hundreds of MB in the wasm FS for the
  // rest of the session.
  const allTemps = new Set()
  const track = (n) => { allTemps.add(n); return n }

  try {
    if (!anyTrim && !anyCut && formatsPlausiblyMatch) {
      onStage?.('Joining (lossless)…')
      const listLines = []
      for (let i = 0; i < parts.length; i++) {
        const n = track(`m${i}.${fileExt(parts[i].file.name)}`)
        await writeInput(ffmpeg, parts[i].file, n)
        listLines.push(`file '${n}'`)
      }
      await ffmpeg.writeFile(track('list.txt'), listLines.join('\n'))
      const code = await ffmpeg.exec([
        '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-c', 'copy', '-movflags', '+faststart', track('join.mp4'),
      ])
      if (code === 0) {
        const data = await ffmpeg.readFile('join.mp4')
        onProgress?.(1)
        return new File([data.buffer], outName, { type: 'video/mp4' })
      }
      // Demuxer actually refused — clear and fall through to re-encode.
      onStage?.('Files differ — re-encoding to join them…')
      await cleanup(ffmpeg, [...allTemps])
      allTemps.clear()
    }

    // Intermediates: copy-cut when nothing is trimmed AND all parts come
    // from the same source (uniform by construction); else re-encode.
    const reencode = anyTrim || !formatsPlausiblyMatch
    const interNames = []
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      onStage?.(`${reencode ? 'Rendering' : 'Cutting'} part ${i + 1} of ${parts.length}…`)
      const partFile = await renderSegment(p.file, {
        start: p.start, end: p.end, reencode,
        outName: `inter-${i}.mp4`,
        onProgress: onProgress
          ? (frac) => onProgress((i + frac) / (parts.length + 0.2))
          : undefined,
      })
      const n = track(`i${i}.mp4`)
      await writeInput(ffmpeg, partFile, n)
      interNames.push(n)
    }
    await ffmpeg.writeFile(track('list.txt'), interNames.map(n => `file '${n}'`).join('\n'))
    onStage?.('Joining parts…')
    const code = await ffmpeg.exec([
      '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-c', 'copy', '-movflags', '+faststart', track('join.mp4'),
    ])
    if (code !== 0) throw new Error(`Join failed (ffmpeg exit ${code}).`)
    const data = await ffmpeg.readFile('join.mp4')
    onProgress?.(1)
    return new File([data.buffer], outName, { type: 'video/mp4' })
  } finally {
    await cleanup(ffmpeg, [...allTemps])
  }
}
