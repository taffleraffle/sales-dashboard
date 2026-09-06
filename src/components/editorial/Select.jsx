import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'

/*
  Branded dropdown — a drop-in replacement for a native <select> that matches
  the editorial design system (native <select> can't be styled cross-browser).
  Button + custom popover list; closes on outside-click / Esc.

  Usage:
    <Select value={status} onChange={setStatus}
            options={[{ value: 'ran', label: 'Ran in range' }, …]} />
*/
export default function Select({
  value, options, onChange,
  placeholder = 'Select…',
  className = '',
  minWidth = 140,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const sel = options.find(o => o.value === value)

  return (
    <div ref={ref} className={`relative ${className}`} style={{ minWidth }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="house-plain w-full flex items-center justify-between gap-2 text-left outline-none" style={{ height: 40, padding: '0 14px', fontSize: 14, fontWeight: 500, color: 'var(--ink)', background: '#ffffff', border: '1px solid var(--house-line-strong)', borderRadius: 14, boxShadow: 'var(--house-shadow-input)' }}>
        <span className="truncate">{sel ? sel.label : placeholder}</span>
        <ChevronDown size={13} className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-2 left-0 min-w-full max-h-64 overflow-auto" style={{ background: '#ffffff', border: '1px solid var(--rule)', borderRadius: 16, boxShadow: '0 18px 44px -20px rgba(20,22,30,.35)', padding: 6 }}>
          {options.map(o => (
            <button key={o.value} type="button"
              onClick={() => { onChange(o.value); setOpen(false) }}
              className="house-plain w-full flex items-center justify-between gap-2 text-left" style={{ padding: '9px 12px', fontSize: 13.5, fontWeight: 500, borderRadius: 10, color: 'var(--ink)', background: o.value === value ? 'rgba(244,225,74,.18)' : 'transparent' }}>
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check size={12} className="text-opt-yellow shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
