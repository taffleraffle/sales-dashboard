import { Link } from 'react-router-dom'
import { ArrowUpRight, Trophy } from 'lucide-react'

/*
  House table for people and lists (Overview boards, Closers, Setters).

  One pattern everywhere:
    - white 22px card, title strip with an optional "View all" pill
    - uppercase muted headers, hairline rows, 48px row height
    - rank badge + initials avatar + name in the first column
    - numbers right-aligned in Inter Tight tabular figures, never the serif
    - optional footer row (team total) on a soft yellow wash
    - optional per-cell status colour via `tone(value, row)` on a column

  columns: [{ key, label, align: 'left'|'right', width, render(row), tone(row) -> 'good'|'warn'|'bad'|null, strong }]
*/

export function initialsOf(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/)
  return parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const TONE = {
  good: 'var(--house-good)',
  warn: 'var(--house-warn)',
  bad:  'var(--house-bad)',
}

export function Rank({ n }) {
  const first = n === 1
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: 999, flex: 'none',
      background: first ? 'var(--accent)' : '#ffffff',
      border: `1px solid ${first ? 'var(--accent)' : 'var(--rule)'}`,
      fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 700, color: 'var(--ink)',
    }}>{first ? <Trophy size={12} /> : n}</span>
  )
}

export function Person({ name, sub, rank }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {rank != null && <Rank n={rank} />}
      <span style={{
        width: 30, height: 30, borderRadius: 10, flex: 'none',
        background: 'rgba(244,225,74,.55)', color: 'var(--ink)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11.5, fontWeight: 700,
      }}>{initialsOf(name)}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        {sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>{sub}</span>}
      </span>
    </span>
  )
}

export function Card({ title, count, to, right, children, flush = true }) {
  return (
    <div className="tile" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {(title || right || to) && (
        <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--rule)' }}>
          <h2 className="editorial-panel-title" style={{ margin: 0 }}>
            {title}{count != null && <span style={{ fontFamily: 'var(--sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-4)', marginLeft: 10 }}>{count}</span>}
          </h2>
          <div className="flex items-center gap-2">
            {right}
            {to && (
              <Link to={to} className="editorial-btn-ghost" style={{ height: 34, padding: '0 14px', fontSize: 12.5 }}>
                View all <ArrowUpRight size={12} />
              </Link>
            )}
          </div>
        </div>
      )}
      <div style={{ padding: flush ? 0 : 20 }} className={flush ? 'overflow-x-auto' : ''}>{children}</div>
    </div>
  )
}

export function Empty({ children }) {
  return <p style={{ margin: 0, padding: '28px 20px', fontSize: 13.5, color: 'var(--ink-4)', textAlign: 'center' }}>{children}</p>
}

export default function LeaderTable({ columns, rows, footer, rowKey = (r) => r.id, onRowClick, highlightFirst = true, empty = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) return <Empty>{empty}</Empty>
  const cell = (col, row, isFooter) => {
    const raw = col.render ? col.render(row, isFooter) : row[col.key]
    const tone = !isFooter && col.tone ? col.tone(row) : null
    return (
      <td key={col.key} className={col.align === 'right' ? 'num' : ''} style={{
        textAlign: col.align === 'right' ? 'right' : 'left',
        fontWeight: col.strong ? 700 : (isFooter ? 600 : 500),
        color: tone ? TONE[tone] : 'var(--ink)',
        whiteSpace: 'nowrap',
        width: col.width,
      }}>{raw ?? '—'}</td>
    )
  }
  return (
    <table className="house-table">
      <thead>
        <tr>{columns.map(c => (
          <th key={c.key} className={c.align === 'right' ? 'num' : ''} style={{ textAlign: c.align === 'right' ? 'right' : 'left', width: c.width }}>{c.label}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i) ?? i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`${onRowClick ? 'cursor-pointer' : ''} ${highlightFirst && i === 0 ? 'bg-opt-yellow-subtle' : ''}`}>
            {columns.map(c => cell(c, { ...row, _rank: i + 1 }, false))}
          </tr>
        ))}
      </tbody>
      {footer && (
        <tfoot><tr>{columns.map(c => cell(c, footer, true))}</tr></tfoot>
      )}
    </table>
  )
}
