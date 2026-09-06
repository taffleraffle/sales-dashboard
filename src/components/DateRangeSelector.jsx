import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronDown } from 'lucide-react'
import EditorialDate from './EditorialDate'

const presets = [
  { label: 'Today', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: 'MTD', days: 'mtd' },
]

function isCustomRange(selected) {
  return selected && typeof selected === 'object' && selected.from
}

function formatRangeLabel(selected) {
  if (isCustomRange(selected)) {
    const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
    return `${fmt(selected.from)} – ${fmt(selected.to)}`
  }
  return null
}

// House segmented control: white pill track, yellow pill for the active preset.
const segActive = { background: 'var(--accent)', color: '#1a1700', borderRadius: 999, boxShadow: '0 8px 20px -10px rgba(244,197,24,.9)' }
const segIdle   = { background: 'transparent', color: 'var(--ink-2)', borderRadius: 999 }

export default function DateRangeSelector({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [popover, setPopover] = useState({ top: 0, left: 0, maxWidth: 0 })
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gutter = 12
    const panelWidth = 288
    let left = rect.right - panelWidth
    if (left < gutter) left = gutter
    const maxRight = window.innerWidth - gutter
    if (left + panelWidth > maxRight) left = maxRight - panelWidth
    setPopover({ top: rect.bottom + 8, left, maxWidth: panelWidth })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (popoverRef.current?.contains(e.target)) return
      // The From/To pickers are EditorialDate components whose calendars
      // portal to document.body — NOT inside popoverRef. Without this guard
      // every click on a calendar day counted as "outside" and closed the
      // whole custom-range popover before a range could be applied.
      if (e.target.closest?.('[data-editorial-date-popover]')) return
      setOpen(false)
    }
    const reposition = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      const gutter = 12
      const panelWidth = 288
      let left = rect.right - panelWidth
      if (left < gutter) left = gutter
      const maxRight = window.innerWidth - gutter
      if (left + panelWidth > maxRight) left = maxRight - panelWidth
      setPopover({ top: rect.bottom + 8, left, maxWidth: panelWidth })
    }
    document.addEventListener('mousedown', handleDown)
    window.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      window.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  // Seed the From/To fields from the currently-applied custom range whenever
  // the popover opens. Without this, a reload (or fresh mount) left both
  // fields blank even though a range was active — Apply sat disabled until
  // BOTH ends were re-picked, and the stale local values fed min/max
  // constraints that invisibly greyed out the days being clicked.
  useEffect(() => {
    if (!open) return
    if (isCustomRange(selected)) {
      setCustomFrom(selected.from)
      setCustomTo(selected.to || '')
    }
  }, [open, selected])

  const isPreset = (days) => {
    if (isCustomRange(selected)) return false
    return selected === days
  }

  const applyCustom = () => {
    if (!customFrom || !customTo) return
    // Swap silently if the user picked them in reverse order — friendlier
    // than hard-disabling half the calendar via min/max constraints.
    const [from, to] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
    onChange({ from, to })
    setOpen(false)
  }

  const customLabel = formatRangeLabel(selected)

  return (
    <div className="relative" ref={containerRef}>
      <div
        className="flex gap-1 overflow-x-auto no-scrollbar"
        style={{
          background: '#ffffff',
          border: '1px solid var(--house-line-strong)',
          borderRadius: 999,
          padding: 4,
          boxShadow: 'var(--house-shadow-input)',
        }}
      >
        {presets.map(({ label, days }) => (
          <button
            key={label}
            onClick={() => { onChange(days); setOpen(false) }}
            className="house-plain"
            style={{
              height: 32,
              padding: '0 14px',
              fontFamily: 'var(--sans)',
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              transition: 'background 160ms ease, color 160ms ease',
              ...(isPreset(days) ? segActive : segIdle),
            }}
          >
            {label}
          </button>
        ))}

        <button
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          className="house-plain"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 14px',
            fontFamily: 'var(--sans)',
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            ...(isCustomRange(selected) ? segActive : segIdle),
          }}
        >
          <Calendar size={11} />
          <span className="hidden sm:inline">{customLabel || 'Custom'}</span>
          <span className="sm:hidden">{customLabel ? customLabel.substring(0, 10) : 'Custom'}</span>
          <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[1000]"
          style={{
            top: popover.top,
            left: popover.left,
            width: popover.maxWidth,
            background: '#ffffff',
            border: '1px solid var(--rule)',
            borderRadius: 22,
            padding: 22,
            boxShadow: '0 30px 70px -30px rgba(20,22,30,.45)',
          }}
          role="dialog"
          aria-label="Custom date range"
        >
          <span className="eyebrow" style={{ marginBottom: 14, display: 'inline-flex' }}>Custom range</span>

          <div className="space-y-3 mt-3">
            <div>
              <label
                className="eyebrow"
                style={{ display: 'block', marginBottom: 6 }}
              >
                From
              </label>
              <EditorialDate value={customFrom} onChange={setCustomFrom} placeholder="Pick start" fullWidth />
            </div>
            <div>
              <label
                className="eyebrow"
                style={{ display: 'block', marginBottom: 6 }}
              >
                To
              </label>
              <EditorialDate value={customTo} onChange={setCustomTo} placeholder="Pick end" fullWidth />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-4 pt-3" style={{ borderTop: '1px solid var(--rule)' }}>
            {[
              { label: 'Last 14d', from: 14 },
              { label: 'Last 60d', from: 60 },
              { label: 'Last 90d', from: 90 },
              { label: 'This Quarter', quarter: true },
            ].map(preset => {
              const handleClick = () => {
                const now = new Date()
                const toStr = now.toISOString().split('T')[0]
                let fromStr
                if (preset.quarter) {
                  const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
                  fromStr = qStart.toISOString().split('T')[0]
                } else {
                  const d = new Date()
                  d.setDate(d.getDate() - preset.from)
                  fromStr = d.toISOString().split('T')[0]
                }
                setCustomFrom(fromStr)
                setCustomTo(toStr)
                onChange({ from: fromStr, to: toStr })
                setOpen(false)
              }
              return (
                <button
                  key={preset.label}
                  onClick={handleClick}
                  style={{
                    padding: '6px 12px',
                    border: '1px solid var(--house-line-strong)',
                    background: '#ffffff',
                    color: 'var(--ink-2)',
                    fontFamily: 'var(--sans)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    transition: 'color 160ms ease, border-color 160ms ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--ink)'; e.currentTarget.style.borderColor = 'var(--ink-3)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3)'; e.currentTarget.style.borderColor = 'var(--rule)' }}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>

          <button
            onClick={applyCustom}
            disabled={!customFrom || !customTo}
            style={{
              marginTop: 18,
              width: '100%',
              height: 40,
              borderRadius: 999,
              fontFamily: 'var(--sans)',
              fontSize: 13.5,
              fontWeight: 600,
              background: 'var(--accent)',
              color: '#1a1700',
              border: '1px solid var(--accent)',
              boxShadow: '0 8px 20px -10px rgba(244,197,24,.9)',
              cursor: (!customFrom || !customTo) ? 'not-allowed' : 'pointer',
              opacity: (!customFrom || !customTo) ? 0.4 : 1,
            }}
          >
            Apply Range
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
