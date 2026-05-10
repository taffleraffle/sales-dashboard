import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import PhraseTable from './PhraseTable'

/*
  Phrases sub-tab of the Messaging page. Renders top/bottom phrases from
  lib_phrase_performance. Extracted from the original AdsMessaging so the
  page can hold multiple sub-tabs.
*/

const WINDOWS = [
  { value: 'full', label: 'Full ad' },
  { value: 'hook', label: 'First 3s' },
  { value: 'body', label: 'Body' },
]
const NGRAMS = [
  { value: 0, label: 'All sizes' },
  { value: 1, label: '1 word' },
  { value: 2, label: '2 words' },
  { value: 3, label: '3 words' },
  { value: 5, label: '5 words' },
  { value: 8, label: '8 words' },
]

export default function AdsPhrasesPanel() {
  const [rows, setRows] = useState([])
  const [, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [windowFilter, setWindowFilter] = useState('full')
  const [ngramFilter, setNgramFilter] = useState(0)
  const [sortKey, setSortKey] = useState('delta_vs_library')
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        let q = supabase
          .from('lib_phrase_performance')
          .select('phrase, ngram_size, window_kind, brand, variants_count, total_spend, mean_perf_score, delta_vs_library, computed_at')
          .eq('window_kind', windowFilter)
        if (ngramFilter) q = q.eq('ngram_size', ngramFilter)
        const { data, error: err } = await q.order('delta_vs_library', { ascending: false }).limit(500)
        if (cancelled) return
        if (err) {
          if (/Could not find the table/i.test(err.message) || err.code === 'PGRST205') {
            throw new Error('Phrase performance view is not available yet. Apply migration 028 in Supabase Studio to enable this tab.')
          }
          throw new Error(err.message)
        }
        setRows(data || [])
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [windowFilter, ngramFilter])

  const top = useMemo(() => rows.filter(r => r.delta_vs_library > 0).slice(0, 30), [rows])
  const bottom = useMemo(() => [...rows].filter(r => r.delta_vs_library < 0).sort((a, b) => a.delta_vs_library - b.delta_vs_library).slice(0, 20), [rows])

  return (
    <div>
      {/* Sub-tab header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Phrases · empirical</span>
          <h2 className="h3 mt-2" style={{ fontSize: 20 }}>What words <em>actually</em> win.</h2>
          <p
            className="mt-2"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
            }}
          >
            {rows.length} scored phrases · weighted by spend
          </p>
        </div>
        <FilterChips windowFilter={windowFilter} setWindowFilter={setWindowFilter} ngramFilter={ngramFilter} setNgramFilter={setNgramFilter} />
      </div>

      {error && (
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--down-soft)',
            border: '1px solid var(--down)',
            borderLeftWidth: 3,
            borderRadius: '0 3px 3px 0',
            color: 'var(--down)',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Phrase scoring error</strong>
          {error}
        </div>
      )}

      <section style={{ marginBottom: 32 }}>
        <div className="section-head">
          <div className="sh-num">§ 01</div>
          <div className="sh-title">
            <span className="kicker">What's winning</span>
            <h2 className="h2">Top phrases · <em>over-indexing</em>.</h2>
          </div>
          <div className="sh-meta">{top.length} phrases</div>
        </div>
        <PhraseTable rows={top} sortKey={sortKey} sortDir={sortDir} onSortChange={(k, d) => { setSortKey(k); setSortDir(d) }} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <div className="section-head">
          <div className="sh-num">§ 02</div>
          <div className="sh-title">
            <span className="kicker">Anti-patterns</span>
            <h2 className="h2">Bottom phrases · <em>stop saying these</em>.</h2>
          </div>
          <div className="sh-meta">{bottom.length} flagged</div>
        </div>
        <PhraseTable rows={bottom} sortKey={sortKey} sortDir={sortDir} onSortChange={(k, d) => { setSortKey(k); setSortDir(d) }} />
      </section>
    </div>
  )
}

function FilterChips({ windowFilter, setWindowFilter, ngramFilter, setNgramFilter }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <ChipGroup label="Window" value={windowFilter} setValue={setWindowFilter} options={WINDOWS} />
      <ChipGroup label="Length" value={ngramFilter} setValue={setNgramFilter} options={NGRAMS} />
    </div>
  )
}

function ChipGroup({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          fontWeight: 500,
          marginRight: 4,
        }}
      >
        {label}
      </span>
      <div style={{ display: 'inline-flex', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 2, padding: 2 }}>
        {options.map(opt => {
          const active = value === opt.value
          return (
            <button
              key={String(opt.value)}
              onClick={() => setValue(opt.value)}
              style={{
                padding: '4px 9px',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 500,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--ink-3)',
                borderRadius: 2,
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
