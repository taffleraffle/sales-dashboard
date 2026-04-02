import { useState, useRef } from 'react'
import { Plus, Upload, Download, X, Edit3, Loader, Save, Eye } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getCountry } from '../../utils/countryUtils'
import ClientEditPanel from '../ClientEditPanel'
import ClientPaymentTimeline from '../ClientPaymentTimeline'
import GHLImportModal from '../GHLImportModal'

const STAGE_COLORS = {
  trial: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  ascended: 'bg-success/15 text-success border-success/30',
  churned: 'bg-danger/15 text-danger border-danger/30',
  paused: 'bg-warning/15 text-warning border-warning/30',
  pif: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const inputCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 placeholder:text-text-400/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
const selectCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 appearance-none cursor-pointer'

export default function ClientsTab({ clients, members, payments, refreshClients, refreshLedger, refreshPayments }) {
  const [editingClient, setEditingClient] = useState(null)
  const [showAddClient, setShowAddClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', email: '', phone: '', company_name: '', closer_id: '', setter_id: '', stage: 'trial', monthly_amount: '', trial_amount: '', trial_start_date: '', ascension_date: '', billing_day: '', next_billing_date: '', payment_count: '0' })
  const [csvPreview, setCsvPreview] = useState(null)
  const [importStatus, setImportStatus] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [addingClient, setAddingClient] = useState(false)
  const [timelineClient, setTimelineClient] = useState(null)
  const [showGHLImport, setShowGHLImport] = useState(false)
  const fileRef = useRef(null)

  // Count transactions per client
  const txCountByClient = {}
  payments.forEach(p => { if (p.client_id) txCountByClient[p.client_id] = (txCountByClient[p.client_id] || 0) + 1 })

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

  const parseDate = (v) => {
    if (!v || !v.trim()) return null
    v = v.trim()
    let year, month, day
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
      ;[year, month, day] = v.split('-').map(Number)
    } else {
      const slash = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
      if (!slash) return null
      const [, a, b, y] = slash.map(Number)
      year = y
      if (a > 12) { day = a; month = b }
      else if (b > 12) { month = a; day = b }
      else { day = a; month = b }
    }
    const d = new Date(year, month - 1, day)
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // Template download as Excel (.xls)
  const downloadTemplate = () => {
    const headers = ['name', 'email', 'phone', 'company_name', 'closer', 'setter', 'stage', 'monthly_amount', 'trial_amount', 'trial_start_date', 'ascension_date', 'billing_day', 'next_billing_date', 'payment_count', 'notes']
    const examples = [
      ['John Smith', 'john@company.com', '+15551234567', 'Smith Remodeling', 'Daniel', 'Josh', 'trial', '3000', '997', '2026-03-15', '', '15', '2026-04-15', '1', 'Trial paid, month 1 due Apr 15'],
      ['Jane Doe', 'jane@janedoe.com', '+15559876543', 'Doe Restoration', 'Daniel', 'Leandre', 'ascended', '3000', '997', '2026-01-10', '2026-02-10', '10', '2026-04-10', '3', 'Month 3 payment due'],
    ]
    const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rows = [headers, ...examples]
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Client Import</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table>${rows.map((row, ri) => `<tr>${row.map(v => `<td${ri === 0 ? ' style="font-weight:bold;background:#f0e050"' : ''}>${escXml(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'client_import_template.xls'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleCSVSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const { headers, rows } = parseCSV(text)
    const memberByName = {}
    members.forEach(m => { memberByName[m.name.toLowerCase()] = m.id })
    const enriched = rows.map(row => ({
      ...row,
      _closerMatch: row.closer ? !!memberByName[row.closer.toLowerCase()] : true,
      _setterMatch: row.setter ? !!memberByName[row.setter.toLowerCase()] : true,
      _hasName: !!row.name,
    }))
    setCsvPreview({ headers, rows: enriched })
    e.target.value = ''
  }

  const handleConfirmImport = async () => {
    if (!csvPreview) return
    setImportStatus('Importing...')
    const memberByName = {}
    members.forEach(m => { memberByName[m.name.toLowerCase()] = m.id })
    const rows = csvPreview.rows.filter(r => r.name)
    const insertRows = rows.map(row => ({
      name: row.name,
      email: row.email || null,
      phone: row.phone || null,
      company_name: row.company_name || row.company || null,
      closer_id: (row.closer ? memberByName[row.closer.toLowerCase()] : null) || null,
      setter_id: (row.setter ? memberByName[row.setter.toLowerCase()] : null) || null,
      stage: row.stage || 'trial',
      trial_start_date: parseDate(row.trial_start_date || row.trial_start),
      ascension_date: parseDate(row.ascension_date),
      monthly_amount: parseFloat(row.monthly_amount) || 0,
      trial_amount: parseFloat(row.trial_amount) || 0,
      billing_day: parseInt(row.billing_day) || null,
      next_billing_date: parseDate(row.next_billing_date),
      payment_count: parseInt(row.payment_count) || 0,
      notes: row.notes || null,
    }))
    const { data, error } = await supabase.from('clients').insert(insertRows).select('id')
    if (error) {
      setImportStatus(`Error: ${error.message}`)
    } else {
      setImportStatus(`Imported ${data.length} of ${rows.length} clients`)
    }
    setCsvPreview(null)
    refreshClients()
    setTimeout(() => setImportStatus(null), 8000)
  }

  const handleAddClient = async () => {
    setAddingClient(true)
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
    setAddingClient(false)
    if (!error) {
      setShowAddClient(false)
      setNewClient({ name: '', email: '', phone: '', company_name: '', closer_id: '', setter_id: '', stage: 'trial', monthly_amount: '', trial_amount: '', trial_start_date: '', ascension_date: '', billing_day: '', next_billing_date: '', payment_count: '0' })
      refreshClients()
    }
  }

  const handleSaveClient = async (clientId, data) => {
    const { error } = await supabase.from('clients').update(data).eq('id', clientId)
    if (!error) {
      refreshClients()
    }
  }

  const deleteClient = async (clientId) => {
    if (!confirm('Delete this client? This cannot be undone.')) return
    setDeletingId(clientId)
    await supabase.from('commission_ledger').delete().eq('client_id', clientId)
    await supabase.from('payments').update({ client_id: null, matched: false }).eq('client_id', clientId)
    await supabase.from('clients').delete().eq('id', clientId)
    setDeletingId(null)
    // Silent refreshes to avoid table flash
    refreshClients()
    refreshLedger()
    refreshPayments()
  }

  return (
    <div>
      {/* Add Client Form */}
      <div className={`expand-section ${showAddClient ? 'max-h-[600px] opacity-100 mb-4' : 'max-h-0 opacity-0'}`}>
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-secondary">Add Client</h3>
            <button onClick={() => setShowAddClient(false)} className="text-text-400 hover:text-text-primary transition-colors"><X size={14} /></button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Name *</label><input value={newClient.name} onChange={e => setNewClient(c => ({ ...c, name: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Email</label><input value={newClient.email} onChange={e => setNewClient(c => ({ ...c, email: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Phone</label><input value={newClient.phone} onChange={e => setNewClient(c => ({ ...c, phone: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Company</label><input value={newClient.company_name} onChange={e => setNewClient(c => ({ ...c, company_name: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Closer</label>
              <select value={newClient.closer_id} onChange={e => setNewClient(c => ({ ...c, closer_id: e.target.value }))} className={selectCls}>
                <option value="">—</option>
                {members.filter(m => m.role === 'closer').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Setter</label>
              <select value={newClient.setter_id} onChange={e => setNewClient(c => ({ ...c, setter_id: e.target.value }))} className={selectCls}>
                <option value="">—</option>
                {members.filter(m => m.role === 'setter').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Stage</label>
              <select value={newClient.stage} onChange={e => setNewClient(c => ({ ...c, stage: e.target.value }))} className={selectCls}>
                <option value="trial">Trial</option><option value="ascended">Ascended</option><option value="pif">PIF</option><option value="paused">Paused</option><option value="churned">Churned</option>
              </select></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Monthly $</label><input type="number" value={newClient.monthly_amount} onChange={e => setNewClient(c => ({ ...c, monthly_amount: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Trial $</label><input type="number" value={newClient.trial_amount} onChange={e => setNewClient(c => ({ ...c, trial_amount: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Trial Start</label><input type="date" value={newClient.trial_start_date} onChange={e => setNewClient(c => ({ ...c, trial_start_date: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Ascension Date</label><input type="date" value={newClient.ascension_date} onChange={e => setNewClient(c => ({ ...c, ascension_date: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Billing Day (1-28)</label><input type="number" min="1" max="28" value={newClient.billing_day || ''} onChange={e => setNewClient(c => ({ ...c, billing_day: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Next Billing Date</label><input type="date" value={newClient.next_billing_date || ''} onChange={e => setNewClient(c => ({ ...c, next_billing_date: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Payments Received</label>
              <select value={newClient.payment_count || '0'} onChange={e => setNewClient(c => ({ ...c, payment_count: e.target.value }))} className={selectCls}>
                <option value="0">0 — No payments yet</option>
                <option value="1">1 — Trial paid</option>
                <option value="2">2 — Month 1 paid</option>
                <option value="3">3 — Month 2 paid</option>
                <option value="4">4 — Month 3 paid</option>
              </select></div>
          </div>
          <button onClick={handleAddClient} disabled={!newClient.name || addingClient} className="px-4 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 disabled:opacity-50 transition-all duration-150 flex items-center gap-1.5">
            {addingClient ? <><Loader size={12} className="animate-spin" /> Saving...</> : <><Save size={12} /> Save Client</>}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-secondary">Client List</h2>
        <div className="flex items-center gap-2">
          {importStatus && <span className="text-[10px] text-success">{importStatus}</span>}
          <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx,.tsv,.txt" onChange={handleCSVSelect} className="hidden" />
          <button onClick={downloadTemplate} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-default text-text-400 rounded-xl hover:bg-bg-card-hover transition-all duration-150"><Download size={12} /> Template</button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-default text-text-primary rounded-xl hover:bg-bg-card-hover transition-all duration-150"><Upload size={12} /> Import CSV</button>
          <button onClick={() => setShowGHLImport(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-purple-500/30 text-purple-400 rounded-xl hover:bg-purple-500/10 transition-all duration-150"><Download size={12} /> Import GHL</button>
          <button onClick={() => setShowAddClient(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 transition-all duration-150"><Plus size={12} /> Add Client</button>
        </div>
      </div>

      {/* CSV Preview */}
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
              <button onClick={() => setCsvPreview(null)} className="px-3 py-1 text-xs text-text-400 hover:text-text-primary border border-border-default rounded-xl transition-all duration-150">Cancel</button>
              <button onClick={handleConfirmImport} className="px-4 py-1 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 transition-all duration-150">Import All ({csvPreview.rows.filter(r => r._hasName).length})</button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[350px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-card z-10">
                <tr className="text-text-400 uppercase text-[10px] tracking-wider">
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

      {/* Client Table */}
      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-card text-text-400 uppercase text-[10px] tracking-wider">
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-center w-14">Country</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Stage</th>
                <th className="px-3 py-2 text-left">Closer</th>
                <th className="px-3 py-2 text-left">Setter</th>
                <th className="px-3 py-2 text-right">Monthly</th>
                <th className="px-3 py-2 text-left">Payment #</th>
                <th className="px-3 py-2 text-left">Next Billing</th>
                <th className="px-3 py-2 text-right">Txns</th>
                <th className="px-3 py-2 text-right">Forecast</th>
                <th className="px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 ? (
                <tr><td colSpan={13} className="px-4 py-8 text-center text-text-400">No clients yet — click Add Client or Import CSV to get started</td></tr>
              ) : clients.map(c => {
                const country = getCountry(c.phone, c.email)
                return (
                  <tr key={c.id} className={`border-t border-border-default/30 row-glow transition-all duration-150 group ${deletingId === c.id ? 'opacity-40' : ''}`}>
                    <td className="px-3 py-2 font-medium text-text-primary group-hover:text-opt-yellow transition-colors">
                      {c.name}
                    </td>
                    <td className="px-3 py-2 text-center text-[10px]">
                      <span title={country.code}>{country.flag} {country.code}</span>
                    </td>
                    <td className="px-3 py-2 text-text-400">{c.company_name || '—'}</td>
                    <td className="px-3 py-2 text-text-400 text-[10px]">{c.email || '—'}</td>
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
                      <button
                        onClick={() => txCountByClient[c.id] > 0 && setTimelineClient(c)}
                        className={`text-[10px] font-medium tabular-nums ${txCountByClient[c.id] > 0 ? 'text-opt-yellow hover:underline cursor-pointer' : 'text-text-primary cursor-default'}`}
                      >
                        {txCountByClient[c.id] || 0}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {(() => {
                        const pc = c.payment_count || 0
                        const remaining = Math.max(0, 4 - pc)
                        const forecast = remaining * Number(c.monthly_amount || 0)
                        return forecast > 0
                          ? <span className="text-opt-yellow text-[10px] font-medium">${forecast.toLocaleString()}</span>
                          : <span className="text-text-400 text-[10px]">—</span>
                      })()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1.5 items-center">
                        <button onClick={() => setEditingClient(c)} className="text-text-400 hover:text-opt-yellow transition-colors"><Edit3 size={12} /></button>
                        <button onClick={() => deleteClient(c.id)} disabled={deletingId === c.id} className="text-text-400 hover:text-danger transition-colors disabled:opacity-30">
                          {deletingId === c.id ? <Loader size={12} className="animate-spin" /> : <X size={12} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Client Edit Slide-Out Panel */}
      {editingClient && (
        <ClientEditPanel
          client={editingClient}
          members={members}
          onSave={handleSaveClient}
          onClose={() => setEditingClient(null)}
        />
      )}

      {/* Payment Timeline Modal */}
      {timelineClient && (
        <ClientPaymentTimeline
          client={timelineClient}
          payments={payments}
          onClose={() => setTimelineClient(null)}
        />
      )}

      {/* GHL Import Modal */}
      {showGHLImport && (
        <GHLImportModal
          clients={clients}
          onClose={() => setShowGHLImport(false)}
          onImported={() => { setShowGHLImport(false); refreshClients() }}
        />
      )}
    </div>
  )
}
