import { useState, useEffect, useRef, useCallback } from 'react'
import { Headphones, RefreshCw, Plus, Search, X, ExternalLink, ChevronDown, ChevronUp, Send, Loader, Trash2, User, Clock, Phone, Users } from 'lucide-react'
import { useCallData, useCallStats } from '../hooks/useCallData'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { syncFathomAllMembers } from '../services/fathomSync'
import { buildTranscriptContext } from '../services/transcriptChat'
import AddTranscriptModal from '../components/AddTranscriptModal'
import { supabase } from '../lib/supabase'

// ── Markdown parser (reused from SalesChatWidget) ──
function parseMarkdown(text) {
  let html = text
    .replace(/```[\s\S]*?```/g, m => `<pre class="bg-bg-primary rounded px-3 py-2 text-xs overflow-x-auto my-2">${m.slice(3, -3).trim()}</pre>`)
    .replace(/^### (.+)$/gm, '<h4 class="text-xs font-semibold text-opt-yellow mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="text-sm font-semibold text-opt-yellow mt-3 mb-1">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>')
    .replace(/^\|(.+)\|$/gm, (match) => {
      const cells = match.split('|').filter(c => c.trim())
      if (cells.every(c => /^[\s-:]+$/.test(c))) return ''
      return `<tr>${cells.map(c => `<td class="px-2 py-1 border-b border-border-default text-xs">${c.trim()}</td>`).join('')}</tr>`
    })
    .replace(/^[•\-\*] (.+)$/gm, '<li class="ml-3 text-xs">$1</li>')
    .replace(/\n\n/g, '<br/>').replace(/\n/g, '<br/>')
  if (html.includes('<tr>')) {
    html = html.replace(/(<tr>[\s\S]*?<\/tr>(\s*<br\/>)?)+/g, m =>
      `<table class="w-full border-collapse my-2 text-xs">${m.replace(/<br\/>/g, '')}</table>`)
    html = html.replace(/<table([^>]*)><tr>([\s\S]*?)<\/tr>/g, (m, attrs, cells) =>
      `<table${attrs}><tr>${cells.replace(/<td/g, '<th').replace(/<\/td/g, '</th')}</tr>`)
  }
  return html
}

// ── Outcome badge ──
const outcomeBadge = (outcome) => {
  if (!outcome) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-primary text-text-400 border border-border-default">pending</span>
  const colors = {
    closed: 'bg-success/15 text-success border-success/30',
    ascended: 'bg-success/15 text-success border-success/30',
    not_closed: 'bg-text-400/10 text-text-400 border-text-400/20',
    no_show: 'bg-danger/15 text-danger border-danger/30',
    rescheduled: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  }
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${colors[outcome] || colors.not_closed}`}>{outcome.replace('_', ' ')}</span>
}

// ── Format duration ──
const fmtDur = (s) => {
  if (!s) return '-'
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

// ── Suggested questions for AI chat ──
const SUGGESTED = [
  'What objections came up this week?',
  'How did Daniel handle pricing objections?',
  'What patterns do closed deals have in common?',
  'Compare call techniques between team members',
  'What are the most common reasons for no-shows?',
  'Summarize the last 5 calls',
]

// ── Transcript Card ──
function TranscriptCard({ t }) {
  const [expanded, setExpanded] = useState(false)
  const memberName = t.member?.name || 'Unassigned'
  const sourceBadge = t.source === 'manual'
    ? <span className="text-[9px] px-1 py-0.5 rounded bg-blue-400/10 text-blue-400">manual</span>
    : null

  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-3 hover:border-border-default/60 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">{t.prospect_name || 'Unknown'}</span>
            {outcomeBadge(t.outcome)}
            {sourceBadge}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-text-400">
            <span className="flex items-center gap-1"><User size={10} />{memberName}</span>
            <span>{t.meeting_date}</span>
            <span className="flex items-center gap-1"><Clock size={10} />{fmtDur(t.duration_seconds)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {t.transcript_url && (
            <a href={t.transcript_url} target="_blank" rel="noopener noreferrer"
              className="p-1 rounded-lg text-text-400 hover:text-opt-yellow hover:bg-opt-yellow/10 transition-colors" title="Open in Fathom">
              <ExternalLink size={14} />
            </a>
          )}
          <button onClick={() => setExpanded(!expanded)}
            className="p-1 rounded-lg text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {!expanded && t.summary && (
        <p className="text-[11px] text-text-400 mt-2 line-clamp-2">{t.summary.slice(0, 200)}</p>
      )}

      {expanded && t.summary && (
        <div className="mt-3 pt-3 border-t border-border-default text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
          {t.summary}
        </div>
      )}
    </div>
  )
}

// ── Main Page ──
export default function CallData() {
  const { members } = useTeamMembers()
  const { stats } = useCallStats()

  // Filters
  const [search, setSearch] = useState('')
  const [memberId, setMemberId] = useState('')
  const [dateRange, setDateRange] = useState('30')
  const [outcome, setOutcome] = useState('')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  const sinceDate = dateRange === 'all' ? '' : (() => {
    const d = new Date(); d.setDate(d.getDate() - parseInt(dateRange)); return d.toISOString().split('T')[0]
  })()

  const { transcripts, total, loading, reload } = useCallData({
    search, memberId, sinceDate, outcome,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  })

  // Sync state
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)
  const handleSync = async () => {
    setSyncing(true); setSyncMsg('Syncing Fathom...')
    try {
      const result = await syncFathomAllMembers()
      setSyncMsg(result.message)
      reload()
    } catch (err) { setSyncMsg('Sync failed: ' + err.message) }
    setSyncing(false)
    setTimeout(() => setSyncMsg(null), 4000)
  }

  // Add transcript modal
  const [showAdd, setShowAdd] = useState(false)

  // ── AI Chat state ──
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatStreaming, setChatStreaming] = useState(false)
  const [chatStreamText, setChatStreamText] = useState('')
  const chatEndRef = useRef(null)
  const chatContextRef = useRef(null)

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatMessages, chatStreamText])

  // Invalidate context when filters change
  useEffect(() => { chatContextRef.current = null }, [memberId, sinceDate])

  const sendChat = async (text) => {
    if (!text?.trim() || chatStreaming) return
    setChatMessages(prev => [...prev, { role: 'user', content: text.trim() }])
    setChatInput('')
    setChatStreaming(true)
    setChatStreamText('')

    try {
      if (!chatContextRef.current) {
        chatContextRef.current = await buildTranscriptContext({ memberId, sinceDate })
      }

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const msgs = [
        ...chatMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: text.trim() },
      ]

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sales-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ systemPrompt: chatContextRef.current, messages: msgs }),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(errText)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = '', buffer = ''

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
              setChatStreamText(fullText)
            }
          } catch {}
        }
      }

      if (fullText) setChatMessages(prev => [...prev, { role: 'assistant', content: fullText }])
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    }
    setChatStreamText('')
    setChatStreaming(false)
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-opt-yellow/10 border border-opt-yellow/20 flex items-center justify-center">
            <Headphones size={20} className="text-opt-yellow" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Call Data</h1>
            <p className="text-xs text-text-400">{total} transcript{total !== 1 ? 's' : ''} found</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-[11px] text-text-400">{syncMsg}</span>}
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs border border-border-default rounded-xl hover:bg-bg-card-hover transition-colors text-text-secondary disabled:opacity-50">
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />Sync Fathom
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-opt-yellow text-bg-primary rounded-xl font-medium hover:brightness-110">
            <Plus size={13} />Add Transcript
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { icon: Phone, label: 'Total Calls', value: stats.totalCalls },
          { icon: Clock, label: 'Total Hours', value: stats.totalHours + 'h' },
          { icon: Headphones, label: 'This Week', value: stats.callsThisWeek },
          { icon: Users, label: 'Team Members', value: stats.memberCount },
        ].map((s, i) => (
          <div key={i} className="bg-bg-card border border-border-default rounded-xl p-3">
            <div className="flex items-center gap-2 text-text-400 mb-1">
              <s.icon size={13} />
              <span className="text-[11px]">{s.label}</span>
            </div>
            <span className="text-lg font-semibold text-text-primary">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search prospects or transcripts..."
            className="w-full bg-bg-card border border-border-default rounded-xl pl-9 pr-8 py-2 text-sm text-text-primary placeholder-text-400 outline-none focus:border-opt-yellow/40" />
          {search && <button onClick={() => { setSearch(''); setPage(0) }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-400 hover:text-text-primary"><X size={14} /></button>}
        </div>
        <select value={memberId} onChange={e => { setMemberId(e.target.value); setPage(0) }}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40">
          <option value="">All Members</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={dateRange} onChange={e => { setDateRange(e.target.value); setPage(0) }}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40">
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
        <select value={outcome} onChange={e => { setOutcome(e.target.value); setPage(0) }}
          className="bg-bg-card border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40">
          <option value="">All Outcomes</option>
          <option value="closed">Closed</option>
          <option value="not_closed">Not Closed</option>
          <option value="no_show">No Show</option>
          <option value="rescheduled">Rescheduled</option>
        </select>
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Transcript list */}
        <div className="lg:col-span-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-text-400">
              <Loader size={20} className="animate-spin mr-2" />Loading...
            </div>
          ) : transcripts.length === 0 ? (
            <div className="text-center py-16 text-text-400 text-sm">
              No transcripts found. Click "Sync Fathom" to pull calls, or "Add Transcript" to add one manually.
            </div>
          ) : (
            <>
              {transcripts.map(t => <TranscriptCard key={t.id} t={t} />)}
              {/* Pagination */}
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[11px] text-text-400">Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
                  <div className="flex gap-1">
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      className="px-3 py-1 text-xs border border-border-default rounded-lg text-text-secondary hover:bg-bg-card-hover disabled:opacity-30">Prev</button>
                    <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total}
                      className="px-3 py-1 text-xs border border-border-default rounded-lg text-text-secondary hover:bg-bg-card-hover disabled:opacity-30">Next</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: AI Chat */}
        <div className="lg:col-span-2 bg-bg-card border border-border-default rounded-2xl flex flex-col h-[600px] lg:sticky lg:top-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-default shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-opt-yellow/15 flex items-center justify-center">
                <Headphones size={14} className="text-opt-yellow" />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-text-primary">Transcript Intelligence</h3>
                <p className="text-[10px] text-text-400">Ask about your calls</p>
              </div>
            </div>
            {chatMessages.length > 0 && (
              <button onClick={() => { setChatMessages([]); setChatStreamText(''); chatContextRef.current = null }}
                className="p-1.5 rounded-lg text-text-400 hover:text-danger hover:bg-danger/10 transition-colors" title="Clear">
                <Trash2 size={13} />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {chatMessages.length === 0 && !chatStreaming && (
              <div className="space-y-3 pt-1">
                <p className="text-[10px] text-text-400 uppercase font-medium">Try asking...</p>
                {SUGGESTED.map((q, i) => (
                  <button key={i} onClick={() => sendChat(q)}
                    className="w-full text-left px-2.5 py-1.5 rounded-xl bg-bg-primary border border-border-default hover:border-opt-yellow/30 hover:bg-bg-card-hover text-[11px] text-text-secondary transition-colors">
                    {q}
                  </button>
                ))}
              </div>
            )}

            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[90%] rounded-2xl px-3 py-2 ${
                  msg.role === 'user' ? 'bg-opt-yellow text-bg-primary rounded-br-md' : 'bg-bg-primary border border-border-default rounded-bl-md'
                }`}>
                  {msg.role === 'user' ? (
                    <p className="text-sm">{msg.content}</p>
                  ) : (
                    <div className="text-xs text-text-secondary leading-relaxed" dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }} />
                  )}
                </div>
              </div>
            ))}

            {chatStreaming && chatStreamText && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl rounded-bl-md px-3 py-2 bg-bg-primary border border-border-default">
                  <div className="text-xs text-text-secondary leading-relaxed" dangerouslySetInnerHTML={{ __html: parseMarkdown(chatStreamText) }} />
                </div>
              </div>
            )}

            {chatStreaming && !chatStreamText && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md px-3 py-2 bg-bg-primary border border-border-default">
                  <div className="flex items-center gap-2 text-xs text-text-400">
                    <Loader size={12} className="animate-spin" />Analyzing transcripts...
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          <div className="shrink-0 border-t border-border-default px-3 py-2.5">
            <div className="flex items-end gap-2">
              <textarea
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(chatInput) } }}
                placeholder="Ask about your calls..."
                rows={1}
                className="flex-1 bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary placeholder-text-400 outline-none focus:border-opt-yellow/40 resize-none max-h-20"
                style={{ minHeight: '36px' }}
                disabled={chatStreaming}
              />
              <button onClick={() => sendChat(chatInput)} disabled={!chatInput.trim() || chatStreaming}
                className="w-8 h-8 rounded-xl bg-opt-yellow text-bg-primary flex items-center justify-center shrink-0 disabled:opacity-30 hover:brightness-110">
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add Transcript Modal */}
      {showAdd && <AddTranscriptModal members={members} onClose={() => setShowAdd(false)} onSaved={reload} />}
    </div>
  )
}
