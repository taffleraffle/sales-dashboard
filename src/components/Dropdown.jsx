import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, Check } from 'lucide-react'

/**
 * A select that looks like the rest of the app instead of like the operating
 * system. A native <select> renders with the OS widget — grey chrome, system
 * font, tiny arrows, and a completely different look on Mac vs Windows — which
 * is the one control on a page that gives away that nobody styled it.
 *
 * Keyboard behaviour matches a native select closely enough not to surprise
 * anyone: arrows move, Enter/Space picks, Escape closes, Home/End jump, and
 * typing nothing is required.
 *
 * options: [{ value, label, hint? }]
 */
export default function Dropdown({ value, options, onChange, label, width = 210 }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrap = useRef(null)
  const listRef = useRef(null)

  const selected = options.find(o => o.value === value) || options[0]

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex(o => o.value === value)))
  }, [open, options, value])

  // Keep the highlighted row visible when arrowing through a longer list.
  useEffect(() => {
    if (!open || !listRef.current) return
    listRef.current.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (i) => {
    const opt = options[i]
    if (opt) onChange(opt.value)
    close()
  }

  const onKeyDown = (e) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active) }
    else if (e.key === 'Tab') close()
  }

  return (
    <div className="flex flex-col gap-1" ref={wrap} style={{ width }}>
      {label && (
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-3)' }}>
          {label}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          onKeyDown={onKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm rounded text-left"
          style={{
            border: `1px solid ${open ? 'var(--ink-2, #444)' : 'var(--rule)'}`,
            background: 'transparent',
            color: 'var(--ink, inherit)',
          }}>
          <span className="truncate">{selected?.label}</span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--ink-3)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }} />
        </button>

        {open && (
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            className="absolute left-0 right-0 mt-1 py-1 rounded shadow-lg"
            style={{
              zIndex: 40, background: 'var(--paper, #fff)', border: '1px solid var(--rule)',
              maxHeight: '15rem', overflowY: 'auto',
            }}>
            {options.map((o, i) => {
              const isSel = o.value === value
              const isActive = i === active
              return (
                <li key={o.value ?? i}
                  role="option"
                  aria-selected={isSel}
                  data-active={isActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                  className="flex items-start gap-2 px-2.5 py-1.5 text-sm"
                  style={{ cursor: 'pointer', background: isActive ? 'var(--paper-2, #f4f2ee)' : 'transparent' }}>
                  <Check className="w-3.5 h-3.5 mt-0.5 shrink-0"
                    style={{ opacity: isSel ? 1 : 0, color: '#0a6b39' }} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.hint && (
                      <span className="block text-[10px] truncate" style={{ color: 'var(--ink-3)' }}>
                        {o.hint}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
