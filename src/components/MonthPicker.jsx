import { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatMonth(value) {
  // value = "2026-03"
  const [y, m] = value.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export default function MonthPicker({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const [y, m] = value.split('-').map(Number)

  // Close on outside click
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

  // Sync viewYear when value changes
  useEffect(() => { setViewYear(y) }, [y])

  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const isCurrentMonth = value === currentMonth

  return (
    <div className="relative" ref={ref}>
      <div className="flex items-center gap-0.5 bg-bg-card border border-border-default rounded-xl p-1">
        {/* Prev month */}
        <button
          onClick={() => shift(-1)}
          disabled={disabled}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all disabled:opacity-30"
        >
          <ChevronLeft size={14} />
        </button>

        {/* Current month display / dropdown trigger */}
        <button
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
            isCurrentMonth
              ? 'bg-opt-yellow text-bg-primary shadow-sm'
              : 'text-text-primary hover:bg-bg-card-hover'
          }`}
        >
          <Calendar size={12} />
          {formatMonth(value)}
          <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {/* Next month */}
        <button
          onClick={() => shift(1)}
          disabled={disabled}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all disabled:opacity-30"
        >
          <ChevronRight size={14} />
        </button>

        {/* Quick: This month */}
        {!isCurrentMonth && (
          <button
            onClick={() => { onChange(currentMonth); setOpen(false) }}
            disabled={disabled}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all disabled:opacity-30 whitespace-nowrap"
          >
            This month
          </button>
        )}
      </div>

      {/* Month grid dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 bg-bg-card border border-border-default rounded-2xl p-4 shadow-xl shadow-black/40 w-64">
          {/* Year nav */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setViewYear(v => v - 1)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-sm font-medium text-text-primary">{viewYear}</span>
            <button
              onClick={() => setViewYear(v => v + 1)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {MONTH_NAMES.map((name, i) => {
              const monthVal = `${viewYear}-${String(i + 1).padStart(2, '0')}`
              const isSelected = monthVal === value
              const isCurrent = monthVal === currentMonth
              return (
                <button
                  key={name}
                  onClick={() => selectMonth(i)}
                  className={`px-2 py-2 rounded-lg text-[11px] font-medium transition-all duration-150 ${
                    isSelected
                      ? 'bg-opt-yellow text-bg-primary shadow-sm'
                      : isCurrent
                        ? 'bg-opt-yellow/15 text-opt-yellow border border-opt-yellow/30'
                        : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
                  }`}
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
