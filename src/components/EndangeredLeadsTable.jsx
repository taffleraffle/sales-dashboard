import { Loader, AlertTriangle, Phone } from 'lucide-react'

const tierStyles = {
  critical: 'bg-danger/10 border-l-2 border-danger',
  warning: 'bg-warning/10 border-l-2 border-warning',
  monitor: 'bg-blue-500/5 border-l-2 border-blue-500/40',
}

const tierBadge = {
  critical: 'bg-danger/15 text-danger border-danger/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  monitor: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
}

const tierLabel = {
  critical: 'Critical',
  warning: 'Warning',
  monitor: 'Monitor',
}

function formatTimeLeft(hours) {
  if (hours < 1) return '<1h'
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d ${hours % 24}h`
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

export default function EndangeredLeadsTable({ leads, loading }) {
  if (loading) {
    return (
      <div className="bg-bg-card border border-border-default rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-danger" />
          <h2 className="text-sm font-medium text-text-secondary">Endangered Leads</h2>
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
          <AlertTriangle size={14} className="text-success" />
          <h2 className="text-sm font-medium text-text-secondary">Endangered Leads</h2>
        </div>
        <p className="text-xs text-text-400 text-center py-4">No endangered leads — all upcoming appointments have engagement signals.</p>
      </div>
    )
  }

  const criticalCount = leads.filter(l => l.tier === 'critical').length
  const warningCount = leads.filter(l => l.tier === 'warning').length
  const monitorCount = leads.filter(l => l.tier === 'monitor').length

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-danger" />
          <h2 className="text-sm font-medium text-text-secondary">Endangered Leads ({leads.length})</h2>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {criticalCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-danger/15 text-danger font-medium">
              {criticalCount} critical
            </span>
          )}
          {warningCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
              {warningCount} warning
            </span>
          )}
          {monitorCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">
              {monitorCount} monitor
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
              <th className="px-3 py-2 text-left">Longest Call</th>
              <th className="px-3 py-2 text-left">Inbound Reply</th>
              <th className="px-3 py-2 text-left">Risk</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, i) => (
              <tr key={lead.ghl_event_id || i} className={`border-t border-border-default/30 ${tierStyles[lead.tier]}`}>
                <td className="px-3 py-2 font-medium text-text-primary">{lead.contact_name}</td>
                <td className="px-3 py-2 text-text-400">
                  <a href={`tel:${lead.contact_phone}`} className="flex items-center gap-1 hover:text-opt-yellow transition-colors">
                    <Phone size={10} />
                    {formatPhone(lead.contact_phone)}
                  </a>
                </td>
                <td className="px-3 py-2 text-text-400">
                  {lead.startTime ? new Date(lead.startTime).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : lead.appointment_date}
                </td>
                <td className="px-3 py-2">
                  <span className={lead.tier === 'critical' ? 'text-danger font-medium' : 'text-warning'}>
                    {formatTimeLeft(lead.hoursUntil)}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-400">
                  {lead.longestCall > 0 ? `${lead.longestCall}s` : '—'}
                </td>
                <td className="px-3 py-2">
                  <span className="text-danger">No</span>
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
