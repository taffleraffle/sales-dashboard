import { useState, useRef, useEffect } from 'react'
import { Sparkles, Loader, X, Send } from 'lucide-react'
import { QUICK_PROMPTS, runQuickPrompt, chatStream } from '../../services/adAnalyst'

/*
  Editorial analyst panel that sits next to the gallery.
  - Top section: quick-prompts (one-click)
  - Middle: streaming response area
  - Bottom: open chat input

  Conversation state is local. Tokens stream via async generator from the
  service. Errors surface visibly per Ben's "surface errors, never swallow"
  rule.
*/

export default function AdAnalystPanel({ open, onClose }) {
  const [messages, setMessages] = useState([])
  const [streamingText, setStreamingText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState(null)
  const messagesEndRef = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages, streamingText])

  // Quick-prompts run a deterministic data fetch + a single LLM call. They
  // don't currently stream (runQuickPrompt awaits the full response), so we
  // show a "Working…" affordance instead of a fake streaming cursor.
  const runPrompt = async (promptId, label) => {
    setError(null)
    setStreaming(true)
    setStreamingText('')  // unused for quick-prompt path; kept to clear stale text
    const userMsg = { role: 'user', content: label }
    setMessages(prev => [...prev, userMsg])

    try {
      const reply = await runQuickPrompt(promptId)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
      setError(e.message)
    } finally {
      setStreaming(false)
    }
  }

  const sendChat = async () => {
    if (!input.trim() || streaming) return
    setError(null)
    const userMsg = { role: 'user', content: input.trim() }
    // Build the next history before mutating state so we send a clean record.
    const nextHistory = [...messages, userMsg]
    setMessages(nextHistory)
    setInput('')
    setStreaming(true)
    setStreamingText('')

    let full = ''
    try {
      for await (const chunk of chatStream(
        nextHistory.map(({ role, content }) => ({ role, content }))
      )) {
        full += chunk
        setStreamingText(full)
      }
      setMessages(prev => [...prev, { role: 'assistant', content: full }])
      setStreamingText('')
    } catch (e) {
      // Preserve whatever was already streamed so the user keeps the partial
      // answer; don't silently nuke it. Per CLAUDE.md "surface errors, never swallow".
      if (full.length > 0) {
        setMessages(prev => [...prev, { role: 'assistant', content: full, partial: true }])
      }
      setStreamingText('')
      setError(e.message)
    } finally {
      setStreaming(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  }

  const clear = () => { setMessages([]); setStreamingText(''); setError(null) }

  if (!open) return null

  return (
    <aside
      ref={containerRef}
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 600,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--rule)',
          background: 'var(--paper-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={14} style={{ color: 'var(--ink)' }} />
          <span className="eyebrow eyebrow-accent" style={{ fontSize: 9 }}>Ad Analyst</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={clear}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--ink-3)',
                padding: '4px 8px',
                borderRadius: 2,
              }}
            >
              Clear
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                borderRadius: 2,
                color: 'var(--ink-3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Body — quick prompts when empty, conversation when populated */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
        }}
      >
        {messages.length === 0 && !streaming && (
          <>
            <p
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 17,
                lineHeight: 1.4,
                color: 'var(--ink-2)',
                margin: 0,
              }}
            >
              Ask anything about <em>ad performance</em>. The agent reads <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>public.ads</span>, <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>lib_phrase_performance</span>, and Daniel's prospect transcripts (excluding team meetings).
            </p>
            <div style={{ height: 1, background: 'var(--rule)', margin: '6px 0' }} />
            <div className="kicker" style={{ marginBottom: 4 }}>Quick prompts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {QUICK_PROMPTS.map(p => (
                <button
                  key={p.id}
                  onClick={() => runPrompt(p.id, p.label)}
                  disabled={streaming}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    background: 'var(--paper)',
                    border: '1px solid var(--rule)',
                    borderRadius: 3,
                    cursor: streaming ? 'not-allowed' : 'pointer',
                    transition: 'border-color 160ms ease, background 160ms ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.background = 'var(--paper-2)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--rule)'; e.currentTarget.style.background = 'var(--paper)' }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--serif)',
                      fontSize: 14,
                      color: 'var(--ink)',
                      letterSpacing: '-0.005em',
                      lineHeight: 1.3,
                    }}
                  >
                    {p.label}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 9.5,
                      letterSpacing: '0.06em',
                      color: 'var(--ink-3)',
                      marginTop: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {p.description}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content} partial={m.partial} />
        ))}

        {streaming && (
          // Show streaming bubble only when we have text (open-chat path).
          // Quick-prompt path is non-streaming → show a "Working…" bubble instead.
          streamingText
            ? <Message role="assistant" content={streamingText} streaming />
            : <Message role="assistant" content="Analysing data…" working />
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              background: 'var(--down-soft)',
              border: '1px solid var(--down)',
              borderLeftWidth: 3,
              borderRadius: '0 3px 3px 0',
              color: 'var(--down)',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Agent error</strong>
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: '12px 14px',
          borderTop: '1px solid var(--rule)',
          background: 'var(--paper)',
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about variants, hooks, KPI, fatigue…"
            rows={1}
            disabled={streaming}
            style={{
              flex: 1,
              background: 'var(--paper-2)',
              border: '1px solid var(--rule)',
              borderRadius: 3,
              padding: '8px 10px',
              fontSize: 13,
              fontFamily: 'var(--sans)',
              color: 'var(--ink)',
              outline: 'none',
              resize: 'none',
              minHeight: 36,
              maxHeight: 120,
            }}
          />
          <button
            onClick={sendChat}
            disabled={!input.trim() || streaming}
            style={{
              width: 36,
              height: 36,
              background: input.trim() ? 'var(--accent)' : 'var(--paper-2)',
              border: '1px solid',
              borderColor: input.trim() ? 'var(--accent)' : 'var(--rule)',
              color: 'var(--ink)',
              borderRadius: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: streaming ? 'wait' : input.trim() ? 'pointer' : 'not-allowed',
              opacity: streaming ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {streaming ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </aside>
  )
}

function Message({ role, content, streaming, working, partial }) {
  const isUser = role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '92%',
          padding: '10px 13px',
          borderRadius: 3,
          background: isUser ? 'var(--accent-soft)' : partial ? 'var(--down-soft)' : 'var(--paper-2)',
          border: `1px solid ${isUser ? 'var(--accent)' : partial ? 'var(--down)' : 'var(--rule)'}`,
          color: 'var(--ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: partial ? 'var(--down)' : 'var(--ink-3)',
            marginBottom: 6,
            fontWeight: 500,
          }}
        >
          {isUser ? 'You' : 'Analyst'}
          {partial && ' · partial (stream cut off)'}
        </div>
        <div
          style={{
            fontFamily: isUser ? 'var(--sans)' : 'var(--serif)',
            fontSize: isUser ? 13 : 14,
            fontStyle: working ? 'italic' : 'normal',
            color: working ? 'var(--ink-3)' : 'inherit',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {content}
          {streaming && <span style={{ opacity: 0.5 }}>▎</span>}
        </div>
      </div>
    </div>
  )
}
