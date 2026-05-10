import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import PhraseTable from '../../components/ads/PhraseTable'

/*
  Messaging Isolation tab.
  Reads from lib_phrase_performance — phrases scored against composite
  perf_score across every variant they appeared in.

  v1 surfaces three sections:
    1. Top phrases (positive delta vs library)
    2. Bottom phrases (anti-patterns)
    3. Empty placeholder for embedding-based clusters (Phase 2)
*/

const WINDOWS = [
  { value: 'full', label: 'Full ad' },
  { value: 'hook', label: 'First 3s' },
  { value: 'body', label: 'Body' },
]

const NGRAMS = [
  { value: 0,  label: 'All sizes' },
  { value: 1,  label: '1 word' },
  { value: 2,  label: '2 words' },
  { value: 3,  label: '3 words' },
  { value: 5,  label: '5 words' },
  { value: 8,  label: '8 words' },
]

export default function AdsMessaging() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [windowFilter, setWindowFilter] = useState('full')
  const [ngramFilter, setNgramFilter] = useState(0)
  const [sortKey, setSortKey] = useState('delta_vs_library')
  const [sortDir, setSortDir] = useState('desc')

  // Effect-scoped fetch with stale-result guard. Without `cancelled`, fast
  // filter switches can land an old response on top of a newer one.
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
          // Friendlier message when migration 028 hasn't been applied yet.
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
      {/* Tab page header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Library · Messaging isolation</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>What words <em>actually</em> win.</h2>
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
            {rows.length} scored phrases · weighted by spend + close-rate
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

      {/* § 01 — Top phrases */}
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

      {/* § 02 — Bottom phrases */}
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

      {/* § 03 — Clusters placeholder */}
      <section>
        <div className="section-head">
          <div className="sh-num">§ 03</div>
          <div className="sh-title">
            <span className="kicker">Phase 2</span>
            <h2 className="h2">Phrase clusters · <em>themes</em>.</h2>
          </div>
          <div className="sh-meta">Coming soon</div>
        </div>
        <div className="placeholder-card">
          <span className="eyebrow eyebrow-accent" style={{ justifyContent: 'center', display: 'inline-flex', marginBottom: 10 }}>Awaiting embedding pass</span>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink-2)', maxWidth: '54ch', margin: '0 auto', lineHeight: 1.55 }}>
            Phase 2 embeds every transcript phrase via OpenAI ada-002 and clusters semantically.
            Themes like <em>"demonstration-promise"</em> or <em>"pain-led-cold-open"</em> emerge as cluster-level rollups instead of literal n-grams.
          </div>
        </div>
      </section>

      <div className="what-it-means" style={{ marginTop: 40 }}>
        <div className="wim-tag">What this means</div>
        <div className="wim-body">
          Phrase scoring is <em>only as good as the transcripts feeding it</em>. Right now the pipeline scores against ad copy text (body + title) pulled from Meta — that gives us written hook + body angle signal but not spoken-video signal.
          For full coverage, the next phase adds Whisper-API transcription for source MP4 uploads. Until then, treat this as the <em>copywriting</em> phrase library — it'll catch winning written hooks but won't capture what the creator says on camera in the first 3 seconds.
        </div>
      </div>
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
