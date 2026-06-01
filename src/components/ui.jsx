/**
 * Shared design primitives — Apple-system, hairlines, no chrome.
 *
 * These are the building blocks for the redesigned admin dashboard.
 * Use them in every page so the design stays consistent.
 *
 * Tokens come from src/index.css (--color-ink, --color-hairline, etc.)
 */

import { Link } from 'react-router-dom'

export const ink   = 'var(--color-ink)'
export const ink2  = 'var(--color-ink-2)'
export const ink3  = 'var(--color-ink-3)'
export const ink4  = 'var(--color-ink-4)'
export const hair  = '1px solid var(--color-hairline)'
export const hair2 = '1px solid var(--color-hairline-2)'
export const accent = 'var(--color-accent)'
export const pos    = 'var(--color-pos)'
export const neg    = 'var(--color-neg)'
export const fontDisplay = 'var(--font-display)'

export const fmt$    = (n) => `$${Math.round(n || 0).toLocaleString()}`
export const fmtPct  = (n, d = 1) => `${(n || 0).toFixed(d)}%`
export const fmtNum  = (n) => (n || 0).toLocaleString()

/* ================================================================
   PageShell — full-bleed page wrapper. Use as outermost <PageShell>
   to get correct background + max-width section grammar.
   ================================================================ */
export function PageShell({ children }) {
  return <div style={{ background: 'var(--color-bg)', minHeight: '100vh' }}>{children}</div>
}

/* ================================================================
   PageHeader — quiet title + optional date scope / right action.
   Lives at the top of pages without a black hero.
   ================================================================ */
export function PageHeader({ title, eyebrow, action, children }) {
  return (
    <div style={{
      maxWidth: 1240, margin: '0 auto', padding: '32px 28px',
      borderBottom: hair,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 22 }}>
        <div>
          {eyebrow && <div style={{ fontSize: 12, color: ink2, marginBottom: 4 }}>{eyebrow}</div>}
          <h1 className="font-display" style={{
            fontSize: 28, fontWeight: 600, letterSpacing: '-0.025em',
            lineHeight: 1.05, color: ink, margin: 0,
          }}>
            {title}
          </h1>
        </div>
        {action && <div>{action}</div>}
      </div>
      {children && <div style={{ marginTop: 22 }}>{children}</div>}
    </div>
  )
}

/* ================================================================
   BrandedHero — sage gradient anchor for any page header.
   Renders eyebrow + title + sub-line + right-side action.
   Use across all pages so brand stays consistent.
   ================================================================ */
export function BrandedHero({ eyebrow, title, sub, action, padTop = 72, padBottom = 64 }) {
  return (
    <section style={{
      background: 'linear-gradient(135deg, #1F4D3C 0%, #0F2E22 100%)',
      color: '#FAF8F2', padding: `${padTop}px 28px ${padBottom}px`, borderBottom: hair,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: -80, right: -80, width: 320, height: 320,
        background: 'radial-gradient(circle, rgba(58,110,90,0.45) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{ maxWidth: 1240, margin: '0 auto', position: 'relative' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 18, flexWrap: 'wrap', marginBottom: eyebrow ? 18 : 0,
        }}>
          {eyebrow && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.22em', textTransform: 'uppercase',
              color: 'rgba(250,248,242,0.55)',
            }}>{eyebrow}</div>
          )}
          {action && <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>{action}</div>}
        </div>
        <h1 className="font-display" style={{
          fontSize: 'clamp(40px, 5vw, 64px)', fontWeight: 800,
          letterSpacing: '-0.045em', lineHeight: 0.95, margin: 0, color: '#FAF8F2',
        }}>
          {title}
        </h1>
        {sub && (
          <div style={{ marginTop: 14, fontSize: 14, color: 'rgba(250,248,242,0.7)' }}>
            {sub}
          </div>
        )}
      </div>
    </section>
  )
}

/* ================================================================
   Hero — black canvas with one anchor metric. Reserved for
   pages where there's a single number that owns the page.
   ================================================================ */
export function Hero({ scope, label, figure, delta, sub, children }) {
  return (
    <section style={{ background: 'linear-gradient(135deg, #1F4D3C 0%, #0F2E22 100%)', color: '#FAF8F2', padding: '96px 28px 88px', borderBottom: hair }}>
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>
        {scope && <div style={{ marginLeft: -8, marginBottom: 14 }}>{scope}</div>}
        {label && (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{label}</div>
        )}
        {figure && (
          <div className="font-display num" style={{
            fontSize: 'clamp(72px, 9.5vw, 128px)', fontWeight: 600,
            letterSpacing: '-0.045em', lineHeight: 0.94, marginTop: 4,
          }}>
            {figure}
          </div>
        )}
        {delta && (
          <div className="font-display" style={{
            fontSize: 19, fontWeight: 500, color: 'rgba(255,255,255,0.78)',
            letterSpacing: '-0.012em', marginTop: 22,
          }}>
            {delta}
          </div>
        )}
        {sub && (
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14, marginTop: 8 }}>
            {sub}
          </div>
        )}
        {children}
      </div>
    </section>
  )
}

/* ================================================================
   Section — h2 + content, hairline divider. The default container
   for a page's body sections. `alt` switches to off-white background.
   ================================================================ */
export function Section({ title, action, children, alt = false, padTop = 56, padBottom = 56 }) {
  return (
    <section style={{ borderBottom: hair, background: alt ? 'var(--color-bg-alt)' : 'var(--color-bg)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: `${padTop}px 28px ${padBottom}px` }}>
        {title && (
          <h2 className="font-display" style={{
            fontSize: 22, fontWeight: 500, letterSpacing: '-0.022em',
            marginBottom: 22, display: 'flex', alignItems: 'baseline',
            justifyContent: 'space-between', gap: 18,
          }}>
            <span>{title}</span>
            {action && <span style={{ font: '400 13px var(--font-sans)', color: ink2 }}>{action}</span>}
          </h2>
        )}
        {children}
      </div>
    </section>
  )
}

/* ================================================================
   StripCell — one cell in a horizontal KPI strip. Used after Hero.
   ================================================================ */
export function StripCell({ label, value, ctx, first, delta }) {
  return (
    <div style={{ padding: '0 32px', borderLeft: first ? 0 : hair2, ...(first ? { paddingLeft: 0 } : {}) }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
        letterSpacing: '0.18em', textTransform: 'uppercase', color: ink2,
      }}>{label}</div>
      <div className="font-display num" style={{
        fontSize: 42, fontWeight: 800, letterSpacing: '-0.038em',
        lineHeight: 1, marginTop: 12, color: ink,
        fontFeatureSettings: '"tnum"',
      }}>
        {value}
        {delta && <span style={{ fontSize: 12, marginLeft: 8, verticalAlign: 'middle' }}>{delta}</span>}
      </div>
      {ctx && <div style={{
        fontSize: 11, color: ink2, marginTop: 10,
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>{ctx}</div>}
    </div>
  )
}

/* ================================================================
   KpiStrip — 2/3/4 column hairline-separated KPIs.
   `cells` = array of { label, value, ctx } objects.
   ================================================================ */
export function KpiStrip({ cells, columns }) {
  const cols = columns || cells.length
  return (
    <div style={{ borderBottom: hair }}>
      <div style={{
        maxWidth: 1240, margin: '0 auto', padding: '32px 28px',
        display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 0,
      }}>
        {cells.map((c, i) => <StripCell key={c.label} {...c} first={i === 0} />)}
      </div>
    </div>
  )
}

/* ================================================================
   PaneStat — small KPI used inside a section (not the top strip).
   ================================================================ */
export function PaneStat({ label, v, accent: accentColor, big, sub }) {
  return (
    <div style={{ paddingRight: 14 }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500,
        letterSpacing: '0.18em', textTransform: 'uppercase', color: ink2,
      }}>{label}</div>
      <div className="font-display num" style={{
        fontSize: big ? 36 : 26, fontWeight: 700,
        letterSpacing: big ? '-0.035em' : '-0.025em',
        lineHeight: 1, marginTop: big ? 8 : 6,
        color: accentColor ? accentColor : ink,
        fontFeatureSettings: '"tnum"',
      }}>{v}</div>
      {sub && <div style={{
        fontSize: 11, color: ink2, marginTop: 6,
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>{sub}</div>}
    </div>
  )
}

/* ================================================================
   RowStat — vertical-list stat with label / value / sub.
   Used in side panels next to charts.
   ================================================================ */
export function RowStat({ label, value, sub }) {
  return (
    <div style={{
      padding: '18px 0', borderBottom: hair2,
      display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'baseline', rowGap: 4,
    }}>
      <div style={{ fontSize: 12, color: ink2 }}>{label}</div>
      <div className="font-display" style={{ fontSize: 19, fontWeight: 500, letterSpacing: '-0.018em' }}>{value}</div>
      {sub && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: ink3 }}>{sub}</div>}
    </div>
  )
}

/* ================================================================
   Table primitives — borderless, hairline rows, tabular nums.
   ================================================================ */
export function Th({ children, right }) {
  return (
    <th style={{
      textAlign: right ? 'right' : 'left', padding: '12px 14px',
      fontWeight: 500, fontSize: 12, color: ink2, letterSpacing: '-0.005em',
      borderBottom: hair2,
    }}>{children}</th>
  )
}

export function Td({ children, right, v, lg, color }) {
  return (
    <td style={{
      textAlign: right ? 'right' : 'left',
      padding: '18px 14px', borderBottom: hair2, fontSize: 14,
      color: color || ink, letterSpacing: '-0.005em',
      ...(v ? { fontFamily: fontDisplay, fontWeight: 500, letterSpacing: '-0.012em' } : {}),
      ...(lg ? { fontSize: 17 } : {}),
    }}>{children}</td>
  )
}

export function EmptyRow({ children, span }) {
  return (
    <tr><td colSpan={span} style={{ padding: '32px 14px', textAlign: 'center', fontSize: 13, color: ink2 }}>{children}</td></tr>
  )
}

export function DataTable({ children }) {
  return <table className="list" style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
}

/* ================================================================
   Chip — used for EOD compliance, status pills, etc.
   ================================================================ */
export function Chip({ name, meta, pending, color }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', border: hair, borderRadius: 99,
      fontSize: 13, color: pending ? ink3 : (color || ink),
    }}>
      <span style={{ fontWeight: 500, letterSpacing: '-0.005em' }}>{name}</span>
      {meta && <span style={{ color: ink2, fontSize: 12 }}>{meta}</span>}
    </div>
  )
}

/* ================================================================
   Spark — small bar sparkline. Pass values[]; auto-scaled.
   ================================================================ */
export function Spark({ values = [], up = false }) {
  if (!values.length) return <span style={{ color: ink3 }}>—</span>
  const max = Math.max(...values, 1)
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 18, verticalAlign: 'middle' }}>
      {values.map((v, i) => (
        <span
          key={i}
          style={{
            width: 3, height: `${Math.max((v / max) * 100, 8)}%`,
            background: up ? pos : ink4,
            borderRadius: 1,
          }}
        />
      ))}
    </span>
  )
}

/* ================================================================
   Button + IconButton — quiet defaults. Apple's are very plain.
   ================================================================ */
export function Button({ children, onClick, primary, danger, small, type = 'button', disabled }) {
  const bg = primary ? 'var(--color-accent)' : 'transparent'
  const color = primary ? '#FAF8F2' : (danger ? neg : ink)
  const border = primary ? '1px solid var(--color-accent)' : hair
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: bg,
        color,
        border,
        borderRadius: 8,
        padding: small ? '5px 12px' : '8px 16px',
        fontSize: small ? 12 : 13,
        fontWeight: 500,
        letterSpacing: '-0.005em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontFamily: 'inherit',
        transition: 'opacity 120ms',
      }}
    >
      {children}
    </button>
  )
}

/* ================================================================
   Card — soft container for grouped content.
   Use sparingly — Section is preferred. Card is for inside a Section.
   ================================================================ */
export function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--color-bg-alt)',
      border: hair,
      borderRadius: 12,
      ...style,
    }}>
      {children}
    </div>
  )
}

/* ================================================================
   AvatarMono — initials in a quiet circle. Used in tables for people.
   ================================================================ */
export function AvatarMono({ name, size = 28 }) {
  const initials = (name || '?').split(' ').filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase()
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: 'linear-gradient(135deg, #1F4D3C 0%, #0F2E22 100%)', color: '#FAF8F2',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.4), fontWeight: 700, letterSpacing: '-0.005em',
      flexShrink: 0, boxShadow: '0 1px 4px rgba(15,46,34,0.2)',
    }}>
      {initials}
    </span>
  )
}

/* ================================================================
   StealthLink — looks like text but navigates.
   ================================================================ */
export function StealthLink({ to, children, color }) {
  return (
    <Link to={to} style={{
      color: color || 'inherit',
      textDecoration: 'none',
      letterSpacing: '-0.005em',
    }}>{children}</Link>
  )
}

/* ================================================================
   Loading + Empty states
   ================================================================ */
export function Loading({ children = 'Loading…' }) {
  return (
    <div style={{ padding: '80px 28px', textAlign: 'center', color: ink2, fontSize: 14 }}>
      {children}
    </div>
  )
}

export function EmptyState({ children }) {
  return (
    <div style={{ padding: '40px 0', fontSize: 13, color: ink2, textAlign: 'left' }}>
      {children}
    </div>
  )
}

/* ================================================================
   Delta — ▲/▼ trend chip vs prior period.
     - For absolute counts/$, pass `pct` (percent change vs prior).
     - For rates already in %, pass `pts` (point delta — e.g. show% +3.2 pts).
     - `lowerIsBetter` flips sign coloring (e.g. for no-shows, CAC).
   Renders nothing when value is null (insufficient prior data).
   ================================================================ */
export function Delta({ pct, pts, lowerIsBetter = false, suffix }) {
  const v = pct ?? pts
  if (v === null || v === undefined || Number.isNaN(v)) return null
  if (Math.abs(v) < 0.5) return null
  const better = lowerIsBetter ? v < 0 : v > 0
  const arrow = v > 0 ? '↑' : '↓'   // mono symbols per brand kit (no triangles)
  const formatted = pct != null
    ? `${Math.abs(v).toFixed(0)}%`
    : `${Math.abs(v).toFixed(1)} pts`
  // Brand rule: up is sage, down is muted ink-2 (not aggressive clay/red).
  // Clay reserved for genuine critical states, not period deltas.
  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 10, fontWeight: 600, marginLeft: 8,
      color: better ? pos : ink2,
      letterSpacing: '0.06em',
    }}>
      {arrow} {formatted}{suffix ? ` ${suffix}` : ''}
    </span>
  )
}

/* ================================================================
   PaceBar — "you're on pace for X by month-end" forecast.
     props: { current, target, scope }
   Pace only makes sense when current = THIS month's cash so far.
   Pass scope='mtd' to show; anything else renders an explainer instead
   of a misleading extrapolation.
   ================================================================ */
export function PaceBar({ current = 0, target = 100000, scope }) {
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysElapsed = now.getDate()

  if (scope !== 'mtd') {
    return (
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '10px 0', borderBottom: hair2,
        fontSize: 12, letterSpacing: '-0.005em', color: ink3,
      }}>
        <div>Pace forecast available when viewing <span style={{ color: ink2 }}>Month to date</span></div>
      </div>
    )
  }

  const pace = daysElapsed > 0 ? (current / daysElapsed) * daysInMonth : 0
  const onTrack = pace >= target
  const gap = pace - target
  const remaining = daysInMonth - daysElapsed

  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: hair2,
      fontSize: 12, letterSpacing: '-0.005em',
    }}>
      <div style={{ color: ink2 }}>
        Pace: <span className="num" style={{ color: ink, fontWeight: 500 }}>${Math.round(pace).toLocaleString()}</span> by month-end
        <span style={{ color: ink3, marginLeft: 8 }}>
          · {daysElapsed} of {daysInMonth} days
        </span>
      </div>
      <div style={{ color: onTrack ? pos : neg, fontWeight: 500 }}>
        {onTrack
          ? `+$${Math.round(gap).toLocaleString()} above target`
          : `$${Math.round(Math.abs(gap)).toLocaleString()} short · ${remaining}d left`}
      </div>
    </div>
  )
}
