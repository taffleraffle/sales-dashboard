import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader, RefreshCw, Send } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Messaging ideation panel — three-lens output (Problems · Circumstances ·
  Outcomes) with a hook line for each idea. Two interaction modes:
    1. Initial generate (or regenerate) — one-shot, no inputs
    2. Follow-up chat — refine the list ("more aggressive", "lean into TPAs",
       "give me hooks for circumstance #3", etc.)

  Backend:
    POST ad-analyst { mode: 'messaging_topics' }
    POST ad-analyst { mode: 'messaging_topics_followup', messages: [...] }
*/

export default function AdsIdeationPanel() {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [conversation, setConversation] = useState([]) // [{ role, content }]
  const [followUp, setFollowUp] = useState('')
  const [meta, setMeta] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [conversation, generating])

  const generate = async () => {
    setError(null)
    setGenerating(true)
    setConversation([])
    setMeta(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('ad-analyst', {
        body: { mode: 'messaging_topics' },
      })
      if (err) throw new Error(err.message || 'messaging_topics failed')
      if (data?.error) throw new Error(data.error)
      setConversation([{ role: 'assistant', content: data.reply || '' }])
      setMeta({ transcripts: data.transcript_count, phrases: data.phrase_count })
    } catch (e) {
      console.error('[ideation] generate failed:', e)
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const sendFollowUp = async () => {
    if (!followUp.trim() || generating) return
    setError(null)
    setGenerating(true)
    const nextHistory = [...conversation, { role: 'user', content: followUp.trim() }]
    setConversation(nextHistory)
    setFollowUp('')
    try {
      const { data, error: err } = await supabase.functions.invoke('ad-analyst', {
        body: { mode: 'messaging_topics_followup', messages: nextHistory.map(({ role, content }) => ({ role, content })) },
      })
      if (err) throw new Error(err.message || 'follow-up failed')
      if (data?.error) throw new Error(data.error)
      setConversation(prev => [...prev, { role: 'assistant', content: data.reply || '' }])
    } catch (e) {
      console.error('[ideation] follow-up failed:', e)
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const onFollowUpKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp() }
  }

  // The latest assistant message is the one we render as structured lenses.
  const latestReply = [...conversation].reverse().find(m => m.role === 'assistant')?.content || ''
  const lenses = parseLenses(latestReply)

  return (
    <div>
      {/* Top control row — single Generate button + status line.
          No redundant eyebrow/headline — user is already on the "Ideation"
          sub-tab so we don't repeat the label inside the panel. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}
        >
          Jeremy Haynes framework · Problems · Circumstances · Outcomes
          {meta ? ` · ${meta.transcripts} calls + ${meta.phrases} phrases` : ''}
        </div>
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
            : conversation.length ? <RefreshCw size={13} /> : <Sparkles size={13} />}
          {generating ? 'Reading transcripts…' : conversation.length ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {/* Error banner */}
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
      {!conversation.length && !generating && !error && (
        <div className="what-it-means" style={{ marginBottom: 0 }}>
          <div className="wim-tag">How this works</div>
          <div className="wim-body">
            Click <em>Generate</em>. The agent reads the most-recent 25 prospect calls plus the top-decile phrases from your live ads, and produces a long list of messaging ideas organised under Jeremy Haynes' three lenses: <em>Problems</em>, <em>Circumstances</em>, <em>Outcomes</em>. Each idea has a hook line beside it. After it's done, you can regenerate for a fresh take or ask follow-up questions to refine.
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {generating && !conversation.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {['Problems', 'Circumstances', 'Outcomes'].map(lbl => (
            <div
              key={lbl}
              style={{
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                borderRadius: 4,
                padding: 20,
                height: 200,
                opacity: 0.4,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      )}

      {/* Lens sections from the latest assistant message */}
      {lenses && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {['Problems', 'Circumstances', 'Outcomes'].map(name => (
            <LensSection key={name} name={name} block={lenses[name.toLowerCase()]} />
          ))}
        </div>
      )}

      {/* Raw fallback if parser couldn't split into 3 lenses (e.g. follow-up
          replies that are conversational rather than re-structured) */}
      {!lenses && latestReply && (
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
          {latestReply}
        </div>
      )}

      {/* Follow-up chat input — shown once we have at least one assistant reply */}
      {conversation.length > 0 && (
        <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--rule)' }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            Ask a follow-up
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={followUp}
              onChange={e => setFollowUp(e.target.value)}
              onKeyDown={onFollowUpKey}
              placeholder="e.g. 'lean into the TPA-dependency angle', 'give me 5 more hooks for outcome #2', 'make these more aggressive'…"
              rows={2}
              disabled={generating}
              style={{
                flex: 1,
                background: 'var(--paper-2)',
                border: '1px solid var(--rule)',
                borderRadius: 3,
                padding: '10px 12px',
                fontSize: 13,
                fontFamily: 'var(--sans)',
                color: 'var(--ink)',
                outline: 'none',
                resize: 'vertical',
                minHeight: 48,
                maxHeight: 160,
              }}
            />
            <button
              onClick={sendFollowUp}
              disabled={!followUp.trim() || generating}
              style={{
                width: 42, height: 42,
                background: followUp.trim() && !generating ? 'var(--accent)' : 'var(--paper-2)',
                border: '1px solid',
                borderColor: followUp.trim() && !generating ? 'var(--accent)' : 'var(--rule)',
                color: 'var(--ink)',
                borderRadius: 3,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: followUp.trim() && !generating ? 'pointer' : 'not-allowed',
                flexShrink: 0,
              }}
            >
              {generating ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>

          {/* Prior turns (collapsed) — show last user question + answer when present */}
          {conversation.length > 1 && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  marginBottom: 0,
                }}
              >
                Conversation
              </div>
              {conversation.slice(1).map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} />
              ))}
              <div ref={scrollRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/*
  Parse the assistant reply into three named lens blocks.
  Required shape from the prompt:
    ## Problems
    <opener>
    - **Angle name** — sentence. Anchored in: "quote". Hook: "..."
    - ...

    ## Circumstances
    - ...

    ## Outcomes
    - ...

  Returns { problems: { opener, ideas: [{name, text, anchor, hook}] }, ... }
  or `null` when the reply doesn't match the structure (e.g. a chat refinement
  reply that's conversational, not a full re-render).
*/
function parseLenses(text) {
  if (!text) return null
  const want = ['Problems', 'Circumstances', 'Outcomes']
  const headerRe = /(?:^|\n)##\s*(Problems|Circumstances|Outcomes)\s*\n/gi
  const matches = [...text.matchAll(headerRe)]
  if (matches.length < 3) return null

  const result = {}
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toLowerCase()
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const block = text.slice(start, end).trim()

    // Split into pre-bullet opener vs bullet list. First bullet starts at "- ".
    const firstBulletIdx = block.search(/(?:^|\n)\s*-\s+/)
    const opener = (firstBulletIdx > 0 ? block.slice(0, firstBulletIdx) : '').trim()
    const bulletText = firstBulletIdx >= 0 ? block.slice(firstBulletIdx) : ''
    const bulletLines = bulletText.split(/\n(?=\s*-\s+)/).map(s => s.trim()).filter(Boolean)

    const ideas = bulletLines.map(parseIdeaLine).filter(Boolean)
    result[name] = { opener, ideas }
  }

  // Require all three lenses to render
  if (!want.every(w => result[w.toLowerCase()])) return null
  return result
}

function parseIdeaLine(line) {
  // Strip leading "- "
  const body = line.replace(/^\s*-\s*/, '').trim()
  if (!body) return null

  // **Angle name** — sentence. Anchored in: "quote". Hook: "hook"
  // We extract these four pieces; tolerate variations in punctuation.
  const nameMatch = body.match(/^\*\*([^*]+?)\*\*\s*(?:—|-|–|:)?\s*/)
  const name = nameMatch ? nameMatch[1].trim() : null
  let rest = nameMatch ? body.slice(nameMatch[0].length) : body

  const anchorMatch = rest.match(/Anchored\s+in:?\s*["“]?([^"”\n]+?)["”]?(?=\s*(?:Hook|$))/i)
  const anchor = anchorMatch ? anchorMatch[1].trim() : null
  if (anchorMatch) rest = rest.slice(0, anchorMatch.index).trim()

  const hookMatch = body.match(/Hook:?\s*["“]?([^"”\n]+?)["”]?\s*$/i)
  const hook = hookMatch ? hookMatch[1].trim() : null

  const text = rest.replace(/\s+(?:Hook|Anchored).*$/i, '').trim()
  return { name, text, anchor, hook }
}

function LensSection({ name, block }) {
  if (!block || (!block.opener && (!block.ideas || block.ideas.length === 0))) return null
  return (
    <section>
      {/* Clean, single heading — no eyebrow, no italics, no tagline. Just the label. */}
      <h3
        style={{
          fontFamily: 'var(--serif)',
          fontSize: 26,
          lineHeight: 1.15,
          letterSpacing: '-0.015em',
          color: 'var(--ink)',
          fontWeight: 500,
          margin: 0,
          paddingBottom: 6,
          borderBottom: '2px solid var(--accent)',
          display: 'inline-block',
        }}
      >
        {name}
      </h3>

      {block.opener && (
        <p
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--ink-2)',
            fontStyle: 'italic',
            margin: '12px 0 16px 0',
          }}
        >
          {block.opener}
        </p>
      )}

      {block.ideas && block.ideas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {block.ideas.map((idea, i) => (
            <IdeaRow key={i} idea={idea} />
          ))}
        </div>
      )}
    </section>
  )
}

function IdeaRow({ idea }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 16,
        padding: '14px 16px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      {/* Left: the idea + anchor */}
      <div>
        {idea.name && (
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 15,
              lineHeight: 1.3,
              fontWeight: 500,
              color: 'var(--ink)',
              marginBottom: 4,
            }}
          >
            {idea.name}
          </div>
        )}
        {idea.text && (
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--ink-2)',
              marginBottom: idea.anchor ? 6 : 0,
            }}
          >
            {idea.text}
          </div>
        )}
        {idea.anchor && (
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 12.5,
              lineHeight: 1.45,
              fontStyle: 'italic',
              color: 'var(--ink-3)',
              borderLeft: '2px solid var(--accent)',
              paddingLeft: 8,
              marginTop: 4,
            }}
          >
            "{idea.anchor}"
          </div>
        )}
      </div>

      {/* Right: hook line */}
      <div
        style={{
          borderLeft: '1px solid var(--rule)',
          paddingLeft: 16,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-4)',
            marginBottom: 4,
          }}
        >
          Hook to test
        </div>
        {idea.hook ? (
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 14,
              lineHeight: 1.4,
              color: 'var(--ink)',
              fontWeight: 500,
            }}
          >
            {idea.hook}
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>—</div>
        )}
      </div>
    </div>
  )
}

function Bubble({ role, content }) {
  const isUser = role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '88%',
          padding: '10px 12px',
          borderRadius: 3,
          background: isUser ? 'var(--accent-soft)' : 'var(--paper-2)',
          border: `1px solid ${isUser ? 'var(--accent)' : 'var(--rule)'}`,
          color: 'var(--ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 8.5,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            marginBottom: 4,
            fontWeight: 500,
          }}
        >
          {isUser ? 'You' : 'Analyst'}
        </div>
        <div
          style={{
            fontFamily: isUser ? 'var(--sans)' : 'var(--serif)',
            fontSize: isUser ? 13 : 13.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {content}
        </div>
      </div>
    </div>
  )
}
