import { useState } from 'react'
import { DollarSign, ChevronDown, TrendingUp } from 'lucide-react'
import { useCommissionLedger, useCommissionSettings } from '../hooks/useCommissions'
import { summarizeCommissions } from '../services/commissionCalc'
import { Link } from 'react-router-dom'

export default function CommissionWidget({ memberId }) {
  const [expanded, setExpanded] = useState(false)
  const now = new Date()
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // Last 3 months
  const periods = []
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const { ledger, loading } = useCommissionLedger(memberId, null)
  const { settingsMap } = useCommissionSettings()

  // Group ledger by period
  const byPeriod = {}
  for (const entry of ledger) {
    if (!byPeriod[entry.period]) byPeriod[entry.period] = []
    byPeriod[entry.period].push(entry)
  }

  const settings = settingsMap[memberId] || {}
  const currentLedger = byPeriod[currentPeriod] || []
  const currentSummary = summarizeCommissions(currentLedger, settingsMap)[memberId] || {
    base_salary: settings.base_salary || 0,
    trial_commission: 0, ascension_commission: 0, recurring_commission: 0,
    total_commission: 0, total_earnings: settings.base_salary || 0,
    entries: [],
  }

  if (loading) return null

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <DollarSign size={14} className="text-opt-yellow" />
          <h3 className="text-sm font-medium">Commission — {currentPeriod}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-success">${currentSummary.total_earnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          <ChevronDown size={14} className={`text-text-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border-default px-4 py-3">
          {/* Current month breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div>
              <p className="text-[10px] text-text-400 uppercase">Base</p>
              <p className="text-sm font-medium text-text-primary">${currentSummary.base_salary.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase">Trial</p>
              <p className="text-sm font-medium text-text-primary">${currentSummary.trial_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase">Ascension</p>
              <p className="text-sm font-medium text-text-primary">${currentSummary.ascension_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-400 uppercase">Recurring</p>
              <p className="text-sm font-medium text-text-primary">${currentSummary.recurring_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>

          {/* Last 3 months trend */}
          <div className="flex items-center gap-1 mb-3">
            <TrendingUp size={11} className="text-text-400" />
            <span className="text-[10px] text-text-400 uppercase">Last 3 months</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {periods.map(p => {
              const pLedger = byPeriod[p] || []
              const pSummary = summarizeCommissions(pLedger, settingsMap)[memberId]
              const total = pSummary ? pSummary.total_earnings : (settings.base_salary || 0)
              return (
                <div key={p} className={`px-3 py-2 rounded-lg ${p === currentPeriod ? 'bg-opt-yellow/10 border border-opt-yellow/20' : 'bg-bg-primary border border-border-default/30'}`}>
                  <p className="text-[10px] text-text-400">{p}</p>
                  <p className="text-xs font-medium text-text-primary">${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                </div>
              )
            })}
          </div>

          {/* Recent entries */}
          {currentSummary.entries.length > 0 && (
            <div>
              <span className="text-[10px] text-text-400 uppercase">Recent commission entries</span>
              <div className="mt-1 space-y-1">
                {currentSummary.entries.slice(0, 5).map(e => (
                  <div key={e.id} className="flex items-center justify-between px-2 py-1 bg-bg-primary rounded text-[11px]">
                    <span className="text-text-primary">{e.client?.name || '—'}</span>
                    <span className="text-success font-medium">${Number(e.commission_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Link
            to="/sales/commissions"
            className="block mt-3 text-center text-[10px] text-opt-yellow hover:text-opt-yellow/80 transition-colors"
          >
            View full commission details →
          </Link>
        </div>
      )}
    </div>
  )
}
