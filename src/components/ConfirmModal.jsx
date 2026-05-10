import { useEffect, useRef } from 'react'
import { AlertTriangle, Trash2, Loader } from 'lucide-react'

/*
  Editorial confirm modal.
  Backdrop: ink/45 + paper-bg panel with hairline.
  Title: serif italic emphasis. Action buttons in editorial style.
*/

export default function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', variant = 'danger', loading = false }) {
  const confirmRef = useRef(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleEsc = (e) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [open, onClose, loading])

  if (!open) return null

  const accent = variant === 'danger' ? 'var(--down)' : 'var(--accent)'
  const iconColor = accent

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: 'rgba(10,10,10,0.45)',
        backdropFilter: 'blur(6px)',
      }}
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-full max-w-sm mx-4"
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderTop: `3px solid ${accent}`,
          borderRadius: '0 0 4px 4px',
          padding: '20px 22px 18px',
          boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 3,
              background: variant === 'danger' ? 'var(--down-soft)' : 'var(--accent-soft)',
              color: iconColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {variant === 'danger' ? <Trash2 size={16} /> : <AlertTriangle size={16} />}
          </div>
          <div>
            <span className="eyebrow" style={{ fontSize: 9 }}>{variant === 'danger' ? 'Confirm action' : 'Heads up'}</span>
            <h3
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 19,
                fontWeight: 500,
                color: 'var(--ink)',
                margin: '6px 0 6px',
                letterSpacing: '-0.015em',
                lineHeight: 1.2,
              }}
            >
              {title}
            </h3>
            <p
              style={{
                fontSize: 13,
                color: 'var(--ink-2)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {message}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '8px 14px',
              borderRadius: 3,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              background: 'transparent',
              border: '1px solid var(--rule)',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
              transition: 'color 160ms ease, border-color 160ms ease',
            }}
            onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.color = 'var(--ink)'; e.currentTarget.style.borderColor = 'var(--ink-3)' } }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3)'; e.currentTarget.style.borderColor = 'var(--rule)' }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={loading}
            style={{
              padding: '8px 14px',
              borderRadius: 3,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 600,
              color: variant === 'danger' ? 'var(--paper)' : 'var(--ink)',
              background: variant === 'danger' ? 'var(--down)' : 'var(--accent)',
              border: `1px solid ${variant === 'danger' ? 'var(--down)' : 'var(--accent)'}`,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {loading && <Loader size={11} className="animate-spin" />}
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
