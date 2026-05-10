import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { useToast } from '../hooks/useToast'
import { ICON } from '../utils/constants'

/*
  Editorial toast.
  Paper panel with hairline border + 3px left accent stripe by kind:
  success → up-green, error → down-red, info → editorial-yellow.
*/

const KIND_STYLES = {
  success: { icon: CheckCircle2, accent: 'var(--up)',     soft: 'var(--up-soft)' },
  error:   { icon: AlertTriangle, accent: 'var(--down)',  soft: 'var(--down-soft)' },
  info:    { icon: Info,           accent: 'var(--accent)', soft: 'var(--accent-soft)' },
}

export default function ToastStack() {
  const { toasts, dismiss } = useToast()
  if (!toasts.length) return null
  return (
    <div className="toast-stack">
      {toasts.map(t => {
        const style = KIND_STYLES[t.kind] || KIND_STYLES.info
        const Icon = style.icon
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="toast-in"
            style={{
              background: 'var(--paper)',
              borderLeft: `3px solid ${style.accent}`,
              border: '1px solid var(--rule)',
              borderLeftWidth: 3,
              borderLeftColor: style.accent,
              borderRadius: '0 3px 3px 0',
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              boxShadow: '0 4px 16px rgba(10,10,10,0.08)',
            }}
          >
            <Icon size={ICON.lg} style={{ color: style.accent, flexShrink: 0, marginTop: 2 }} />
            <div className="flex-1 min-w-0">
              {t.title && (
                <p
                  style={{
                    fontFamily: 'var(--serif)',
                    fontSize: 14,
                    fontWeight: 500,
                    color: 'var(--ink)',
                    margin: 0,
                    lineHeight: 1.3,
                  }}
                >
                  {t.title}
                </p>
              )}
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--ink-2)',
                  margin: t.title ? '4px 0 0' : 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  lineHeight: 1.45,
                }}
              >
                {t.message}
              </p>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              style={{
                color: 'var(--ink-3)',
                flexShrink: 0,
                marginRight: -2,
                marginTop: 1,
                padding: 0,
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--ink)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3)' }}
              aria-label="Dismiss"
            >
              <X size={ICON.md} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
