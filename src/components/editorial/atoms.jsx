import { useState } from 'react'

/*
  Editorial design system atoms — port from the Claude Design handoff
  for the Insights / Generate / Creatives pages.

  Source of truth: design-pkg/ad-performance/project/lib.jsx
  Tokens: src/index.css (--paper, --ink, --accent, --rule, frame-*)
*/

// ─── Eyebrow + SectionHead ─────────────────────────────────────────────
export function Eyebrow({ children, style }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500,
      letterSpacing: '0.14em', textTransform: 'uppercase',
      color: 'var(--ink-3)',
      ...style,
    }}>{children}</div>
  )
}

export function SerifWithItalic({ text, italicWord }) {
  if (!italicWord) return text
  const idx = text.toLowerCase().indexOf(italicWord.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <em>{text.slice(idx, idx + italicWord.length)}</em>
      {text.slice(idx + italicWord.length)}
    </>
  )
}

export function SectionHead({ eyebrow, title, italicWord, tagline, right, gap = 16 }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 24, marginBottom: gap,
    }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow && <Eyebrow style={{ marginBottom: 8 }}>{eyebrow}</Eyebrow>}
        <h2 style={{
          margin: 0, fontSize: 34, lineHeight: 1.05, color: 'var(--ink)',
          letterSpacing: '-0.015em', fontFamily: 'var(--serif)', fontWeight: 400,
        }}>
          <SerifWithItalic text={title} italicWord={italicWord} />
        </h2>
        {tagline && (
          <p style={{
            margin: '8px 0 0', fontStyle: 'italic', color: 'var(--ink-3)',
            fontSize: 16, maxWidth: 640, lineHeight: 1.45,
            fontFamily: 'var(--serif)',
          }}>{tagline}</p>
        )}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  )
}

// ─── Buttons ───────────────────────────────────────────────────────────
const btnBase = {
  fontFamily: 'var(--sans)',
  fontSize: 13, fontWeight: 500, letterSpacing: '-0.005em',
  padding: '9px 14px',
  border: '1px solid transparent',
  borderRadius: 2,
  display: 'inline-flex', alignItems: 'center', gap: 8,
  transition: 'background 0.12s cubic-bezier(0.2,0.7,0.2,1), border 0.12s cubic-bezier(0.2,0.7,0.2,1)',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export function Button({ children, variant = 'secondary', onClick, leftIcon, rightIcon, size = 'md', disabled, style, type = 'button' }) {
  const sizeStyle = size === 'sm' ? { padding: '6px 10px', fontSize: 12 } : {}
  const variants = {
    primary:   { background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' },
    accent:    { background: 'var(--accent)', color: 'var(--ink)', borderColor: 'var(--accent-2)' },
    secondary: { background: 'transparent', color: 'var(--ink)', borderColor: 'var(--ink-3)' },
    ghost:     { background: 'transparent', color: 'var(--ink-2)', borderColor: 'transparent' },
    danger:    { background: 'transparent', color: '#b53e3e', borderColor: '#b53e3e' },
  }
  const hover = {
    primary:   { background: 'var(--ink-2)' },
    accent:    { background: 'var(--accent-2)' },
    secondary: { background: 'var(--paper-2)' },
    ghost:     { background: 'var(--paper-2)' },
    danger:    { background: 'rgba(181,62,62,0.06)' },
  }
  const [h, setH] = useState(false)
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        ...btnBase, ...sizeStyle, ...variants[variant],
        ...(h && !disabled ? hover[variant] : {}),
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}>
      {leftIcon}{children}{rightIcon}
    </button>
  )
}

// ─── Pill / chip ───────────────────────────────────────────────────────
export function Pill({ children, tone = 'default', size = 'sm', uppercase = false, dot, style }) {
  const tones = {
    default: { bg: 'var(--paper-2)', fg: 'var(--ink-2)', bd: 'var(--rule)' },
    ink:     { bg: 'var(--ink)', fg: 'var(--paper)', bd: 'var(--ink)' },
    accent:  { bg: 'var(--accent)', fg: 'var(--ink)', bd: 'var(--accent-2)' },
    ghost:   { bg: 'transparent', fg: 'var(--ink-3)', bd: 'var(--rule)' },
    red:     { bg: 'transparent', fg: '#b53e3e', bd: 'rgba(181,62,62,0.3)' },
    amber:   { bg: 'transparent', fg: '#b86a0c', bd: 'rgba(184,106,12,0.3)' },
    green:   { bg: 'transparent', fg: '#3e8a5e', bd: 'rgba(62,138,94,0.3)' },
    purple:  { bg: 'transparent', fg: '#5b3a8f', bd: 'rgba(91,58,143,0.3)' },
    teal:    { bg: 'transparent', fg: '#0e7c86', bd: 'rgba(14,124,134,0.3)' },
  }
  const t = tones[tone] || tones.default
  const sizes = {
    xs: { padding: '1px 6px', fontSize: 9.5 },
    sm: { padding: '2px 8px', fontSize: 10.5 },
    md: { padding: '4px 10px', fontSize: 11.5 },
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      borderRadius: 2, fontWeight: 500,
      letterSpacing: uppercase ? '0.06em' : '0.02em',
      textTransform: uppercase ? 'uppercase' : 'none',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--mono)',
      fontVariantNumeric: 'tabular-nums',
      ...sizes[size], ...style,
    }}>
      {dot && <span style={{
        width: 5, height: 5, borderRadius: 5, background: dot, flexShrink: 0,
      }} />}
      {children}
    </span>
  )
}

// ─── Card ──────────────────────────────────────────────────────────────
export function Card({ children, accent, accentSide = 'top', padding = 20, style, hoverable, onClick }) {
  const [h, setH] = useState(false)
  const accentStyle = accent ? (
    accentSide === 'top'
      ? { borderTop: `3px solid ${accent}`, paddingTop: padding - 3 }
      : { borderLeft: `3px solid ${accent}`, paddingLeft: padding - 3 }
  ) : {}
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => hoverable && setH(true)}
      onMouseLeave={() => hoverable && setH(false)}
      style={{
        background: 'white',
        border: '1px solid var(--rule)',
        padding,
        transition: 'box-shadow 0.16s cubic-bezier(0.2,0.7,0.2,1), border 0.16s cubic-bezier(0.2,0.7,0.2,1)',
        boxShadow: h ? '0 2px 4px rgba(10,10,10,0.05), 0 8px 24px rgba(10,10,10,0.06)' : '0 1px 0 rgba(10,10,10,0.02), 0 1px 2px rgba(10,10,10,0.03)',
        cursor: onClick ? 'pointer' : 'default',
        ...accentStyle, ...style,
      }}>
      {children}
    </div>
  )
}

// ─── Sparkline (inline SVG) ───────────────────────────────────────────
export function Sparkline({ values, width = 80, height = 24, stroke = 'var(--ink)', fill, accent }) {
  if (!values || !values.length) return null
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const stepX = width / (values.length - 1 || 1)
  const points = values.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * (height - 4) - 2
    return [x, y]
  })
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const dFill = `${d} L${width},${height} L0,${height} Z`
  const last = points[points.length - 1]
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {fill && <path d={dFill} fill={fill} />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" />
      {accent && last && (
        <circle cx={last[0]} cy={last[1]} r={2.5} fill={accent} stroke="var(--ink)" strokeWidth={1} />
      )}
    </svg>
  )
}

// ─── BigNumber — serif tabular-nums for KPI values ─────────────────────
export function BigNumber({ value, suffix = '', prefix = '', size = 64, weight = 400, color = 'var(--ink)' }) {
  return (
    <span style={{
      fontFamily: 'var(--serif)',
      fontVariantNumeric: 'tabular-nums',
      fontSize: size, lineHeight: 1, fontWeight: weight, color,
      letterSpacing: '-0.025em',
      display: 'inline-flex', alignItems: 'baseline',
    }}>
      {prefix && <span style={{ fontSize: size * 0.5, color: 'var(--ink-3)', marginRight: 2 }}>{prefix}</span>}
      {value}
      {suffix && <span style={{ fontSize: size * 0.4, color: 'var(--ink-3)', marginLeft: 4 }}>{suffix}</span>}
    </span>
  )
}

// ─── Format helpers ────────────────────────────────────────────────────
export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `$${Math.round(n)}`
}
export function fmtMoneyFull(n) {
  if (n == null || isNaN(n)) return '—'
  return `$${Math.round(n).toLocaleString()}`
}
export function fmtNum(n) {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString()
}
export function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '—'
  return `${n.toFixed(d)}%`
}
export function fmtLift(n, d = 1) {
  if (n == null || isNaN(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`
}
export function humanAttr(s) {
  if (!s) return ''
  return s.replace(/_/g, ' ')
}
export function frameColor(frame) {
  return {
    problem: 'var(--frame-problem)',
    circumstance: 'var(--frame-circumstance)',
    outcome: 'var(--frame-outcome)',
    PROBLEM: 'var(--frame-problem)',
    CIRCUMSTANCE: 'var(--frame-circumstance)',
    OUTCOME: 'var(--frame-outcome)',
  }[frame] || 'var(--ink-3)'
}
export function frameTone(frame) {
  return { problem: 'red', circumstance: 'amber', outcome: 'green',
           PROBLEM: 'red', CIRCUMSTANCE: 'amber', OUTCOME: 'green' }[frame] || 'default'
}

// ─── Icon set (inline SVG, 1.5px stroke) ───────────────────────────────
export const Icon = {
  plus: (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
  tag: (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M2 2h6l6 6-6 6-6-6V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="5.5" cy="5.5" r="1" fill="currentColor" /></svg>,
  arrow: (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  arrowUp: (s = 12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  arrowDn: (s = 12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  edit: (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M2 14h12M10 3l3 3-7 7H3v-3l7-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>,
  x: (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
  external: (s = 12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M6 3H3v10h10v-3M9 3h4v4M9 7l4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  filter: (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
  check: (s = 12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  refresh: (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none"><path d="M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4M11 4h2.5V1.5M5 12H2.5V14.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
}

// ─── Deterministic thumb color from a seed ─────────────────────────────
export function thumbColor(seed) {
  const palette = ['#0e7c86', '#5b3a8f', '#b86a0c', '#3e8a5e', '#b53e3e', '#2a2825']
  const h = typeof seed === 'string'
    ? seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    : (seed || 0)
  return palette[h % palette.length]
}
