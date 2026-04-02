import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { DollarSign, ArrowLeft, TrendingUp, ChevronDown } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useCommissionLedger, useCommissionSettings, useClients } from '../hooks/useCommissions'
import { summarizeCommissions } from '../services/commissionCalc'
import KPICard from '../components/KPICard'
import MonthPicker from '../components/MonthPicker'

const TYPE_COLORS = {
  trial_close: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  ascension: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  recurring: 'bg-success/15 text-success border-success/30',
  bonus: 'bg-opt-yellow/15 text-opt-yellow border-opt-yellow/30',
}

const TYPE_LABELS = {
  trial_close: 'Trial',
  ascension: 'Ascension',
  recurring: 'Recurring',
  bonus: 'Bonus',
}

const STATUS_COLORS = {
  pending: 'bg-warning/15 text-warning border-warning/30',
  approved: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  paid: 'bg-success/15 text-success border-success/30',
}

export default function CommissionDetail({ memberId: propId } = {}) {
  const params = useParams()
  const id = propId || params.id
  const navigate = useNavigate()
  const { isAdmin, profile } = useAuth()

  // URL security: non-admins can only view their own commission detail
  if (!propId && !isAdmin && profile?.teamMemberId && profile.teamMemberId !== id) {
    return <Navigate to="/sales/commissions" replace />
  }
  const now = new Date()
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [period, setPeriod] = useState(currentPeriod)
  const [member, setMember] = useState(null)
  const [showAllTime, setShowAllTime] = useState(false)

  const { ledger, loading, updateStatus } = useCommissionLedger(id, showAllTime ? null : period)
  const { settingsMap } = useCommissionSettings()
  const settings = settingsMap[id] || {}
  const { clients } = useClients()

  // Fetch member info
  useEffect(() => {
    supabase.from('team_members').select('*').eq('id', id).single()
      .then(({ data }) => setMember(data))
  }, [id])

  // Get last 6 months for trend
  const periods = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  // Fetch all-time ledger for trend (separate from filtered view)
  const { ledger: allLedger } = useCommissionLedger(id, null)
  const byPeriod = {}
  for (const entry of allLedger) {
    if (!byPeriod[entry.period]) byPeriod[entry.period] = []
    byPeriod[entry.period].push(entry)
  }

  // Current period summary
  const currentEntries = byPeriod[period] || []
  const summary = summarizeCommissions(currentEntries, settingsMap)[id] || {
    base_salary: settings.base_salary || 0,
    trial_commission: 0, ascension_commission: 0, recurring_commission: 0, bonus_commission: 0,
    total_commission: 0, total_earnings: settings.base_salary || 0, entries: [],
  }

  // All-time totals
  const allTimeTotals = allLedger.reduce((acc, e) => ({
    total: acc.total + Number(e.commission_amount || 0),
    deals: acc.deals + 1,
    revenue: acc.revenue + Number(e.payment_amount || 0),
  }), { total: 0, deals: 0, revenue: 0 })

  if (!member) return null

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          {!propId && (
            <button onClick={() => navigate('/sales/commissions')} className="text-text-400 hover:text-text-primary">
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
              <DollarSign size={20} className="text-opt-yellow" /> {propId ? 'My Commission' : member.name}
            </h1>
            <p className="text-xs sm:text-sm text-text-400 capitalize">{member.role} — Commission Detail</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-text-400">
            <input
              type="checkbox"
              checked={showAllTime}
              onChange={e => setShowAllTime(e.target.checked)}
              className="rounded border-border-default"
            />
            All time
          </label>
          <MonthPicker value={period} onChange={setPeriod} disabled={showAllTime} />
        </div>
      </div>

      {/* KPI Cards — single condensed row */}
      {(() => {
        // Forecast: clients assigned to this member within commission window (0-3 months)
        const memberClients = clients.filter(c =>
          (c.closer_id === id || c.setter_id === id) &&
          c.stage !== 'churned' &&
          (c.payment_count || 0) < 4
        )
        const forecastedCash = memberClients.reduce((s, c) => s + Number(c.monthly_amount || 0), 0)
        const actualCash = showAllTime
          ? allTimeTotals.revenue
          : currentEntries.reduce((s, e) => s + Number(e.payment_amount || 0), 0)
        // Clients who haven't paid this period (no ledger entry for this period)
        const paidClientIds = new Set(currentEntries.map(e => e.client_id))
        const missingClients = memberClients.filter(c => !paidClientIds.has(c.id))

        const rate = settings.commission_rate || 0
        const forecastedCommission = forecastedCash * rate / 100
        const actualCommission = showAllTime ? allTimeTotals.total : summary.total_commission

        const isRamp = (settings.pay_type || 'base') === 'ramp'
        const rampAmount = settings.ramp_amount || 0
        const rampTopUp = isRamp ? Math.max(0, rampAmount - actualCommission) : 0

        return (
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden mb-6">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-bg-card text-text-400 uppercase text-[10px] tracking-wider">
                  <th className="px-4 py-2.5 text-left"></th>
                  <th className="px-4 py-2.5 text-right">Cash</th>
                  <th className="px-4 py-2.5 text-right">Commission ({rate}%)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-default/30 bg-danger/5">
                  <td className="px-4 py-3 font-medium text-danger">Forecasted</td>
                  <td className="px-4 py-3 text-right text-danger font-medium">${forecastedCash.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-right text-danger font-medium">${forecastedCommission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                </tr>
                <tr className="border-t border-border-default/30 bg-success/5">
                  <td className="px-4 py-3 font-medium text-success">Actual</td>
                  <td className="px-4 py-3 text-right text-success font-medium">${actualCash.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-right text-success font-bold">${actualCommission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                </tr>
                {isRamp && (
                  <tr className="border-t border-border-default/30">
                    <td className="px-4 py-3 font-medium text-text-400">Ramp Guarantee</td>
                    <td className="px-4 py-3 text-right text-text-400 font-medium">${rampAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right text-text-primary font-medium">
                      {rampTopUp > 0
                        ? <span className="text-warning">+${rampTopUp.toLocaleString('en-US', { minimumFractionDigits: 2 })} top-up</span>
                        : <span className="text-success">exceeded</span>
                      }
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      })()}

      {/* Unified Table: Collected + Forecasted */}
      {(() => {
        const memberClients = clients.filter(c =>
          (c.closer_id === id || c.setter_id === id) &&
          c.stage !== 'churned' &&
          (c.payment_count || 0) < 4
        )
        const paidClientIds = new Set(currentEntries.map(e => e.client_id))
        const forecastedClients = showAllTime ? [] : memberClients.filter(c => !paidClientIds.has(c.id))
        const rate = settings.commission_rate || 0

        const totalCollected = ledger.reduce((s, e) => s + Number(e.payment_amount || 0), 0)
        const totalCommission = ledger.reduce((s, e) => s + Number(e.commission_amount || 0), 0)
        const totalForecasted = forecastedClients.reduce((s, c) => s + Number(c.monthly_amount || 0), 0)
        const totalForecastedComm = totalForecasted * rate / 100

        return (
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
              <h2 className="text-sm font-medium text-text-secondary">
                {showAllTime ? 'All Deals' : `Deals — ${period}`}
              </h2>
              <div className="flex items-center gap-3 text-[10px]">
                <span className="text-success">{ledger.length} collected</span>
                {forecastedClients.length > 0 && <span className="text-warning">{forecastedClients.length} forecasted</span>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-bg-card text-text-400 uppercase text-[10px] tracking-wider">
                    <th className="px-3 py-2 text-left">Client</th>
                    <th className="px-3 py-2 text-left">Payment #</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-right">Cash</th>
                    <th className="px-3 py-2 text-right">Commission</th>
                    <th className="px-3 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-text-400">Loading...</td></tr>
                  ) : (ledger.length === 0 && forecastedClients.length === 0) ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-text-400">No deals for this period</td></tr>
                  ) : (<>
                    {/* Actual collected deals */}
                    {ledger.map(entry => (
                      <tr key={entry.id} className="border-t border-border-default/30 hover:bg-bg-card-hover/50">
                        <td className="px-3 py-2">
                          <div>
                            <span className="font-medium text-text-primary">{entry.client?.name || '—'}</span>
                            {entry.client?.company_name && (
                              <span className="block text-[10px] text-text-400">{entry.client.company_name}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {(() => {
                            const pn = entry.payment?.payment_number
                            const labels = { 0: 'Trial', 1: 'Month 1', 2: 'Month 2', 3: 'Month 3' }
                            return <span className="text-[10px] font-medium text-text-primary">{pn != null ? (labels[pn] || `Month ${pn}`) : '—'}</span>
                          })()}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${TYPE_COLORS[entry.commission_type] || ''}`}>
                            {TYPE_LABELS[entry.commission_type] || entry.commission_type}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-text-400">
                          {entry.payment?.payment_date
                            ? new Date(entry.payment.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-text-primary font-medium">
                          ${Number(entry.payment_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-success">
                          ${Number(entry.commission_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => {
                              const next = entry.status === 'pending' ? 'approved' : entry.status === 'approved' ? 'paid' : 'pending'
                              updateStatus(entry.id, next)
                            }}
                            className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border cursor-pointer hover:opacity-80 ${STATUS_COLORS[entry.status] || ''}`}
                            title="Click to cycle: pending → approved → paid"
                          >
                            {entry.status}
                          </button>
                        </td>
                      </tr>
                    ))}

                    {/* Forecasted payments — clients who haven't paid yet */}
                    {forecastedClients.map(c => (
                      <tr key={`forecast-${c.id}`} className="border-t border-warning/15 bg-warning/5">
                        <td className="px-3 py-2">
                          <div>
                            <span className="font-medium text-text-primary">{c.name}</span>
                            {c.company_name && (
                              <span className="block text-[10px] text-text-400">{c.company_name}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] font-medium text-text-400">#{(c.payment_count || 0) + 1}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium border bg-warning/15 text-warning border-warning/30">
                            Forecasted
                          </span>
                        </td>
                        <td className="px-3 py-2 text-text-400 text-[10px]">
                          {c.next_billing_date ? new Date(c.next_billing_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-warning font-medium">
                          ${Number(c.monthly_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2 text-right text-warning/60">
                          ${(Number(c.monthly_amount || 0) * rate / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium border bg-warning/15 text-warning border-warning/30">
                            awaiting
                          </span>
                        </td>
                      </tr>
                    ))}
                  </>)}
                </tbody>
                {(ledger.length > 0 || forecastedClients.length > 0) && (
                  <tfoot>
                    {ledger.length > 0 && (
                      <tr className="border-t-2 border-border-default bg-bg-card">
                        <td colSpan={4} className="px-3 py-2 font-medium text-text-secondary text-right">Collected</td>
                        <td className="px-3 py-2 text-right font-bold text-text-primary">
                          ${totalCollected.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-success">
                          ${totalCommission.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2"></td>
                      </tr>
                    )}
                    {forecastedClients.length > 0 && (
                      <tr className="border-t border-warning/20 bg-warning/5">
                        <td colSpan={4} className="px-3 py-2 font-medium text-warning text-right">Forecasted</td>
                        <td className="px-3 py-2 text-right font-bold text-warning">
                          ${totalForecasted.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-warning/60">
                          ${totalForecastedComm.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2"></td>
                      </tr>
                    )}
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
