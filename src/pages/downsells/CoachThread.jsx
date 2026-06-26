// CoachThread — bubbles + input in a bounded container.
// - Enter sends, Shift+Enter newline (standard chat behaviour).
// - Closer's message appears INSTANTLY via optimistic state; the
//   "Thinking…" bubble sits below it while the Edge fn is running.
//   Without the optimistic step the input would clear and nothing
//   visible would happen for 5-15s while Claude responded — felt like
//   the app froze.

import { useState, useEffect, useRef } from 'react'
import { Loader, Send, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'

export function CoachThread({ thread, messages, onChange }) {
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const [err, setErr]             = useState(null)
  // pendingMessage holds the closer's just-sent text so it renders
  // immediately as a chat bubble. Cleared after onChange() refreshes
  // the real message list from the DB.
  const [pendingMessage, setPendingMessage] = useState(null)
  const threadEndRef = useRef(null)
  const prevLengthRef = useRef(messages.length)

  const needsAutoRetry = !thread.locked_at
    && messages.length === 1
    && messages[0].role === 'closer'
  const retriedRef = useRef(false)

  async function callCoach() {
    setSending(true); setErr(null)
    try {
      const { data, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: thread.id },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await onChange()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (!needsAutoRetry || retriedRef.current) return
    retriedRef.current = true
    callCoach()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAutoRetry, thread.id])

  useEffect(() => {
    if (messages.length > prevLengthRef.current || pendingMessage) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevLengthRef.current = messages.length
  }, [messages.length, pendingMessage])

  async function sendReply(e) {
    e?.preventDefault()
    if (!replyText.trim() || sending) return
    const message = replyText.trim()
    // Optimistic — show the closer's message AND clear the input
    // immediately so the chat feels responsive while Claude runs.
    setPendingMessage(message)
    setReplyText('')
    setSending(true); setErr(null)
    try {
      const { data, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: thread.id, new_message: message },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await onChange()
      setPendingMessage(null)
    } catch (e) {
      setErr(e.message || String(e))
      setReplyText(message)
      setPendingMessage(null)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="tile tile-feedback" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      {/* Header strip — matches the right pane's "Coaching context" header
          for visual rhythm */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--rule)', background: 'var(--paper-2)' }}>
        <span className="eyebrow eyebrow-bare" style={{ fontSize: 10 }}>Chat with coach</span>
      </div>

      {/* Chat history */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', minHeight: 360 }}>
        <div className="space-y-3">
          {messages.map(m => <Bubble key={m.id} message={m} />)}
          {pendingMessage && (
            <Bubble message={{ role: 'closer', content: pendingMessage, created_at: new Date().toISOString() }} optimistic />
          )}
          {sending && (
            <div className="flex justify-start">
              <div className="p-3" style={{ background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 9, fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Loader size={12} className="animate-spin" />
                <span>Thinking…</span>
              </div>
            </div>
          )}
          <div ref={threadEndRef} />
        </div>
      </div>

      {err && (
        <div className="p-3 flex items-start gap-3" style={{ borderTop: '1px solid var(--rule)', borderLeft: '3px solid var(--down)', background: 'rgba(181,62,62,0.04)' }}>
          <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <div className="flex-1">
            <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0, fontFamily: 'var(--mono)' }}>{err}</p>
            <button
              type="button"
              onClick={callCoach}
              disabled={sending}
              style={{
                marginTop: 6,
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontSize: 11,
                color: 'var(--ink)',
                textDecoration: 'underline',
                cursor: sending ? 'default' : 'pointer',
                opacity: sending ? 0.5 : 1,
              }}
            >
              {sending ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={sendReply} style={{ borderTop: '1px solid var(--rule)', padding: '10px 12px', background: 'var(--paper)' }}>
        <div className="flex items-end gap-2">
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => {
              // Enter sends; Shift+Enter inserts a newline. Standard chat
              // ergonomics — previously required Cmd/Ctrl+Enter which
              // nobody discovered.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendReply()
              }
            }}
            placeholder="Reply… (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="editorial-input flex-1"
            style={{ resize: 'vertical' }}
            disabled={sending}
          />
          <button type="submit" disabled={sending || !replyText.trim()} className="editorial-btn-primary" style={{ flexShrink: 0 }}>
            {sending ? <Loader size={ICON.sm} className="animate-spin" /> : <Send size={ICON.sm} />}
          </button>
        </div>
      </form>
    </div>
  )
}

function Bubble({ message, optimistic }) {
  const isCloser = message.role === 'closer'
  return (
    <div className="flex" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
      <div className="p-3" style={{
        maxWidth: '85%',
        background: isCloser ? 'var(--ink)' : 'var(--paper)',
        color: isCloser ? 'var(--paper)' : 'var(--ink)',
        border: isCloser ? '1px solid var(--ink)' : '1px solid var(--rule)',
        borderRadius: 9,
        fontSize: 13,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        opacity: optimistic ? 0.75 : 1,
        transition: 'opacity 200ms ease',
      }}>
        {message.content}
      </div>
    </div>
  )
}
