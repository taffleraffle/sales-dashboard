import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { DollarSign, ArrowLeft, TrendingUp, ChevronDown } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useCommissionLedger, useCommissionSettings } from '../hooks/useCommissions'
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

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <KPICard
          label={(settings.pay_type || 'base') === 'ramp' ? 'Monthly Ramp' : 'Base Salary'}
          value={`$${((settings.pay_type || 'base') === 'ramp' ? (settings.ramp_amount || 0) : (settings.base_salary || 0)).toLocaleString()}`}
          subtitle={(settings.pay_type || 'base') === 'ramp' ? 'guaranteed minimum' : 'monthly fixed'}
        />
        <KPICard label="Commission Rate" value={`${settings.commission_rate || 0}%`} subtitle="of net cash (months 0-3)" />
        <KPICard label={showAllTime ? 'All-Time Commission' : `${period} Commission`} value={`$${(showAllTime ? allTimeTotals.total : summary.total_commission).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${showAllTime ? allTimeTotals.deals : summary.entries.length} deals`} />
        <KPICard label={showAllTime ? 'All-Time Revenue' : `${period} Revenue`} value={`$${(showAllTime ? allTimeTotals.revenue : currentEntries.reduce((s, e) => s + Number(e.payment_amount || 0), 0)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle="attributed" />
        <KPICard label={showAllTime ? 'All-Time Earnings' : `${period} Earnings`} value={`$${(showAllTime ? allTimeTotals.total + (settings.base_salary || 0) : summary.total_earnings).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle="base + commission" />
      </div>

      {/* Monthly Breakdown */}
      {!showAllTime && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <KPICard label="Commission Earned" value={`$${summary.total_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${summary.entries.length} deals`} />
          {summary.pay_type === 'ramp' ? (
            <KPICard
              label="Ramp Top-Up"
              value={summary.ramp_topup > 0 ? `+$${summary.ramp_topup.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'}
              subtitle={summary.ramp_topup > 0 ? `topped up to $${summary.ramp_amount.toLocaleString()} min` : 'commissions exceed ramp'}
            />
          ) : (
            <KPICard label="Base Salary" value={`$${summary.base_salary.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle="fixed monthly" />
          )}
          <KPICard label="Trial Deals" value={`$${summary.trial_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${summary.entries.filter(e => e.commission_type === 'trial_close').length} closes`} />
          <KPICard label="Ascension Deals" value={`$${summary.ascension_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${summary.entries.filter(e => e.commission_type === 'ascension').length} payments`} />
          <KPICard label="Total Earnings" value={`$${summary.total_earnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={summary.pay_type === 'ramp' ? 'ramp or commission (higher)' : 'base + commission'} />
        </div>
      )}

      {/* 6-Month Trend */}
      <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-6">
        <div className="flex items-center gap-1.5 mb-3">
          <TrendingUp size={12} className="text-opt-yellow" />
          <span className="text-[10px] text-opt-yellow uppercase font-medium">Monthly Trend</span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {periods.map(p => {
            const pEntries = byPeriod[p] || []
            const pSummary = summarizeCommissions(pEntries, settingsMap)[id]
            const earnings = pSummary ? pSummary.total_earnings : (settings.base_salary || 0)
            const commission = pSummary ? pSummary.total_commission : 0
            const isCurrent = p === period
            return (
              <button
                key={p}
                onClick={() => { setPeriod(p); setShowAllTime(false) }}
                className={`px-3 py-3 rounded-lg text-left transition-colors ${
                  isCurrent ? 'bg-opt-yellow/10 border border-opt-yellow/20' : 'bg-bg-primary border border-border-default/30 hover:border-border-default'
                }`}
              >
                <p className="text-[10px] text-text-400">{new Date(p + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</p>
                <p className="text-sm font-bold text-text-primary">${earnings.toLocaleString('en-US', { minimumFractionDigits: 0 })}</p>
                <p className="text-[10px] text-success">${commission.toLocaleString('en-US', { minimumFractionDigits: 2 })} comm</p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Deal-by-Deal Table */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-medium text-text-secondary">
            {showAllTime ? 'All Deals' : `Deals — ${period}`} ({ledger.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                <th className="px-3 py-2 text-left">Client</th>
                <th className="px-3 py-2 text-left">Payment #</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Cash Collected</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Commission</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-text-400">Loading...</td></tr>
              ) : ledger.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-text-400">No commission entries for this period</td></tr>
              ) : ledger.map(entry => (
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
                    {entry.payment?.source || '—'}
                  </td>
                  <td className="px-3 py-2 text-text-400">
                    {entry.payment?.payment_date
                      ? new Date(entry.payment.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-text-primary font-medium">
                    ${Number(entry.payment_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2 text-right text-text-400">
                    {entry.commission_rate}%
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
            </tbody>
            {ledger.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border-default bg-bg-card">
                  <td colSpan={5} className="px-3 py-2 font-medium text-text-secondary text-right">Totals</td>
                  <td className="px-3 py-2 text-right font-bold text-text-primary">
                    ${ledger.reduce((s, e) => s + Number(e.payment_amount || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 text-right font-bold text-success">
                    ${ledger.reduce((s, e) => s + Number(e.commission_amount || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
