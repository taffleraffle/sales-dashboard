import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronDown } from 'lucide-react'

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

export default function DateRangeSelector({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // Portal-based popover position. Measuring the Custom-button rect on open
  // and rendering the popover into document.body means no ancestor flex /
  // overflow / transform can push the page layout around when the panel
  // opens — it floats above everything, independent of its DOM position.
  const [popover, setPopover] = useState({ top: 0, left: 0, maxWidth: 0 })
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gutter = 12
    const panelWidth = 288 // w-72
    // Anchor panel to the right edge of the trigger button so it aligns with
    // the "Custom" chip. Clamp at viewport edges so we don't spill off-screen.
    let left = rect.right - panelWidth
    if (left < gutter) left = gutter
    const maxRight = window.innerWidth - gutter
    if (left + panelWidth > maxRight) left = maxRight - panelWidth
    setPopover({ top: rect.bottom + 8, left, maxWidth: panelWidth })
  }, [open])

  // Close on outside click OR on scroll/resize (so the panel doesn't float
  // detached from the trigger button if the user scrolls the page).
  useEffect(() => {
    if (!open) return
    const handleDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (popoverRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const handleScroll = () => setOpen(false)
    document.addEventListener('mousedown', handleDown)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleScroll)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleScroll)
    }
  }, [open])

  const isPreset = (days) => {
    if (isCustomRange(selected)) return false
    return selected === days
  }

  const applyCustom = () => {
    if (customFrom && customTo) {
      onChange({ from: customFrom, to: customTo })
      setOpen(false)
    }
  }

  const customLabel = formatRangeLabel(selected)

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex gap-1.5 bg-bg-card border border-border-default rounded-xl p-1 overflow-x-auto no-scrollbar">
        {presets.map(({ label, days }) => (
          <button
            key={label}
            onClick={() => { onChange(days); setOpen(false) }}
            className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all duration-200 whitespace-nowrap shrink-0 ${
              isPreset(days)
                ? 'bg-opt-yellow text-bg-primary shadow-sm'
                : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
            }`}
          >
            {label}
          </button>
        ))}

        {/* Custom range toggle */}
        <button
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all duration-200 whitespace-nowrap shrink-0 ${
            isCustomRange(selected)
              ? 'bg-opt-yellow text-bg-primary shadow-sm'
              : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
          }`}
        >
          <Calendar size={12} />
          <span className="hidden sm:inline">{customLabel || 'Custom'}</span>
          <span className="sm:hidden">{customLabel ? customLabel.substring(0, 10) : 'Custom'}</span>
          <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Custom popover — rendered into document.body via portal so opening
          it never pushes the surrounding page layout around. */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[1000] tile tile-feedback p-5 shadow-xl shadow-black/40"
          style={{ top: popover.top, left: popover.left, width: popover.maxWidth }}
          role="dialog"
          aria-label="Custom date range"
        >
          <p className="text-[11px] text-text-400 uppercase tracking-wider font-medium mb-3">Custom Range</p>

          <div className="space-y-3">
            <div>
              <label className="text-[11px] text-text-400 block mb-1">From</label>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/50 transition-colors [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="text-[11px] text-text-400 block mb-1">To</label>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/50 transition-colors [color-scheme:dark]"
              />
            </div>
          </div>

          {/* Quick presets within dropdown */}
          <div className="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-border-default">
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
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-bg-primary text-text-400 border border-border-default hover:text-text-primary hover:border-opt-yellow/30 transition-all"
                >
                  {preset.label}
                </button>
              )
            })}
          </div>

          <button
            onClick={applyCustom}
            disabled={!customFrom || !customTo}
            className="mt-4 w-full py-2 rounded-xl text-xs font-semibold bg-opt-yellow text-bg-primary hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            Apply Range
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
