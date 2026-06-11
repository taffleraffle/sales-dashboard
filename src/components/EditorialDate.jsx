import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'

/*
  EditorialDate — drop-in replacement for <input type="date">. Renders as
  a paper-cream pill with a monospace YYYY-MM-DD value + a small calendar
  icon. Click opens a portaled month-grid calendar popover styled in the
  OPT editorial system (paper / ink / accent yellow, mono labels, serif
  numerals).

  Props mirror the native input where it matters:
    value     string  'YYYY-MM-DD' (or '' for empty)
    onChange  fn(str)
    min, max  string  'YYYY-MM-DD' bounds (optional)
    placeholder string fallback when value is empty
    disabled  bool
    compact   bool    smaller pill for table-cell use
*/

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Format a YYYY-MM-DD string as "May 12" / "12 May" without timezone math.
function shortLabel(yyyymmdd) {
  if (!yyyymmdd) return null
  const [y, m, d] = yyyymmdd.split('-').map(Number)
  if (!y || !m || !d) return null
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`
}

// Parse a YYYY-MM-DD into a plain {y,m,d} record (no Date object — avoids
// TZ shifts on dates near midnight). Returns null on garbage.
function parse(yyyymmdd) {
  if (!yyyymmdd) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd)
  if (!m) return null
  return { y: +m[1], m: +m[2], d: +m[3] }
}
function pad(n) { return n < 10 ? `0${n}` : String(n) }
function fmt(y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }

// Number of days in a given month (1-indexed month)
function daysInMonth(y, m) { return new Date(y, m, 0).getDate() }

// Day-of-week (0=Mo, 6=Su) for the first day of a month
function firstDow(y, m) {
  const d = new Date(y, m - 1, 1).getDay() // 0=Sun
  return (d + 6) % 7  // shift so Monday=0
}

const todayStr = () => {
  const d = new Date()
  return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

export default function EditorialDate({ value, onChange, min, max, placeholder = 'Pick a date', disabled, compact, fullWidth }) {
  const [open, setOpen] = useState(false)
  // pickerMode: 'days' (default 7×6 grid), 'months' (12-month grid),
  // 'years' (year decade grid). Clicking the month name → 'months';
  // clicking the year → 'years'. Selecting jumps back to 'days'.
  const [pickerMode, setPickerMode] = useState('days')
  const [view, setView] = useState(() => {
    const p = parse(value) || parse(todayStr())
    return { y: p.y, m: p.m }
  })
  const [popover, setPopover] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  // Keep the visible month in sync with `value` whenever it changes externally
  useEffect(() => {
    const p = parse(value)
    if (p) setView({ y: p.y, m: p.m })
  }, [value])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gutter = 12
    const panelW = 296
    let left = rect.left
    if (left + panelW > window.innerWidth - gutter) left = window.innerWidth - gutter - panelW
    if (left < gutter) left = gutter
    setPopover({ top: rect.bottom + 6, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (popoverRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const reposition = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      const gutter = 12
      const panelW = 296
      let left = rect.left
      if (left + panelW > window.innerWidth - gutter) left = window.innerWidth - gutter - panelW
      if (left < gutter) left = gutter
      setPopover({ top: rect.bottom + 6, left })
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const selected = parse(value)
  const today = parse(todayStr())

  // Bounds
  const minP = parse(min)
  const maxP = parse(max)
  const isDisabled = (y, m, d) => {
    const s = fmt(y, m, d)
    if (minP && s < fmt(minP.y, minP.m, minP.d)) return true
    if (maxP && s > fmt(maxP.y, maxP.m, maxP.d)) return true
    return false
  }

  // Build the visible month grid
  const monthLen = daysInMonth(view.y, view.m)
  const lead = firstDow(view.y, view.m)
  // Previous-month trailing days for the first row
  const prevLen = daysInMonth(view.y, view.m === 1 ? view.y - 1 : view.y, view.m === 1 ? 12 : view.m - 1)
  const cells = []
  for (let i = 0; i < lead; i++) {
    const d = prevLen - lead + 1 + i
    cells.push({ day: d, mute: true, y: view.m === 1 ? view.y - 1 : view.y, m: view.m === 1 ? 12 : view.m - 1 })
  }
  for (let d = 1; d <= monthLen; d++) {
    cells.push({ day: d, mute: false, y: view.y, m: view.m })
  }
  while (cells.length % 7 !== 0) {
    const d = cells.length - lead - monthLen + 1
    cells.push({ day: d, mute: true, y: view.m === 12 ? view.y + 1 : view.y, m: view.m === 12 ? 1 : view.m + 1 })
  }

  const stepMonth = (delta) => {
    let { y, m } = view
    m += delta
    if (m < 1) { m = 12; y-- }
    if (m > 12) { m = 1; y++ }
    setView({ y, m })
  }

  const pickToday = () => {
    onChange(todayStr())
    setOpen(false)
  }
  const clear = (e) => {
    e.stopPropagation()
    onChange('')
  }

  const labelText = value ? shortLabel(value) : placeholder

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '4px 8px' : '7px 10px',
          fontFamily: 'var(--mono)',
          fontSize: compact ? 10.5 : 11.5,
          letterSpacing: '0.06em',
          fontWeight: 500,
          color: value ? 'var(--ink)' : 'var(--ink-3)',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 3,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          transition: 'border-color 160ms ease',
          whiteSpace: 'nowrap',
          width: fullWidth ? '100%' : undefined,
          justifyContent: fullWidth ? 'space-between' : undefined,
        }}
        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = 'var(--ink-3)' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--rule)' }}
      >
        <Calendar size={compact ? 10 : 12} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
        <span style={{ flex: fullWidth ? 1 : undefined, textAlign: 'left' }}>{labelText}</span>
        {value && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            onClick={clear}
            title="Clear"
            style={{ marginLeft: 4, padding: 1, display: 'inline-flex', alignItems: 'center', color: 'var(--ink-4)' }}
          >
            <X size={compact ? 9 : 11} />
          </span>
        )}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Choose date"
          data-editorial-date-popover=""
          // Defensive: stop mousedown inside the popover from ever bubbling
          // up to the document-level click-outside handler. Even if
          // popoverRef.current is briefly null during a React re-render
          // (e.g. after stepMonth fires), this prevents the popover from
          // closing on its own internal clicks — the exact symptom Ben
          // hit ("clicks close the whole thing").
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: popover.top,
            left: popover.left,
            width: 296,
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            padding: 14,
            boxShadow: '0 16px 40px rgba(10,10,10,0.12)',
            zIndex: 1000,
          }}
        >
          {/* Header — month nav with clickable month + year labels.
              Clicking the month name swaps to a 12-month picker grid;
              clicking the year swaps to a 12-year picker grid. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 6 }}>
            <button
              type="button"
              onClick={() => pickerMode === 'days' ? stepMonth(-1) : pickerMode === 'months' ? setView({ ...view, y: view.y - 1 }) : setView({ ...view, y: view.y - 12 })}
              aria-label={pickerMode === 'years' ? 'Previous decade' : pickerMode === 'months' ? 'Previous year' : 'Previous month'}
              style={navBtn}
            >
              <ChevronLeft size={14} />
            </button>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {pickerMode === 'years' ? (
                <span style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.005em' }}>
                  {Math.floor(view.y / 12) * 12} – {Math.floor(view.y / 12) * 12 + 11}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setPickerMode(pickerMode === 'months' ? 'days' : 'months')}
                    style={headerBtn}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--paper-2)'; e.currentTarget.style.borderColor = 'var(--rule)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                  >
                    {MONTHS[view.m - 1]}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPickerMode('years')}
                    style={{ ...headerBtn, fontFamily: 'var(--mono)', fontSize: 15, letterSpacing: '0.02em' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--paper-2)'; e.currentTarget.style.borderColor = 'var(--rule)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                  >
                    {view.y}
                  </button>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => pickerMode === 'days' ? stepMonth(1) : pickerMode === 'months' ? setView({ ...view, y: view.y + 1 }) : setView({ ...view, y: view.y + 12 })}
              aria-label={pickerMode === 'years' ? 'Next decade' : pickerMode === 'months' ? 'Next year' : 'Next month'}
              style={navBtn}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Month picker — 12 months in a 3x4 grid */}
          {pickerMode === 'months' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 8 }}>
              {MONTHS.map((mn, i) => {
                const isCurrent = (i + 1) === view.m
                return (
                  <button
                    key={mn}
                    type="button"
                    onClick={() => { setView({ ...view, m: i + 1 }); setPickerMode('days') }}
                    style={{
                      padding: '12px 8px',
                      fontFamily: 'var(--serif)',
                      fontSize: 13,
                      fontWeight: isCurrent ? 600 : 400,
                      background: isCurrent ? 'var(--accent)' : 'transparent',
                      color: 'var(--ink)',
                      border: '1px solid', borderColor: isCurrent ? 'var(--accent)' : 'var(--rule)',
                      borderRadius: 2,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--paper-2)' }}
                    onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
                  >
                    {mn.slice(0, 3)}
                  </button>
                )
              })}
            </div>
          )}

          {/* Year picker — 12 years in a 3x4 grid */}
          {pickerMode === 'years' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 8 }}>
              {Array.from({ length: 12 }, (_, i) => {
                const base = Math.floor(view.y / 12) * 12
                const yr = base + i
                const isCurrent = yr === view.y
                return (
                  <button
                    key={yr}
                    type="button"
                    onClick={() => { setView({ ...view, y: yr }); setPickerMode('months') }}
                    style={{
                      padding: '12px 8px',
                      fontFamily: 'var(--mono)',
                      fontSize: 13,
                      fontWeight: isCurrent ? 700 : 500,
                      letterSpacing: '0.04em',
                      background: isCurrent ? 'var(--accent)' : 'transparent',
                      color: 'var(--ink)',
                      border: '1px solid', borderColor: isCurrent ? 'var(--accent)' : 'var(--rule)',
                      borderRadius: 2,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--paper-2)' }}
                    onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
                  >
                    {yr}
                  </button>
                )
              })}
            </div>
          )}

          {/* Day-of-week header (only in days mode) */}
          {pickerMode === 'days' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {DAYS.map(d => (
              <div key={d} style={{ textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-4)', padding: '4px 0' }}>{d}</div>
            ))}
          </div>
          )}

          {/* Day cells (only in days mode) */}
          {pickerMode === 'days' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((c, i) => {
              const dStr = fmt(c.y, c.m, c.day)
              const isSel = selected && c.y === selected.y && c.m === selected.m && c.day === selected.d
              const isToday = today && c.y === today.y && c.m === today.m && c.day === today.d
              const dis = isDisabled(c.y, c.m, c.day)
              const baseColor = c.mute ? 'var(--ink-4)' : 'var(--ink)'
              return (
                <button
                  key={i}
                  type="button"
                  disabled={dis}
                  onClick={() => { onChange(dStr); setOpen(false) }}
                  style={{
                    padding: '7px 0',
                    background: isSel ? 'var(--accent)' : isToday ? 'var(--paper-2)' : 'transparent',
                    color: isSel ? 'var(--ink)' : baseColor,
                    fontFamily: 'var(--serif)',
                    fontSize: 14,
                    fontWeight: isSel ? 600 : (isToday ? 500 : 400),
                    fontVariantNumeric: 'tabular-nums',
                    border: '1px solid',
                    borderColor: isSel ? 'var(--accent)' : isToday ? 'var(--rule)' : 'transparent',
                    borderRadius: 2,
                    cursor: dis ? 'not-allowed' : 'pointer',
                    opacity: dis ? 0.3 : 1,
                    transition: 'background 120ms ease, border-color 120ms ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!dis && !isSel) {
                      e.currentTarget.style.background = 'var(--paper-2)'
                      e.currentTarget.style.borderColor = 'var(--ink-3)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSel) {
                      e.currentTarget.style.background = isToday ? 'var(--paper-2)' : 'transparent'
                      e.currentTarget.style.borderColor = isToday ? 'var(--rule)' : 'transparent'
                    }
                  }}
                >
                  {c.day}
                </button>
              )
            })}
          </div>
          )}

          {/* Footer */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <button onClick={pickToday} style={footBtnGhost}>Today</button>
            {value && (
              <button onClick={() => { onChange(''); setOpen(false) }} style={footBtnGhost}>Clear</button>
            )}
            <button onClick={() => setOpen(false)} style={footBtnPrimary}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

const navBtn = {
  padding: 5,
  background: 'transparent',
  border: '1px solid var(--rule)',
  borderRadius: 2,
  cursor: 'pointer',
  color: 'var(--ink-2)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}
// Header buttons (month name, year) — clickable to open month/year picker modes
const headerBtn = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 2,
  cursor: 'pointer',
  color: 'var(--ink)',
  fontFamily: 'var(--serif)',
  fontSize: 17,
  fontWeight: 500,
  lineHeight: 1.1,
  letterSpacing: '-0.005em',
  transition: 'background 120ms ease, border-color 120ms ease',
}
const footBtnGhost = {
  padding: '5px 10px',
  background: 'transparent',
  border: '1px solid var(--rule)',
  borderRadius: 2,
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 500,
  color: 'var(--ink-3)',
}
const footBtnPrimary = {
  padding: '5px 12px',
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 2,
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--ink)',
  marginLeft: 'auto',
}
