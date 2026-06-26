import { useMemo } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

/*
  Editorial phrase ranking table.
  Reads from lib_phrase_performance. Each row = one phrase × one window.
  Sortable by perf score / delta vs library / variants_count / total_spend.
*/

function fmtNum(n, digits = 1) { return n == null || isNaN(n) ? '—' : n.toFixed(digits) }
function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}

export default function PhraseTable({ rows, sortKey = 'delta_vs_library', onSortChange = () => {}, sortDir = 'desc' }) {
  const sorted = useMemo(() => {
    const list = [...rows]
    list.sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [rows, sortKey, sortDir])

  const sortFor = (key) => {
    if (sortKey === key) onSortChange(key, sortDir === 'asc' ? 'desc' : 'asc')
    else onSortChange(key, 'desc')
  }

  if (!rows.length) {
    return (
      <div className="placeholder-card">
        <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 10 }}>Awaiting phrase scoring</span>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink-2)', maxWidth: '52ch', margin: '0 auto', lineHeight: 1.55 }}>
          The nightly phrase scoring job hasn't run yet — or there aren't enough variants with transcripts + spend to surface signal.
          Once we have at least <strong>3 variants</strong> sharing a phrase and <strong>$250+ total spend</strong>, that phrase will land here.
        </div>
      </div>
    )
  }

  return (
    <div
      className="overflow-x-auto"
      style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 10 }}
    >
      <table className="data" style={{ minWidth: '100%' }}>
        <thead>
          <tr>
            <Th label="Phrase"       sortKey="phrase"           current={sortKey} dir={sortDir} onClick={sortFor} />
            <Th label="Window"       sortKey="window"           current={sortKey} dir={sortDir} onClick={sortFor} />
            <Th label="Variants"     sortKey="variants_count"   current={sortKey} dir={sortDir} onClick={sortFor} numeric />
            <Th label="Total spend"  sortKey="total_spend"      current={sortKey} dir={sortDir} onClick={sortFor} numeric />
            <Th label="Mean perf"    sortKey="mean_perf_score"  current={sortKey} dir={sortDir} onClick={sortFor} numeric />
            <Th label="Δ vs library" sortKey="delta_vs_library" current={sortKey} dir={sortDir} onClick={sortFor} numeric />
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={`${r.phrase}-${r.window_kind}-${r.brand || 'all'}-${r.ngram_size}`}>
              <td className="kw">{r.phrase}</td>
              <td className="dim" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                {r.window_kind}
              </td>
              <td className="num">{fmtNum(r.variants_count, 0)}</td>
              <td className="num">{fmt$(r.total_spend)}</td>
              <td className="num">{fmtNum(r.mean_perf_score)}</td>
              <td className="num">
                <DeltaCell delta={r.delta_vs_library} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ label, sortKey, current, dir, onClick, numeric }) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onClick(sortKey)}
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        textAlign: numeric ? 'right' : 'left',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {active && (dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  )
}

function DeltaCell({ delta }) {
  if (delta == null || isNaN(delta)) return <span>—</span>
  const sign = delta > 0 ? '+' : ''
  const cls = delta > 0 ? 'pill-up' : delta < 0 ? 'pill-down' : 'pill-flat'
  return <span className={`pill ${cls}`}>{sign}{delta.toFixed(1)}</span>
}
