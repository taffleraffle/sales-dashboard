import { useState, useRef } from 'react'
import { DollarSign, Upload, Check, X, ChevronDown, Loader, Search, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCommissionSettings, useClients, usePayments, useCommissionLedger } from '../hooks/useCommissions'
import { summarizeCommissions } from '../services/commissionCalc'
import { supabase } from '../lib/supabase'
import KPICard from '../components/KPICard'

const STAGE_COLORS = {
  trial: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  ascended: 'bg-success/15 text-success border-success/30',
  churned: 'bg-danger/15 text-danger border-danger/30',
  paused: 'bg-warning/15 text-warning border-warning/30',
  pif: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

function MonthPicker({ value, onChange }) {
  return (
    <input
      type="month"
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-bg-primary border border-border-default rounded-lg px-3 py-1.5 text-xs text-text-primary"
    />
  )
}

export default function CommissionPage() {
  const now = new Date()
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [activeTab, setActiveTab] = useState('overview')
  const { members } = useTeamMembers()
  const { settings, settingsMap, upsert: upsertSettings } = useCommissionSettings()
  const { clients, clientsMap, refresh: refreshClients } = useClients()
  const { payments, loading: loadingPayments, matchPayment } = usePayments(period)
  const { ledger, loading: loadingLedger, updateStatus, refresh: refreshLedger } = useCommissionLedger(null, period)
  const navigate = useNavigate()
  const [importStatus, setImportStatus] = useState(null)
  const fileRef = useRef(null)
  const [matchingPaymentId, setMatchingPaymentId] = useState(null)
  const [searchClient, setSearchClient] = useState('')

  const summaries = summarizeCommissions(ledger, settingsMap)
  const totalCommission = Object.values(summaries).reduce((s, m) => s + m.total_commission, 0)
  const totalEarnings = Object.values(summaries).reduce((s, m) => s + m.total_earnings, 0)
  const totalPayments = payments.reduce((s, p) => s + Number(p.net_amount || 0), 0)
  const unmatchedCount = payments.filter(p => !p.matched).length

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'payments', label: `Payments${unmatchedCount > 0 ? ` (${unmatchedCount} unmatched)` : ''}` },
    { key: 'clients', label: `Clients (${clients.length})` },
    { key: 'settings', label: 'Settings' },
  ]

  // CSV Import
  const handleImportCSV = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportStatus('Importing...')

    const text = await file.text()
    const lines = text.split('\n').filter(l => l.trim())
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))

    const rows = []
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      const row = {}
      headers.forEach((h, j) => { row[h] = vals[j] || null })
      rows.push(row)
    }

    // Match closer/setter by name
    const memberByName = {}
    members.forEach(m => { memberByName[m.name.toLowerCase()] = m.id })

    let imported = 0
    for (const row of rows) {
      const closerId = row.closer ? memberByName[row.closer.toLowerCase()] : null
      const setterId = row.setter ? memberByName[row.setter.toLowerCase()] : null
      const { error } = await supabase.from('clients').upsert({
        name: row.name,
        email: row.email || null,
        phone: row.phone || null,
        company_name: row.company_name || row.company || null,
        closer_id: closerId || null,
        setter_id: setterId || null,
        stage: row.stage || 'trial',
        trial_start_date: row.trial_start_date || row.trial_start || null,
        ascension_date: row.ascension_date || null,
        monthly_amount: parseFloat(row.monthly_amount) || 0,
        trial_amount: parseFloat(row.trial_amount) || 0,
        notes: row.notes || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email', ignoreDuplicates: false })
      if (!error) imported++
    }

    setImportStatus(`Imported ${imported} of ${rows.length} clients`)
    refreshClients()
    setTimeout(() => setImportStatus(null), 5000)
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
            <DollarSign size={20} className="text-opt-yellow" /> Commission Tracker
          </h1>
          <p className="text-xs sm:text-sm text-text-400">Track payments, calculate commissions, manage payouts</p>
        </div>
        <MonthPicker value={period} onChange={setPeriod} />
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPICard label="Net Revenue" value={`$${totalPayments.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${payments.length} payments`} />
        <KPICard label="Total Commissions" value={`$${totalCommission.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle={`${ledger.length} entries`} />
        <KPICard label="Total Earnings" value={`$${totalEarnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} subtitle="base + commission" />
        <KPICard label="Unmatched" value={unmatchedCount} subtitle={unmatchedCount > 0 ? 'payments need matching' : 'all matched'} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border-default">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === t.key
                ? 'text-opt-yellow border-b-2 border-opt-yellow'
                : 'text-text-400 hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default">
            <h2 className="text-sm font-medium text-text-secondary">Commission Breakdown — {period}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-right">Base</th>
                  <th className="px-3 py-2 text-right">Trial</th>
                  <th className="px-3 py-2 text-right">Ascension</th>
                  <th className="px-3 py-2 text-right">Recurring</th>
                  <th className="px-3 py-2 text-right">Total Commission</th>
                  <th className="px-3 py-2 text-right">Total Earnings</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => {
                  const s = summaries[m.id] || { base_salary: settingsMap[m.id]?.base_salary || 0, trial_commission: 0, ascension_commission: 0, recurring_commission: 0, total_commission: 0, total_earnings: settingsMap[m.id]?.base_salary || 0 }
                  return (
                    <tr key={m.id} onClick={() => navigate(`/sales/commissions/${m.id}`)} className="border-t border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer">
                      <td className="px-3 py-2 font-medium text-opt-yellow hover:underline">{m.name}</td>
                      <td className="px-3 py-2 text-text-400 capitalize">{m.role}</td>
                      <td className="px-3 py-2 text-right text-text-400">${s.base_salary.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-text-primary">${s.trial_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-3 py-2 text-right text-text-primary">${s.ascension_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-3 py-2 text-right text-text-primary">${s.recurring_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-3 py-2 text-right font-medium text-opt-yellow">${s.total_commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-3 py-2 text-right font-medium text-success flex items-center justify-end gap-1">${s.total_earnings.toLocaleString('en-US', { minimumFractionDigits: 2 })} <ArrowRight size={10} className="text-text-400" /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payments Tab */}
      {activeTab === 'payments' && (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Customer</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Fee</th>
                  <th className="px-3 py-2 text-right">Net</th>
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {loadingPayments ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-text-400"><Loader size={14} className="animate-spin inline mr-2" />Loading...</td></tr>
                ) : payments.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-text-400">No payments for this period</td></tr>
                ) : payments.map(p => (
                  <tr key={p.id} className={`border-t border-border-default/30 hover:bg-bg-card-hover/50 ${!p.matched ? 'bg-warning/5' : ''}`}>
                    <td className="px-3 py-2 text-text-400">{new Date(p.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td className="px-3 py-2 text-text-primary">{p.customer_name || p.customer_email || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${
                        p.source === 'stripe' ? 'bg-purple-500/15 text-purple-400 border-purple-500/30' :
                        p.source === 'fanbasis' ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
                        'bg-text-400/15 text-text-400 border-text-400/30'
                      }`}>{p.source}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-text-primary">${Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-3 py-2 text-right text-danger">${Number(p.fee).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-3 py-2 text-right font-medium text-text-primary">${Number(p.net_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-3 py-2">
                      {p.matched ? (
                        <span className="text-success text-[10px] flex items-center gap-1"><Check size={10} /> {p.client?.name || 'Matched'}</span>
                      ) : (
                        <div className="relative">
                          <button
                            onClick={() => setMatchingPaymentId(matchingPaymentId === p.id ? null : p.id)}
                            className="text-warning text-[10px] font-medium flex items-center gap-1 hover:text-opt-yellow"
                          >
                            Match <ChevronDown size={10} />
                          </button>
                          {matchingPaymentId === p.id && (
                            <div className="absolute z-20 mt-1 left-0 bg-bg-card border border-border-default rounded-lg shadow-lg py-1 min-w-[200px] max-h-[200px] overflow-y-auto">
                              <div className="px-2 py-1">
                                <input
                                  type="text"
                                  placeholder="Search clients..."
                                  value={searchClient}
                                  onChange={e => setSearchClient(e.target.value)}
                                  className="w-full px-2 py-1 text-[11px] bg-bg-primary border border-border-default rounded text-text-primary"
                                  autoFocus
                                />
                              </div>
                              {clients
                                .filter(c => !searchClient || c.name.toLowerCase().includes(searchClient.toLowerCase()))
                                .slice(0, 15)
                                .map(c => (
                                  <button
                                    key={c.id}
                                    onClick={async () => {
                                      await matchPayment(p.id, c.id)
                                      setMatchingPaymentId(null)
                                      setSearchClient('')
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-card-hover flex items-center justify-between"
                                  >
                                    {c.name}
                                    <span className="text-text-400 text-[9px]">{c.company_name}</span>
                                  </button>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${
                        p.matched ? 'bg-success/15 text-success border-success/30' : 'bg-warning/15 text-warning border-warning/30'
                      }`}>{p.matched ? 'Matched' : 'Unmatched'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Clients Tab */}
      {activeTab === 'clients' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-secondary">Client List</h2>
            <div className="flex items-center gap-2">
              {importStatus && <span className="text-[10px] text-success">{importStatus}</span>}
              <input ref={fileRef} type="file" accept=".csv" onChange={handleImportCSV} className="hidden" />
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90 transition-colors"
              >
                <Upload size={12} /> Import CSV
              </button>
            </div>
          </div>
          <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Company</th>
                    <th className="px-3 py-2 text-left">Email</th>
                    <th className="px-3 py-2 text-left">Stage</th>
                    <th className="px-3 py-2 text-left">Closer</th>
                    <th className="px-3 py-2 text-left">Setter</th>
                    <th className="px-3 py-2 text-right">Monthly</th>
                    <th className="px-3 py-2 text-left">Trial Start</th>
                    <th className="px-3 py-2 text-left">Ascension</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-text-400">No clients yet — import a CSV to get started</td></tr>
                  ) : clients.map(c => (
                    <tr key={c.id} className="border-t border-border-default/30 hover:bg-bg-card-hover/50">
                      <td className="px-3 py-2 font-medium text-text-primary">{c.name}</td>
                      <td className="px-3 py-2 text-text-400">{c.company_name || '—'}</td>
                      <td className="px-3 py-2 text-text-400">{c.email || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border capitalize ${STAGE_COLORS[c.stage] || STAGE_COLORS.trial}`}>
                          {c.stage}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text-400">{c.closer_name}</td>
                      <td className="px-3 py-2 text-text-400">{c.setter_name}</td>
                      <td className="px-3 py-2 text-right text-text-primary">${Number(c.monthly_amount).toLocaleString()}</td>
                      <td className="px-3 py-2 text-text-400">{c.trial_start_date || '—'}</td>
                      <td className="px-3 py-2 text-text-400">{c.ascension_date || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default">
            <h2 className="text-sm font-medium text-text-secondary">Commission Rates</h2>
            <p className="text-[10px] text-text-400 mt-0.5">Configure base salary and commission percentages per team member</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-right">Base Salary</th>
                  <th className="px-3 py-2 text-right">Commission %</th>
                  <th className="px-3 py-2 text-right">Ascension %</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => {
                  const s = settingsMap[m.id] || {}
                  return (
                    <tr key={m.id} className="border-t border-border-default/30">
                      <td className="px-3 py-2 font-medium text-text-primary">{m.name}</td>
                      <td className="px-3 py-2 text-text-400 capitalize">{m.role}</td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          defaultValue={s.base_salary || 0}
                          onBlur={e => upsertSettings(m.id, { base_salary: parseFloat(e.target.value) || 0 })}
                          className="w-24 text-right px-2 py-1 bg-bg-primary border border-border-default rounded text-xs text-text-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.5"
                          defaultValue={s.commission_rate || 0}
                          onBlur={e => upsertSettings(m.id, { commission_rate: parseFloat(e.target.value) || 0 })}
                          className="w-20 text-right px-2 py-1 bg-bg-primary border border-border-default rounded text-xs text-text-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.5"
                          defaultValue={s.ascension_rate || 0}
                          onBlur={e => upsertSettings(m.id, { ascension_rate: parseFloat(e.target.value) || 0 })}
                          className="w-20 text-right px-2 py-1 bg-bg-primary border border-border-default rounded text-xs text-text-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="text"
                          defaultValue={s.notes || ''}
                          onBlur={e => upsertSettings(m.id, { notes: e.target.value })}
                          placeholder="Notes..."
                          className="w-full px-2 py-1 bg-bg-primary border border-border-default rounded text-xs text-text-primary"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
