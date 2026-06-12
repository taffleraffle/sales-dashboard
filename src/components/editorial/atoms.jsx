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

// level: 'page' = serif h1 (36px) for top-of-page; 'section' = sans h2 (18px) for sections inside.
export function SectionHead({ eyebrow, title, italicWord, tagline, right, gap = 16, level = 'section' }) {
  const isPage = level === 'page'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      // flexWrap: callers stack 200-300px button clusters in the right
      // slot; without wrap the title column collapses to ~70px on phones.
      gap: 24, marginBottom: gap, flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow && <Eyebrow style={{ marginBottom: isPage ? 8 : 6 }}>{eyebrow}</Eyebrow>}
        {isPage ? (
          <h1 style={{
            margin: 0, fontSize: 36, lineHeight: 1.05, color: 'var(--ink)',
            letterSpacing: '-0.015em', fontFamily: 'var(--serif)', fontWeight: 500,
          }}>
            <SerifWithItalic text={title} italicWord={italicWord} />
          </h1>
        ) : (
          <h2 style={{
            margin: 0, fontSize: 18, lineHeight: 1.2, color: 'var(--ink)',
            letterSpacing: '-0.005em', fontFamily: 'var(--sans)', fontWeight: 600,
          }}>
            {title}
          </h2>
        )}
        {tagline && (
          <p style={{
            margin: isPage ? '8px 0 0' : '4px 0 0',
            color: 'var(--ink-3)',
            fontSize: isPage ? 15 : 13,
            maxWidth: 720, lineHeight: 1.5,
            fontFamily: 'var(--sans)',
          }}>{tagline}</p>
        )}
      </div>
      {/* marginLeft:auto keeps the action cluster right-aligned even when
          flexWrap pushes it onto its own line (space-between only spreads
          items sharing a line). */}
      {right && <div style={{ flexShrink: 0, marginLeft: 'auto' }}>{right}</div>}
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

// ─── PALETTE — base hues (ported from design palette.jsx) ──────────────
export const PALETTE = {
  red: '#b53e3e', redDeep: '#8c2c2c',
  amber: '#d97f1e', amberLight: '#e4a23c',
  green: '#3e8a5e', greenDeep: '#2a6a45',
  purple: '#6b4ba0', purpleDeep: '#4a2f78',
  teal: '#0e7c86', tealDeep: '#085a62',
  blue: '#1f4a8b', blueLight: '#3068b5',
  orange: '#b86a0c', orangeDeep: '#8e510a',
  gold: '#8c6f20',
  ink: '#0a0a0a', ink3: '#5a5650', ink4: '#88847e',
}

// Per-attribute value colors — every value gets a consistent hue across pages
export const VALUE_COLORS = {
  message_frame: {
    problem: PALETTE.red, circumstance: PALETTE.amber, outcome: PALETTE.green,
    PROBLEM: PALETTE.red, CIRCUMSTANCE: PALETTE.amber, OUTCOME: PALETTE.green,
  },
  hook_type: {
    question: PALETTE.teal, scene: PALETTE.purple, dollar_pain: PALETTE.orange,
    diagnostic: PALETTE.blue, conditional: PALETTE.red,
  },
  mechanism_reveal: {
    gated: PALETTE.purple, explicit: PALETTE.green, hidden: PALETTE.ink3,
    GATED: PALETTE.purple, EXPLICIT: PALETTE.green, HIDDEN: PALETTE.ink3,
  },
  funnel_stage: {
    tof: PALETTE.teal, mof: PALETTE.orange, bof: PALETTE.purple, cross: PALETTE.ink4,
    TOF: PALETTE.teal, MOF: PALETTE.orange, BOF: PALETTE.purple, CROSS: PALETTE.ink4,
  },
  format: {
    talking_head: PALETTE.ink, ugc: PALETTE.teal, comparative: PALETTE.orange,
    voiceover: PALETTE.purple,
  },
  awareness_level: {
    unaware: PALETTE.ink4, problem_aware: PALETTE.red, solution_aware: PALETTE.amber,
    product_aware: PALETTE.teal, most_aware: PALETTE.green,
  },
  length_bucket: {
    under_60s: PALETTE.teal, '60_75s': PALETTE.green, '75s_plus': PALETTE.amber,
    'sixty_75s': PALETTE.green,
  },
  proof_character: {
    eric: PALETTE.red, adam: PALETTE.teal, belinda: PALETTE.orange,
    morgan: PALETTE.green, karen: PALETTE.purple, derek: PALETTE.gold,
    mike: PALETTE.blue, none: PALETTE.ink4,
  },
  pain_angle: {
    phone_not_ringing: PALETTE.red, agency_burn: PALETTE.orange,
    tpa_referral_dep: PALETTE.purple, capacity_mismatch: PALETTE.teal,
    lead_platform: PALETTE.blue, storm_seasonal: PALETTE.amber,
    guarantee_proof: PALETTE.green, founder_identity: PALETTE.redDeep,
    adjuster_relations: PALETTE.gold, commercial_tier: PALETTE.tealDeep,
    last_objection: PALETTE.purpleDeep, speed_timeline: PALETTE.orangeDeep,
    seasonal: PALETTE.amberLight,
  },
  actor: {
    ben: PALETTE.ink, austin: PALETTE.teal, client: PALETTE.green,
    voiceover_only: PALETTE.purple, other: PALETTE.ink4,
  },
  vertical: {
    restoration: PALETTE.red, plumbing: PALETTE.teal, roofing: PALETTE.purple,
  },
}

export function attrColor(attr, value) {
  if (!attr || !value) return PALETTE.ink4
  const a = VALUE_COLORS[attr]
  if (!a) return PALETTE.ink4
  return a[value] || a[String(value).toLowerCase()] || PALETTE.ink4
}

// hex → rgba helper for tinted backgrounds
export function tint(hex, alpha = 0.12) {
  if (!hex || !hex.startsWith('#')) return `rgba(0,0,0,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// Display labels — title-case + custom overrides
const CUSTOM_LABELS = {
  tof: 'TOF', mof: 'MOF', bof: 'BOF', cross: 'Cross', ugc: 'UGC',
  tpa_referral_dep: 'TPA Referral', phone_not_ringing: 'Phone Not Ringing',
  agency_burn: 'Agency Burn', capacity_mismatch: 'Capacity Mismatch',
  lead_platform: 'Lead Platform', storm_seasonal: 'Storm Season',
  guarantee_proof: 'Guarantee Proof', founder_identity: 'Founder Identity',
  adjuster_relations: 'Adjuster Relations', commercial_tier: 'Commercial Tier',
  last_objection: 'Last Objection', speed_timeline: 'Speed Timeline',
  talking_head: 'Talking Head', dollar_pain: 'Dollar Pain',
  problem_aware: 'Problem-Aware', solution_aware: 'Solution-Aware',
  product_aware: 'Product-Aware', most_aware: 'Most-Aware',
  under_60s: 'Under 60s', '60_75s': '60–75s', '75s_plus': '75s+',
  sixty_75s: '60–75s',
  voiceover_only: 'Voiceover Only',
}

export function displayValue(value) {
  if (!value) return '—'
  const k = String(value)
  if (CUSTOM_LABELS[k]) return CUSTOM_LABELS[k]
  if (CUSTOM_LABELS[k.toLowerCase()]) return CUSTOM_LABELS[k.toLowerCase()]
  return k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ─── ValueChip — colored attribute-value chip ─────────────────────────
// Replaces neutral Pill for attribute values; colored dot + tinted bg
export function ValueChip({ attr, value, size = 'sm', showAttr = false, dot = true, truncate = false, style }) {
  if (!value) return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)' }}>—</span>
  const color = attrColor(attr, value)
  const label = displayValue(value)
  const sizes = {
    xs: { padding: '1px 6px 1px 6px', fontSize: 10, dotSize: 5 },
    sm: { padding: '2px 8px 2px 7px', fontSize: 10.5, dotSize: 6 },
    md: { padding: '4px 10px 4px 9px', fontSize: 11.5, dotSize: 7 },
  }
  const s = sizes[size]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: s.padding,
      background: tint(color, 0.1),
      color: color,
      border: `1px solid ${tint(color, 0.22)}`,
      borderRadius: 2,
      fontFamily: 'var(--mono)',
      fontVariantNumeric: 'tabular-nums',
      fontSize: s.fontSize, fontWeight: 600,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      maxWidth: truncate ? '100%' : undefined,
      overflow: truncate ? 'hidden' : 'visible',
      ...style,
    }}>
      {dot && <span style={{
        width: s.dotSize, height: s.dotSize, borderRadius: s.dotSize,
        background: color, flexShrink: 0,
      }} />}
      {showAttr && (
        <span style={{ opacity: 0.65, fontWeight: 500, marginRight: 2,
                       textTransform: 'uppercase', fontSize: s.fontSize - 1 }}>
          {String(attr).split('_')[0]}
        </span>
      )}
      <span style={truncate ? { overflow: 'hidden', textOverflow: 'ellipsis' } : undefined}>{label}</span>
    </span>
  )
}

// ─── LiftBadge — green/red arrow + value ──────────────────────────────
export function LiftBadge({ lift, size = 'md' }) {
  if (lift == null || isNaN(lift)) return null
  const positive = lift >= 0
  const sizes = {
    sm: { font: 13, arrow: 10 },
    md: { font: 18, arrow: 12 },
    lg: { font: 28, arrow: 16 },
  }
  const s = sizes[size]
  const color = positive ? '#3e8a5e' : '#b53e3e'
  return (
    <span style={{
      fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums',
      fontSize: s.font, fontWeight: 500, color,
      letterSpacing: '-0.01em',
      display: 'inline-flex', alignItems: 'center', gap: 3,
    }}>
      <svg width={s.arrow} height={s.arrow} viewBox="0 0 16 16" fill="none"
           style={{ transform: positive ? 'none' : 'rotate(180deg)' }}>
        <path d="M8 3v10M4 7l4-4 4 4" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {Math.abs(lift).toFixed(1)}%
    </span>
  )
}

// ─── TrendDelta — tiny inline trend chip (+0.6pt vs prior 30d) ────────
export function TrendDelta({ dir = 'flat', label, color }) {
  const fallback = dir === 'up' ? '#3e8a5e' : dir === 'down' ? '#b53e3e' : 'var(--ink-4)'
  const c = color || fallback
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      color: c,
    }}>
      {dir === 'up' && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {dir === 'down' && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {label}
    </span>
  )
}

// ─── WinnerBadge — punchier than plain accent pill ────────────────────
export function WinnerBadge({ size = 'md', muted = false }) {
  const sizes = {
    sm: { padding: '3px 8px', fontSize: 9.5, icon: 8 },
    md: { padding: '4px 10px', fontSize: 10.5, icon: 10 },
    lg: { padding: '5px 12px', fontSize: 12, icon: 12 },
  }
  const s = sizes[size]
  if (muted) {
    return (
      <span style={{
        fontFamily: 'var(--mono)', padding: s.padding,
        fontSize: s.fontSize, fontWeight: 600,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        background: 'transparent', color: 'var(--ink)',
        border: '1px solid var(--ink)',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>Winner</span>
    )
  }
  return (
    <span style={{
      fontFamily: 'var(--mono)', padding: s.padding,
      fontSize: s.fontSize, fontWeight: 700,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      background: 'var(--accent)', color: 'var(--ink)',
      border: '1px solid var(--accent-2)',
      boxShadow: '0 1px 0 rgba(10,10,10,0.06)',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      <svg width={s.icon} height={s.icon} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1l1.85 4.6L14.5 6.3l-3.4 3.3.85 4.8L8 12l-3.95 2.4.85-4.8L1.5 6.3l4.65-.7L8 1z" />
      </svg>
      Winner
    </span>
  )
}

// ─── PodiumRank — gold/silver/bronze rank badge ───────────────────────
export function PodiumRank({ rank, size = 'md' }) {
  const sizes = { sm: 22, md: 28, lg: 36 }
  const w = sizes[size]
  const isPodium = rank <= 3
  if (!isPodium) {
    return (
      <span style={{
        fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
        fontSize: w * 0.5, color: 'var(--ink-5)',
        display: 'inline-block', width: w, textAlign: 'center',
      }}>{String(rank).padStart(2, '0')}</span>
    )
  }
  const color = rank === 1 ? 'var(--accent)' : rank === 2 ? '#dcd6c4' : '#e8d2a8'
  const isFirst = rank === 1
  return (
    <span style={{
      display: 'inline-grid', placeItems: 'center',
      width: w, height: w, background: color, color: 'var(--ink)',
      border: isFirst ? '1px solid var(--accent-2)' : '1px solid var(--rule-2)',
      fontFamily: 'var(--serif)', fontStyle: 'italic',
      fontSize: w * 0.5, fontWeight: 500,
      boxShadow: isFirst ? '0 1px 0 rgba(10,10,10,0.06)' : 'none',
    }}>{rank}</span>
  )
}
