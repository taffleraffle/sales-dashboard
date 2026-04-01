import { useState, useMemo } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useEngagementData } from '../hooks/useEngagementData'
import { Bot, Loader2, ChevronDown, ChevronUp, Filter } from 'lucide-react'

const SEQ_COLORS = {
  pre_call: 'bg-emerald-500/20 text-emerald-400',
  after_hours: 'bg-blue-500/20 text-blue-400',
  post_call: 'bg-purple-500/20 text-purple-400',
  re_engage: 'bg-amber-500/20 text-amber-400',
  non_responsive_confirm: 'bg-red-500/20 text-red-400',
}

const STATUS_COLORS = {
  active: 'bg-emerald-500/20 text-emerald-400',
  completed: 'bg-text-400/20 text-text-secondary',
  handed_off: 'bg-amber-500/20 text-amber-400',
  stopped: 'bg-red-500/20 text-red-400',
}

const SEQ_LABELS = {
  pre_call: 'Pre-Call',
  after_hours: 'Speed to Lead',
  post_call: 'Post-Call',
  re_engage: 'Re-Engage',
  non_responsive_confirm: 'Non-Responsive',
}

function Badge({ text, colorMap }) {
  const cls = colorMap?.[text] || 'bg-text-400/20 text-text-secondary'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {SEQ_LABELS[text] || (text || 'unknown').replace(/_/g, ' ')}
    </span>
  )
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
}

function ConversationRow({ convo }) {
  const [expanded, setExpanded] = useState(false)
  const messages = convo.messages || []
  const lastMsg = messages.slice(-1)[0]

  return (
    <>
      <tr
        className="border-b border-border-default/50 hover:bg-bg-card-hover transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-3 px-3">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronUp size={14} className="text-text-400" /> : <ChevronDown size={14} className="text-text-400" />}
            <div>
              <p className="text-sm text-text-primary font-medium">{convo.prospect_name || 'Unknown'}</p>
              <p className="text-[10px] text-text-400 font-mono">{convo.prospect_phone}</p>
            </div>
          </div>
        </td>
        <td className="py-3 px-3"><Badge text={convo.sequence_type} colorMap={SEQ_COLORS} /></td>
        <td className="py-3 px-3"><Badge text={convo.status} colorMap={STATUS_COLORS} /></td>
        <td className="py-3 px-3 text-sm text-text-primary">{messages.length}</td>
        <td className="py-3 px-3">
          {convo.last_prospect_reply_at
            ? <span className="text-emerald-400 text-xs">Replied</span>
            : <span className="text-text-400 text-xs">No reply</span>
          }
        </td>
        <td className="py-3 px-3 text-sm text-text-secondary">{convo.setter_name || ''}</td>
        <td className="py-3 px-3 text-sm text-text-secondary">{timeAgo(convo.updated_at)}</td>
        <td className="py-3 px-3 text-sm text-text-secondary max-w-[200px] truncate">
          {lastMsg?.direction === 'inbound' && <span className="text-emerald-400 mr-1">&larr;</span>}
          {lastMsg?.direction === 'outbound' && <span className="text-blue-400 mr-1">&rarr;</span>}
          {lastMsg?.content?.slice(0, 50) || ''}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <div className="bg-bg-primary/50 border-t border-border-default px-6 py-4 max-h-[400px] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] text-text-400 uppercase tracking-wider font-semibold">Conversation History</p>
                {convo.appointment_time && (
                  <p className="text-[10px] text-text-400">Call: {formatTime(convo.appointment_time)}</p>
                )}
              </div>
              {messages.length === 0 ? (
                <p className="text-text-400 text-sm">No messages yet</p>
              ) : (
                <div className="space-y-2">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-xl px-3 py-2 ${
                        msg.direction === 'outbound'
                          ? 'bg-blue-500/15 border border-blue-500/20'
                          : 'bg-bg-card border border-border-default'
                      }`}>
                        <p className="text-sm text-text-primary">{msg.content}</p>
                        <p className="text-[9px] text-text-400 mt-1">
                          {msg.direction === 'outbound' ? (convo.setter_name || 'Bot') : (convo.prospect_name || 'Prospect')}
                          {msg.time && ` \u00b7 ${formatTime(msg.time)}`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function SetterBot() {
  const [range, setRange] = useState(30)
  const [leadFilter, setLeadFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { conversations, stats, setterStats, loading } = useEngagementData(range)

  const filteredLeads = useMemo(() => {
    let filtered = [...conversations]

    if (leadFilter === 'contacted') {
      filtered = filtered.filter(c => (c.messages || []).some(m => m.direction === 'outbound'))
    } else if (leadFilter === 'replied') {
      filtered = filtered.filter(c => c.last_prospect_reply_at)
    } else if (leadFilter === 'booked') {
      filtered = filtered.filter(c => c.booking_state === 'confirmed')
    } else if (leadFilter === 'active') {
      filtered = filtered.filter(c => c.status === 'active')
    } else if (leadFilter === 'handed_off') {
      filtered = filtered.filter(c => c.status === 'handed_off')
    } else if (leadFilter === 'stopped') {
      filtered = filtered.filter(c => c.status === 'stopped')
    } else if (leadFilter === 'no_reply') {
      filtered = filtered.filter(c => !c.last_prospect_reply_at && (c.messages || []).some(m => m.direction === 'outbound'))
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(c =>
        (c.prospect_name || '').toLowerCase().includes(q) ||
        (c.prospect_phone || '').includes(q) ||
        (c.setter_name || '').toLowerCase().includes(q)
      )
    }

    return filtered
  }, [conversations, leadFilter, searchQuery])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-opt-yellow" />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div className="flex items-center gap-3">
          <Bot className="w-6 h-6 text-opt-yellow" />
          <h1 className="text-xl sm:text-2xl font-bold text-text-primary">Setter Bot</h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-400">
            Dry Run
          </span>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
        <KPICard label="Conversations" value={stats.total} highlight />
        <KPICard label="Active" value={stats.active} />
        <KPICard label="Reply Rate" value={`${stats.replyRate}%`} target={40} />
        <KPICard label="Sent" value={stats.outbound} />
        <KPICard label="Received" value={stats.inbound} />
        <KPICard label="Booked" value={stats.booked} />
        <KPICard label="Handoffs" value={stats.handedOff} />
        <KPICard label="Stopped" value={stats.stopped} />
      </div>

      {/* Gauge Row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Gauge label="Reply Rate" value={parseFloat(stats.replyRate) || 0} target={40} />
        <Gauge label="Booking Rate" value={parseFloat(stats.bookingRate) || 0} target={15} />
        <Gauge label="Handoff Rate" value={stats.total > 0 ? parseFloat(((stats.handedOff / stats.total) * 100).toFixed(1)) : 0} target={10} direction="below" />
      </div>

      {/* Sequence Breakdown + Setter Cards Row */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        {/* Sequence Breakdown */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">By Sequence</h2>
          <div className="space-y-2">
            {Object.entries(stats.bySequence).map(([seq, count]) => (
              <div key={seq} className="flex items-center justify-between">
                <Badge text={seq} colorMap={SEQ_COLORS} />
                <span className="text-text-primary font-bold">{count}</span>
              </div>
            ))}
            {Object.keys(stats.bySequence).length === 0 && (
              <p className="text-text-400 text-sm">No data yet</p>
            )}
          </div>
        </div>

        {/* Per-Setter Cards */}
        {setterStats.map(s => (
          <div key={s.id} className="bg-bg-card border border-border-default rounded-2xl p-5 hover:border-border-default/60 transition-all">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-opt-yellow/10 flex items-center justify-center">
                <span className="text-opt-yellow font-bold text-sm">{s.name?.[0]}</span>
              </div>
              <div>
                <p className="text-text-primary font-semibold">{s.name}</p>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">{s.role}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Convos</p>
                <p className="text-text-primary font-bold text-lg">{s.convos}</p>
              </div>
              <div>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Replies</p>
                <p className="text-text-primary font-bold text-lg">{s.replies}</p>
              </div>
              <div>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Reply Rate</p>
                <p className={`font-bold text-lg ${parseFloat(s.replyRate) >= 40 ? 'text-success' : 'text-text-primary'}`}>{s.replyRate}%</p>
              </div>
              <div>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Booked</p>
                <p className="text-opt-yellow font-bold text-lg">{s.booked}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Leads Table */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">All Leads</h2>
          <div className="flex items-center gap-2">
            {/* Search */}
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search name or phone..."
              className="bg-bg-primary border border-border-default rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-400 w-48 focus:outline-none focus:border-opt-yellow/40"
            />
            {/* Filter Dropdown */}
            <div className="relative">
              <select
                value={leadFilter}
                onChange={e => setLeadFilter(e.target.value)}
                className="appearance-none bg-bg-primary border border-border-default rounded-lg px-3 py-1.5 pr-8 text-xs text-text-primary focus:outline-none focus:border-opt-yellow/40 cursor-pointer"
              >
                <option value="all">All Leads ({conversations.length})</option>
                <option value="contacted">Contacted ({conversations.filter(c => (c.messages || []).some(m => m.direction === 'outbound')).length})</option>
                <option value="replied">Replied ({conversations.filter(c => c.last_prospect_reply_at).length})</option>
                <option value="no_reply">No Reply ({conversations.filter(c => !c.last_prospect_reply_at && (c.messages || []).some(m => m.direction === 'outbound')).length})</option>
                <option value="booked">Booked ({conversations.filter(c => c.booking_state === 'confirmed').length})</option>
                <option value="active">Active ({conversations.filter(c => c.status === 'active').length})</option>
                <option value="handed_off">Handed Off ({conversations.filter(c => c.status === 'handed_off').length})</option>
                <option value="stopped">Stopped ({conversations.filter(c => c.status === 'stopped').length})</option>
              </select>
              <Filter size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-400 pointer-events-none" />
            </div>
          </div>
        </div>

        {filteredLeads.length === 0 ? (
          <p className="text-text-400 text-sm py-8 text-center">
            {conversations.length === 0 ? 'No conversations yet. Bot is in dry run mode.' : 'No leads match this filter.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Prospect</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Sequence</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Status</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Msgs</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Reply</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Setter</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Activity</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map(c => (
                  <ConversationRow key={c.id} convo={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 text-[10px] text-text-400">
          Showing {filteredLeads.length} of {conversations.length} leads
        </div>
      </div>
    </div>
  )
}
