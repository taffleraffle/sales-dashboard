import { useEffect, useState } from 'react'
import { X, ExternalLink, FileVideo, Image as ImageIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import CreativeAttributesPanel from './CreativeAttributesPanel'
import { supabase } from '../../lib/supabase'
import { pickThumbnail } from '../../utils/adThumbnail'

/*
  Right-side drawer for editing one ad's creative attributes from
  Insights. Wraps CreativeAttributesPanel inside a sticky-header
  drawer scaffold matching ClientEditPanel's convention.

  Props:
    open — boolean
    ad   — full row object from lib_ad_performance (used for header
           thumbnail + ad_name + ad_id display)
    onClose — callback
*/

export default function CreativeEditDrawer({ open, ad, onClose }) {
  const [sourceVideoUrl, setSourceVideoUrl] = useState(null)
  const [videoChecked, setVideoChecked] = useState(false)

  // Escape-key close
  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Try to load operator-uploaded source video from ad-source-videos bucket.
  // Falls back to ad.asset_url (Meta-hosted, signed, ~7-day TTL).
  useEffect(() => {
    if (!open || !ad?.ad_id) return
    let cancelled = false
    setVideoChecked(false); setSourceVideoUrl(null)
    ;(async () => {
      // Try common extensions in priority order. m4a (extracted audio) is
      // last since it's audio-only, but still playable.
      const exts = ['mp4', 'mov', 'webm', 'm4v', 'm4a']
      for (const ext of exts) {
        const path = `${ad.ad_id}.${ext}`
        const { data } = await supabase.storage
          .from('ad-source-videos')
          .createSignedUrl(path, 60 * 60)  // 1-hour signed URL
        if (cancelled) return
        if (data?.signedUrl) {
          setSourceVideoUrl(data.signedUrl)
          break
        }
      }
      if (!cancelled) setVideoChecked(true)
    })()
    return () => { cancelled = true }
  }, [open, ad?.ad_id])

  if (!open || !ad) return null

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.45)',
        backdropFilter: 'blur(2px)', zIndex: 99,
      }} />

      {/* Drawer */}
      <div onClick={e => e.stopPropagation()} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: '100%', maxWidth: 560, height: '100vh',
        background: 'var(--paper)',
        borderLeft: '3px solid var(--accent)',
        boxShadow: '-12px 0 32px rgba(10,10,10,0.15)',
        zIndex: 100,
        display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        {/* Header — sticky */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--rule)',
          background: 'white',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <AdThumbnail ad={ad} size="md" />
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div className="eyebrow eyebrow-accent" style={{ marginBottom: 2 }}>
              Editing <em>creative</em>
            </div>
            <div style={{
              fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink)',
              lineHeight: 1.2, fontWeight: 400,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={ad.ad_name}>
              {ad.ad_name || ad.ad_id}
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
              letterSpacing: '0.06em', marginTop: 2,
            }}>
              {ad.ad_id}
            </div>
          </div>
          <Link to={`/sales/ads/ad/${ad.ad_id}`} title="Open full detail page"
            style={{
              padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
              letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
              border: '1px solid var(--rule)', background: 'white', color: 'var(--ink-3)',
              borderRadius: 2, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <ExternalLink size={11} />
            Full
          </Link>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: 'var(--ink-3)',
            cursor: 'pointer', padding: 4, marginLeft: 4,
          }}>
            <X size={18} />
          </button>
        </div>

        {/* Body — scrollable. CreativeAttributesPanel has its own padding/borders. */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
          <CreativePreview ad={ad} sourceVideoUrl={sourceVideoUrl} videoChecked={videoChecked} />
          <CreativeAttributesPanel ad_id={ad.ad_id} />
        </div>
      </div>

      {/* Slide animation keyframes injected once */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0.4; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  )
}

/* Inline preview: plays video if we have one, otherwise shows the full-size
   thumbnail. Operator can review the creative before fixing attributes. */
function CreativePreview({ ad, sourceVideoUrl, videoChecked }) {
  // Decide what to render:
  //  1. If we have an uploaded source video → <video src> (our copy, never expires before signed URL TTL)
  //  2. Else if ad.asset_type === 'video' && ad.asset_url → <video src> (Meta-hosted, may have expired)
  //  3. Else → big thumbnail
  const metaVideoUrl = ad?.asset_type === 'video' ? ad?.asset_url : null
  const videoUrl = sourceVideoUrl || metaVideoUrl
  const thumb = pickThumbnail(ad)

  if (!videoChecked && !metaVideoUrl) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16, aspectRatio: '16 / 9',
                    background: 'var(--paper)', border: '1px solid var(--rule)',
                    borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)' }}>
        Loading preview…
      </div>
    )
  }

  if (videoUrl) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16 }}>
        <video controls preload="metadata"
          poster={thumb || undefined}
          src={videoUrl}
          style={{
            width: '100%', borderRadius: 2,
            border: '1px solid var(--rule)',
            background: 'var(--paper)',
            display: 'block',
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

  // Fallback: big thumbnail when nothing playable
  if (thumb) {
    return (
      <div style={{ marginTop: 20, marginBottom: 16, position: 'relative' }}>
        <img src={thumb} alt={ad?.ad_name || 'creative'}
          style={{ width: '100%', borderRadius: 2, border: '1px solid var(--rule)', display: 'block' }} />
        {ad?.asset_type === 'image' && (
          <div style={{ position: 'absolute', top: 8, right: 8,
                        padding: '2px 6px', background: 'rgba(10,10,10,0.7)', color: 'white',
                        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
                        textTransform: 'uppercase', borderRadius: 2 }}>
            <ImageIcon size={9} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
            Image
          </div>
        )}
      </div>
    )
  }

  return null
}
