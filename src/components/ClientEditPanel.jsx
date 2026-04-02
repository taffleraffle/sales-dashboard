import { useState, useEffect } from 'react'
import { X, Save, Loader } from 'lucide-react'

const inputCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 placeholder:text-text-400/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
const selectCls = 'w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none focus:shadow-[0_0_10px_rgba(212,245,12,0.08)] transition-all duration-200 appearance-none cursor-pointer'
const labelCls = 'text-[11px] text-text-400 uppercase tracking-wider block mb-1.5'

export default function ClientEditPanel({ client, members, onSave, onClose }) {
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (client) {
      setForm({
        name: client.name || '',
        company_name: client.company_name || '',
        email: client.email || '',
        phone: client.phone || '',
        closer_id: client.closer_id || '',
        setter_id: client.setter_id || '',
        stage: client.stage || 'trial',
        trial_amount: client.trial_amount ?? '',
        monthly_amount: client.monthly_amount ?? '',
        trial_start_date: client.trial_start_date || '',
        ascension_date: client.ascension_date || '',
        billing_day: client.billing_day ?? '',
        next_billing_date: client.next_billing_date || '',
        payment_count: client.payment_count ?? 0,
        notes: client.notes || '',
      })
    }
  }, [client])

  if (!client) return null

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    setSaving(true)
    await onSave(client.id, {
      name: form.name,
      email: form.email || null,
      phone: form.phone || null,
      company_name: form.company_name || null,
      closer_id: form.closer_id || null,
      setter_id: form.setter_id || null,
      stage: form.stage || 'trial',
      trial_amount: parseFloat(form.trial_amount) || 0,
      monthly_amount: parseFloat(form.monthly_amount) || 0,
      trial_start_date: form.trial_start_date || null,
      ascension_date: form.ascension_date || null,
      billing_day: parseInt(form.billing_day) || null,
      next_billing_date: form.next_billing_date || null,
      payment_count: parseInt(form.payment_count) || 0,
      notes: form.notes || null,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    onClose()
  }

  const closers = members.filter(m => m.role === 'closer')
  const setters = members.filter(m => m.role === 'setter')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[99] bg-black/40 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full z-[100] w-full sm:w-[480px] bg-bg-card border-l border-border-default shadow-2xl flex flex-col slide-panel">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Edit Client</h2>
            <p className="text-[10px] text-text-400 mt-0.5">{client.name}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all">
            <X size={16} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Identity */}
          <div>
            <h3 className="text-[10px] text-opt-yellow uppercase tracking-wider font-medium mb-3">Identity</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Name *</label>
                <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Company</label>
                <input value={form.company_name} onChange={e => set('company_name', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Email</label>
                <input type="email" value={form.email} onChange={e => set('email', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Phone</label>
                <input value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+1..." className={inputCls} />
              </div>
            </div>
          </div>

          {/* Attribution */}
          <div>
            <h3 className="text-[10px] text-opt-yellow uppercase tracking-wider font-medium mb-3">Attribution</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Closer</label>
                <select value={form.closer_id} onChange={e => set('closer_id', e.target.value)} className={selectCls}>
                  <option value="">—</option>
                  {closers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Setter</label>
                <select value={form.setter_id} onChange={e => set('setter_id', e.target.value)} className={selectCls}>
                  <option value="">—</option>
                  {setters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Stage</label>
                <select value={form.stage} onChange={e => set('stage', e.target.value)} className={selectCls}>
                  <option value="trial">Trial</option>
                  <option value="ascended">Ascended</option>
                  <option value="pif">PIF</option>
                  <option value="paused">Paused</option>
                  <option value="churned">Churned</option>
                </select>
              </div>
            </div>
          </div>

          {/* Financials */}
          <div>
            <h3 className="text-[10px] text-opt-yellow uppercase tracking-wider font-medium mb-3">Financials</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Trial Amount ($)</label>
                <input type="number" step="0.01" value={form.trial_amount} onChange={e => set('trial_amount', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Monthly Amount ($)</label>
                <input type="number" step="0.01" value={form.monthly_amount} onChange={e => set('monthly_amount', e.target.value)} className={inputCls} />
              </div>
            </div>
          </div>

          {/* Dates & Billing */}
          <div>
            <h3 className="text-[10px] text-opt-yellow uppercase tracking-wider font-medium mb-3">Dates & Billing</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Trial Start Date</label>
                <input type="date" value={form.trial_start_date} onChange={e => set('trial_start_date', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Ascension Date</label>
                <input type="date" value={form.ascension_date} onChange={e => set('ascension_date', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Billing Day (1-28)</label>
                <input type="number" min="1" max="28" value={form.billing_day} onChange={e => set('billing_day', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Next Billing Date</label>
                <input type="date" value={form.next_billing_date} onChange={e => set('next_billing_date', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Payments Received</label>
                <select value={form.payment_count} onChange={e => set('payment_count', e.target.value)} className={selectCls}>
                  <option value="0">0 — No payments yet</option>
                  <option value="1">1 — Trial paid</option>
                  <option value="2">2 — Month 1 paid</option>
                  <option value="3">3 — Month 2 paid</option>
                  <option value="4">4 — Month 3 paid</option>
                </select>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={3}
              placeholder="Internal notes..."
              className={`${inputCls} resize-none`}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-default">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium border border-border-default text-text-secondary rounded-xl hover:bg-bg-card-hover transition-all duration-150"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name}
            className="px-5 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 disabled:opacity-50 transition-all duration-150 flex items-center gap-1.5"
          >
            {saving ? <><Loader size={12} className="animate-spin" /> Saving...</> : <><Save size={12} /> Save Client</>}
          </button>
        </div>
      </div>
    </>
  )
}
