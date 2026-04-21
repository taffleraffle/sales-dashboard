import { useEffect, useRef } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'

export default function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', variant = 'danger' }) {
  const confirmRef = useRef(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [open, onClose])

  if (!open) return null

  const btnColor = variant === 'danger'
    ? 'bg-danger hover:bg-danger/80 text-white'
    : 'bg-opt-yellow hover:brightness-110 text-bg-primary'

  const iconColor = variant === 'danger' ? 'text-danger' : 'text-opt-yellow'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="tile tile-feedback w-full max-w-sm mx-4 p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className={`p-2 rounded-xl bg-bg-primary ${iconColor}`}>
            {variant === 'danger' ? <Trash2 size={18} /> : <AlertTriangle size={18} />}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="text-xs text-text-400 mt-1">{message}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-medium text-text-400 hover:text-text-primary hover:bg-bg-primary transition-all">
            Cancel
          </button>
          <button ref={confirmRef} onClick={onConfirm} className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${btnColor}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
