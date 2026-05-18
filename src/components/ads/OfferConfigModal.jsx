import { useState, useEffect } from 'react'
import { X, Check, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Offer config modal.

  Two modes:
    create  — operator is making a brand new offer (eg. "OPT Plumbing")
    edit    — operator is filling in config on a placeholder (eg. white-label-template)

  Required-for-good-output fields:
    slug, name, vertical, mechanism_name, primary_audience,
    default_proof_characters (comma-separated), has_dual_guarantee

  Optional: brand_voice_md, kb_doc_url
*/

export default function OfferConfigModal({ open, onClose, onSaved, existing }) {
  const [form, setForm] = useState({
    slug: '',
    name: '',
    vertical: '',
    mechanism_name: '',
    primary_audience: '',
    default_proof_characters: '',
    has_dual_guarantee: false,
    brand_voice_md: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (existing) {
      setForm({
        slug: existing.slug || '',
        name: existing.name || '',
        vertical: existing.vertical || '',
        mechanism_name: existing.mechanism_name || '',
        primary_audience: existing.primary_audience || '',
        default_proof_characters: (existing.default_proof_characters || []).join(', '),
        has_dual_guarantee: !!existing.has_dual_guarantee,
        brand_voice_md: existing.brand_voice_md || '',
      })
    } else if (open) {
      setForm({
        slug: '',
        name: '',
        vertical: '',
        mechanism_name: '',
        primary_audience: '',
        default_proof_characters: '',
        has_dual_guarantee: false,
        brand_voice_md: '',
      })
    }
    setErr(null)
  }, [existing, open])

  if (!open) return null

  const isEdit = !!existing

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const payload = {
        slug: form.slug.trim(),
        name: form.name.trim(),
        vertical: form.vertical.trim().toLowerCase(),
        mechanism_name: form.mechanism_name.trim() || null,
        primary_audience: form.primary_audience.trim() || null,
        default_proof_characters: form.default_proof_characters
          .split(',').map(s => s.trim()).filter(Boolean),
        has_dual_guarantee: form.has_dual_guarantee,
        brand_voice_md: form.brand_voice_md.trim() || null,
      }
      if (!payload.slug || !payload.name || !payload.vertical) {
        throw new Error('slug, name, and vertical are required')
      }
      let result
      if (isEdit) {
        const { data, error } = await supabase.from('offers')
          .update(payload).eq('slug', existing.slug).select().maybeSingle()
        if (error) throw new Error(error.message)
        result = data
      } else {
        const { data, error } = await supabase.from('offers')
          .insert(payload).select().maybeSingle()
        if (error) throw new Error(error.message)
        result = data
      }
      onSaved(result)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--paper)', maxWidth: 720, width: '100%', maxHeight: '90vh',
          overflow: 'auto', border: '2px solid var(--ink)', borderRadius: 2,
          boxShadow: '8px 8px 0 var(--accent)',
        }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow eyebrow-accent">{isEdit ? 'Configure offer' : 'New offer'}</div>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 400, margin: '6px 0 0' }}>
              {isEdit ? `Configure ${existing.name}` : 'Add a new offer'}
            </h2>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer',
            padding: 4,
          }}>
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <div style={{ padding: 24 }}>
          <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                      fontSize: 14, margin: '0 0 20px', lineHeight: 1.5 }}>
            These fields feed directly into the script generator's prompt. The more specific
            you are about mechanism and audience, the better the generated scripts will be.
          </p>

          {err && (
            <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                          color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 2 }}>
              <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <Field label="Slug (URL-safe)" required
              helper="e.g. opt-plumbing"
              value={form.slug}
              disabled={isEdit}
              onChange={v => setForm({ ...form, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            <Field label="Vertical" required
              helper="e.g. plumbing, hvac, roofing"
              value={form.vertical}
              onChange={v => setForm({ ...form, vertical: v })} />
          </div>

          <Field label="Display name" required
            helper="e.g. OPT Plumbing (Pipe Flow Engine)"
            value={form.name}
            onChange={v => setForm({ ...form, name: v })} />

          <Field label="Mechanism name"
            helper="Brand-named mechanism the scripts will reference (gated mode). Leave blank if hidden/explicit only."
            placeholder="e.g. The Direct Call Engine, The Pipe Flow System"
            value={form.mechanism_name}
            onChange={v => setForm({ ...form, mechanism_name: v })} />

          <Field label="Primary audience"
            helper="Who is this for? Be specific about revenue range, current pain, and what they've tried."
            placeholder="e.g. Plumbing company owners doing $30k+/mo, burned by HomeAdvisor lead platforms, stuck on referrals."
            value={form.primary_audience}
            onChange={v => setForm({ ...form, primary_audience: v })}
            multiline />

          <Field label="Proof characters (comma-separated)"
            helper="Real client names with brief context. The generator picks one per script."
            placeholder="e.g. Eric, Adam, Belinda, Morgan"
            value={form.default_proof_characters}
            onChange={v => setForm({ ...form, default_proof_characters: v })} />

          <Field label="Brand voice notes (optional)"
            helper="Banned phrases, tone, or specific words/cadence to use. Markdown OK."
            placeholder="Tight, declarative. No adjectives like 'amazing' or 'incredible'. Use mit/water mit not 'restoration' literally."
            value={form.brand_voice_md}
            onChange={v => setForm({ ...form, brand_voice_md: v })}
            multiline />

          <div style={{ marginTop: 16, padding: 14, background: 'white', border: '1px solid var(--rule)',
                        borderRadius: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.has_dual_guarantee}
                onChange={e => setForm({ ...form, has_dual_guarantee: e.target.checked })} />
              <span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                              textTransform: 'uppercase', color: 'var(--ink)', fontWeight: 600 }}>
                  Dual guarantee
                </span>
                <span style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                              color: 'var(--ink-3)', marginLeft: 8 }}>
                  Use the "top 3 ranking + crews booked, money back if neither" close.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    border: '1px solid var(--rule)', background: 'transparent',
                    color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 2 }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '10px 22px', fontFamily: 'var(--mono)', fontSize: 11,
                    letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                    border: '2px solid var(--ink)', background: 'var(--ink)',
                    color: 'var(--paper)', cursor: saving ? 'wait' : 'pointer',
                    opacity: saving ? 0.6 : 1, borderRadius: 2,
                    boxShadow: !saving ? '3px 3px 0 var(--accent)' : 'none' }}>
            <Check size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            {saving ? 'Saving…' : isEdit ? 'Save offer' : 'Create offer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, helper, value, onChange, placeholder, multiline, disabled }) {
  const baseStyle = {
    width: '100%', padding: '10px 12px',
    fontFamily: 'var(--sans)', fontSize: 14,
    border: '1px solid var(--rule)', background: disabled ? 'var(--paper-2)' : 'white',
    color: disabled ? 'var(--ink-4)' : 'var(--ink)',
    borderRadius: 2, resize: multiline ? 'vertical' : undefined,
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 11,
                     letterSpacing: '0.12em', textTransform: 'uppercase',
                     color: 'var(--ink-3)', marginBottom: 6 }}>
        {label} {required && <span style={{ color: '#b53e3e' }}>*</span>}
      </label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={3}
          placeholder={placeholder} style={baseStyle} disabled={disabled} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} style={baseStyle} disabled={disabled} />
      )}
      {helper && (
        <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontStyle: 'italic',
                      fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.4 }}>
          {helper}
        </div>
      )}
    </div>
  )
}
