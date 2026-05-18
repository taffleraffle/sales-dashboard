import { FileVideo, Image as ImageIcon } from 'lucide-react'
import { pickThumbnail } from '../../utils/adThumbnail'

/*
  Pure presentational thumbnail for an ad row.

  Props:
    ad      — object with at minimum { thumbnail_url, asset_url, asset_type }
    size    — 'sm' (40), 'md' (56), 'lg' (80), 'xl' (120)
    onClick — optional click handler
    rounded — optional bool (default false; circle if true)
*/

const SIZES = {
  sm: 40,
  md: 56,
  lg: 80,
  xl: 120,
}

export default function AdThumbnail({ ad, size = 'md', onClick, rounded = false, style: extraStyle = {} }) {
  const px = SIZES[size] || SIZES.md
  const src = pickThumbnail(ad)
  const isVideo = ad?.asset_type === 'video'

  const baseStyle = {
    width: px,
    height: px,
    flexShrink: 0,
    objectFit: 'cover',
    background: 'var(--paper)',
    border: '1px solid var(--rule)',
    borderRadius: rounded ? '50%' : 2,
    cursor: onClick ? 'pointer' : 'default',
    display: 'inline-block',
    overflow: 'hidden',
    position: 'relative',
    ...extraStyle,
  }

  if (src) {
    return (
      <div onClick={onClick} style={baseStyle}>
        <img
          src={src}
          alt={ad?.ad_name || 'creative'}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={e => { e.currentTarget.style.display = 'none' }}
        />
        {isVideo && (
          <div style={{
            position: 'absolute', bottom: 4, right: 4,
            background: 'rgba(10,10,10,0.7)', color: 'white',
            padding: '1px 5px', fontFamily: 'var(--mono)', fontSize: 9,
            letterSpacing: '0.06em', borderRadius: 2, fontWeight: 600,
            textTransform: 'uppercase',
          }}>
            VID
          </div>
        )}
      </div>
    )
  }

  return (
    <div onClick={onClick} style={{
      ...baseStyle,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--ink-4)',
    }}>
      {isVideo ? <FileVideo size={px * 0.4} /> : <ImageIcon size={px * 0.4} />}
    </div>
  )
}
