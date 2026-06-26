import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader, RefreshCw, Send, History } from 'lucide-react'
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
  // currentId: the lib_messaging_ideations.id of the row we're currently
  // viewing/extending. null = nothing loaded yet OR a brand-new generation
  // not yet saved. When we save the first time we set this; subsequent
  // follow-ups update the same row.
  const [currentId, setCurrentId] = useState(null)
  const [history, setHistory] = useState([])     // [{id, created_at, title, transcript_count, ...}]
  const [showHistory, setShowHistory] = useState(false)
  // T# → {name, date, url} so we can link each quote to its Fathom recording.
  // Populated from X-Transcript-Map response header (live runs) or from the
  // saved row (history loads).
  const [transcriptMap, setTranscriptMap] = useState({})
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [conversation, generating])

  // Load the persisted history on mount and auto-display the most recent one
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('lib_messaging_ideations')
        .select('id, created_at, title, transcript_count, phrase_count, conversation, initial_reply')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(25)
      if (cancelled || !data || !data.length) return
      setHistory(data.map(r => ({
        id: r.id,
        created_at: r.created_at,
        title: r.title,
        transcript_count: r.transcript_count,
        phrase_count: r.phrase_count,
      })))
      // Auto-load most recent so the page never looks empty when Ben returns
      const top = data[0]
      const convo = Array.isArray(top.conversation) && top.conversation.length
        ? top.conversation
        : [{ role: 'assistant', content: top.initial_reply }]
      setConversation(convo)
      setMeta({ transcripts: top.transcript_count, phrases: top.phrase_count })
      setTranscriptMap(top.transcript_map || {})
      setCurrentId(top.id)
    })()
    return () => { cancelled = true }
  }, [])

  // Persist the current ideation. Insert on first save, update afterwards so
  // follow-up exchanges are appended to the same row.
  async function persistIdeation(convo, m, isNewGen, tMap) {
    try {
      const initial = convo.find(x => x.role === 'assistant')?.content || ''
      const title = deriveTitle(initial)
      if (isNewGen || !currentId) {
        const { data, error: err } = await supabase
          .from('lib_messaging_ideations')
          .insert({
            initial_reply: initial,
            conversation: convo,
            transcript_count: m?.transcripts || null,
            phrase_count: m?.phrases || null,
            transcript_map: tMap || null,
            title,
          })
          .select('id, created_at')
          .single()
        if (err) throw new Error(err.message)
        setCurrentId(data.id)
        setHistory(prev => [{ id: data.id, created_at: data.created_at, title, transcript_count: m?.transcripts, phrase_count: m?.phrases }, ...prev])
      } else {
        await supabase
          .from('lib_messaging_ideations')
          .update({ conversation: convo, title })
          .eq('id', currentId)
      }
    } catch (e) {
      console.warn('[ideation] persist failed (non-fatal):', e.message)
    }
  }

  const loadHistory = async (id) => {
    const { data, error: err } = await supabase
      .from('lib_messaging_ideations')
      .select('id, conversation, initial_reply, transcript_count, phrase_count, transcript_map')
      .eq('id', id).single()
    if (err) { setError(err.message); return }
    const convo = Array.isArray(data.conversation) && data.conversation.length
      ? data.conversation
      : [{ role: 'assistant', content: data.initial_reply }]
    setConversation(convo)
    setMeta({ transcripts: data.transcript_count, phrases: data.phrase_count })
    setTranscriptMap(data.transcript_map || {})
    setCurrentId(id)
    setShowHistory(false)
  }

  // Stream the SSE response from the ad-analyst function and update the
  // assistant message as tokens arrive. Replaces supabase.functions.invoke
  // which buffers the full body — that was timing out at 60s on the broader
  // prompt. Now first bytes arrive in 1-2s and content streams in live.
  async function streamMessagingTopics({ mode, messages }) {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ad-analyst`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(mode === 'messaging_topics_followup'
        ? { mode, messages }
        : { mode }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText)
      throw new Error(`ad-analyst ${mode} ${res.status}: ${err.slice(0, 200)}`)
    }
    const transcriptCount = parseInt(res.headers.get('X-Transcript-Count') || '0', 10) || null
    const phraseCount = parseInt(res.headers.get('X-Phrase-Count') || '0', 10) || null
    const mapB64 = res.headers.get('X-Transcript-Map')
    let mapFromHeaders = null
    if (mapB64) {
      try {
        const jsonStr = decodeURIComponent(escape(atob(mapB64)))
        mapFromHeaders = JSON.parse(jsonStr)
        setTranscriptMap(mapFromHeaders)
      } catch (e) {
        console.warn('[ideation] transcript-map decode failed:', e.message)
      }
    }
    const metaFromHeaders = transcriptCount ? { transcripts: transcriptCount, phrases: phraseCount } : null
    if (metaFromHeaders) setMeta(metaFromHeaders)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let acc = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          if (json.type === 'content_block_delta' && json.delta?.text) {
            acc += json.delta.text
            // Update conversation state with the in-progress reply
            setConversation(prev => {
              const next = [...prev]
              // Replace the last assistant placeholder, or append a fresh one
              const lastIdx = next.findIndex((m, i) => m.role === 'assistant' && i === next.length - 1)
              if (lastIdx >= 0) next[lastIdx] = { role: 'assistant', content: acc }
              else next.push({ role: 'assistant', content: acc })
              return next
            })
          } else if (json.type === 'error') {
            throw new Error(`stream error: ${json.error?.message || JSON.stringify(json)}`)
          }
        } catch (e) {
          if (e.message?.startsWith('stream error')) throw e
          // ignore non-JSON heartbeats etc
        }
      }
    }
    return { text: acc, meta: metaFromHeaders, transcriptMap: mapFromHeaders }
  }

  const generate = async () => {
    setError(null)
    setGenerating(true)
    setMeta(null)
    setCurrentId(null) // start a fresh row on every Generate
    setTranscriptMap({})
    setConversation([{ role: 'assistant', content: '' }])
    try {
      const { text: finalText, meta: finalMeta, transcriptMap: finalMap } = await streamMessagingTopics({ mode: 'messaging_topics' })
      const finalConvo = [{ role: 'assistant', content: finalText }]
      await persistIdeation(finalConvo, finalMeta, true, finalMap)
    } catch (e) {
      console.error('[ideation] generate failed:', e)
      setError(e.message)
      setConversation([])
    } finally {
      setGenerating(false)
    }
  }

  const sendFollowUp = async () => {
    if (!followUp.trim() || generating) return
    setError(null)
    setGenerating(true)
    const userTurn = followUp.trim()
    setFollowUp('')
    const baseHistory = [
      ...conversation,
      { role: 'user', content: userTurn },
      { role: 'assistant', content: '' },
    ]
    setConversation(baseHistory)
    try {
      const { text: finalText } = await streamMessagingTopics({
        mode: 'messaging_topics_followup',
        messages: baseHistory.slice(0, -1).map(({ role, content }) => ({ role, content })),
      })
      const finalConvo = [...baseHistory.slice(0, -1), { role: 'assistant', content: finalText }]
      await persistIdeation(finalConvo, meta, false)
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
      {/* Top control row — status line + history picker + generate button.
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          {history.length > 0 && (
            <>
              <button
                onClick={() => setShowHistory(v => !v)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '10px 14px',
                  background: 'var(--paper-2)',
                  color: 'var(--ink-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 9,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <History size={12} />
                History · {history.length}
              </button>
              {showHistory && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    width: 360,
                    maxHeight: 400,
                    overflowY: 'auto',
                    background: 'var(--paper)',
                    border: '1px solid var(--rule)',
                    borderRadius: 9,
                    boxShadow: '0 6px 20px rgba(10,10,10,0.08)',
                    zIndex: 10,
                  }}
                >
                  {history.map(h => (
                    <button
                      key={h.id}
                      onClick={() => loadHistory(h.id)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 14px',
                        background: h.id === currentId ? 'var(--accent-soft)' : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--rule)',
                        cursor: 'pointer',
                        color: 'var(--ink)',
                      }}
                      onMouseEnter={e => { if (h.id !== currentId) e.currentTarget.style.background = 'var(--paper-2)' }}
                      onMouseLeave={e => { if (h.id !== currentId) e.currentTarget.style.background = 'transparent' }}
                    >
                      <div
                        style={{
                          fontFamily: 'var(--serif)',
                          fontSize: 13,
                          lineHeight: 1.3,
                          color: 'var(--ink)',
                          fontWeight: 500,
                          marginBottom: 3,
                        }}
                      >
                        {h.title || 'Untitled ideation'}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          letterSpacing: '0.1em',
                          color: 'var(--ink-4)',
                        }}
                      >
                        {formatDate(h.created_at)}
                        {h.transcript_count ? ` · ${h.transcript_count} calls` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
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
              borderRadius: 9,
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
            {generating ? 'Reading transcripts…' : conversation.length ? 'New generation' : 'Generate'}
          </button>
        </div>
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
                borderRadius: 10,
                padding: 20,
                height: 200,
                opacity: 0.4,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      )}

      {/* Lens sections from the latest assistant message.
          "Other patterns" is optional — only rendered if the model produced it. */}
      {lenses && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {['Problems', 'Circumstances', 'Outcomes', 'Other patterns'].map(name => (
            <LensSection key={name} name={name} block={lenses[name.toLowerCase()]} transcriptMap={transcriptMap} />
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
            borderRadius: 10,
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
                borderRadius: 9,
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
                borderRadius: 9,
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
  const required = ['Problems', 'Circumstances', 'Outcomes']
  // Matches "## Problems", "## Circumstances", "## Outcomes", and optionally
  // "## Other patterns" (case-insensitive). Captures the section name.
  const headerRe = /(?:^|\n)##\s*(Problems|Circumstances|Outcomes|Other\s+patterns)\s*(?:\(optional\))?\s*\n/gi
  const matches = [...text.matchAll(headerRe)]
  if (matches.length < 3) return null

  const result = {}
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toLowerCase().replace(/\s+/g, ' ').trim()
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const block = text.slice(start, end).trim()

    const firstBulletIdx = block.search(/(?:^|\n)\s*-\s+/)
    const opener = (firstBulletIdx > 0 ? block.slice(0, firstBulletIdx) : '').trim()
    const bulletText = firstBulletIdx >= 0 ? block.slice(firstBulletIdx) : ''
    const bulletLines = bulletText.split(/\n(?=\s*-\s+)/).map(s => s.trim()).filter(Boolean)

    const ideas = bulletLines.map(parseIdeaLine).filter(Boolean)
    result[name] = { opener, ideas }
  }

  if (!required.every(w => result[w.toLowerCase()])) return null
  return result
}

/*
  Parse a single bullet line shaped as:
    **Angle name** — Sentence explanation. Anchored in: "q1" · "q2" · "q3". Hook: "hook line"
  Returns { name, text, quotes: [...], hook }.
  Tolerates: single quote without separator, smart-quote characters, missing
  hook, missing anchor.
*/
function parseIdeaLine(line) {
  const body = line.replace(/^\s*-\s*/, '').trim()
  if (!body) return null

  // 1. Pull the bold angle name from the front
  const nameMatch = body.match(/^\*\*([^*]+?)\*\*\s*/)
  const name = nameMatch ? nameMatch[1].trim() : null
  let rest = nameMatch ? body.slice(nameMatch[0].length) : body

  // 2. Strength score: "[Strength: 8/10]" — optional, immediately after the name
  let strength = null
  const strengthMatch = rest.match(/^\[?\s*Strength:?\s*(\d+)\s*\/\s*10\s*\]?\s*(?:—|-|–|:)?\s*/i)
  if (strengthMatch) {
    strength = parseInt(strengthMatch[1], 10)
    rest = rest.slice(strengthMatch[0].length)
  } else {
    // Tolerate "— " separator before any strength tag
    const sep = rest.match(/^(?:—|-|–|:)\s*/)
    if (sep) rest = rest.slice(sep[0].length)
  }

  // 3. Split off the Hook section (always at the end)
  let hook = null
  const hookMatch = rest.match(/(?:^|\s)Hook:?\s*(.+?)\s*$/i)
  if (hookMatch) {
    hook = hookMatch[1].trim().replace(/^["“]|["”]\s*$/g, '')
    rest = rest.slice(0, hookMatch.index).trim()
  }

  // 4. Split off the Anchored-in section
  let quotes = []
  const anchorMatch = rest.match(/(?:^|\s)Anchored\s+in:?\s*(.+?)\s*$/i)
  if (anchorMatch) {
    const anchorBody = anchorMatch[1].trim().replace(/\.$/, '')
    quotes = extractQuotes(anchorBody)
    rest = rest.slice(0, anchorMatch.index).trim()
  }

  const text = rest.replace(/[.\s]+$/, '').trim()
  return { name, strength, text, quotes, hook }
}

function QuoteBlock({ quote, transcriptMap }) {
  // quote = { text, sourceId } where sourceId is "T7" or null
  const attribution = quote.sourceId && transcriptMap?.[quote.sourceId]
  const hasUrl = !!attribution?.url
  return (
    <div
      style={{
        fontFamily: 'var(--serif)',
        fontSize: 12.5,
        lineHeight: 1.45,
        color: 'var(--ink-3)',
        borderLeft: '2px solid var(--accent)',
        paddingLeft: 8,
      }}
    >
      <span style={{ fontStyle: 'italic' }}>"{quote.text}"</span>
      {attribution ? (
        hasUrl ? (
          <a
            href={attribution.url}
            target="_blank"
            rel="noreferrer"
            title="Open Fathom recording"
            style={{
              display: 'inline-block',
              marginLeft: 8,
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'var(--ink-2)',
              textDecoration: 'underline',
              textDecorationColor: 'var(--ink-4)',
              textDecorationStyle: 'dotted',
              textUnderlineOffset: 2,
              fontStyle: 'normal',
            }}
          >
            — {attribution.name} · {attribution.date}
          </a>
        ) : (
          <span
            style={{
              marginLeft: 8,
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'var(--ink-4)',
              fontStyle: 'normal',
            }}
          >
            — {attribution.name} · {attribution.date}
          </span>
        )
      ) : quote.sourceId ? (
        <span
          style={{
            marginLeft: 8,
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            color: 'var(--ink-4)',
            fontStyle: 'normal',
          }}
        >
          [{quote.sourceId}]
        </span>
      ) : null}
    </div>
  )
}

function StrengthBadge({ score }) {
  // Color tier: 8-10 strong (accent yellow), 5-7 mid (ink), 1-4 weak (muted)
  const tier = score >= 8 ? 'strong' : score >= 5 ? 'mid' : 'weak'
  const bg = tier === 'strong' ? 'var(--accent)' : tier === 'mid' ? 'var(--paper-2)' : 'transparent'
  const fg = tier === 'strong' ? 'var(--ink)' : tier === 'mid' ? 'var(--ink)' : 'var(--ink-4)'
  const border = tier === 'strong' ? 'var(--accent)' : 'var(--rule)'
  return (
    <span
      title={`Strength: ${score}/10 — ${tier === 'strong' ? 'recurring theme across many calls' : tier === 'mid' ? 'solid pattern in several calls' : 'anecdotal, fewer mentions'}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        borderRadius: 9,
        fontFamily: 'var(--mono)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        flexShrink: 0,
      }}
    >
      {score}/10
    </span>
  )
}

function deriveTitle(text) {
  if (!text) return null
  // Pick the first **bold** angle name from the Problems section as a title
  const m = text.match(/##\s*Problems[\s\S]*?-\s*\*\*([^*]+?)\*\*/i)
  if (m) return m[1].trim().slice(0, 80)
  return null
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

function extractQuotes(s) {
  // Match quote + optional [T#] tag immediately after the closing quote
  //   "the verbatim text" [T7]
  const QUOTE_TAG_RE = /["“]([^"”]+?)["”]\s*\[([Tt]\d+)\]/g
  const out = []
  let m
  while ((m = QUOTE_TAG_RE.exec(s)) !== null) {
    out.push({ text: m[1].trim(), sourceId: m[2].toUpperCase() })
  }
  if (out.length) return out

  // Fallback for quotes without [T#] tags (legacy generations or model drift)
  const QUOTE_RE = /["“]([^"”]+?)["”]/g
  const fallback = []
  while ((m = QUOTE_RE.exec(s)) !== null) {
    const q = m[1].trim()
    if (q) fallback.push({ text: q, sourceId: null })
  }
  return fallback
}

function LensSection({ name, block, transcriptMap }) {
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
            <IdeaRow key={i} idea={idea} transcriptMap={transcriptMap} />
          ))}
        </div>
      )}
    </section>
  )
}

function IdeaRow({ idea, transcriptMap }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 16,
        padding: '14px 16px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 9,
      }}
    >
      {/* Left: the idea + supporting quotes */}
      <div>
        {idea.name && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <div
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 15,
                lineHeight: 1.3,
                fontWeight: 500,
                color: 'var(--ink)',
              }}
            >
              {idea.name}
            </div>
            {Number.isFinite(idea.strength) && <StrengthBadge score={idea.strength} />}
          </div>
        )}
        {idea.text && (
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--ink-2)',
              marginBottom: idea.quotes?.length ? 8 : 0,
            }}
          >
            {idea.text}
          </div>
        )}
        {idea.quotes && idea.quotes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {idea.quotes.map((q, i) => (
              <QuoteBlock key={i} quote={q} transcriptMap={transcriptMap} />
            ))}
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
          borderRadius: 9,
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
