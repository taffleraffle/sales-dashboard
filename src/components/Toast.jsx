import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { useToast } from '../hooks/useToast'
import { ICON } from '../utils/constants'

const KIND_STYLES = {
  success: { icon: CheckCircle2, accent: 'text-success', ring: 'border-success/30' },
  error:   { icon: AlertTriangle, accent: 'text-danger',  ring: 'border-danger/40' },
  info:    { icon: Info,           accent: 'text-opt-yellow', ring: 'border-opt-yellow/30' },
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
            className={`toast-in tile ${style.ring} p-3 flex items-start gap-3`}
          >
            <Icon size={ICON.lg} className={`${style.accent} shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
              {t.title && <p className="text-sm font-semibold text-text-primary">{t.title}</p>}
              <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">{t.message}</p>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-text-400 hover:text-text-primary shrink-0 -mr-1 -mt-0.5"
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
