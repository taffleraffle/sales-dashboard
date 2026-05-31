import { useEffect, useState } from 'react'
import { Icon } from './atoms'

// Module-level depth counter so nested modals stack correctly.
// When TestBatchDetailModal opens UploadScriptsModal, the inner one
// needs a higher z-index than the outer; otherwise the outer's
// backdrop bleeds over the inner content (see 2026-05-19 screenshot).
let MODAL_DEPTH = 0
const Z_BASE = 100  // backdrop = Z_BASE + depth*10, dialog = +1

// Shared body-scroll-lock state. Each modal used to capture
// `document.body.style.overflow` independently and restore it on
// cleanup — which broke for nested modals: modal A captures '' and
// sets 'hidden', then modal B captures 'hidden' (A's value) and
// sets 'hidden'. When A closes first it restores '' (good), then
// when B closes it restores 'hidden' (BAD) and the page stays
// scroll-locked forever. Real-world symptom: the Launch queue
// stops scrolling after a sequence of preview-modal opens and
// closes (Ben 2026-06-01).
//
// New approach: only the FIRST modal captures the pre-lock value
// and writes 'hidden'; only the LAST modal restores it. Nested
// modals just increment/decrement the counter.
let SCROLL_LOCK_COUNT = 0
let PRE_LOCK_OVERFLOW = ''

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
  // 'full' is used by the SubmissionPreviewModal review surface — the
  // earlier xl size (1080px) felt cramped on big monitors when the
  // video, scrubber, AND comments sidebar all had to share it. 'full'
  // lets the modal fill nearly the entire viewport so the video can
  // breathe.
  full: 1600,
}

export default function Modal({
  open, onClose,
  title, subtitle, eyebrow, right, footer,
  size = 'md',
  children,
}) {
  // Reserve a stack slot for this modal so nested modals sit above us.
  // Top-most modal owns Esc (others ignore the key while not on top).
  const [depth, setDepth] = useState(null)
  useEffect(() => {
    if (!open) return
    MODAL_DEPTH += 1
    const myDepth = MODAL_DEPTH
    setDepth(myDepth)
    return () => {
      MODAL_DEPTH = Math.max(0, MODAL_DEPTH - 1)
      setDepth(null)
    }
  }, [open])

  // Esc to close — only when we're the top-most modal
  useEffect(() => {
    if (!open || depth == null) return
    const h = (e) => {
      if (e.key === 'Escape' && depth === MODAL_DEPTH) onClose?.()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose, depth])

  // Lock body scroll while open — reference-counted across all
  // mounted modals so nested-then-staggered closes don't strand
  // body.style.overflow = 'hidden'.
  useEffect(() => {
    if (!open) return
    if (SCROLL_LOCK_COUNT === 0) {
      PRE_LOCK_OVERFLOW = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    SCROLL_LOCK_COUNT++
    return () => {
      SCROLL_LOCK_COUNT = Math.max(0, SCROLL_LOCK_COUNT - 1)
      if (SCROLL_LOCK_COUNT === 0) {
        document.body.style.overflow = PRE_LOCK_OVERFLOW
      }
    }
  }, [open])

  if (!open || depth == null) return null

  const maxW = SIZES[size] || SIZES.md
  const zBackdrop = Z_BASE + (depth - 1) * 10
  const zDialog = zBackdrop + 1

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          // Stronger fill for nested modals so the outer modal doesn't bleed through.
          // backdropFilter dropped 2026-05-22: each opening modal forced the GPU to
          // re-rasterise the entire viewport behind it, which on the heavy library
          // page (200+ matrix rows + inline styles) added 150-300ms of paint cost
          // per open/close. Visual difference is minimal; perf difference is huge.
          background: depth > 1 ? 'rgba(10,10,10,0.55)' : 'rgba(10,10,10,0.40)',
          zIndex: zBackdrop,
          animation: 'modalFadeIn 80ms ease-out',
        }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: `min(${maxW}px, 94vw)`,
          // 'full' size always renders at the max viewport height so
          // the review surface doesn't shrink/grow based on how many
          // comments are in the sidebar (Ben 2026-06-01: "I just want
          // it to be that size by default and not be this small one
          // at the start"). Other sizes still hug their content via
          // maxHeight only.
          maxHeight: '90vh',
          ...(size === 'full' ? { height: '90vh' } : {}),
          background: 'var(--paper)',
          borderTop: '3px solid var(--accent)',
          borderLeft: '1px solid var(--rule)',
          borderRight: '1px solid var(--rule)',
          borderBottom: '1px solid var(--rule)',
          boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
          zIndex: zDialog,
          display: 'flex', flexDirection: 'column',
          // Animation shortened from 220ms -> 100ms (2026-05-22). The
          // longer ease felt premium but ate 100+ms of perceived click latency
          // on every modal open. 100ms is fast enough that the eye registers
          // motion but not a wait.
          animation: 'modalSlideIn 100ms cubic-bezier(0.2,0.7,0.2,1)',
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
