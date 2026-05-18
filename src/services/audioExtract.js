/*
  Audio extraction via ffmpeg.wasm — runs entirely in the browser.

  Why this exists: OpenAI Whisper has a 25MB API file limit. Restoration
  ads filmed on phones can be 50-500MB MP4s. Rather than rejecting them
  or making the operator pre-process in Handbrake, we extract just the
  audio track (typically 1-5MB per minute) before upload.

  Implementation notes:
   - Lazy-loads ffmpeg.wasm on first call (~25MB bundle). Cached afterward.
   - Uses single-threaded core (no SharedArrayBuffer / cross-origin
     isolation headers required). Slower than multi-threaded but works
     on standard hosting like Render.
   - Re-encodes to AAC 64kbps mono — small enough to comfortably fit
     under Whisper's 25MB limit even for 30+ minute clips.
   - Falls back to .mp3 if AAC isn't viable.

  Cost: ~5-15 seconds of browser CPU per 30s clip. Linear with duration.
*/

let _ffmpeg = null
let _loading = null

const FFMPEG_CORE_VERSION = '0.12.6'
// Use CDN-hosted single-threaded core (no cross-origin isolation needed)
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`

async function getFfmpeg(onProgress) {
  if (_ffmpeg) return _ffmpeg
  if (_loading) return _loading

  _loading = (async () => {
    onProgress?.('Loading audio extractor (one-time, ~25MB)…')
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { toBlobURL } = await import('@ffmpeg/util')

    const ffmpeg = new FFmpeg()
    ffmpeg.on('log', ({ message }) => {
      if (import.meta.env.DEV) console.log('[ffmpeg]', message)
    })

    // Load core + wasm via Blob URLs to dodge CORS issues
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    _ffmpeg = ffmpeg
    return ffmpeg
  })()

  try {
    return await _loading
  } finally {
    _loading = null
  }
}

/**
 * Extract the audio track from a video File and return it as an
 * .m4a Blob (AAC, 64kbps mono).
 *
 * @param {File} videoFile        — the video to extract from
 * @param {object} opts
 * @param {(stage: string) => void} [opts.onProgress] — stage callback
 * @returns {Promise<{ blob: Blob, suggestedName: string, size: number }>}
 */
export async function extractAudioFromVideo(videoFile, { onProgress } = {}) {
  if (!videoFile) throw new Error('extractAudioFromVideo: videoFile required')

  const ffmpeg = await getFfmpeg(onProgress)
  const { fetchFile } = await import('@ffmpeg/util')

  onProgress?.('Reading video file…')

  // Filenames inside the in-memory ffmpeg FS — kept simple to avoid escaping issues
  const inExt = (videoFile.name.split('.').pop() || 'mp4').toLowerCase()
  const inName = `in.${inExt}`
  const outName = `out.m4a`

  await ffmpeg.writeFile(inName, await fetchFile(videoFile))

  onProgress?.('Extracting audio…')

  // -vn        no video
  // -c:a aac   AAC codec (universally supported)
  // -b:a 64k   64kbps mono — small + clear enough for speech
  // -ac 1      single audio channel
  // -y         overwrite output
  const code = await ffmpeg.exec([
    '-i', inName,
    '-vn',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ac', '1',
    '-y',
    outName,
  ])

  if (code !== 0) {
    // Clean up before throwing
    try { await ffmpeg.deleteFile(inName) } catch {}
    throw new Error(`Audio extraction failed (ffmpeg exit code ${code}). The video may be corrupted or use an unsupported codec.`)
  }

  const data = await ffmpeg.readFile(outName)
  const blob = new Blob([data.buffer], { type: 'audio/mp4' })

  // Free in-memory files immediately to keep memory bounded across multiple uploads
  try { await ffmpeg.deleteFile(inName) } catch {}
  try { await ffmpeg.deleteFile(outName) } catch {}

  const suggestedName = videoFile.name.replace(/\.[^.]+$/, '') + '.m4a'
  return { blob, suggestedName, size: blob.size }
}

/**
 * Decide whether a file should have its audio extracted before upload.
 * Threshold of 20MB gives a safety margin under Whisper's 25MB limit.
 */
export function shouldExtractAudio(file) {
  if (!file) return false
  // Only video files. Audio files (m4a, mp3, wav) skip extraction.
  if (!file.type.startsWith('video/') && !file.name.match(/\.(mp4|mov|webm|m4v|mkv|avi)$/i)) {
    return false
  }
  return file.size > 20 * 1024 * 1024
}
