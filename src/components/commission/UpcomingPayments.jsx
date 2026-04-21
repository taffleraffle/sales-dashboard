import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export default function UpcomingPayments({ clients }) {
  const [expanded, setExpanded] = useState(false)

  const now = new Date()
  const upcoming = clients
    .filter(c => c.next_billing_date && c.stage !== 'churned')
    .map(c => {
      const date = new Date(c.next_billing_date + 'T12:00:00')
      const daysUntil = Math.ceil((date - now) / (86400000))
      return { ...c, billingDate: date, daysUntil }
    })
    .sort((a, b) => a.billingDate - b.billingDate)

  const overdue = upcoming.filter(c => c.daysUntil < 0)
  const thisWeek = upcoming.filter(c => c.daysUntil >= 0 && c.daysUntil <= 7)
  const later = upcoming.filter(c => c.daysUntil > 7)

  if (upcoming.length === 0) return null

  return (
    <div className="tile tile-feedback mt-4 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-text-secondary">Upcoming Payments</h3>
          {overdue.length > 0 && (
            <span className="text-[10px] text-danger font-medium">{overdue.length} overdue</span>
          )}
          <span className="text-[10px] text-text-400">{upcoming.length} total</span>
        </div>
        {expanded ? <ChevronUp size={14} className="text-text-400" /> : <ChevronDown size={14} className="text-text-400" />}
      </button>

      {expanded && (
        <div className="border-t border-border-default">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-card text-text-400 uppercase text-[10px] tracking-wider">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Client</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Payment #</th>
                <th className="px-3 py-2 text-right">Days</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.slice(0, 25).map(c => (
                <tr
                  key={c.id}
                  className={`border-t border-border-default/30 ${
                    c.daysUntil < 0 ? 'bg-danger/5' :
                    c.daysUntil <= 7 ? 'bg-warning/5' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-text-400">
                    {c.billingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-3 py-2 text-text-primary font-medium">{c.name}</td>
                  <td className="px-3 py-2 text-right text-success">${Number(c.monthly_amount).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className="text-[10px] text-text-400">#{(c.payment_count || 0) + 1}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className={`text-[10px] font-medium ${
                      c.daysUntil < 0 ? 'text-danger' :
                      c.daysUntil <= 7 ? 'text-warning' :
                      'text-text-400'
                    }`}>
                      {c.daysUntil < 0 ? `${Math.abs(c.daysUntil)}d overdue` :
                       c.daysUntil === 0 ? 'Today' :
                       `${c.daysUntil}d`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
