import { useState } from 'react'
import { Loader, Calendar, Phone, CheckCircle, ChevronDown, MessageSquare, Mail, PhoneCall, ArrowDownLeft, ArrowUpRight, AlertTriangle } from 'lucide-react'

const tierStyles = {
  critical: 'bg-danger/10 border-l-2 border-danger',
  warning: 'bg-warning/10 border-l-2 border-warning',
  monitor: 'bg-blue-500/5 border-l-2 border-blue-500/40',
  confirmed: '',
  cancel_risk: 'bg-danger/10 border-l-2 border-danger',
}

const tierBadge = {
  critical: 'bg-danger/15 text-danger border-danger/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  monitor: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  confirmed: 'bg-success/15 text-success border-success/30',
  cancel_risk: 'bg-danger/15 text-danger border-danger/30',
}

const tierLabel = {
  critical: 'At Risk',
  warning: 'Warning',
  monitor: 'Monitor',
  confirmed: 'Confirmed',
  cancel_risk: 'Cancel Risk',
}

const channelIcons = {
  Call: PhoneCall,
  SMS: MessageSquare,
  Email: Mail,
  Social: MessageSquare,
}

const channelColors = {
  Call: 'text-blue-400',
  SMS: 'text-opt-yellow',
  Email: 'text-purple-400',
  Social: 'text-pink-400',
}

const tzOpts = { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

function formatTimeLeft(hours) {
  if (hours < 1) return '<1h'
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const rem = hours % 24
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`
}

function formatPhone(phone) {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return phone
}

function formatDuration(secs) {
  if (!secs || secs <= 0) return '—'
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

export default function EndangeredLeadsTable({ leads, loading, fillHeight = false }) {
  const [expandedId, setExpandedId] = useState(null)
  // `fillHeight` is opt-in because this component is also used on SalesOverview
  // as a free-standing tile where default-height + bottom-margin is correct.
  // SetterOverview passes fillHeight so it matches sibling card height in the
  // side-by-side grid layout.
  const containerCls = fillHeight
    ? 'tile tile-feedback overflow-hidden h-full flex flex-col'
    : 'tile tile-feedback overflow-hidden mb-6'

  if (loading) {
    return (
      <div className={fillHeight ? 'tile tile-feedback p-6 h-full flex flex-col' : 'tile tile-feedback p-6 mb-6'}>
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls</h2>
        </div>
        <div className={`flex items-center justify-center gap-2 text-text-400 text-xs ${fillHeight ? 'flex-1' : 'py-8'}`}>
          <Loader size={14} className="animate-spin" />
          Checking engagement signals...
        </div>
      </div>
    )
  }

  if (!leads || leads.length === 0) {
    return (
      <div className={fillHeight ? 'tile tile-feedback p-6 h-full flex flex-col' : 'tile tile-feedback p-6 mb-6'}>
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls</h2>
        </div>
        <p className={`text-xs text-text-400 text-center ${fillHeight ? 'flex-1 flex items-center justify-center' : 'py-4'}`}>No upcoming strategy calls in the next 7 days.</p>
      </div>
    )
  }

  const cancelRisk = leads.filter(l => l.tier === 'cancel_risk')
  const endangered = leads.filter(l => !l.engaged && l.tier !== 'cancel_risk')
  const confirmed = leads.filter(l => l.engaged && l.tier !== 'cancel_risk')

  return (
    <div className={containerCls}>
      <div className="px-4 py-3 border-b border-border-default flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls ({leads.length})</h2>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {cancelRisk.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-danger/15 text-danger font-medium flex items-center gap-1">
              <AlertTriangle size={9} /> {cancelRisk.length} cancel risk
            </span>
          )}
          {endangered.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
              {endangered.length} no engagement
            </span>
          )}
          {confirmed.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">
              {confirmed.length} confirmed
            </span>
          )}
        </div>
      </div>
      <div className={fillHeight ? 'flex-1 overflow-auto min-h-0' : 'overflow-x-auto'}>
        <table className="w-full text-xs">
          <thead className={fillHeight ? 'sticky top-0 bg-bg-card z-10' : ''}>
            <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
              <th className="px-3 py-2 text-left w-5"></th>
              <th className="px-3 py-2 text-left">Lead</th>
              <th className="px-3 py-2 text-left">Phone</th>
              <th className="px-3 py-2 text-left">Appointment</th>
              <th className="px-3 py-2 text-left">Time Left</th>
              <th className="px-3 py-2 text-left">Best Call</th>
              <th className="px-3 py-2 text-left">Confirmed Via</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, i) => {
              const id = lead.ghl_event_id || i
              const isExpanded = expandedId === id
              const activity = lead.activity || []
              return (
                <>
                  <tr
                    key={id}
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                    className={`border-t border-border-default/30 ${tierStyles[lead.tier]} hover:bg-bg-card-hover/50 transition-colors cursor-pointer`}
                  >
                    <td className="px-3 py-2 text-text-400">
                      <ChevronDown size={10} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </td>
                    <td className="px-3 py-2 font-medium text-text-primary">{lead.contact_name}</td>
                    <td className="px-3 py-2 text-text-400">
                      {lead.contact_phone ? (
                        <a href={`tel:${lead.contact_phone}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1 hover:text-opt-yellow transition-colors">
                          <Phone size={10} />
                          {formatPhone(lead.contact_phone)}
                        </a>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-text-400">
                      {lead.startTime ? new Date(lead.startTime).toLocaleString('en-US', tzOpts) : lead.appointment_date}
                    </td>
                    <td className="px-3 py-2">
                      <span className={lead.tier === 'critical' ? 'text-danger font-medium' : lead.tier === 'confirmed' ? 'text-text-400' : 'text-warning'}>
                        {formatTimeLeft(lead.hoursUntil)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={lead.longestCall >= 60 ? 'text-success' : lead.longestCall > 30 ? 'text-opt-yellow' : 'text-text-400'}>
                        {formatDuration(lead.longestCall)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {lead.channels?.length > 0 ? (
                        <div className="flex items-center gap-1.5">
                          {lead.channels.map(ch => {
                            const Icon = channelIcons[ch] || MessageSquare
                            return (
                              <span key={ch} className={`flex items-center gap-0.5 ${channelColors[ch] || 'text-text-400'}`} title={ch}>
                                <Icon size={11} />
                                <span className="text-[10px]">{ch}</span>
                              </span>
                            )
                          })}
                        </div>
                      ) : (
                        <span className="text-danger text-[10px] font-medium">None</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${tierBadge[lead.tier]}`}>
                        {tierLabel[lead.tier]}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${id}-detail`} className="bg-bg-primary/50">
                      <td colSpan={8} className="px-4 py-3">
                        {lead.cancelRisk && (
                          <div className="flex items-start gap-2 px-3 py-2 mb-2 rounded-lg bg-danger/10 border border-danger/20">
                            <AlertTriangle size={12} className="text-danger shrink-0 mt-0.5" />
                            <div>
                              <span className="text-[11px] font-medium text-danger">AI Alert: Likely No-Show</span>
                              <p className="text-[10px] text-text-400 mt-0.5">{lead.cancelRisk}</p>
                            </div>
                          </div>
                        )}
                        <div className="text-[10px] text-opt-yellow uppercase font-medium mb-2">Inbound Responses (last 24h)</div>
                        {activity.length === 0 ? (
                          <p className="text-[11px] text-text-400 italic">No activity found in the last 24 hours.</p>
                        ) : (
                          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                            {activity.map((a, ai) => {
                              const Icon = channelIcons[a.channel] || MessageSquare
                              const isInbound = a.direction === 'inbound'
                              const isContext = a.isContext
                              return (
                                <div key={ai} className={`flex items-start gap-2 px-3 py-1.5 rounded-lg ${
                                  isInbound
                                    ? a.risk?.isRisk
                                      ? 'bg-danger/10 border border-danger/20'
                                      : 'bg-success/5 border border-success/10'
                                    : 'bg-bg-card/50 border border-border-default/20'
                                }`}>
                                  <div className="flex items-center gap-1 shrink-0 mt-0.5">
                                    {isInbound ? <ArrowDownLeft size={10} className={a.risk?.isRisk ? 'text-danger' : 'text-success'} /> : <ArrowUpRight size={10} className="text-text-400" />}
                                    <Icon size={11} className={isInbound ? (a.risk?.isRisk ? 'text-danger' : channelColors[a.channel]) : 'text-text-400'} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-[10px] font-medium ${
                                        isInbound ? (a.risk?.isRisk ? 'text-danger' : 'text-success') : 'text-text-400'
                                      }`}>
                                        {isContext ? 'They replied to →' : isInbound ? `Inbound ${a.channel}` : `Outbound ${a.channel}`}
                                      </span>
                                      <span className="text-[9px] text-text-400">
                                        {new Date(a.date).toLocaleString('en-US', tzOpts)}
                                      </span>
                                      {a.risk?.isRisk && (
                                        <span className="text-[9px] text-danger font-medium flex items-center gap-0.5">
                                          <AlertTriangle size={8} /> Cancel/Reschedule
                                        </span>
                                      )}
                                    </div>
                                    {a.body && (
                                      <p className={`text-[11px] mt-0.5 ${isContext ? 'text-text-400 italic' : 'text-text-secondary'}`}>{a.body}</p>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
