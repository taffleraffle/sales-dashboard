import { useState } from 'react'
import { Loader, Calendar, Phone, CheckCircle, ChevronDown, MessageSquare, Mail, PhoneCall } from 'lucide-react'

const tierStyles = {
  critical: 'bg-danger/10 border-l-2 border-danger',
  warning: 'bg-warning/10 border-l-2 border-warning',
  monitor: 'bg-blue-500/5 border-l-2 border-blue-500/40',
  confirmed: '',
}

const tierBadge = {
  critical: 'bg-danger/15 text-danger border-danger/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  monitor: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  confirmed: 'bg-success/15 text-success border-success/30',
}

const tierLabel = {
  critical: 'At Risk',
  warning: 'Warning',
  monitor: 'Monitor',
  confirmed: 'Confirmed',
}

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

const channelIcons = {
  Call: PhoneCall,
  SMS: MessageSquare,
  Email: Mail,
  Social: MessageSquare,
}

function ChannelDropdown({ channels }) {
  const [open, setOpen] = useState(false)

  if (!channels.length) {
    return <span className="text-danger text-[10px] font-medium">None</span>
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-success text-[10px] font-medium hover:text-opt-yellow transition-colors"
      >
        <CheckCircle size={10} />
        {channels.length} channel{channels.length > 1 ? 's' : ''}
        <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 bg-bg-card border border-border-default rounded-lg shadow-lg py-1 min-w-[120px]">
          {channels.map(ch => {
            const Icon = channelIcons[ch] || MessageSquare
            return (
              <div key={ch} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-primary">
                <Icon size={11} className="text-success" />
                {ch}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function EndangeredLeadsTable({ leads, loading }) {
  if (loading) {
    return (
      <div className="bg-bg-card border border-border-default rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls</h2>
        </div>
        <div className="flex items-center justify-center gap-2 py-8 text-text-400 text-xs">
          <Loader size={14} className="animate-spin" />
          Checking engagement signals...
        </div>
      </div>
    )
  }

  if (!leads || leads.length === 0) {
    return (
      <div className="bg-bg-card border border-border-default rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls</h2>
        </div>
        <p className="text-xs text-text-400 text-center py-4">No upcoming strategy calls in the next 7 days.</p>
      </div>
    )
  }

  const endangered = leads.filter(l => !l.engaged)
  const confirmed = leads.filter(l => l.engaged)

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-opt-yellow" />
          <h2 className="text-sm font-medium text-text-secondary">Upcoming Strategy Calls ({leads.length})</h2>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {endangered.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-danger/15 text-danger font-medium">
              {endangered.length} at risk
            </span>
          )}
          {confirmed.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">
              {confirmed.length} confirmed
            </span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
              <th className="px-3 py-2 text-left">Lead</th>
              <th className="px-3 py-2 text-left">Phone</th>
              <th className="px-3 py-2 text-left">Appointment</th>
              <th className="px-3 py-2 text-left">Time Left</th>
              <th className="px-3 py-2 text-left">Best Call</th>
              <th className="px-3 py-2 text-left">Engagement</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, i) => (
              <tr key={lead.ghl_event_id || i} className={`border-t border-border-default/30 ${tierStyles[lead.tier]} hover:bg-bg-card-hover/50 transition-colors`}>
                <td className="px-3 py-2 font-medium text-text-primary">{lead.contact_name}</td>
                <td className="px-3 py-2 text-text-400">
                  {lead.contact_phone ? (
                    <a href={`tel:${lead.contact_phone}`} className="flex items-center gap-1 hover:text-opt-yellow transition-colors">
                      <Phone size={10} />
                      {formatPhone(lead.contact_phone)}
                    </a>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-text-400">
                  {lead.startTime ? new Date(lead.startTime).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : lead.appointment_date}
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
                  <ChannelDropdown channels={lead.channels || []} />
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${tierBadge[lead.tier]}`}>
                    {tierLabel[lead.tier]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
