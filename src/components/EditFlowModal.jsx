import { useState, useEffect } from 'react'
import { X, Loader, Save, Check } from 'lucide-react'
import { ICON } from '../utils/constants'

// Preset palette — matches the existing design language (yellow, accent hues).
// Users can still pick a custom color via the input.
const SWATCHES = [
  '#f0e050', '#d4f50c', '#22c55e', '#3b82f6',
  '#a855f7', '#ec4899', '#ef4444', '#f97316',
  '#06b6d4', '#8b5cf6', '#eab308', '#6b7280',
]

export default function EditFlowModal({ flow, onClose, onSave }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#f0e050')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!flow) return
    setName(flow.name || '')
    setDescription(flow.description || '')
    setColor(flow.color || '#f0e050')
    setError(null)
  }, [flow])

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, saving])

  if (!flow) return null

  const handleSave = async (e) => {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, color })
      onClose()
    } catch (err) {
      setError(err.message || String(err))
    }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => !saving && onClose()}>
      <form onSubmit={handleSave} className="tile w-full max-w-md p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Edit Flow</h3>
            <p className="text-[11px] text-text-400 mt-0.5">Rename, re-describe, or recolor this flow</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="text-text-400 hover:text-text-primary transition-colors disabled:opacity-50">
            <X size={ICON.lg} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-400 block mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Welcome Sequence"
              required
              autoFocus
              className="w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none transition-all"
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-400 block mb-1.5">Description <span className="text-text-400/60 normal-case">(optional)</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this flow is for, who it's sent to…"
              rows={2}
              className="w-full px-3 py-2 bg-bg-primary border border-border-default rounded-xl text-sm text-text-primary focus:border-opt-yellow/50 focus:outline-none transition-all resize-none"
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-text-400 block mb-1.5">Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {SWATCHES.map(c => {
                const selected = color.toLowerCase() === c.toLowerCase()
                // Pick a legible tick color: dark for light swatches, white for dark.
                // Dark tick on bright/light swatches, white tick on dark ones.
                const tickDark = ['#f0e050', '#d4f50c', '#eab308', '#22c55e', '#06b6d4', '#3b82f6'].includes(c.toLowerCase())
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={`Set color to ${c}`}
                    aria-pressed={selected}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ring-offset-2 ring-offset-bg-card ${selected ? 'ring-2 ring-text-primary scale-110' : 'ring-0 hover:scale-105'}`}
                    style={{ backgroundColor: c }}
                  >
                    {selected && <Check size={14} className={tickDark ? 'text-bg-primary' : 'text-white'} strokeWidth={3} />}
                  </button>
                )
              })}
              {/* Custom color picker — also shows a tick when active. */}
              {(() => {
                const isCustom = !SWATCHES.map(s => s.toLowerCase()).includes(color.toLowerCase())
                return (
                  <label className={`w-8 h-8 rounded-lg border flex items-center justify-center text-[10px] cursor-pointer relative transition-all ${isCustom ? 'border-text-primary scale-110' : 'border-border-default text-text-400 hover:border-opt-yellow/30'}`}
                    style={isCustom ? { backgroundColor: color } : {}}
                    aria-pressed={isCustom}
                    title="Custom color"
                  >
                    <input
                      type="color"
                      value={color}
                      onChange={e => setColor(e.target.value)}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      aria-label="Pick a custom color"
                    />
                    {isCustom ? <Check size={14} className="text-white" strokeWidth={3} /> : '+'}
                  </label>
                )
              })()}
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-4 text-xs text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-xl text-xs font-medium text-text-400 hover:text-text-primary hover:bg-bg-primary transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-opt-yellow hover:brightness-110 text-bg-primary transition-all inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? <Loader size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
