import { useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

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
    <div className="overflow-x-auto rounded-lg border border-border-default">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-bg-card">
            {columns.map(col => (
              <th
                key={col.key}
                onClick={() => col.sortable !== false && handleSort(col.key)}
                className={`text-left px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-400 font-medium ${
                  col.sortable !== false ? 'cursor-pointer hover:text-text-secondary select-none' : ''
                } ${col.align === 'right' ? 'text-right' : ''}`}
              >
                <span className="flex items-center gap-1">
                  {col.label}
                  {sortCol === col.key && (
                    sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-text-400">{emptyMessage}</td>
            </tr>
          ) : (
            sorted.map((row, i) => (
              <tr
                key={row.id ?? i}
                onClick={() => onRowClick?.(row)}
                className={`border-t border-border-default transition-colors ${
                  onRowClick ? 'cursor-pointer hover:bg-bg-card-hover' : ''
                } ${i % 2 === 0 ? 'bg-bg-primary' : 'bg-bg-card/30'}`}
              >
                {columns.map(col => (
                  <td key={col.key} className={`px-4 py-2.5 ${col.align === 'right' ? 'text-right' : ''}`}>
                    {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
