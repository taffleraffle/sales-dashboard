import { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatMonth(value) {
  const [y, m] = value.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

const segActive = { background: 'var(--ink)', color: 'var(--paper)', borderRadius: 3 }

export default function MonthPicker({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const [y, m] = value.split('-').map(Number)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const shift = (delta) => {
    const d = new Date(y, m - 1 + delta, 1)
    const newVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    onChange(newVal)
  }

  const selectMonth = (month) => {
    const newVal = `${viewYear}-${String(month + 1).padStart(2, '0')}`
    onChange(newVal)
    setOpen(false)
  }

  const [viewYear, setViewYear] = useState(y)

  useEffect(() => { setViewYear(y) }, [y])

  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const isCurrentMonth = value === currentMonth

  const arrowBtn = {
    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--ink-3)', borderRadius: 3,
  }

  return (
    <div className="relative" ref={ref}>
      <div
        className="flex items-center gap-0.5"
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 3,
          padding: 3,
        }}
      >
        <button onClick={() => shift(-1)} disabled={disabled} style={{ ...arrowBtn, opacity: disabled ? 0.3 : 1 }}>
          <ChevronLeft size={13} />
        </button>

        <button
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '5px 10px',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 500,
            ...(isCurrentMonth ? segActive : { background: 'transparent', color: 'var(--ink)', borderRadius: 3 }),
          }}
        >
          <Calendar size={11} />
          {formatMonth(value)}
          <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        <button onClick={() => shift(1)} disabled={disabled} style={{ ...arrowBtn, opacity: disabled ? 0.3 : 1 }}>
          <ChevronRight size={13} />
        </button>

        {!isCurrentMonth && (
          <button
            onClick={() => { onChange(currentMonth); setOpen(false) }}
            disabled={disabled}
            style={{
              padding: '5px 10px',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 500,
              color: 'var(--ink-3)',
              borderRadius: 3,
              whiteSpace: 'nowrap',
            }}
          >
            This month
          </button>
        )}
      </div>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 w-64"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            padding: 16,
            boxShadow: '0 16px 40px rgba(10,10,10,0.12)',
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <button onClick={() => setViewYear(v => v - 1)} style={arrowBtn}>
              <ChevronLeft size={13} />
            </button>
            <span
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 17,
                color: 'var(--ink)',
                fontWeight: 500,
                letterSpacing: '-0.01em',
              }}
            >
              {viewYear}
            </span>
            <button onClick={() => setViewYear(v => v + 1)} style={arrowBtn}>
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1">
            {MONTH_NAMES.map((name, i) => {
              const monthVal = `${viewYear}-${String(i + 1).padStart(2, '0')}`
              const isSelected = monthVal === value
              const isCurrent = monthVal === currentMonth
              return (
                <button
                  key={name}
                  onClick={() => selectMonth(i)}
                  style={{
                    padding: '8px 0',
                    fontFamily: 'var(--mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    borderRadius: 3,
                    transition: 'all 140ms ease',
                    ...(isSelected
                      ? { background: 'var(--ink)', color: 'var(--paper)' }
                      : isCurrent
                        ? { background: 'var(--accent-soft)', color: 'var(--ink)', border: '1px solid var(--accent)' }
                        : { background: 'transparent', color: 'var(--ink-3)' }),
                  }}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
