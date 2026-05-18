import { useEffect } from 'react'
import { Icon } from './atoms'

/*
  Centered modal primitive. Replaces the right-side slide drawers per
  Ben's request 2026-05-18 — "instead of making these pop-ups slide out
  from the side, could we make them a bulk pop-up that appears in the
  middle of the screen, please?"

  Design: paper background, 3px accent top border (matches the
  ConfirmModal convention from OPT-DESIGN-SYSTEM.md), subtle drop
  shadow, no gimmicky yellow box-shadow. Body scrolls when content
  exceeds viewport. Backdrop click + Esc close.

  Width defaults to 720px (good for forms + tables). Pass `size="xl"`
  for 1040px when more is needed (campaign picker, attribute editor).
*/

const SIZES = {
  sm: 480,
  md: 720,
  lg: 920,
  xl: 1080,
}

export default function Modal({
  open, onClose,
  title, subtitle, eyebrow, right, footer,
  size = 'md',
  children,
}) {
  // Esc to close
  useEffect(() => {
    if (!open) return
    const h = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const maxW = SIZES[size] || SIZES.md

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(10,10,10,0.32)',
          backdropFilter: 'blur(2px)',
          zIndex: 99,
          animation: 'modalFadeIn 0.18s cubic-bezier(0.2,0.7,0.2,1)',
        }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: `min(${maxW}px, 94vw)`,
          maxHeight: '90vh',
          background: 'var(--paper)',
          borderTop: '3px solid var(--accent)',
          borderLeft: '1px solid var(--rule)',
          borderRight: '1px solid var(--rule)',
          borderBottom: '1px solid var(--rule)',
          boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
          zIndex: 100,
          display: 'flex', flexDirection: 'column',
          animation: 'modalSlideIn 0.22s cubic-bezier(0.2,0.7,0.2,1)',
        }}>
        {/* Header — sticky inside the modal */}
        <div style={{
          padding: '20px 28px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          gap: 16, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            {eyebrow && (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
                letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--ink-3)', marginBottom: 6,
              }}>{eyebrow}</div>
            )}
            {title && (
              <h2 style={{
                margin: 0, fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500,
                lineHeight: 1.1, letterSpacing: '-0.015em', color: 'var(--ink)',
              }}>{title}</h2>
            )}
            {subtitle && (
              <p style={{
                margin: '6px 0 0', fontFamily: 'var(--sans)', fontSize: 13,
                color: 'var(--ink-3)', lineHeight: 1.5,
              }}>{subtitle}</p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {right}
            <button onClick={onClose} aria-label="Close" style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--ink-3)', padding: 4,
            }}>{Icon.x(18)}</button>
          </div>
        </div>

        {/* Body — scroll independently of header/footer */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
        }}>
          {children}
        </div>

        {/* Optional footer */}
        {footer && (
          <div style={{
            padding: '14px 28px',
            borderTop: '1px solid var(--rule)',
            background: 'var(--paper-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 16, flexShrink: 0,
          }}>
            {footer}
          </div>
        )}
      </div>

      <style>{`
        @keyframes modalFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes modalSlideIn {
          from { transform: translate(-50%, -48%); opacity: 0 }
          to   { transform: translate(-50%, -50%); opacity: 1 }
        }
      `}</style>
    </>
  )
}
