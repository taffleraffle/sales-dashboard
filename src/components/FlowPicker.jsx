import { useState, useRef, useEffect } from 'react'
import { Plus, ChevronDown } from 'lucide-react'
import { ICON } from '../utils/constants'

/**
 * Small "Add to flow" picker used inline in the Email Flows table. Replaces a
 * native <select> which clipped inside cramped table cells on mobile and didn't
 * match the rest of the dropdown styling. Uses the shared .dropdown-panel primitive.
 *
 * Props:
 *   flowGroups: [{ id, name, color }]
 *   onPick: (flowId) => void
 */
export default function FlowPicker({ flowGroups, onPick, compact = true }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [open])

  const handlePick = (id) => {
    setOpen(false)
    onPick(id)
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className={`inline-flex items-center gap-1 ${compact ? 'text-[10px]' : 'text-xs'} text-text-400 hover:text-opt-yellow transition-colors`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus size={ICON.xs} />
        Add to…
        <ChevronDown size={ICON.xs} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 dropdown-panel min-w-[180px] max-h-64 overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {flowGroups.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-text-400">No flows yet — create one above.</p>
          ) : (
            flowGroups.map(fg => (
              <button
                key={fg.id}
                onClick={() => handlePick(fg.id)}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-bg-card-hover transition-colors"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: fg.color || '#f0e050' }}
                />
                <span className="truncate">{fg.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
