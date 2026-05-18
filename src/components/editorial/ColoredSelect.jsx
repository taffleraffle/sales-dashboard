import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { attrColor, displayValue, tint } from './atoms'

/*
  Custom dropdown for attribute values. Native <select> can't style
  individual <option> elements (most browsers ignore CSS), so this
  component renders its own list with proper colored dots + tinted
  selected backgrounds.

  Usage:
    <ColoredSelect attr="hook_type" value={attrs.hook_type}
                   options={vocabRows} onChange={v => handleChange('hook_type', v)} />

  options shape: [{ value: 'diagnostic', label: 'Diagnostic', description?: string }]

  Keeps the field visually associated with its color: selected value
  shows a colored dot in the field + colored left-stripe. Empty state
  is grey/neutral.
*/

export default function ColoredSelect({
  attr, value, options, onChange,
  placeholder = '—',
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  // Close on outside click + Esc
  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selectedColor = value ? attrColor(attr, value) : null
  const selectedLabel = value ? displayValue(value) : null

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
      {/* Field — colored dot + tinted background when a value is set */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        style={{
          width: '100%',
          padding: '8px 10px',
          paddingLeft: selectedColor ? 9 : 10,
          fontFamily: 'var(--sans)', fontSize: 13,
          textAlign: 'left',
          background: selectedColor ? tint(selectedColor, 0.08) : 'white',
          color: selectedColor ? selectedColor : (value ? 'var(--ink)' : 'var(--ink-4)'),
          fontWeight: selectedColor ? 600 : 400,
          border: '1px solid var(--rule)',
          borderLeft: selectedColor ? `3px solid ${selectedColor}` : '1px solid var(--rule)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.5 : 1,
        }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0,
        }}>
          {selectedColor && (
            <span style={{
              width: 8, height: 8, borderRadius: 8,
              background: selectedColor, flexShrink: 0,
            }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selectedLabel || placeholder}
          </span>
        </span>
        <ChevronDown size={14} color="var(--ink-4)" style={{ flexShrink: 0 }} />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          maxHeight: 320, overflowY: 'auto',
          background: 'white',
          border: '1px solid var(--rule)',
          boxShadow: '0 12px 28px rgba(10,10,10,0.14)',
          zIndex: 200,
        }}>
          {/* Clear option */}
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', textAlign: 'left',
              padding: '8px 12px',
              fontFamily: 'var(--sans)', fontSize: 13,
              color: 'var(--ink-4)', fontStyle: 'italic',
              background: !value ? 'var(--paper-2)' : 'transparent',
              border: 'none', borderBottom: '1px solid var(--rule)',
              cursor: 'pointer',
            }}>
            <span>— Clear —</span>
            {!value && <Check size={13} color="var(--ink-3)" />}
          </button>
          {options.map(o => {
            const color = attrColor(attr, o.value)
            const isSelected = o.value === value
            const label = o.label || displayValue(o.value)
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false) }}
                title={o.description}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 8,
                  width: '100%', textAlign: 'left',
                  padding: '8px 12px',
                  fontFamily: 'var(--sans)', fontSize: 13,
                  color: isSelected ? color : 'var(--ink-2)',
                  fontWeight: isSelected ? 600 : 400,
                  background: isSelected ? tint(color, 0.08) : 'transparent',
                  border: 'none',
                  borderLeft: isSelected ? `3px solid ${color}` : '3px solid transparent',
                  cursor: 'pointer',
                  transition: 'background 0.08s ease',
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--paper-2)' }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 10,
                  overflow: 'hidden', minWidth: 0,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 8, flexShrink: 0,
                    background: color,
                  }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {label}
                  </span>
                </span>
                {isSelected && <Check size={13} color={color} style={{ flexShrink: 0 }} />}
              </button>
            )
          })}
          {options.length === 0 && (
            <div style={{
              padding: 14, textAlign: 'center', fontFamily: 'var(--sans)', fontSize: 12,
              color: 'var(--ink-4)', fontStyle: 'italic',
            }}>
              No values defined yet.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
