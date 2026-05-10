import { useEffect, useState } from 'react'
import { X, Upload, Loader, AlertTriangle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const TYPE_LABELS = {
  hook:       'Hook',
  body_angle: 'Body angle',
  scene:      'Scene',
  creator:    'Creator',
}

const ID_PREFIXES = {
  hook:       'H',         // e.g. H7.1
  body_angle: 'BA-',       // e.g. BA-CUSTOM
  scene:      'S-',        // e.g. S-CUSTOM
  creator:    '',          // e.g. NEWCREATOR
}

const STATUSES = ['concept', 'in_production', 'ready', 'retired']

// Reusable modal for creating or editing a library component.
// Pass `existing` to edit; omit to create a new one.
export default function AddComponentModal({ open, type, existing, onClose, onSaved }) {
  const [componentId, setComponentId] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [scriptText, setScriptText] = useState('')
  const [durationSec, setDurationSec] = useState('')
  const [assetUrl, setAssetUrl] = useState('')
  const [status, setStatus] = useState('concept')
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    if (existing) {
      setComponentId(existing.component_id || '')
      setLabel(existing.label || '')
      setDescription(existing.description || '')
      setScriptText(existing.script_text || '')
      setDurationSec(existing.duration_sec ? String(existing.duration_sec) : '')
      setAssetUrl(existing.asset_url || '')
      setStatus(existing.status || 'concept')
    } else {
      setComponentId(ID_PREFIXES[type] || '')
      setLabel('')
      setDescription('')
      setScriptText('')
      setDurationSec('')
      setAssetUrl('')
      setStatus('concept')
    }
    setFile(null)
    setError(null)
  }, [open, type, existing])

  if (!open) return null

  const isHookOrBody = type === 'hook' || type === 'body_angle'
  const typeLabel = TYPE_LABELS[type] || type

  async function handleUpload() {
    if (!file) return null
    setUploading(true)
    setError(null)
    try {
      const safeId = (componentId || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_')
      const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/) || [, 'bin'])[1]
      const path = `${type}/${safeId}_${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('creative_components')
        .upload(path, file, { cacheControl: '3600', upsert: false })
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
      const { data: pub } = supabase.storage.from('creative_components').getPublicUrl(path)
      return pub?.publicUrl || null
    } finally {
      setUploading(false)
    }
  }

  async function handleSave() {
    setError(null)
    if (!componentId.trim()) { setError('Component ID is required'); return }
    if (!label.trim()) { setError('Label is required'); return }

    setSaving(true)
    try {
      let finalAssetUrl = assetUrl || null
      if (file) {
        const uploaded = await handleUpload()
        if (uploaded) finalAssetUrl = uploaded
      }

      const { data, error: rpcErr } = await supabase.rpc('lib_upsert_component', {
        p_component_id: componentId.trim(),
        p_type: type,
        p_label: label.trim(),
        p_description: description.trim() || null,
        p_script_text: scriptText.trim() || null,
        p_duration_sec: durationSec ? parseInt(durationSec) : null,
        p_asset_url: finalAssetUrl,
        p_status: status,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      onSaved?.(data)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-default rounded-sm w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-primary">
            {existing ? `Edit ${typeLabel.toLowerCase()}` : `Add ${typeLabel.toLowerCase()}`}
          </h2>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          {error && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-sm px-3 py-2">
              <AlertTriangle size={14} /> <span className="flex-1">{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-400">Component ID</label>
              <input
                type="text"
                value={componentId}
                onChange={e => setComponentId(e.target.value.toUpperCase())}
                disabled={!!existing}
                placeholder={
                  type === 'hook' ? 'H7.1' :
                  type === 'body_angle' ? 'BA-CUSTOM' :
                  type === 'scene' ? 'S-CUSTOM' :
                  'NEWCREATOR'
                }
                className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs font-mono text-text-primary w-full mt-0.5 disabled:opacity-50"
              />
              {type === 'hook' && <p className="text-[9px] text-text-400 mt-0.5">Per SOP: H{'{n}'}.{'{m}'} (e.g. H4.2)</p>}
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-400">Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
              >
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-400">Label</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={type === 'hook' ? 'e.g. Pattern interrupt — yelling owner' : 'Short, descriptive label'}
              className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-400">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional notes — what this component is for, when to use it, what tested well"
              className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
            />
          </div>

          {isHookOrBody && (
            <>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-400">Script text</label>
                <textarea
                  value={scriptText}
                  onChange={e => setScriptText(e.target.value)}
                  rows={3}
                  placeholder={type === 'hook' ? 'The opening line(s) the creator says.' : 'The body content / pitch / proof points.'}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-400">Duration (seconds)</label>
                <input
                  type="number"
                  value={durationSec}
                  onChange={e => setDurationSec(e.target.value)}
                  placeholder={type === 'hook' ? '3' : '30'}
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-32 mt-0.5"
                />
              </div>
            </>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-400">Reference asset</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="file"
                accept="video/*,image/*"
                onChange={e => setFile(e.target.files?.[0] || null)}
                className="text-xs text-text-secondary file:mr-2 file:px-2 file:py-1 file:bg-opt-yellow/15 file:text-text-primary file:border-0 file:rounded-lg file:text-xs file:cursor-pointer"
              />
              {uploading && <Loader size={12} className="animate-spin text-text-primary" />}
            </div>
            {assetUrl && !file && (
              <p className="text-[10px] text-text-400 mt-1">
                Current: <a href={assetUrl} target="_blank" rel="noreferrer" className="text-text-primary hover:underline break-all">{assetUrl}</a>
              </p>
            )}
            <p className="text-[9px] text-text-400/70 mt-1">Upload to Supabase Storage. Public URL will be saved on the component.</p>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border-default flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs text-text-400 hover:text-text-secondary px-2">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-opt-yellow/15 border border-opt-yellow/40 text-text-primary rounded-lg hover:bg-opt-yellow/20 disabled:opacity-50"
          >
            {(saving || uploading) ? <Loader size={12} className="animate-spin" /> : <Upload size={12} />}
            {existing ? 'Save changes' : 'Add to library'}
          </button>
        </div>
      </div>
    </div>
  )
}
