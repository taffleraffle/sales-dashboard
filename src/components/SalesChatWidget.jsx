import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageSquare, X, Send, Loader, Trash2, Maximize2, Minimize2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { buildSalesContext } from '../services/salesIntelligence'

const SUGGESTED_QUESTIONS = [
  'What time of day has the best show rate?',
  'What time of day has the best close rate?',
  'What are our close rates and show rates?',
  'Give me a full funnel breakdown for the last 30 days',
  'How are the setters performing this week?',
  'How many dials has each setter done this week?',
  'What is our cost per acquisition?',
  'Compare closer performance this month',
  'What day of the week gets the most leads?',
  'What is our speed to lead average?',
]

function parseMarkdown(text) {
  // Simple markdown to HTML: bold, tables, headers, lists
  let html = text
    // Code blocks
    .replace(/```[\s\S]*?```/g, m => `<pre class="bg-bg-primary rounded px-3 py-2 text-xs overflow-x-auto my-2">${m.slice(3, -3).trim()}</pre>`)
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="text-xs font-semibold text-opt-yellow mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="text-sm font-semibold text-opt-yellow mt-3 mb-1">$1</h3>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>')
    // Tables
    .replace(/^\|(.+)\|$/gm, (match) => {
      const cells = match.split('|').filter(c => c.trim())
      const isHeader = cells.every(c => /^[\s-:]+$/.test(c))
      if (isHeader) return ''
      const tag = 'td'
      return `<tr>${cells.map(c => `<${tag} class="px-2 py-1 border-b border-border-default text-xs">${c.trim()}</${tag}>`).join('')}</tr>`
    })
    // Bullet lists
    .replace(/^[•\-\*] (.+)$/gm, '<li class="ml-3 text-xs">$1</li>')
    // Line breaks
    .replace(/\n\n/g, '<br/>')
    .replace(/\n/g, '<br/>')

  // Wrap table rows
  if (html.includes('<tr>')) {
    html = html.replace(/(<tr>[\s\S]*?<\/tr>(\s*<br\/>)?)+/g, m =>
      `<table class="w-full border-collapse my-2 text-xs">${m.replace(/<br\/>/g, '')}</table>`
    )
    // First row in each table becomes header
    html = html.replace(/<table([^>]*)><tr>([\s\S]*?)<\/tr>/g, (m, attrs, cells) =>
      `<table${attrs}><tr>${cells.replace(/<td/g, '<th').replace(/<\/td/g, '</th')}</tr>`
    )
  }

  return html
}

export default function SalesChatWidget() {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const messagesContainerRef = useRef(null)
  const userScrolledUpRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    if (userScrolledUpRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Track if user has scrolled up
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    userScrolledUpRef.current = distFromBottom > 80
  }, [])

  // Auto-scroll only when near bottom
  useEffect(() => { if (open) scrollToBottom() }, [messages, streamingText, open, scrollToBottom])
  // Reset scroll lock when new user message is sent
  useEffect(() => { userScrolledUpRef.current = false }, [messages.length])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const contextRef = useRef(null)
  const contextLoadingRef = useRef(false)

  const ensureContext = async () => {
    if (contextRef.current) return contextRef.current
    if (contextLoadingRef.current) {
      // Wait for existing load
      while (contextLoadingRef.current) await new Promise(r => setTimeout(r, 100))
      return contextRef.current
    }
    contextLoadingRef.current = true
    try {
      contextRef.current = await buildSalesContext()
    } catch (err) {
      console.error('Failed to build context:', err)
      contextRef.current = 'Data context unavailable. Answer based on general knowledge.'
    }
    contextLoadingRef.current = false
    return contextRef.current
  }

  // Refresh context every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => { contextRef.current = null }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const sendMessage = async (text) => {
    if (!text?.trim() || streaming) return
    const userMsg = { role: 'user', content: text.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setStreamingText('')

    try {
      // Build data context (cached for 5 min)
      const systemPrompt = await ensureContext()

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const chatMessages = [
        ...messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: text.trim() },
      ]

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sales-chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ systemPrompt, messages: chatMessages }),
        }
      )

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        let errMsg
        try { errMsg = JSON.parse(errText).error } catch { errMsg = errText }
        throw new Error(errMsg || `HTTP ${res.status}`)
      }

      // Parse SSE stream from Claude
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text
              setStreamingText(fullText)
            }
          } catch {}
        }
      }

      if (fullText) {
        setMessages(prev => [...prev, { role: 'assistant', content: fullText }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    }
    setStreamingText('')
    setStreaming(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const clearChat = () => {
    setMessages([])
    setStreamingText('')
  }

  const widgetSize = expanded
    ? 'fixed inset-0 z-[100]'
    : 'fixed bottom-20 md:bottom-6 right-4 md:right-6 w-[calc(100vw-2rem)] md:w-[480px] h-[70vh] md:h-[600px] z-[100]'

  return (
    <>
      {/* Toggle button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-[100] w-14 h-14 rounded-full bg-opt-yellow text-bg-primary shadow-[0_0_30px_rgba(212,245,12,0.3)] hover:shadow-[0_0_40px_rgba(212,245,12,0.5)] flex items-center justify-center transition-all hover:scale-105 active:scale-95"
        >
          <MessageSquare size={24} />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className={`${widgetSize} flex flex-col bg-bg-card border border-border-default shadow-2xl overflow-hidden ${expanded ? 'rounded-none' : 'rounded-2xl'}`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-bg-sidebar shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-opt-yellow flex items-center justify-center">
                <MessageSquare size={16} className="text-bg-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary leading-tight">Sales Intelligence</h3>
                <p className="text-[10px] text-text-400">Ask anything about your sales data</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button onClick={clearChat} className="p-1.5 rounded-lg text-text-400 hover:text-danger hover:bg-danger/10 transition-colors" title="Clear chat">
                  <Trash2 size={14} />
                </button>
              )}
              <button onClick={() => setExpanded(e => !e)} className="p-1.5 rounded-lg text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-colors" title={expanded ? 'Minimize' : 'Expand'}>
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button onClick={() => { setOpen(false); setExpanded(false) }} className="p-1.5 rounded-lg text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 && !streaming && (
              <div className="space-y-4 pt-2">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-full bg-opt-yellow/10 border border-opt-yellow/20 flex items-center justify-center mx-auto mb-3">
                    <MessageSquare size={20} className="text-opt-yellow" />
                  </div>
                  <h4 className="text-sm font-semibold mb-1">Sales Intelligence</h4>
                  <p className="text-xs text-text-400">Ask me anything about leads, performance, revenue, marketing — all your sales data in one place.</p>
                </div>
                <div className="space-y-1.5">
                  <p className="text-[10px] text-text-400 uppercase font-medium px-1">Try asking...</p>
                  {SUGGESTED_QUESTIONS.map((q, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(q)}
                      className="w-full text-left px-3 py-2 rounded-xl bg-bg-primary border border-border-default hover:border-opt-yellow/30 hover:bg-bg-card-hover text-xs text-text-secondary transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                  msg.role === 'user'
                    ? 'bg-opt-yellow text-bg-primary rounded-br-md'
                    : 'bg-bg-primary border border-border-default rounded-bl-md'
                }`}>
                  {msg.role === 'user' ? (
                    <p className="text-sm">{msg.content}</p>
                  ) : (
                    <div
                      className="text-xs text-text-secondary leading-relaxed prose-chat"
                      dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }}
                    />
                  )}
                </div>
              </div>
            ))}

            {streaming && streamingText && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-md px-3.5 py-2.5 bg-bg-primary border border-border-default">
                  <div
                    className="text-xs text-text-secondary leading-relaxed prose-chat"
                    dangerouslySetInnerHTML={{ __html: parseMarkdown(streamingText) }}
                  />
                </div>
              </div>
            )}

            {streaming && !streamingText && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md px-3.5 py-2.5 bg-bg-primary border border-border-default">
                  <div className="flex items-center gap-2 text-xs text-text-400">
                    <Loader size={12} className="animate-spin" />
                    <span>Analyzing your sales data...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-border-default px-3 py-2.5 bg-bg-sidebar">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about leads, performance, revenue..."
                rows={1}
                className="flex-1 bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary placeholder-text-400 outline-none focus:border-opt-yellow/40 resize-none max-h-24"
                style={{ minHeight: '36px' }}
                disabled={streaming}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || streaming}
                className="w-9 h-9 rounded-xl bg-opt-yellow text-bg-primary flex items-center justify-center shrink-0 disabled:opacity-30 hover:brightness-110 transition-all"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
