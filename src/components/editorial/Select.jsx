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
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[11px] bg-bg-card border border-border-default rounded-sm outline-none text-text-secondary hover:border-text-400 transition-colors">
        <span className="truncate">{sel ? sel.label : placeholder}</span>
        <ChevronDown size={13} className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 min-w-full max-h-64 overflow-auto bg-bg-card border border-border-default rounded-sm shadow-xl">
          {options.map(o => (
            <button key={o.value} type="button"
              onClick={() => { onChange(o.value); setOpen(false) }}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-left hover:bg-white/[0.05] ${o.value === value ? 'text-text-primary bg-white/[0.03]' : 'text-text-secondary'}`}>
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check size={12} className="text-opt-yellow shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
