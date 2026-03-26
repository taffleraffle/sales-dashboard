import { useState } from 'react'
import { X, Loader } from 'lucide-react'
import { supabase } from '../lib/supabase'

const OUTCOMES = [
  { value: '', label: 'No outcome' },
  { value: 'closed', label: 'Closed' },
  { value: 'not_closed', label: 'Not Closed' },
  { value: 'no_show', label: 'No Show' },
  { value: 'rescheduled', label: 'Rescheduled' },
]

export default function AddTranscriptModal({ members = [], onClose, onSaved }) {
  const [form, setForm] = useState({
    closer_id: '',
    prospect_name: '',
    prospect_email: '',
    meeting_date: new Date().toISOString().split('T')[0],
    duration_minutes: '',
    summary: '',
    transcript_url: '',
    outcome: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    if (!form.prospect_name.trim()) { setError('Prospect name is required'); return }
    if (!form.summary.trim()) { setError('Transcript text is required'); return }
    setSaving(true)
    setError(null)

    const { error: insertErr } = await supabase.from('closer_transcripts').insert({
      fathom_meeting_id: 'manual_' + crypto.randomUUID(),
      closer_id: form.closer_id || null,
      prospect_name: form.prospect_name.trim(),
      prospect_email: form.prospect_email.trim() || null,
      meeting_date: form.meeting_date || null,
      duration_seconds: form.duration_minutes ? parseInt(form.duration_minutes) * 60 : null,
      summary: form.summary.trim(),
      transcript_url: form.transcript_url.trim() || null,
      outcome: form.outcome || null,
      source: 'manual',
    })

    setSaving(false)
    if (insertErr) { setError(insertErr.message); return }
    onSaved?.()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <h3 className="text-sm font-semibold text-text-primary">Add Call Transcript</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-text-400 hover:text-text-primary hover:bg-bg-card-hover"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[11px] text-text-400 mb-1 block">Team Member</label>
            <select value={form.closer_id} onChange={e => set('closer_id', e.target.value)}
              className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40">
              <option value="">Unassigned</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-text-400 mb-1 block">Prospect Name *</label>
              <input value={form.prospect_name} onChange={e => set('prospect_name', e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40"
                placeholder="John Smith" />
            </div>
            <div>
              <label className="text-[11px] text-text-400 mb-1 block">Prospect Email</label>
              <input value={form.prospect_email} onChange={e => set('prospect_email', e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40"
                placeholder="john@example.com" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-text-400 mb-1 block">Date</label>
              <input type="date" value={form.meeting_date} onChange={e => set('meeting_date', e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40" />
            </div>
            <div>
              <label className="text-[11px] text-text-400 mb-1 block">Duration (min)</label>
              <input type="number" value={form.duration_minutes} onChange={e => set('duration_minutes', e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40"
                placeholder="30" />
            </div>
            <div>
              <label className="text-[11px] text-text-400 mb-1 block">Outcome</label>
              <select value={form.outcome} onChange={e => set('outcome', e.target.value)}
                className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40">
                {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-text-400 mb-1 block">Link (Fathom / Zoom / Loom)</label>
            <input value={form.transcript_url} onChange={e => set('transcript_url', e.target.value)}
              className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40"
              placeholder="https://fathom.video/share/..." />
          </div>

          <div>
            <label className="text-[11px] text-text-400 mb-1 block">Transcript / Notes *</label>
            <textarea value={form.summary} onChange={e => set('summary', e.target.value)} rows={8}
              className="w-full bg-bg-primary border border-border-default rounded-xl px-3 py-2 text-sm text-text-primary outline-none focus:border-opt-yellow/40 resize-y"
              placeholder="Paste the call transcript or notes here..." />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border-default">
          <button onClick={onClose} className="px-4 py-2 text-xs text-text-secondary border border-border-default rounded-xl hover:bg-bg-card-hover">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-xs bg-opt-yellow text-bg-primary rounded-xl font-medium hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5">
            {saving && <Loader size={12} className="animate-spin" />}
            Save Transcript
          </button>
        </div>
      </div>
    </div>
  )
}
