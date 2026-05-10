import { useState } from 'react'
import { Sparkles, Loader, RefreshCw } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Audience Ideation tab — one-button generation of three messaging topics
  grounded in Daniel's actual prospect-call transcripts plus top-decile
  phrase data from live ads.

  No inputs — OPT's audience (restoration / plumbing / pool / remodeling
  contractors) is fixed. The Edge Function pulls 25 most-recent transcripts
  and lets Claude identify the three strongest angles that emerge from what
  prospects actually say. Output is three topic cards (problem · circumstances
  · outcome · hooks), each anchored in verbatim quotes.

  Backend mode: ad-analyst { mode: 'messaging_topics', days?: 90 }
*/

export default function AdsIdeationPanel() {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [reply, setReply] = useState(null)
  const [meta, setMeta] = useState(null)

  const generate = async () => {
    setError(null)
    setGenerating(true)
    setReply(null)
    setMeta(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('ad-analyst', {
        body: { mode: 'messaging_topics' },
      })
      if (err) throw new Error(err.message || 'messaging_topics failed')
      if (data?.error) throw new Error(data.error)
      setReply(data.reply || '')
      setMeta({ transcripts: data.transcript_count, phrases: data.phrase_count })
    } catch (e) {
      console.error('[ideation] generate failed:', e)
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const topics = reply ? parseTopics(reply) : []

  return (
    <div>
      {/* Sub-tab header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Ideation · messaging</span>
          <h2 className="h3 mt-2" style={{ fontSize: 20 }}>Three messaging topics, <em>from real calls</em>.</h2>
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
            Jeremy Haynes framework · grounded in Daniel's prospect transcripts
            {meta ? ` · ${meta.transcripts} calls + ${meta.phrases} phrases` : ''}
          </p>
        </div>
        <div>
          <button
            onClick={generate}
            disabled={generating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              background: generating ? 'var(--paper-2)' : 'var(--accent)',
              color: 'var(--ink)',
              border: '1px solid',
              borderColor: generating ? 'var(--rule)' : 'var(--accent)',
              borderRadius: 3,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              cursor: generating ? 'wait' : 'pointer',
            }}
          >
            {generating
              ? <Loader size={13} className="animate-spin" />
              : reply ? <RefreshCw size={13} /> : <Sparkles size={13} />}
            {generating ? 'Reading transcripts…' : reply ? 'Regenerate' : 'Generate 3 topics'}
          </button>
        </div>
      </div>

      {/* Error */}
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
          <strong style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Ideation error</strong>
          {error}
        </div>
      )}

      {/* Empty state */}
      {!reply && !generating && !error && (
        <div className="what-it-means">
          <div className="wim-tag">How this works</div>
          <div className="wim-body">
            Click <em>Generate 3 topics</em>. The agent reads the most-recent 25 prospect calls Daniel ran, plus the top-decile phrases from your live ad copy, and identifies the three strongest messaging angles emerging from what prospects actually said. Each topic comes with verbatim quotes, the circumstances those prospects sit in, the outcomes they want, and 4-6 hook lines you can test.
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {generating && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[1, 2, 3].map(i => (
            <div
              key={i}
              style={{
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                borderRadius: 4,
                padding: 20,
                height: 220,
                opacity: 0.4,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      )}

      {/* Topic cards */}
      {topics.length > 0 && !generating && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {topics.map((topic, i) => (
            <TopicCard key={i} index={i + 1} topic={topic} />
          ))}
        </div>
      )}

      {/* Raw fallback (if parser couldn't split into 3 topics) */}
      {reply && topics.length === 0 && !generating && (
        <div
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            padding: 24,
            fontFamily: 'var(--serif)',
            fontSize: 14,
            lineHeight: 1.65,
            whiteSpace: 'pre-wrap',
            color: 'var(--ink)',
          }}
        >
          {reply}
        </div>
      )}
    </div>
  )
}

/*
  Parse Claude's reply into 3 topics. The system prompt enforces:
    ## Topic 1: <name>
    **Why this angle works**
    <para>
    **The problem in their words**
    - "quote 1"
    - "quote 2"
    **Their circumstances**
    - bullet
    **The outcome they want**
    - bullet
    **Hook lines we could test**
    - hook
  We split on `## Topic N:` and break each section into the structured fields.
*/
function parseTopics(text) {
  const out = []
  // Split on `## Topic` (case-insensitive). Drop the first chunk if it's
  // pre-amble (nothing before "## Topic 1:" is part of any topic).
  const chunks = text.split(/##\s*Topic\s+\d+\s*:\s*/i).slice(1)
  for (const chunk of chunks) {
    const [titleLine, ...rest] = chunk.split('\n')
    const title = titleLine.trim()
    const body = rest.join('\n')

    const sections = {}
    // Match each **Header** ... up to next **Header** or end.
    const headerRe = /\*\*([^*]+?)\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|\Z|$)/g
    let m
    while ((m = headerRe.exec(body)) !== null) {
      const key = m[1].trim().toLowerCase()
      sections[key] = m[2].trim()
    }

    out.push({
      title,
      why: sections['why this angle works'] || '',
      problem: parseBullets(sections['the problem in their words']),
      circumstances: parseBullets(sections['their circumstances']),
      outcome: parseBullets(sections['the outcome they want']),
      hooks: parseBullets(sections['hook lines we could test']),
    })
  }
  return out
}

function parseBullets(s) {
  if (!s) return []
  return s
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function TopicCard({ index, topic }) {
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderLeftWidth: 3,
        borderLeftColor: 'var(--accent)',
        borderRadius: 4,
        padding: 24,
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--ink-4)',
            marginBottom: 4,
          }}
        >
          § Topic 0{index}
        </div>
        <h3
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 24,
            lineHeight: 1.2,
            letterSpacing: '-0.015em',
            color: 'var(--ink)',
            fontWeight: 500,
            margin: 0,
          }}
        >
          {topic.title}
        </h3>
      </div>

      {/* Why */}
      {topic.why && (
        <p
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--ink-2)',
            marginBottom: 18,
            paddingBottom: 16,
            borderBottom: '1px solid var(--rule)',
            fontStyle: 'italic',
          }}
        >
          {topic.why}
        </p>
      )}

      {/* 4-quadrant grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '16px 24px',
          marginBottom: 18,
        }}
      >
        <Section label="Problem · in their words" items={topic.problem} italic />
        <Section label="Circumstances" items={topic.circumstances} />
        <Section label="Outcome they want" items={topic.outcome} />
        <Section label="Hook lines to test" items={topic.hooks} bold />
      </div>
    </div>
  )
}

function Section({ label, items, italic, bold }) {
  if (!items || items.length === 0) return null
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          marginBottom: 8,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {items.map((it, i) => (
          <li
            key={i}
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--ink)',
              fontStyle: italic ? 'italic' : 'normal',
              fontWeight: bold ? 500 : 400,
              paddingLeft: 12,
              position: 'relative',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: '0.55em',
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: italic ? 'var(--accent)' : 'var(--ink-4)',
              }}
            />
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
