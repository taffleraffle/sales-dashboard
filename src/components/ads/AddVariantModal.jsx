import { useEffect, useMemo, useState } from 'react'
import { X, Upload, Loader, AlertTriangle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const STATUSES = ['planned', 'editing', 'ready', 'live', 'paused', 'killed', 'winner']

// Modal for creating or editing a variant — picks one component from each
// of the 4 dimensions (hook + body_angle + scene + creator), an iteration
// number, status, optional asset URL, and notes. The variant_id is computed
// from the selected components per the OPT-MetaAd-Naming-SOP.
export default function AddVariantModal({ open, existing, onClose, onSaved }) {
  const [components, setComponents] = useState([])
  const [hookId, setHookId] = useState('')
  const [bodyId, setBodyId] = useState('')
  const [sceneId, setSceneId] = useState('')
  const [creatorId, setCreatorId] = useState('')
  const [iteration, setIteration] = useState('1')
  const [status, setStatus] = useState('planned')
  const [assetUrl, setAssetUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null)
  const [loadingComps, setLoadingComps] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function loadComponents() {
      setLoadingComps(true)
      setError(null)
      try {
        const { data, error: e } = await supabase
          .from('lib_components')
          .select('*')
          .neq('status', 'retired')
          .order('component_id', { ascending: true })
        if (e) throw new Error(e.message)
        if (!cancelled) setComponents(data || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoadingComps(false)
      }
    }
    loadComponents()
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (existing) {
      setHookId(existing.hook_id || '')
      setBodyId(existing.body_angle_id || '')
      setSceneId(existing.scene_id || '')
      setCreatorId(existing.creator_id || '')
      setIteration(String(existing.iteration || 1))
      setStatus(existing.status || 'planned')
      setAssetUrl(existing.asset_url || '')
      setNotes(existing.notes || '')
    } else {
      setHookId('')
      setBodyId('')
      setSceneId('')
      setCreatorId('')
      setIteration('1')
      setStatus('planned')
      setAssetUrl('')
      setNotes('')
    }
    setFile(null)
    setError(null)
  }, [open, existing])

  const compsByType = useMemo(() => ({
    hook:       components.filter(c => c.type === 'hook'),
    body_angle: components.filter(c => c.type === 'body_angle'),
    scene:      components.filter(c => c.type === 'scene'),
    creator:    components.filter(c => c.type === 'creator'),
  }), [components])

  const compMap = useMemo(() => {
    const m = {}
    for (const c of components) m[c.id] = c
    return m
  }, [components])

  const computedVariantId = useMemo(() => {
    const h = compMap[hookId]?.component_id
    const b = compMap[bodyId]?.component_id
    const s = compMap[sceneId]?.component_id
    const cr = compMap[creatorId]?.component_id
    if (!h || !b || !s || !cr) return ''
    return `${h}_${b}_${s}_${cr}_v${iteration || '1'}`
  }, [compMap, hookId, bodyId, sceneId, creatorId, iteration])

  if (!open) return null

  async function uploadAsset() {
    if (!file) return null
    setUploading(true)
    try {
      const safeId = (computedVariantId || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_')
      const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/) || [, 'bin'])[1]
      const path = `variant/${safeId}_${Date.now()}.${ext}`
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
    if (!hookId || !bodyId || !sceneId || !creatorId) {
      setError('All four components are required')
      return
    }
    if (!iteration || parseInt(iteration) < 1) {
      setError('Iteration must be a positive integer')
      return
    }

    setSaving(true)
    try {
      let finalAssetUrl = assetUrl || null
      if (file) {
        const uploaded = await uploadAsset()
        if (uploaded) finalAssetUrl = uploaded
      }

      const { data, error: rpcErr } = await supabase.rpc('lib_upsert_variant', {
        p_variant_id: computedVariantId,
        p_hook_id: hookId,
        p_body_angle_id: bodyId,
        p_scene_id: sceneId,
        p_creator_id: creatorId,
        p_iteration: parseInt(iteration),
        p_status: status,
        p_asset_url: finalAssetUrl,
        p_notes: notes.trim() || null,
        p_meta_ad_id: null,
        p_meta_ad_name: null,
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
        className="bg-bg-card border border-border-default rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-primary">{existing ? 'Edit variant' : 'Add variant'}</h2>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          {error && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger text-xs rounded-xl px-3 py-2">
              <AlertTriangle size={14} /> <span className="flex-1">{error}</span>
            </div>
          )}

          {loadingComps ? (
            <div className="flex items-center justify-center py-8"><Loader size={16} className="animate-spin text-opt-yellow" /></div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <ComponentPicker label="Hook" value={hookId} onChange={setHookId} options={compsByType.hook} />
                <ComponentPicker label="Body angle" value={bodyId} onChange={setBodyId} options={compsByType.body_angle} />
                <ComponentPicker label="Scene" value={sceneId} onChange={setSceneId} options={compsByType.scene} />
                <ComponentPicker label="Creator" value={creatorId} onChange={setCreatorId} options={compsByType.creator} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-text-400">Iteration</label>
                  <input
                    type="number"
                    min="1"
                    value={iteration}
                    onChange={e => setIteration(e.target.value)}
                    className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-text-400">Status</label>
                  <select
                    value={status}
                    onChange={e => setStatus(e.target.value)}
                    className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
                  >
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="bg-bg-primary border border-opt-yellow/30 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-text-400">Computed variant ID</p>
                <p className="text-sm font-mono text-opt-yellow mt-0.5">{computedVariantId || 'pick all 4 components above'}</p>
                <p className="text-[9px] text-text-400/70 mt-0.5">Use this in the Meta ad name: <span className="font-mono">[Campaign] | [Audience] | {computedVariantId || 'variant_id'} | v{iteration}</span></p>
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-400">Final asset</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="file"
                    accept="video/*,image/*"
                    onChange={e => setFile(e.target.files?.[0] || null)}
                    className="text-xs text-text-secondary file:mr-2 file:px-2 file:py-1 file:bg-opt-yellow/15 file:text-opt-yellow file:border-0 file:rounded-lg file:text-xs file:cursor-pointer"
                  />
                  {uploading && <Loader size={12} className="animate-spin text-opt-yellow" />}
                </div>
                {assetUrl && !file && (
                  <p className="text-[10px] text-text-400 mt-1">Current: <a href={assetUrl} target="_blank" rel="noreferrer" className="text-opt-yellow hover:underline break-all">{assetUrl}</a></p>
                )}
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-400">Notes</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Why this combo, hypothesis, post-mortem learnings"
                  className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5"
                />
              </div>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border-default flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs text-text-400 hover:text-text-secondary px-2">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || uploading || !computedVariantId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-opt-yellow/15 border border-opt-yellow/40 text-opt-yellow rounded-lg hover:bg-opt-yellow/20 disabled:opacity-50"
          >
            {(saving || uploading) ? <Loader size={12} className="animate-spin" /> : <Upload size={12} />}
            {existing ? 'Save changes' : 'Add variant'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ComponentPicker({ label, value, onChange, options }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-text-400">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-bg-primary border border-border-default rounded-lg px-2 py-1.5 text-xs text-text-primary w-full mt-0.5 font-mono"
      >
        <option value="">— pick {label.toLowerCase()} —</option>
        {options.map(o => (
          <option key={o.id} value={o.id}>{o.component_id} · {o.label}</option>
        ))}
      </select>
    </div>
  )
}
