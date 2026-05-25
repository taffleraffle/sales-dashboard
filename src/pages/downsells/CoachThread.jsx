// CoachThread — minimum-viable chat. Bubbles + input + send. Nothing else.
// No retry button (auto-retries on first failure), no flag button, no
// lock-in button, no offer snapshot, no status pills. Anything beyond
// "type, send, read the reply" was getting in the way.

import { useState, useEffect, useRef } from 'react'
import { Loader, Send, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'

export function CoachThread({ thread, messages, onChange }) {
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const [err, setErr]             = useState(null)
  const threadEndRef = useRef(null)
  const prevLengthRef = useRef(messages.length)

  // If the only message is the closer's opener and there's no coach reply
  // yet (initial coach call failed silently), auto-retry on mount once.
  const needsAutoRetry = !thread.locked_at
    && messages.length === 1
    && messages[0].role === 'closer'
  const retriedRef = useRef(false)

  useEffect(() => {
    if (!needsAutoRetry || retriedRef.current) return
    retriedRef.current = true
    ;(async () => {
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
    })()
  }, [needsAutoRetry, thread.id, onChange])

  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevLengthRef.current = messages.length
  }, [messages.length])

  async function sendReply(e) {
    e?.preventDefault()
    if (!replyText.trim() || sending) return
    setSending(true); setErr(null)
    const message = replyText.trim()
    setReplyText('')
    try {
      const { data, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
        body: { thread_id: thread.id, new_message: message },
      })
      if (invErr) throw invErr
      if (data?.error) throw new Error(data.error)
      await onChange()
    } catch (e) {
      setErr(e.message || String(e))
      setReplyText(message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      {/* Chat history */}
      <div className="space-y-3 mb-4">
        {messages.map(m => <Bubble key={m.id} message={m} />)}
        {sending && messages[messages.length - 1]?.role === 'closer' && (
          <div className="flex justify-start">
            <div className="p-3" style={{ background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 3, fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              <Loader size={12} className="animate-spin inline-block mr-2" style={{ verticalAlign: 'middle' }} />
              Thinking…
            </div>
          </div>
        )}
        <div ref={threadEndRef} />
      </div>

      {err && (
        <div className="tile tile-feedback p-3 mb-3 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0, fontFamily: 'var(--mono)' }}>{err}</p>
        </div>
      )}

      {/* Input */}
      <form onSubmit={sendReply}>
        <div className="flex items-end gap-2">
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                sendReply()
              }
            }}
            placeholder="Reply…"
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

function Bubble({ message }) {
  const isCloser = message.role === 'closer'
  return (
    <div className="flex" style={{ justifyContent: isCloser ? 'flex-end' : 'flex-start' }}>
      <div className="p-3" style={{
        maxWidth: '85%',
        background: isCloser ? 'var(--ink)' : 'var(--paper)',
        color: isCloser ? 'var(--paper)' : 'var(--ink)',
        border: isCloser ? '1px solid var(--ink)' : '1px solid var(--rule)',
        borderRadius: 3,
        fontSize: 13,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
      }}>
        {message.content}
      </div>
    </div>
  )
}
