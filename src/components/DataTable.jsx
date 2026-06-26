import { useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

/*
  Editorial data table.
  Headers: mono UPPERCASE 10px, ink underline.
  Rows: hairline rule dividers, paper-2 hover wash.
  Numbers: serif tabular when col.align === 'right' or col.numeric === true.
*/

export default function DataTable({ columns, data, onRowClick, emptyMessage = 'No data' }) {
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  const handleSort = (key) => {
    if (sortCol === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  const sorted = sortCol
    ? [...data].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol]
        const cmp = typeof av === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''))
        return sortDir === 'asc' ? cmp : -cmp
      })
    : data

  return (
    <div
      className="overflow-x-auto"
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 10,
        background: 'var(--paper)',
      }}
    >
      <table className="data" style={{ minWidth: '100%' }}>
        <thead>
          <tr>
            {columns.map(col => {
              const sortable = col.sortable !== false
              const isNumeric = col.align === 'right' || col.numeric === true
              return (
                <th
                  key={col.key}
                  onClick={() => sortable && handleSort(col.key)}
                  style={{
                    cursor: sortable ? 'pointer' : 'default',
                    textAlign: isNumeric ? 'right' : 'left',
                    userSelect: sortable ? 'none' : 'auto',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {col.label}
                    {sortCol === col.key && (
                      sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
                    )}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '32px 12px',
                  textAlign: 'center',
                  color: 'var(--ink-3)',
                  fontFamily: 'var(--sans)', fontStyle: 'italic',
                  fontSize: 14,
                }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => (
              <tr
                key={row.id ?? i}
                onClick={() => onRowClick?.(row)}
                style={{
                  cursor: onRowClick ? 'pointer' : 'default',
                  transition: 'background 160ms ease',
                }}
              >
                {columns.map(col => {
                  const isNumeric = col.align === 'right' || col.numeric === true
                  const cellClass = isNumeric ? 'num' : (col.dim ? 'dim' : col.primary ? 'pri' : '')
                  return (
                    <td
                      key={col.key}
                      className={cellClass}
                      style={{ textAlign: isNumeric ? 'right' : 'left' }}
                    >
                      {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
