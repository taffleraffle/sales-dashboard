import { useState } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useEngagementData } from '../hooks/useEngagementData'
import { Bot, MessageSquare, Phone, UserX, ArrowRightLeft, Loader2 } from 'lucide-react'

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

function Badge({ text, colorMap }) {
  const cls = colorMap?.[text] || 'bg-text-400/20 text-text-secondary'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {(text || 'unknown').replace(/_/g, ' ')}
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

export default function SetterBot() {
  const [range, setRange] = useState(30)
  const { stats, setterStats, recentActivity, loading } = useEngagementData(range)

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

      {/* Sequence Breakdown */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">By Sequence Type</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(stats.bySequence).map(([seq, count]) => (
            <div key={seq} className="flex items-center gap-2">
              <Badge text={seq} colorMap={SEQ_COLORS} />
              <span className="text-text-primary font-bold">{count}</span>
            </div>
          ))}
          {Object.keys(stats.bySequence).length === 0 && (
            <p className="text-text-400 text-sm">No conversations yet</p>
          )}
        </div>
      </div>

      {/* Per-Setter Cards */}
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Setter Performance</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {setterStats.map(s => (
          <div key={s.id} className="bg-bg-card border border-border-default rounded-2xl p-5 hover:border-border-default/60 transition-all">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-opt-yellow/10 flex items-center justify-center">
                  <span className="text-opt-yellow font-bold text-sm">{s.name?.[0]}</span>
                </div>
                <div>
                  <p className="text-text-primary font-semibold">{s.name}</p>
                  <p className="text-text-400 text-[10px] uppercase tracking-wider">{s.role}</p>
                </div>
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
        {setterStats.length === 0 && (
          <p className="text-text-400 text-sm col-span-3">No setters configured</p>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">Recent Activity</h2>
        {recentActivity.length === 0 ? (
          <p className="text-text-400 text-sm">No conversations yet. Bot is in dry run mode.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Prospect</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Phone</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Sequence</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Status</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Messages</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Activity</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Message</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map(c => (
                  <tr key={c.id} className="border-b border-border-default/50 hover:bg-bg-card-hover transition-colors">
                    <td className="py-3 px-3 text-sm text-text-primary font-medium">{c.prospect_name || 'Unknown'}</td>
                    <td className="py-3 px-3 text-sm text-text-secondary font-mono">{c.prospect_phone}</td>
                    <td className="py-3 px-3"><Badge text={c.sequence_type} colorMap={SEQ_COLORS} /></td>
                    <td className="py-3 px-3"><Badge text={c.status} colorMap={STATUS_COLORS} /></td>
                    <td className="py-3 px-3 text-sm text-text-primary">{(c.messages || []).length}</td>
                    <td className="py-3 px-3 text-sm text-text-secondary">{timeAgo(c.lastTime)}</td>
                    <td className="py-3 px-3 text-sm text-text-secondary max-w-[200px] truncate">
                      {c.lastDirection === 'inbound' && <span className="text-emerald-400 mr-1">&#8592;</span>}
                      {c.lastDirection === 'outbound' && <span className="text-blue-400 mr-1">&#8594;</span>}
                      {c.lastMessage?.slice(0, 60) || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
