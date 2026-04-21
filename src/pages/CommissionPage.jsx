import { useState, useEffect, useRef } from 'react'
import { DollarSign, Check, Loader, ArrowRight, Save, X, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import CommissionDetail from './CommissionDetail'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCommissionSettings, useClients, usePayments, useCommissionLedger, usePaymentBlacklist } from '../hooks/useCommissions'
import { summarizeCommissions } from '../services/commissionCalc'
import { supabase } from '../lib/supabase'
import KPICard from '../components/KPICard'
import ClientsTab from '../components/commission/ClientsTab'
import PaymentsTab from '../components/commission/PaymentsTab'
import CommissionWarnings from '../components/CommissionWarnings'
import MonthPicker from '../components/MonthPicker'

function SettingsCard({ member, saved, onSave }) {
  const [payType, setPayType] = useState(saved.pay_type || 'base')
  const [baseSalary, setBaseSalary] = useState(String(saved.base_salary || ''))
  const [rampAmount, setRampAmount] = useState(String(saved.ramp_amount || ''))
  const [commissionRate, setCommissionRate] = useState(String(saved.commission_rate || ''))
  const [notes, setNotes] = useState(saved.notes || '')
  const [saving, setSaving] = useState(false)
  const [saved_, setSaved_] = useState(false)

  const isRamp = payType === 'ramp'

  const handleSave = async () => {
    setSaving(true)
    setSaved_(false)
    const ok = await onSave(member.id, {
      pay_type: payType,
      base_salary: parseFloat(baseSalary) || 0,
      ramp_amount: parseFloat(rampAmount) || 0,
      commission_rate: parseFloat(commissionRate) || 0,
      notes,
    })
    setSaving(false)
    if (ok) { setSaved_(true); setTimeout(() => setSaved_(false), 3000) }
  }

  const inputCls = 'w-full py-2 bg-bg-primary border border-border-default rounded-lg text-sm text-text-primary font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none focus:border-opt-yellow/50 focus:outline-none transition-colors'

  return (
    <div className="tile tile-feedback p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-text-primary">{member.name}</h3>
          <span className="text-[10px] text-text-400 capitalize">{member.role}</span>
        </div>
        <select
          value={payType}
          onChange={e => setPayType(e.target.value)}
          className="px-3 py-1.5 bg-bg-primary border border-border-default rounded-lg text-xs text-text-primary font-medium"
        >
          <option value="base">Base + Commission</option>
          <option value="ramp">Ramp (Guaranteed Min)</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-opt-yellow uppercase font-medium block mb-1.5">
            {isRamp ? 'Monthly Ramp (Guaranteed Min)' : 'Monthly Base Salary'}
          </label>
          <p className="text-[9px] text-text-400 mb-1.5">
            {isRamp ? 'Topped up if commissions are below this' : 'Fixed pay, commission added on top'}
          </p>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400 text-xs">$</span>
            <input
              type="number"
              value={isRamp ? rampAmount : baseSalary}
              onChange={e => {
                if (isRamp) setRampAmount(e.target.value); else setBaseSalary(e.target.value)
              }}
              className={`${inputCls} pl-6 pr-3`}
            />
          </div>
        </div>

        <div>
          <label className="text-[10px] text-opt-yellow uppercase font-medium block mb-1.5">
            Commission Rate
          </label>
          <p className="text-[9px] text-text-400 mb-1.5">
            % of net cash collected (months 0-3)
          </p>
          <div className="relative">
            <input
              type="number"
              step="0.5"
              value={commissionRate}
              onChange={e => setCommissionRate(e.target.value)}
              className={`${inputCls} pl-3 pr-7`}
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-400 text-xs">%</span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <input
          type="text"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)..."
          className="w-full px-3 py-1.5 bg-bg-primary border border-border-default/50 rounded-lg text-[11px] text-text-400 placeholder:text-text-400/50 focus:border-opt-yellow/50 focus:outline-none transition-colors"
        />
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving ? <><Loader size={12} className="animate-spin" /> Saving...</> : <><Save size={12} /> Save Settings</>}
        </button>
        {saved_ && <span className="text-xs text-success flex items-center gap-1"><Check size={12} /> Saved</span>}
      </div>
    </div>
  )
}

function BlacklistSettings({ blacklist, onAdd, onRemove, userEmail }) {
  const [newPattern, setNewPattern] = useState('')
  const [newField, setNewField] = useState('email')
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!newPattern.trim()) return
    setAdding(true)
    await onAdd(newPattern.trim(), newField, userEmail)
    setNewPattern('')
    setAdding(false)
  }

  return (
    <div className="mt-6">
      <h2 className="text-sm font-medium text-text-secondary mb-2">Payment Blacklist</h2>
      <p className="text-[10px] text-text-400 mb-3">Payments matching these patterns are hidden from the Payments tab.</p>

      <div className="tile tile-feedback p-4">
        <div className="flex items-center gap-2 mb-3">
          <input
            type="text"
            value={newPattern}
            onChange={e => setNewPattern(e.target.value)}
            placeholder="Pattern to filter..."
            className="flex-1 px-3 py-1.5 bg-bg-primary border border-border-default rounded-xl text-xs text-text-primary focus:border-opt-yellow/50 focus:outline-none transition-all"
          />
          <select
            value={newField}
            onChange={e => setNewField(e.target.value)}
            className="px-3 py-1.5 bg-bg-primary border border-border-default rounded-xl text-xs text-text-primary appearance-none cursor-pointer"
          >
            <option value="email">Email</option>
            <option value="name">Name</option>
            <option value="description">Description</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={!newPattern.trim() || adding}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 disabled:opacity-50 transition-all duration-150"
          >
            {adding ? <Loader size={10} className="animate-spin" /> : <Plus size={10} />} Add
          </button>
        </div>

        {blacklist.length === 0 ? (
          <p className="text-text-400 text-[10px]">No blacklist patterns configured</p>
        ) : (
          <div className="space-y-1">
            {blacklist.map(b => (
              <div key={b.id} className="flex items-center justify-between px-3 py-1.5 bg-bg-primary rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-primary font-mono">{b.pattern}</span>
                  <span className="text-[9px] text-text-400 bg-bg-card px-1.5 py-0.5 rounded capitalize">{b.match_field}</span>
                </div>
                <button onClick={() => onRemove(b.id)} className="text-text-400 hover:text-danger transition-colors">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function CommissionPage() {
  const { isAdmin, profile } = useAuth()
  const navigate = useNavigate()

  // Non-admins go straight to their own commission page
  if (!isAdmin && profile?.teamMemberId) {
    return <CommissionDetail memberId={profile.teamMemberId} />
  }

  return <CommissionPageAdmin />
}

function CommissionPageAdmin() {
  const now = new Date()
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [activeTab, setActiveTab] = useState('overview')
  const { members } = useTeamMembers()
  const { settings, settingsMap, upsert: upsertSettings } = useCommissionSettings()
  const { clients, clientsMap, silentRefresh: refreshClients } = useClients()
  const { payments, loading: loadingPayments, matchPayment, unmatchPayment, silentRefresh: refreshPayments } = usePayments(period)
  const { ledger, loading: loadingLedger, updateStatus, silentRefresh: refreshLedger } = useCommissionLedger(null, period)
  const { blacklist, addPattern: addBlacklistPattern, removePattern: removeBlacklistPattern, isBlacklisted } = usePaymentBlacklist()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)

  // Auto-sync Stripe on first page load (once per session)
  const autoSyncRan = useRef(false)
  useEffect(() => {
    if (autoSyncRan.current || loadingPayments) return
    autoSyncRan.current = true
    ;(async () => {
      try {
        const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=7&limit=100&resync=true', {
          headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
        })
        const data = await r.json()
        if (data.synced > 0 || data.matched > 0) refreshPayments()
      } catch (e) { console.warn('Auto Stripe sync failed:', e) }
    })()
  }, [loadingPayments])

  // Auto-calculate commissions on page load and when payments/settings change
  const settingsReady = Object.values(settingsMap).some(s => s.commission_rate > 0)
  useEffect(() => {
    if (settingsReady && payments.length > 0 && !loadingPayments) {
      autoCalculateCommissions()
    }
  }, [settingsReady, payments.length, loadingPayments])

  const summaries = summarizeCommissions(ledger, settingsMap)
  const totalCommission = Object.values(summaries).reduce((s, m) => s + m.total_commission, 0)
  const totalEarnings = members.reduce((sum, m) => {
    const ms = settingsMap[m.id] || {}
    const isRamp = ms.pay_type === 'ramp'
    const baseOrRamp = isRamp ? (ms.ramp_amount || 0) : (ms.base_salary || 0)
    const comm = summaries[m.id]?.total_commission || 0
    return sum + (isRamp ? Math.max(ms.ramp_amount || 0, comm) : baseOrRamp + comm)
  }, 0)
  const totalPayments = payments.reduce((s, p) => s + Number(p.net_amount || 0), 0)
  const unmatchedCount = payments.filter(p => !p.matched).length

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'payments', label: `Payments${unmatchedCount > 0 ? ` (${unmatchedCount} unmatched)` : ''}` },
    { key: 'clients', label: `Clients (${clients.length})` },
    { key: 'settings', label: 'Settings' },
  ]

  const filteredPayments = payments.filter(p => !isBlacklisted(p))

  // Auto-calculate commissions whenever payments or settings change
  const autoCalculateCommissions = async () => {
    const { data: allPayments } = await supabase.from('payments')
      .select('id, net_amount, payment_date, payment_type, client_id')
      .eq('matched', true)

    if (!allPayments?.length) return

    // Get client details separately to avoid join issues
    const clientIds = [...new Set(allPayments.map(p => p.client_id).filter(Boolean))]
    const { data: clientData } = await supabase.from('clients')
      .select('id, closer_id, setter_id, trial_start_date, stage')
      .in('id', clientIds)
    const clientMap = {}
    clientData?.forEach(c => { clientMap[c.id] = c })

    // Check which payments already have commission entries
    const { data: existingEntries } = await supabase.from('commission_ledger').select('payment_id')
    const processedPayments = new Set((existingEntries || []).map(e => e.payment_id))

    let created = 0
    for (const p of allPayments) {
      if (processedPayments.has(p.id)) continue
      const client = clientMap[p.client_id]
      if (!client || (!client.closer_id && !client.setter_id)) continue

      if (client.trial_start_date) {
        const monthsSince = (new Date(p.payment_date) - new Date(client.trial_start_date)) / (30.44 * 86400000)
        if (monthsSince > 4) continue
      }

      const periodStr = p.payment_date.slice(0, 7)
      const commType = p.payment_type === 'trial' ? 'trial_close' : 'ascension'
      const netAmount = Number(p.net_amount) || 0
      if (netAmount <= 0) continue

      if (client.closer_id && settingsMap[client.closer_id]?.commission_rate > 0) {
        const rate = settingsMap[client.closer_id].commission_rate
        await supabase.from('commission_ledger').insert({
          member_id: client.closer_id, payment_id: p.id, client_id: client.id, period: periodStr,
          commission_type: commType, payment_amount: netAmount, commission_rate: rate,
          commission_amount: Number((netAmount * rate / 100).toFixed(2)), status: 'pending',
        })
        created++
      }
      if (client.setter_id && settingsMap[client.setter_id]?.commission_rate > 0) {
        const rate = settingsMap[client.setter_id].commission_rate
        await supabase.from('commission_ledger').insert({
          member_id: client.setter_id, payment_id: p.id, client_id: client.id, period: periodStr,
          commission_type: commType, payment_amount: netAmount, commission_rate: rate,
          commission_amount: Number((netAmount * rate / 100).toFixed(2)), status: 'pending',
        })
        created++
      }
    }
    if (created > 0) refreshLedger()
  }

  const syncStripePayments = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=90&limit=100&resync=true', {
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error)
      setSyncResult(`Stripe: ${data.synced} new, ${data.updated} updated, ${data.matched} matched`)
      refreshPayments()
    } catch (err) {
      setSyncResult(`Stripe error: ${err.message}`)
    }
    setSyncing(false)
    setTimeout(() => setSyncResult(null), 8000)
  }

  const [syncingFanbasis, setSyncingFanbasis] = useState(false)
  const syncFanbasisPayments = async () => {
    setSyncingFanbasis(true)
    setSyncResult(null)
    try {
      const r = await fetch('https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-fanbasis-payments?days=90&limit=100', {
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error)
      setSyncResult(`Fanbasis: ${data.synced} new, ${data.matched} matched`)
      refreshPayments()
    } catch (err) {
      setSyncResult(`Fanbasis error: ${err.message}`)
    }
    setSyncingFanbasis(false)
    setTimeout(() => setSyncResult(null), 8000)
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

      {/* Warnings */}
      <CommissionWarnings
        settingsMap={settingsMap}
        members={members}
        clients={clients}
        payments={payments}
        onTabChange={setActiveTab}
      />

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
        <div className="tile tile-feedback overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default">
            <h2 className="text-sm font-medium text-text-secondary">Commission Breakdown — {period}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-bg-card text-text-400 uppercase text-[10px]">
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-right">Base / Ramp</th>
                  <th className="px-3 py-2 text-right">Trial</th>
                  <th className="px-3 py-2 text-right">Ascension</th>
                  <th className="px-3 py-2 text-right">Recurring</th>
                  <th className="px-3 py-2 text-right">Total Commission</th>
                  <th className="px-3 py-2 text-right">Total Earnings</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => {
                  const ms = settingsMap[m.id] || {}
                  const isRamp = ms.pay_type === 'ramp'
                  const baseOrRamp = isRamp ? (ms.ramp_amount || 0) : (ms.base_salary || 0)
                  const raw = summaries[m.id] || { trial_commission: 0, ascension_commission: 0, recurring_commission: 0, total_commission: 0, entries: [] }
                  const totalEarnings = isRamp ? Math.max(ms.ramp_amount || 0, raw.total_commission) : baseOrRamp + raw.total_commission
                  const s = { ...raw, base_salary: baseOrRamp, total_earnings: totalEarnings, pay_type: ms.pay_type || 'base' }
                  return (
                    <tr key={m.id} onClick={() => navigate(`/sales/commissions/${m.id}`)} className="border-t border-border-default/30 row-glow transition-all duration-150 cursor-pointer group">
                      <td className="px-3 py-2 font-medium text-opt-yellow hover:underline">{m.name}</td>
                      <td className="px-3 py-2 text-text-400 capitalize">{m.role}</td>
                      <td className="px-3 py-2 text-right text-text-400">
                        ${s.base_salary.toLocaleString()}
                        <span className="text-[9px] ml-1 text-text-400/60">{s.pay_type === 'ramp' ? 'ramp' : 'base'}</span>
                      </td>
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
        <PaymentsTab
          payments={filteredPayments}
          clients={clients}
          period={period}
          loadingPayments={loadingPayments}
          matchPayment={matchPayment}
          unmatchPayment={unmatchPayment}
          refreshPayments={refreshPayments}
          refreshLedger={refreshLedger}
          syncing={syncing}
          syncingFanbasis={syncingFanbasis}
          syncResult={syncResult}
          onSync={syncStripePayments}
          onSyncFanbasis={syncFanbasisPayments}
          userEmail={profile?.email}
        />
      )}

      {/* Clients Tab */}
      {activeTab === 'clients' && (
        <ClientsTab
          clients={clients}
          members={members}
          payments={payments}
          refreshClients={refreshClients}
          refreshLedger={refreshLedger}
          refreshPayments={refreshPayments}
        />
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div>
          <div className="mb-4">
            <h2 className="text-sm font-medium text-text-secondary">Team Commission Settings</h2>
            <p className="text-[10px] text-text-400 mt-0.5">Commission is earned on cash collected within the first 3 months of a client's trial start date. Changes auto-save.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {members.map(m => (
              <SettingsCard key={m.id} member={m} saved={settingsMap[m.id] || {}} onSave={upsertSettings} />
            ))}
          </div>

          {/* Payment Blacklist */}
          <BlacklistSettings blacklist={blacklist} onAdd={addBlacklistPattern} onRemove={removeBlacklistPattern} userEmail={profile?.email} />
        </div>
      )}
    </div>
  )
}
