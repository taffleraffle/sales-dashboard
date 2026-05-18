import { useEffect } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import AdThumbnail from './AdThumbnail'
import CreativeAttributesPanel from './CreativeAttributesPanel'

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
  // Escape-key close
  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

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
