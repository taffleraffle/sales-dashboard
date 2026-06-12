/*
  Shared ffmpeg.wasm loader — extracted from audioExtract.js (2026-06-12)
  so the Clip Editor (merge/trim/split at upload) and audio extraction
  use ONE lazily-loaded core instead of two 25MB instances.

  Single-threaded core on purpose: no SharedArrayBuffer, no COOP/COEP
  headers, works on plain Render static hosting. Slower than the MT core
  but every consumer here treats encode time as a progress-bar problem,
  not a latency problem.
*/

let _ffmpeg = null
let _loading = null

const FFMPEG_CORE_VERSION = '0.12.6'
// CDN-hosted single-threaded core (no cross-origin isolation needed)
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`

export async function getFFmpeg(onStage) {
  if (_ffmpeg) return _ffmpeg
  if (_loading) return _loading

  _loading = (async () => {
    onStage?.('Loading video engine (one-time, ~25MB)…')
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

/*
  Subscribe to ffmpeg's transcode progress for the duration of one
  operation. Returns an unsubscribe fn. progress is 0..1 (can overshoot
  slightly on concat jobs — clamp at the consumer).
*/
export function onFFmpegProgress(ffmpeg, cb) {
  const handler = ({ progress }) => cb(Math.max(0, Math.min(1, progress || 0)))
  ffmpeg.on('progress', handler)
  return () => ffmpeg.off('progress', handler)
}
