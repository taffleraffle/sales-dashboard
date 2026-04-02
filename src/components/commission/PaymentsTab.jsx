import { useState, useRef, useEffect } from 'react'
import { Plus, X, ChevronDown, Loader, Check, Save, Download } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const inputCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 placeholder:text-text-400/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
const selectCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 appearance-none cursor-pointer'

export default function PaymentsTab({
  payments, clients, period, loadingPayments,
  matchPayment, unmatchPayment, refreshPayments, refreshLedger,
  syncing, syncResult, onSync, userEmail,
}) {
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [savingPayment, setSavingPayment] = useState(false)
  const [matchingPaymentId, setMatchingPaymentId] = useState(null)
  const [rematchingPaymentId, setRematchingPaymentId] = useState(null)
  const [unmatchingId, setUnmatchingId] = useState(null)
  const [matchingId, setMatchingId] = useState(null)
  const [searchClient, setSearchClient] = useState('')
  const [dropdownPos, setDropdownPos] = useState(null)
  const dropdownRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!matchingPaymentId && !rematchingPaymentId) return
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setMatchingPaymentId(null)
        setRematchingPaymentId(null)
        setSearchClient('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [matchingPaymentId, rematchingPaymentId])
  const [newPayment, setNewPayment] = useState({
    customer_name: '', customer_email: '', amount: '', fee: '',
    source: 'stripe', payment_type: 'trial',
    payment_date: new Date().toISOString().split('T')[0], description: '',
  })

  const handleAddPayment = async () => {
    setSavingPayment(true)
    const amount = parseFloat(newPayment.amount) || 0
    const fee = parseFloat(newPayment.fee) || 0
    const net = amount - fee

    let clientId = null
    let matched = false
    if (newPayment.customer_email) {
      const match = clients.find(c => c.email && c.email.toLowerCase() === newPayment.customer_email.toLowerCase())
      if (match) { clientId = match.id; matched = true }
    }

    const { error } = await supabase.from('payments').insert({
      source: newPayment.source || 'manual',
      source_event_id: `manual_${Date.now()}`,
      amount, fee, net_amount: net,
      customer_email: newPayment.customer_email || null,
      customer_name: newPayment.customer_name || null,
      payment_date: newPayment.payment_date ? new Date(newPayment.payment_date).toISOString() : new Date().toISOString(),
      payment_type: newPayment.payment_type || 'trial',
      description: newPayment.description || null,
      client_id: clientId,
      matched,
    })
    setSavingPayment(false)
    if (!error) {
      setShowAddPayment(false)
      setNewPayment({ customer_name: '', customer_email: '', amount: '', fee: '', source: 'stripe', payment_type: 'trial', payment_date: new Date().toISOString().split('T')[0], description: '' })
      refreshPayments()
    }
  }

  const handleMatch = async (paymentId, clientId) => {
    setMatchingId(paymentId)
    await matchPayment(paymentId, clientId)
    setMatchingPaymentId(null)
    setRematchingPaymentId(null)
    setSearchClient('')
    setDropdownPos(null)
    setMatchingId(null)
    refreshPayments()
    refreshLedger()
  }

  const handleUnmatch = async (paymentId) => {
    setUnmatchingId(paymentId)
    const ok = await unmatchPayment(paymentId)
    setUnmatchingId(null)
    if (ok) {
      refreshPayments()
      refreshLedger()
    }
  }

  const openDropdown = (e, paymentId, isRematch) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const top = rect.bottom + 4
    const left = Math.min(rect.left, window.innerWidth - 270)
    const maxH = window.innerHeight - top - 16
    setDropdownPos({ top, left, maxH: Math.min(maxH, 250) })
    setSearchClient('')
    if (isRematch) {
      setRematchingPaymentId(rematchingPaymentId === paymentId ? null : paymentId)
      setMatchingPaymentId(null)
    } else {
      setMatchingPaymentId(matchingPaymentId === paymentId ? null : paymentId)
      setRematchingPaymentId(null)
    }
  }

  const activeDropdownId = matchingPaymentId || rematchingPaymentId
  const clientDropdownEl = activeDropdownId && dropdownPos ? (
    <div
      ref={dropdownRef}
      className="fixed z-[200] bg-bg-card border border-border-default rounded-xl shadow-xl shadow-black/40 py-1 w-[260px]"
      style={{ top: dropdownPos.top, left: dropdownPos.left, maxHeight: dropdownPos.maxH }}
    >
      <div className="px-2 py-1">
        <input
          type="text"
          placeholder="Search clients..."
          value={searchClient}
          onChange={e => setSearchClient(e.target.value)}
          className="w-full px-2 py-1.5 text-[11px] bg-bg-primary border border-border-default rounded-lg text-text-primary"
          autoFocus
        />
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: (dropdownPos.maxH || 200) - 40 }}>
        {clients
          .filter(c => !searchClient || c.name.toLowerCase().includes(searchClient.toLowerCase()) || (c.company_name || '').toLowerCase().includes(searchClient.toLowerCase()))
          .slice(0, 20)
          .map(c => (
            <button
              key={c.id}
              onClick={() => handleMatch(activeDropdownId, c.id)}
              disabled={matchingId === activeDropdownId}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-card-hover flex items-center justify-between disabled:opacity-50"
            >
              {c.name}
              <span className="text-text-400 text-[9px]">{c.company_name}</span>
            </button>
          ))}
      </div>
    </div>
  ) : null

  return (
    <div>
      {/* Add Payment Form */}
      <div className={`expand-section ${showAddPayment ? 'max-h-[500px] opacity-100 mb-4' : 'max-h-0 opacity-0'}`}>
        <div className="bg-bg-card border border-border-default rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-secondary">Add Payment</h3>
            <button onClick={() => setShowAddPayment(false)} className="text-text-400 hover:text-text-primary transition-colors"><X size={14} /></button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Customer Name</label><input value={newPayment.customer_name} onChange={e => setNewPayment(p => ({ ...p, customer_name: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Customer Email</label><input value={newPayment.customer_email} onChange={e => setNewPayment(p => ({ ...p, customer_email: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Amount ($)</label><input type="number" step="0.01" value={newPayment.amount} onChange={e => setNewPayment(p => ({ ...p, amount: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Fee ($)</label><input type="number" step="0.01" value={newPayment.fee} onChange={e => setNewPayment(p => ({ ...p, fee: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Source</label>
              <select value={newPayment.source} onChange={e => setNewPayment(p => ({ ...p, source: e.target.value }))} className={selectCls}>
                <option value="stripe">Stripe</option><option value="fanbasis">Fanbasis</option><option value="manual">Manual</option>
              </select></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Type</label>
              <select value={newPayment.payment_type} onChange={e => setNewPayment(p => ({ ...p, payment_type: e.target.value }))} className={selectCls}>
                <option value="trial">Trial</option><option value="monthly">Monthly</option><option value="ascension">Ascension</option><option value="pif">PIF</option><option value="one_time">One-Time</option>
              </select></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Payment Date</label><input type="date" value={newPayment.payment_date} onChange={e => setNewPayment(p => ({ ...p, payment_date: e.target.value }))} className={inputCls} /></div>
            <div><label className="text-[11px] text-text-400 uppercase tracking-wider block mb-1">Description</label><input value={newPayment.description} onChange={e => setNewPayment(p => ({ ...p, description: e.target.value }))} placeholder="Optional" className={inputCls} /></div>
          </div>
          <button onClick={handleAddPayment} disabled={savingPayment} className="px-4 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 disabled:opacity-50 transition-all duration-150 flex items-center gap-1.5">
            {savingPayment ? <><Loader size={12} className="animate-spin" /> Saving...</> : <><Save size={12} /> Save Payment</>}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-text-secondary">Payments — {period}</h2>
          {syncResult && <span className="text-[10px] text-success">{syncResult}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onSync} disabled={syncing} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-purple-500/30 text-purple-400 rounded-xl hover:bg-purple-500/10 disabled:opacity-50 transition-all duration-150">
            {syncing ? <><Loader size={12} className="animate-spin" /> Syncing...</> : <><Download size={12} /> Sync Stripe</>}
          </button>
          <button onClick={() => setShowAddPayment(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 transition-all duration-150"><Plus size={12} /> Add Payment</button>
        </div>
      </div>

      <div className="bg-bg-card border border-border-default rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-card text-text-400 uppercase text-[10px] tracking-wider">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-center">Pay #</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Net</th>
                <th className="px-3 py-2 text-left">Matched Client</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {loadingPayments ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-text-400"><Loader size={14} className="animate-spin inline mr-2" />Loading...</td></tr>
              ) : payments.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-text-400">No payments for this period</td></tr>
              ) : payments.map(p => {
                const pn = p._paymentNumber
                const pastWindow = pn && pn > 3
                const pnLabels = { 1: 'Trial', 2: 'Mo 1', 3: 'Mo 2', 4: 'Mo 3' }
                return (
                <tr key={p.id} className={`border-t border-border-default/30 row-glow transition-all duration-150 ${pastWindow ? 'opacity-40' : ''} ${!p.matched ? 'bg-warning/5' : ''} ${unmatchingId === p.id ? 'opacity-40' : ''}`}>
                  <td className="px-3 py-2 text-text-400">{new Date(p.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                  <td className="px-3 py-2 font-medium text-text-primary">{p.customer_name || '—'}</td>
                  <td className="px-3 py-2 text-text-400 text-[10px]">{p.customer_email || '—'}</td>
                  <td className="px-3 py-2 text-center">
                    {pn ? (
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        pastWindow ? 'text-text-400 bg-text-400/10' :
                        pn === 1 ? 'text-blue-400 bg-blue-500/15' :
                        'text-opt-yellow bg-opt-yellow/15'
                      }`}>{pnLabels[pn] || `#${pn}`}</span>
                    ) : p.matched ? <span className="text-text-400 text-[10px]">—</span> : null}
                  </td>
                  <td className="px-3 py-2 text-text-400 text-[10px]">{p.metadata?.invoice_number ? `#${p.metadata.invoice_number}` : (p.description || '—')}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${
                      p.source === 'stripe' ? 'bg-purple-500/15 text-purple-400 border-purple-500/30' :
                      p.source === 'fanbasis' ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
                      'bg-text-400/15 text-text-400 border-text-400/30'
                    }`}>{p.source}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-text-primary">${Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2 text-right font-medium text-success">${Number(p.net_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2">
                    {p.matched ? (
                      <div className="flex items-center gap-2">
                        <span className="text-success text-[10px] flex items-center gap-1">
                          <Check size={10} /> {p.client?.name || 'Matched'}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnmatch(p.id) }}
                          disabled={unmatchingId === p.id}
                          className="w-5 h-5 rounded flex items-center justify-center bg-danger/10 text-danger hover:bg-danger/25 transition-all disabled:opacity-30 shrink-0"
                          title="Unmatch this payment"
                        >
                          {unmatchingId === p.id ? <Loader size={10} className="animate-spin" /> : <X size={12} />}
                        </button>
                        <button
                          onClick={(e) => openDropdown(e, p.id, true)}
                          className="text-text-400 text-[9px] hover:text-opt-yellow transition-colors"
                          title="Change matched client"
                        >
                          <ChevronDown size={10} />
                        </button>
                      </div>
                    ) : (
                      <div>
                        <button
                          onClick={(e) => openDropdown(e, p.id, false)}
                          disabled={matchingId === p.id}
                          className="text-warning text-[10px] font-medium flex items-center gap-1 hover:text-opt-yellow disabled:opacity-50 transition-colors"
                        >
                          {matchingId === p.id ? <Loader size={10} className="animate-spin" /> : <>Match <ChevronDown size={10} /></>}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${
                      p.matched ? 'bg-success/15 text-success border-success/30' : 'bg-warning/15 text-warning border-warning/30'
                    }`}>{p.matched ? 'Matched' : 'Unmatched'}</span>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fixed-position client match dropdown */}
      {clientDropdownEl}
    </div>
  )
}
