import { useState, useEffect } from 'react'
import { X, Save, Loader } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  AngleEditorModal — edit an existing angle OR create a new custom one.

  Existing angle library is Claude-generated. This is the operator's manual
  override layer:
    - Fix wording on the qualifier ("Licensed electrical contractors doing
      $20K+/mo" → "Electricians doing $50K+/mo")
    - Tighten the primary_promise / mechanism_short when the Claude output
      slips
    - Create a custom angle from scratch when no generated angle fits the
      Maps/EV/seasonal scenario the operator wants to test
    - Toggle active=false to remove a bad angle from the picker without
      deleting the row (and losing the audit trail)

  Open with `angle={existingRow}` to edit. Open with
  `angle={null}` + `mode='create'` + `offerSlug={...}` + `angleType={...}`
  to create a new one. Parent passes `onSaved(slug)` so it can refresh
  the angle library and (optionally) select the new angle.
*/

const ANGLE_TYPES = [
  { value: 'problem',      label: 'Problem' },
  { value: 'circumstance', label: 'Circumstance' },
  { value: 'outcome',      label: 'Outcome (Desire)' },
]

function emptyAngle(offerSlug, angleType) {
  return {
    slug: '',
    name: '',
    offer_slugs: offerSlug ? [offerSlug] : [],
    qualifier: '',
    primary_promise: '',
    mechanism_short: '',
    mechanism_long: '',
    prospect_voice: '',
    angle_type: angleType || 'outcome',
    active: true,
    notes: '',
  }
}

// Slug pattern: <offer-prefix>-<angle_type>-<name-kebab>-<yyyymmdd>-<short_rand>.
// Mirrors the existing seed format (e.g. opt-accounting-desire-banker-s-go-to-cpa-20260531-11)
// without needing a counter — the rand suffix makes inserts collision-safe.
function slugify(offerSlug, angleType, name) {
  const kebab = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'custom'
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  const offer = (offerSlug || 'custom').replace(/-/g, '_').toLowerCase()
  return `${offer}-${angleType}-${kebab}-${today}-${rand}`
}

export default function AngleEditorModal({ open, angle, mode = 'edit', offerSlug = '', angleType = 'outcome', onClose, onSaved }) {
  const isCreate = mode === 'create' || !angle?.slug
  const [draft, setDraft] = useState(emptyAngle(offerSlug, angleType))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    if (isCreate) {
      setDraft(emptyAngle(offerSlug, angleType))
    } else {
      // Hydrate from the row we were handed. Copy only the writable fields —
      // updated_at / created_at are handled by the DB.
      setDraft({
        slug:            angle.slug,
        name:            angle.name || '',
        offer_slugs:     Array.isArray(angle.offer_slugs) ? angle.offer_slugs : [],
        qualifier:       angle.qualifier || '',
        primary_promise: angle.primary_promise || '',
        mechanism_short: angle.mechanism_short || '',
        mechanism_long:  angle.mechanism_long || '',
        prospect_voice:  angle.prospect_voice || '',
        angle_type:      angle.angle_type || 'outcome',
        active:          angle.active !== false,
        notes:           angle.notes || '',
      })
    }
  }, [open, angle?.slug, isCreate, offerSlug, angleType])

  useEffect(() => {
    if (!open) return
    const onEsc = (e) => { if (e.key === 'Escape' && !saving) onClose?.() }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, onClose, saving])

  if (!open) return null

  const set = (patch) => setDraft(prev => ({ ...prev, ...patch }))

  const handleSave = async () => {
    if (!draft.name?.trim()) { setErr('Name is required'); return }
    if (!draft.qualifier?.trim()) { setErr('Qualifier is required'); return }
    if (!draft.offer_slugs?.length) { setErr('At least one offer must be selected'); return }
    setSaving(true); setErr(null)
    try {
      const payload = { ...draft, name: draft.name.trim(), qualifier: draft.qualifier.trim() }
      if (isCreate) {
        payload.slug = slugify(payload.offer_slugs[0], payload.angle_type, payload.name)
        // Stamp a notes line so the audit trail shows this was operator-created.
        payload.notes = (payload.notes ? payload.notes + '\n' : '')
          + `[${new Date().toISOString().split('T')[0]}] Created via AngleEditorModal (custom angle).`
      } else {
        // Preserve the existing notes; just append an update marker so the row
        // history isn't lost.
        payload.notes = (payload.notes ? payload.notes + '\n' : '')
          + `[${new Date().toISOString().split('T')[0]}] Updated via AngleEditorModal.`
      }
      const { error } = await supabase
        .from('script_angles')
        .upsert(payload, { onConflict: 'slug' })
      if (error) throw error
      onSaved?.(payload.slug)
      onClose?.()
    } catch (e) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => !saving && onClose?.()}>
      <div className="bg-bg-card border border-border-default rounded-sm max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default">
          <div>
            <h2 className="text-sm font-semibold">{isCreate ? 'New custom angle' : 'Edit angle'}</h2>
            <p className="text-[10px] text-text-400">
              {isCreate
                ? `Saves to script_angles for offer ${offerSlug || '—'}. Shows up in the Angle picker on save.`
                : `slug: ${draft.slug}`}
            </p>
          </div>
          <button onClick={() => !saving && onClose?.()} className="text-text-400 hover:text-text-primary"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name */}
          <Field label="Name" required>
            <input
              type="text"
              value={draft.name}
              onChange={e => set({ name: e.target.value })}
              placeholder={isCreate ? 'e.g. "Just Hired a Better Tech"' : ''}
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm"
              autoFocus={isCreate}
            />
          </Field>

          {/* Angle type */}
          <Field label="Angle type" required>
            <div className="flex gap-2">
              {ANGLE_TYPES.map(t => (
                <button key={t.value}
                        onClick={() => set({ angle_type: t.value })}
                        className={`px-3 py-1.5 text-[11px] uppercase tracking-wider border transition-colors ${
                          draft.angle_type === t.value
                            ? 'border-text-primary text-text-primary bg-bg-card-hover'
                            : 'border-border-default text-text-secondary hover:border-text-primary'
                        }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </Field>

          {/* Qualifier — the field Ben kept hitting */}
          <Field label="Qualifier (audience-filter opening line)" required>
            <textarea
              value={draft.qualifier}
              onChange={e => set({ qualifier: e.target.value })}
              rows={2}
              placeholder='e.g. "Electricians doing $50K+/month who want to rank in the top 3"'
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm font-mono"
            />
            <p className="text-[10px] text-text-400 mt-1">
              This is injected verbatim into the script-writer prompt as the audience line. Skip fluff (e.g. "licensed", "operating ethically") — the script will repeat exactly what's here.
            </p>
          </Field>

          {/* Primary promise */}
          <Field label="Primary promise">
            <textarea
              value={draft.primary_promise}
              onChange={e => set({ primary_promise: e.target.value })}
              rows={2}
              placeholder='e.g. "Top 3 in Google Maps in 90 days or your money back."'
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm"
            />
          </Field>

          {/* Mechanism short */}
          <Field label="Mechanism (short)">
            <input
              type="text"
              value={draft.mechanism_short}
              onChange={e => set({ mechanism_short: e.target.value })}
              placeholder='e.g. "Pin-1 Rebuild — three fixes on your Google profile."'
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm"
            />
          </Field>

          {/* Mechanism long */}
          <Field label="Mechanism (long — optional)">
            <textarea
              value={draft.mechanism_long}
              onChange={e => set({ mechanism_long: e.target.value })}
              rows={3}
              placeholder="Full mechanism explanation if you want the script to draw on more depth than the short version."
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm"
            />
          </Field>

          {/* Prospect voice */}
          <Field label="Prospect voice (how they'd describe the problem)">
            <textarea
              value={draft.prospect_voice}
              onChange={e => set({ prospect_voice: e.target.value })}
              rows={3}
              placeholder="A 2-3 sentence quote in the prospect's own words. Helps the script use language they recognize."
              className="w-full px-3 py-2 bg-bg-primary border border-border-default text-text-primary text-sm"
            />
          </Field>

          {/* Active toggle */}
          <Field label="Status">
            <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
              <input type="checkbox" checked={draft.active} onChange={e => set({ active: e.target.checked })} />
              Active (uncheck to hide from the picker without deleting)
            </label>
          </Field>
        </div>

        <div className="px-5 py-3 border-t border-border-default flex items-center justify-between gap-3">
          <span className="text-[10px] text-red-400 flex-1">{err || ''}</span>
          <button onClick={() => !saving && onClose?.()}
                  disabled={saving}
                  className="px-3 py-1.5 text-[11px] uppercase tracking-wider border border-border-default hover:border-text-primary hover:text-text-primary transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1.5 text-[11px] uppercase tracking-wider border border-success text-success hover:bg-success/10 transition-colors disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Saving…' : isCreate ? 'Create angle' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-text-400 mb-1">
        {label} {required && <span className="text-red-400">·</span>}
      </label>
      {children}
    </div>
  )
}
