import { useEffect, useState } from 'react'
import { ExternalLink, FileVideo, Image as ImageIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import CreativeAttributesPanel from './CreativeAttributesPanel'
import Modal from '../editorial/Modal'
import { supabase } from '../../lib/supabase'
import { pickThumbnail } from '../../utils/adThumbnail'

/*
  Centered modal for editing one ad's creative attributes. Previously a
  right-side slide drawer (CreativeEditDrawer) — Ben asked 2026-05-18 to
  convert to a bulk centered modal instead. Export name kept for
  compatibility; the contents are the same edit panel inside a different
  scaffold.

  Props:
    open  — boolean
    ad    — full row object from lib_ad_performance (header thumbnail +
            ad_name + ad_id display)
    onClose — callback
*/

export default function CreativeEditDrawer({ open, ad, onClose }) {
  const [sourceVideoUrl, setSourceVideoUrl] = useState(null)
  const [videoChecked, setVideoChecked] = useState(false)
  const [videoError, setVideoError] = useState(false)

  useEffect(() => {
    if (!open || !ad?.ad_id) return
    let cancelled = false
    setVideoChecked(false); setSourceVideoUrl(null); setVideoError(false)
    ;(async () => {
      const exts = ['mp4', 'mov', 'webm', 'm4v', 'm4a']
      const results = await Promise.all(
        exts.map(ext =>
          supabase.storage.from('ad-source-videos')
            .createSignedUrl(`${ad.ad_id}.${ext}`, 60 * 60)
            .then(({ data }) => data?.signedUrl || null)
            .catch(() => null)
        )
      )
      if (cancelled) return
      const found = results.find(Boolean)
      setSourceVideoUrl(found || null)
      setVideoChecked(true)
    })()
    return () => { cancelled = true }
  }, [open, ad?.ad_id])

  if (!ad) return null

  const headerLeft = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
      <AdThumbnail ad={ad} size="md" />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          color: 'var(--ink-3)', marginBottom: 4,
        }}>
          Editing creative
        </div>
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500,
          color: 'var(--ink)', lineHeight: 1.15, letterSpacing: '-0.01em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 540,
        }} title={ad.ad_name}>
          {ad.ad_name || ad.ad_id}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
          letterSpacing: '0.06em', marginTop: 4,
        }}>
          {ad.ad_id}
        </div>
      </div>
    </div>
  )

  const headerRight = (
    <Link to={`/sales/ads/ad/${ad.ad_id}`} title="Open full detail page"
      style={{
        padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10.5,
        letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
        border: '1px solid var(--rule-2)', background: 'var(--paper)', color: 'var(--ink-2)',
        borderRadius: 2, textDecoration: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}>
      <ExternalLink size={11} />
      Full page
    </Link>
  )

  return (
    <Modal open={open} onClose={onClose} size="lg"
      title={null}
      right={headerRight}>
      {/* Custom-styled header — bigger than the default so the thumb fits */}
      <div style={{
        padding: '20px 28px',
        background: 'var(--paper)',
        borderBottom: '1px solid var(--rule)',
        position: 'sticky', top: 0, zIndex: 1,
        marginTop: -1,  // close the gap with the Modal's own border-bottom
      }}>
        {headerLeft}
      </div>

      <div style={{ padding: '0 28px 28px' }}>
        <CreativePreview ad={ad} sourceVideoUrl={sourceVideoUrl}
          videoChecked={videoChecked} videoError={videoError}
          onVideoError={() => setVideoError(true)} />
        <CreativeAttributesPanel ad_id={ad.ad_id} />
      </div>
    </Modal>
  )
}

/* Inline preview — same as before. Plays an uploaded source video if we
   have one, falls back to Meta's signed asset_url, then to the thumbnail. */
function CreativePreview({ ad, sourceVideoUrl, videoChecked, videoError, onVideoError }) {
  const metaVideoUrl = ad?.asset_type === 'video' ? ad?.asset_url : null
  const videoUrl = sourceVideoUrl || metaVideoUrl
  const thumb = pickThumbnail(ad)

  if (!videoChecked && !metaVideoUrl) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16, aspectRatio: '16 / 9',
                    background: 'var(--paper)', border: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)' }}>
        Loading preview…
      </div>
    )
  }

  if (videoUrl && !videoError) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16 }}>
        <video controls preload="metadata"
          poster={thumb || undefined}
          src={videoUrl}
          onError={onVideoError}
          style={{
            width: '100%', border: '1px solid var(--rule)',
            background: 'var(--paper)', display: 'block', maxHeight: 480,
          }}
        />
        {sourceVideoUrl && (
          <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', color: 'var(--ink-4)' }}>
            <FileVideo size={10} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
            Source video from <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>ad-source-videos</code>
          </div>
        )}
        {!sourceVideoUrl && metaVideoUrl && (
          <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.06em', color: 'var(--ink-4)' }}>
            <FileVideo size={10} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
            Meta-hosted preview (signed URL expires after ~7 days)
          </div>
        )}
      </div>
    )
  }

  if (thumb) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16, position: 'relative' }}>
        <img src={thumb} alt={ad?.ad_name || 'creative'}
          style={{ width: '100%', border: '1px solid var(--rule)', display: 'block',
                   maxHeight: 480, objectFit: 'contain', background: 'var(--paper-2)' }} />
        {ad?.asset_type === 'image' && (
          <div style={{ position: 'absolute', top: 8, right: 8,
                        padding: '2px 6px', background: 'rgba(10,10,10,0.7)', color: 'var(--paper)',
                        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
                        textTransform: 'uppercase' }}>
            <ImageIcon size={9} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
            Image
          </div>
        )}
      </div>
    )
  }

  return null
}
