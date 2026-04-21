import { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext(null)

let idCounter = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((toast) => {
    const id = ++idCounter
    const full = {
      id,
      kind: toast.kind || 'info',
      title: toast.title || '',
      message: toast.message || '',
      // Errors stay until dismissed. Success/info auto-dismiss after 8s unless duration is explicitly set.
      duration: toast.duration !== undefined
        ? toast.duration
        : (toast.kind === 'error' ? null : 8000),
    }
    setToasts(prev => [...prev, full])
    if (full.duration) {
      setTimeout(() => dismiss(id), full.duration)
    }
    return id
  }, [dismiss])

  const api = {
    push,
    dismiss,
    success: (message, opts = {}) => push({ kind: 'success', message, ...opts }),
    error: (message, opts = {}) => push({ kind: 'error', message, ...opts }),
    info: (message, opts = {}) => push({ kind: 'info', message, ...opts }),
    toasts,
  }

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Graceful fallback so pages importing useToast outside the provider don't crash —
    // they just log instead of surfacing. Provider is mounted in Layout.
    return {
      push: (t) => console.warn('[toast] no provider:', t),
      dismiss: () => {},
      success: (m) => console.log('[toast:success]', m),
      error: (m) => console.error('[toast:error]', m),
      info: (m) => console.log('[toast:info]', m),
      toasts: [],
    }
  }
  return ctx
}
