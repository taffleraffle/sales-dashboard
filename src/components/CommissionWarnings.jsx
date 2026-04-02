import { AlertTriangle } from 'lucide-react'

export default function CommissionWarnings({ settingsMap, members, clients, payments, onTabChange }) {
  const warnings = []

  // Check for members with 0% commission rate
  const zeroRateMembers = members.filter(m => {
    const s = settingsMap[m.id]
    return !s || !s.commission_rate || s.commission_rate === 0
  })
  if (zeroRateMembers.length > 0) {
    warnings.push({
      type: 'rate',
      message: `${zeroRateMembers.map(m => m.name).join(', ')} ${zeroRateMembers.length === 1 ? 'has' : 'have'} 0% commission rate`,
      action: 'Set rates',
      tab: 'settings',
    })
  }

  // Check for matched payments whose clients have no closer or setter
  const matchedPayments = payments.filter(p => p.matched && p.client_id)
  const unattributed = new Set()
  matchedPayments.forEach(p => {
    const client = clients.find(c => c.id === p.client_id)
    if (client && !client.closer_id && !client.setter_id) {
      unattributed.add(client.name || client.id)
    }
  })
  if (unattributed.size > 0) {
    warnings.push({
      type: 'attribution',
      message: `${unattributed.size} matched ${unattributed.size === 1 ? 'client has' : 'clients have'} no closer/setter assigned`,
      action: 'Assign team',
      tab: 'clients',
    })
  }

  if (warnings.length === 0) return null

  return (
    <div className="bg-warning/10 border border-warning/30 rounded-xl p-3 mb-4 flex flex-col gap-2">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-warning text-xs">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{w.message}</span>
          </div>
          <button
            onClick={() => onTabChange(w.tab)}
            className="px-3 py-1 text-[10px] font-medium bg-warning/15 text-warning border border-warning/30 rounded-lg hover:bg-warning/25 transition-all duration-150 whitespace-nowrap"
          >
            {w.action}
          </button>
        </div>
      ))}
    </div>
  )
}
