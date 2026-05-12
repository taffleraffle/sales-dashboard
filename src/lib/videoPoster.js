// Extract a poster-frame thumbnail from a video File. Used by the Clips
// page so every uploaded MP4 lands with a preview without needing an
// editor to upload a separate image. Returns a Promise<Blob> or null on
// failure. Caller uploads the blob to Supabase Storage and stores the
// resulting URL on library.clips.thumbnail_url.
//
// Strategy:
//   1. Create an <video> element off-DOM, load the File via object URL.
//   2. Seek to ~1.5s (or 25% in if shorter) — first frame is usually a
//      black or "loading" frame, 1.5s gives the talent's face after the
//      cut-in.
//   3. Draw the current frame onto a <canvas> sized to 640px wide
//      (preserves aspect ratio).
//   4. toBlob('image/jpeg', 0.78) — JPEG is plenty for thumbnails and
//      keeps the storage cost trivial.
//
// Times out at 8 seconds because some MP4s have wonky metadata and
// the seeked event never fires.

export async function extractVideoPoster(file, { targetSec = 1.5, maxWidth = 640, quality = 0.78, timeoutMs = 8000 } = {}) {
  if (!file || !file.type || !file.type.startsWith('video/')) return null

  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = objectUrl

  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      try { URL.revokeObjectURL(objectUrl) } catch { /* */ }
      video.removeAttribute('src')
      try { video.load() } catch { /* */ }
    }
    const finish = (blob) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(blob)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    video.addEventListener('loadedmetadata', () => {
      const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      const seekTo = dur > 0 ? Math.min(targetSec, dur * 0.25) : targetSec
      // iOS Safari sometimes needs a tick before seeking
      setTimeout(() => { try { video.currentTime = seekTo } catch { /* */ } }, 30)
    })

    video.addEventListener('seeked', () => {
      try {
        const w = video.videoWidth || 640
        const h = video.videoHeight || 360
        const scale = Math.min(1, maxWidth / w)
        const cw = Math.round(w * scale)
        const ch = Math.round(h * scale)
        const canvas = document.createElement('canvas')
        canvas.width = cw
        canvas.height = ch
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, cw, ch)
        canvas.toBlob((blob) => {
          clearTimeout(timer)
          finish(blob)
        }, 'image/jpeg', quality)
      } catch (e) {
        clearTimeout(timer)
        finish(null)
      }
    })

    video.addEventListener('error', () => {
      clearTimeout(timer)
      finish(null)
    })
  })
}
