import { useState, useRef } from 'react'
import { DollarSign, Upload, Check, X, ChevronDown, Loader, Search, ArrowRight, Plus, Edit3, Save, Download, Eye } from 'lucide-react'
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
    <div className="bg-bg-card border border-border-default rounded-2xl p-4">
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
  const [showAddClient, setShowAddClient] = useState(false)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [editingClientId, setEditingClientId] = useState(null)
  const [editClient, setEditClient] = useState({})
  const [newClient, setNewClient] = useState({ name: '', email: '', phone: '', company_name: '', closer_id: '', setter_id: '', stage: 'trial', monthly_amount: '', trial_amount: '', trial_start_date: '', ascension_date: '', billing_day: '', next_billing_date: '', payment_count: '0' })
  const [newPayment, setNewPayment] = useState({ customer_name: '', customer_email: '', amount: '', fee: '', source: 'stripe', payment_type: 'trial', payment_date: new Date().toISOString().split('T')[0], description: '' })
  const [csvPreview, setCsvPreview] = useState(null) // { headers, rows, file }

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

  // CSV parser that handles quoted fields
  const parseCSV = (text) => {
    const rows = []
    let current = ''
    let inQuotes = false
    const lines = []
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; continue }
      if (ch === '\r' && !inQuotes) continue
      current += ch
    }
    if (current.trim()) lines.push(current)

    if (lines.length < 2) return { headers: [], rows: [] }
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim())
      if (!vals.some(v => v)) continue
      const row = {}
      headers.forEach((h, j) => { row[h] = vals[j] || null })
      rows.push(row)
    }
    return { headers, rows }
  }

  // Template download as Excel (.xlsx)
  const downloadTemplate = () => {
    const headers = ['name', 'email', 'phone', 'company_name', 'closer', 'setter', 'stage', 'monthly_amount', 'trial_amount', 'trial_start_date', 'ascension_date', 'billing_day', 'next_billing_date', 'payment_count', 'notes']
    const examples = [
      ['John Smith', 'john@company.com', '+15551234567', 'Smith Remodeling', 'Daniel', 'Josh', 'trial', '3000', '997', '2026-03-15', '', '15', '2026-04-15', '1', 'Trial paid, month 1 due Apr 15'],
      ['Jane Doe', 'jane@janedoe.com', '+15559876543', 'Doe Restoration', 'Daniel', 'Leandre', 'ascended', '3000', '997', '2026-01-10', '2026-02-10', '10', '2026-04-10', '3', 'Month 3 payment due'],
    ]
    const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const toCell = (v, r, c) => {
      const ref = String.fromCharCode(65 + c) + (r + 1)
      if (!v && v !== 0) return `<c r="${ref}" t="inlineStr"><is><t></t></is></c>`
      return `<c r="${ref}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`
    }
    const rows = [headers, ...examples]
    const sheetRows = rows.map((row, ri) =>
      `<row r="${ri + 1}">${row.map((v, ci) => toCell(v, ri, ci)).join('')}</row>`
    ).join('')
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Client Import" sheetId="1" r:id="rId1"/></sheets></workbook>`
    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

    // Build zip manually using JSZip-like approach with Blob
    // Simpler: just use CSV with .xlsx won't open properly without zip. Use .xls (HTML table format) instead.
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Client Import</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table>${rows.map((row, ri) => `<tr>${row.map(v => `<td${ri === 0 ? ' style="font-weight:bold;background:#f0e050"' : ''}>${escXml(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'client_import_template.xls'; a.click()
    URL.revokeObjectURL(url)
  }

  // CSV preview — parse file and show preview before importing
  const handleCSVSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const { headers, rows } = parseCSV(text)
    // Enrich with closer/setter match status
    const memberByName = {}
    members.forEach(m => { memberByName[m.name.toLowerCase()] = m.id })
    const enriched = rows.map(row => ({
      ...row,
      _closerMatch: row.closer ? !!memberByName[row.closer.toLowerCase()] : true,
      _setterMatch: row.setter ? !!memberByName[row.setter.toLowerCase()] : true,
      _hasName: !!row.name,
    }))
    setCsvPreview({ headers, rows: enriched })
    e.target.value = '' // reset file input
  }

  // Actually import after preview confirmation
  const handleConfirmImport = async () => {
    if (!csvPreview) return
    setImportStatus('Importing...')
    const memberByName = {}
    members.forEach(m => { memberByName[m.name.toLowerCase()] = m.id })

    let imported = 0
    for (const row of csvPreview.rows) {
      if (!row.name) continue
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
        billing_day: parseInt(row.billing_day) || null,
        next_billing_date: row.next_billing_date || null,
        payment_count: parseInt(row.payment_count) || 0,
        notes: row.notes || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email', ignoreDuplicates: false })
      if (!error) imported++
    }

    setImportStatus(`Imported ${imported} of ${csvPreview.rows.length} clients`)
    setCsvPreview(null)
    refreshClients()
    setTimeout(() => setImportStatus(null), 5000)
  }

  const handleAddClient = async () => {
    const { error } = await supabase.from('clients').insert({
      name: newClient.name,
      email: newClient.email || null,
      phone: newClient.phone || null,
      company_name: newClient.company_name || null,
      closer_id: newClient.closer_id || null,
      setter_id: newClient.setter_id || null,
      stage: newClient.stage || 'trial',
      monthly_amount: parseFloat(newClient.monthly_amount) || 0,
      trial_amount: parseFloat(newClient.trial_amount) || 0,
      trial_start_date: newClient.trial_start_date || null,
      ascension_date: newClient.ascension_date || null,
      billing_day: parseInt(newClient.billing_day) || null,
      next_billing_date: newClient.next_billing_date || null,
      payment_count: parseInt(newClient.payment_count) || 0,
    })
    if (!error) {
      setShowAddClient(false)
      setNewClient({ name: '', email: '', phone: '', company_name: '', closer_id: '', setter_id: '', stage: 'trial', monthly_amount: '', trial_amount: '', trial_start_date: '', ascension_date: '' })
      refreshClients()
    }
  }

  const handleSaveClient = async (clientId) => {
    const { error } = await supabase.from('clients').update({
      name: editClient.name,
      email: editClient.email || null,
      phone: editClient.phone || null,
      company_name: editClient.company_name || null,
      closer_id: editClient.closer_id || null,
      setter_id: editClient.setter_id || null,
      stage: editClient.stage || 'trial',
      monthly_amount: parseFloat(editClient.monthly_amount) || 0,
      trial_amount: parseFloat(editClient.trial_amount) || 0,
      trial_start_date: editClient.trial_start_date || null,
      ascension_date: editClient.ascension_date || null,
      billing_day: parseInt(editClient.billing_day) || null,
      next_billing_date: editClient.next_billing_date || null,
      payment_count: parseInt(editClient.payment_count) || 0,
      updated_at: new Date().toISOString(),
    }).eq('id', clientId)
    if (!error) {
      setEditingClientId(null)
      refreshClients()
    }
  }

  const handleAddPayment = async () => {
    const amount = parseFloat(newPayment.amount) || 0
    const fee = parseFloat(newPayment.fee) || 0
    const net = amount - fee

    // Try auto-match by email
    let clientId = null
    let matched = false
    if (newPayment.customer_email) {
      const match = clients.find(c => c.email && c.email.toLowerCase() === newPayment.customer_email.toLowerCase())
      if (match) { clientId = match.id; matched = true }
    }

    const { error } = await supabase.from('payments').insert({
      source: newPayment.source || 'manual',
      source_event_id: `manual_${Date.now()}`,
      amount,
      fee,
      net_amount: net,
      customer_email: newPayment.customer_email || null,
      customer_name: newPayment.customer_name || null,
      payment_date: newPayment.payment_date ? new Date(newPayment.payment_date).toISOString() : new Date().toISOString(),
      payment_type: newPayment.payment_type || 'trial',
      description: newPayment.description || null,
      client_id: clientId,
      matched,
    })
    if (!error) {
      setShowAddPayment(false)
      setNewPayment({ customer_name: '', customer_email: '', amount: '', fee: '', source: 'stripe', payment_type: 'trial', payment_date: new Date().toISOString().split('T')[0], description: '' })
    }
  }

  const inputCls = 'w-full px-2 py-1.5 bg-bg-primary border border-border-default rounded text-xs text-text-primary'
  const selectCls = 'w-full px-2 py-1.5 bg-bg-primary border border-border-default rounded text-xs text-text-primary'

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
                    <tr key={m.id} onClick={() => navigate(`/sales/commissions/${m.id}`)} className="border-t border-border-default/30 hover:bg-bg-card-hover/50 cursor-pointer">
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
        <div>
          {/* Add Payment Modal */}
          {showAddPayment && (
            <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-text-secondary">Add Payment</h3>
                <button onClick={() => setShowAddPayment(false)} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <div><label className="text-[10px] text-text-400 block mb-1">Customer Name</label><input value={newPayment.customer_name} onChange={e => setNewPayment(p => ({ ...p, customer_name: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Customer Email</label><input value={newPayment.customer_email} onChange={e => setNewPayment(p => ({ ...p, customer_email: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Amount ($)</label><input type="number" step="0.01" value={newPayment.amount} onChange={e => setNewPayment(p => ({ ...p, amount: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Fee ($)</label><input type="number" step="0.01" value={newPayment.fee} onChange={e => setNewPayment(p => ({ ...p, fee: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Source</label>
                  <select value={newPayment.source} onChange={e => setNewPayment(p => ({ ...p, source: e.target.value }))} className={selectCls}>
                    <option value="stripe">Stripe</option><option value="fanbasis">Fanbasis</option><option value="manual">Manual</option>
                  </select></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Type</label>
                  <select value={newPayment.payment_type} onChange={e => setNewPayment(p => ({ ...p, payment_type: e.target.value }))} className={selectCls}>
                    <option value="trial">Trial</option><option value="monthly">Monthly</option><option value="ascension">Ascension</option><option value="pif">PIF</option><option value="one_time">One-Time</option>
                  </select></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Payment Date</label><input type="date" value={newPayment.payment_date} onChange={e => setNewPayment(p => ({ ...p, payment_date: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Description</label><input value={newPayment.description} onChange={e => setNewPayment(p => ({ ...p, description: e.target.value }))} placeholder="Optional" className={inputCls} /></div>
              </div>
              <button onClick={handleAddPayment} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90"><Save size={12} className="inline mr-1" />Save Payment</button>
            </div>
          )}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-secondary">Payments — {period}</h2>
            <button onClick={() => setShowAddPayment(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90"><Plus size={12} /> Add Payment</button>
          </div>
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
        </div>
      )}

      {/* Clients Tab */}
      {activeTab === 'clients' && (
        <div>
          {/* Add Client Form */}
          {showAddClient && (
            <div className="bg-bg-card border border-border-default rounded-2xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-text-secondary">Add Client</h3>
                <button onClick={() => setShowAddClient(false)} className="text-text-400 hover:text-text-primary"><X size={14} /></button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <div><label className="text-[10px] text-text-400 block mb-1">Name *</label><input value={newClient.name} onChange={e => setNewClient(c => ({ ...c, name: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Email</label><input value={newClient.email} onChange={e => setNewClient(c => ({ ...c, email: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Phone</label><input value={newClient.phone} onChange={e => setNewClient(c => ({ ...c, phone: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Company</label><input value={newClient.company_name} onChange={e => setNewClient(c => ({ ...c, company_name: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Closer</label>
                  <select value={newClient.closer_id} onChange={e => setNewClient(c => ({ ...c, closer_id: e.target.value }))} className={selectCls}>
                    <option value="">—</option>
                    {members.filter(m => m.role === 'closer').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Setter</label>
                  <select value={newClient.setter_id} onChange={e => setNewClient(c => ({ ...c, setter_id: e.target.value }))} className={selectCls}>
                    <option value="">—</option>
                    {members.filter(m => m.role === 'setter').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Stage</label>
                  <select value={newClient.stage} onChange={e => setNewClient(c => ({ ...c, stage: e.target.value }))} className={selectCls}>
                    <option value="trial">Trial</option><option value="ascended">Ascended</option><option value="pif">PIF</option><option value="paused">Paused</option><option value="churned">Churned</option>
                  </select></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Monthly $</label><input type="number" value={newClient.monthly_amount} onChange={e => setNewClient(c => ({ ...c, monthly_amount: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Trial $</label><input type="number" value={newClient.trial_amount} onChange={e => setNewClient(c => ({ ...c, trial_amount: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Trial Start</label><input type="date" value={newClient.trial_start_date} onChange={e => setNewClient(c => ({ ...c, trial_start_date: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Ascension Date</label><input type="date" value={newClient.ascension_date} onChange={e => setNewClient(c => ({ ...c, ascension_date: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Billing Day (1-28)</label><input type="number" min="1" max="28" value={newClient.billing_day || ''} onChange={e => setNewClient(c => ({ ...c, billing_day: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Next Billing Date</label><input type="date" value={newClient.next_billing_date || ''} onChange={e => setNewClient(c => ({ ...c, next_billing_date: e.target.value }))} className={inputCls} /></div>
                <div><label className="text-[10px] text-text-400 block mb-1">Payments Received</label>
                  <select value={newClient.payment_count || '0'} onChange={e => setNewClient(c => ({ ...c, payment_count: e.target.value }))} className={selectCls}>
                    <option value="0">0 — No payments yet</option>
                    <option value="1">1 — Trial paid</option>
                    <option value="2">2 — Month 1 paid</option>
                    <option value="3">3 — Month 2 paid</option>
                    <option value="4">4 — Month 3 paid</option>
                  </select></div>
              </div>
              <button onClick={handleAddClient} disabled={!newClient.name} className="px-4 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90 disabled:opacity-50"><Save size={12} className="inline mr-1" />Save Client</button>
            </div>
          )}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-secondary">Client List</h2>
            <div className="flex items-center gap-2">
              {importStatus && <span className="text-[10px] text-success">{importStatus}</span>}
              <input ref={fileRef} type="file" accept=".csv" onChange={handleCSVSelect} className="hidden" />
              <button onClick={downloadTemplate} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-default text-text-400 rounded-lg hover:bg-bg-card-hover"><Download size={12} /> Template</button>
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-default text-text-primary rounded-lg hover:bg-bg-card-hover"><Upload size={12} /> Import CSV</button>
              <button onClick={() => setShowAddClient(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90"><Plus size={12} /> Add Client</button>
            </div>
          </div>
          {/* CSV Preview Modal */}
          {csvPreview && (
            <div className="bg-bg-card border-2 border-opt-yellow/30 rounded-2xl overflow-hidden mb-4">
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between bg-opt-yellow/5">
                <div className="flex items-center gap-2">
                  <Eye size={14} className="text-opt-yellow" />
                  <h3 className="text-sm font-medium text-text-secondary">CSV Preview — {csvPreview.rows.length} rows</h3>
                  {csvPreview.rows.some(r => !r._hasName) && (
                    <span className="text-[10px] text-danger">({csvPreview.rows.filter(r => !r._hasName).length} missing name)</span>
                  )}
                  {csvPreview.rows.some(r => !r._closerMatch || !r._setterMatch) && (
                    <span className="text-[10px] text-warning">({csvPreview.rows.filter(r => !r._closerMatch || !r._setterMatch).length} unmatched team)</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setCsvPreview(null)} className="px-3 py-1 text-xs text-text-400 hover:text-text-primary border border-border-default rounded-lg">Cancel</button>
                  <button onClick={handleConfirmImport} className="px-4 py-1 text-xs font-medium bg-opt-yellow text-bg-primary rounded-lg hover:bg-opt-yellow/90">Import All ({csvPreview.rows.filter(r => r._hasName).length})</button>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[350px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card z-10">
                    <tr className="text-text-400 uppercase text-[10px]">
                      <th className="px-2 py-2 text-left w-6">#</th>
                      {csvPreview.headers.map(h => <th key={h} className="px-2 py-2 text-left">{h}</th>)}
                      <th className="px-2 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className={`border-t border-border-default/30 ${!row._hasName ? 'bg-danger/5' : ''}`}>
                        <td className="px-2 py-1.5 text-text-400">{i + 1}</td>
                        {csvPreview.headers.map(h => (
                          <td key={h} className={`px-2 py-1.5 ${
                            h === 'closer' && !row._closerMatch ? 'text-warning' :
                            h === 'setter' && !row._setterMatch ? 'text-warning' :
                            h === 'name' && !row[h] ? 'text-danger' :
                            'text-text-primary'
                          }`}>{row[h] || '—'}</td>
                        ))}
                        <td className="px-2 py-1.5">
                          {!row._hasName ? <span className="text-danger text-[10px]">Missing name</span> :
                           !row._closerMatch ? <span className="text-warning text-[10px]">Closer not found</span> :
                           !row._setterMatch ? <span className="text-warning text-[10px]">Setter not found</span> :
                           <span className="text-success text-[10px]">Ready</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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
                    <th className="px-3 py-2 text-left">Payment #</th>
                    <th className="px-3 py-2 text-left">Next Billing</th>
                    <th className="px-3 py-2 text-right">Forecast</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr><td colSpan={11} className="px-4 py-8 text-center text-text-400">No clients yet — click Add Client or Import CSV to get started</td></tr>
                  ) : clients.map(c => {
                    const isEditing = editingClientId === c.id
                    if (isEditing) {
                      const ec = editClient
                      return (
                        <tr key={c.id} className="border-t border-border-default/30 bg-opt-yellow/5">
                          <td className="px-2 py-1"><input value={ec.name || ''} onChange={e => setEditClient(x => ({ ...x, name: e.target.value }))} className={inputCls} /></td>
                          <td className="px-2 py-1"><input value={ec.company_name || ''} onChange={e => setEditClient(x => ({ ...x, company_name: e.target.value }))} className={inputCls} /></td>
                          <td className="px-2 py-1"><input value={ec.email || ''} onChange={e => setEditClient(x => ({ ...x, email: e.target.value }))} className={inputCls} /></td>
                          <td className="px-2 py-1">
                            <select value={ec.stage || 'trial'} onChange={e => setEditClient(x => ({ ...x, stage: e.target.value }))} className={selectCls}>
                              <option value="trial">Trial</option><option value="ascended">Ascended</option><option value="pif">PIF</option><option value="paused">Paused</option><option value="churned">Churned</option>
                            </select></td>
                          <td className="px-2 py-1">
                            <select value={ec.closer_id || ''} onChange={e => setEditClient(x => ({ ...x, closer_id: e.target.value }))} className={selectCls}>
                              <option value="">—</option>{members.filter(m => m.role === 'closer').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select></td>
                          <td className="px-2 py-1">
                            <select value={ec.setter_id || ''} onChange={e => setEditClient(x => ({ ...x, setter_id: e.target.value }))} className={selectCls}>
                              <option value="">—</option>{members.filter(m => m.role === 'setter').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select></td>
                          <td className="px-2 py-1"><input type="number" value={ec.monthly_amount || ''} onChange={e => setEditClient(x => ({ ...x, monthly_amount: e.target.value }))} className={inputCls + ' text-right'} /></td>
                          <td className="px-2 py-1">
                            <select value={ec.payment_count || 0} onChange={e => setEditClient(x => ({ ...x, payment_count: e.target.value }))} className={selectCls}>
                              <option value="0">None</option><option value="1">Trial</option><option value="2">Mo 1</option><option value="3">Mo 2</option><option value="4">Mo 3</option>
                            </select></td>
                          <td className="px-2 py-1"><input type="date" value={ec.next_billing_date || ''} onChange={e => setEditClient(x => ({ ...x, next_billing_date: e.target.value }))} className={inputCls} /></td>
                          <td className="px-2 py-1"></td>
                          <td className="px-2 py-1">
                            <div className="flex gap-1">
                              <button onClick={() => handleSaveClient(c.id)} className="text-success hover:text-success/80"><Save size={12} /></button>
                              <button onClick={() => setEditingClientId(null)} className="text-text-400 hover:text-text-primary"><X size={12} /></button>
                            </div>
                          </td>
                        </tr>
                      )
                    }
                    return (
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
                        <td className="px-3 py-2">
                          {(() => {
                            const pc = c.payment_count || 0
                            const labels = ['No payments', 'Trial', 'Month 1', 'Month 2', 'Month 3', 'Month 4+']
                            const colors = ['text-danger', 'text-blue-400', 'text-opt-yellow', 'text-opt-yellow', 'text-success', 'text-success']
                            return <span className={`text-[10px] font-medium ${colors[Math.min(pc, 5)]}`}>{labels[Math.min(pc, 5)]}</span>
                          })()}
                        </td>
                        <td className="px-3 py-2 text-text-400 text-[10px]">
                          {c.next_billing_date ? new Date(c.next_billing_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {(() => {
                            const pc = c.payment_count || 0
                            const remaining = Math.max(0, 4 - pc) // payments left in commission window (trial + 3 months)
                            const forecast = remaining * Number(c.monthly_amount || 0)
                            return forecast > 0
                              ? <span className="text-opt-yellow text-[10px] font-medium">${forecast.toLocaleString()}</span>
                              : <span className="text-text-400 text-[10px]">—</span>
                          })()}
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={() => { setEditingClientId(c.id); setEditClient({ name: c.name, email: c.email, phone: c.phone, company_name: c.company_name, closer_id: c.closer_id || '', setter_id: c.setter_id || '', stage: c.stage, monthly_amount: c.monthly_amount, trial_amount: c.trial_amount, trial_start_date: c.trial_start_date || '', ascension_date: c.ascension_date || '', billing_day: c.billing_day || '', next_billing_date: c.next_billing_date || '', payment_count: c.payment_count || 0 }) }} className="text-text-400 hover:text-opt-yellow"><Edit3 size={12} /></button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
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
        </div>
      )}
    </div>
  )
}
