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

const segActive = { background: 'var(--ink)', color: 'var(--paper)', borderRadius: 3 }
const segIdle   = { background: 'transparent', color: 'var(--ink-3)', borderRadius: 3 }

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
      <div
        className="flex gap-1 overflow-x-auto no-scrollbar"
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 3,
          padding: 3,
        }}
      >
        {presets.map(({ label, days }) => (
          <button
            key={label}
            onClick={() => { onChange(days); setOpen(false) }}
            style={{
              padding: '5px 10px',
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 500,
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
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '5px 10px',
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 500,
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
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            padding: 18,
            boxShadow: '0 16px 40px rgba(10,10,10,0.12)',
          }}
          role="dialog"
          aria-label="Custom date range"
        >
          <span className="eyebrow eyebrow-accent" style={{ fontSize: 9, marginBottom: 14, display: 'inline-flex' }}>Custom range</span>

          <div className="space-y-3 mt-3">
            <div>
              <label
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                From
              </label>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="w-full"
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 3,
                  padding: '7px 10px',
                  fontSize: 13,
                  color: 'var(--ink)',
                  colorScheme: 'light',
                  outline: 'none',
                }}
              />
            </div>
            <div>
              <label
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                To
              </label>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="w-full"
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 3,
                  padding: '7px 10px',
                  fontSize: 13,
                  color: 'var(--ink)',
                  colorScheme: 'light',
                  outline: 'none',
                }}
              />
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
                    padding: '4px 9px',
                    border: '1px solid var(--rule)',
                    background: 'var(--paper)',
                    color: 'var(--ink-3)',
                    fontFamily: 'var(--mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    borderRadius: 2,
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
              marginTop: 16,
              width: '100%',
              padding: '8px 12px',
              borderRadius: 3,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              background: 'var(--accent)',
              color: 'var(--ink)',
              border: '1px solid var(--accent)',
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
