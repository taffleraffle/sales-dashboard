import { useState, useEffect } from 'react'
import { X, Check, AlertCircle, Trash2, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import ConfirmModal from '../ConfirmModal'

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

// Per-offer structured proof items shape (mirrors migration 120 column).
// Each entry: { proof_type, name, result_short, result_long?, industry_context?, metric_kind? }
const OFFER_PROOF_TYPES = [
  { value: 'case_study',    label: 'Case study',    namePh: 'Eric',                         resultPh: 'Closed a $215K job in 90 days' },
  { value: 'testimonial',   label: 'Testimonial',   namePh: 'Mark — plumber, NC',           resultPh: '"My closing rate doubled in week 2."' },
  { value: 'statistic',     label: 'Statistic',     namePh: 'HomeAdvisor burnout rate',     resultPh: '67% of restoration owners burn out in year 2' },
  { value: 'authority',     label: 'Authority',     namePh: 'Roto-Rooter franchise manual', resultPh: 'Explicitly recommends abandoning shared-lead platforms' },
  { value: 'demonstration', label: 'Demonstration', namePh: 'Month 1 vs 6 dashboard',       resultPh: '$14K → $48K MRR by month 6, charted' },
  { value: 'social_volume', label: 'Social volume', namePh: 'Restoration cohort 2024',      resultPh: '38 companies, avg $32K/mo lift' },
  { value: 'comparison',    label: 'Comparison',    namePh: 'vs HomeAdvisor',               resultPh: '3.2x bookings, 1/4 the cost-per-lead' },
]

function emptyOfferProof() {
  return { proof_type: 'case_study', name: '', result_short: '', result_long: '' }
}

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
    offer_proof_items: [],
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [retireConfirmOpen, setRetireConfirmOpen] = useState(false)
  const [retiring, setRetiring] = useState(false)

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
        offer_proof_items: Array.isArray(existing.offer_proof_items) ? existing.offer_proof_items : [],
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
        offer_proof_items: [],
      })
    }
    setErr(null)
  }, [existing, open])

  if (!open) return null

  const isEdit = !!existing

  async function performRetire() {
    if (!existing?.slug) return
    setRetiring(true); setErr(null)
    try {
      const { error } = await supabase.from('offers')
        .update({ retired: true }).eq('slug', existing.slug)
      if (error) throw new Error(error.message)
      setRetireConfirmOpen(false)
      onSaved(null)   // null = retired, parent should refresh + pick a different offer
    } catch (e) {
      setErr(`Retire failed: ${e.message}`)
    } finally {
      setRetiring(false)
    }
  }

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
        // Filter out incomplete inline proofs (both name + result must be
        // present) and normalize fields. proof_type defaults to case_study.
        offer_proof_items: (form.offer_proof_items || [])
          .map(p => ({
            proof_type: p.proof_type || 'case_study',
            name: (p.name || '').trim(),
            result_short: (p.result_short || '').trim(),
            result_long: (p.result_long || '').trim() || undefined,
            industry_context: (p.industry_context || '').trim() || undefined,
            metric_kind: (p.metric_kind || '').trim() || undefined,
          }))
          .filter(p => p.name && p.result_short),
      }
      if (!payload.slug || !payload.name) {
        throw new Error('slug and name are required')
      }
      if (!isEdit && !payload.vertical) {
        throw new Error('vertical is required for new offers')
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
      // Guard: maybeSingle() returns null without an error when RLS or a
      // grant silently blocks the row from coming back. Without this
      // check the parent treats null as a retire signal and switches
      // offer — the save looks successful but nothing changed.
      if (!result) {
        throw new Error('Save returned no row. Check RLS / grants on offers.')
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
          overflow: 'auto',
          border: '1px solid var(--rule)',
          borderTop: '3px solid var(--accent)',
          borderRadius: 9,
          boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
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
                          color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 9 }}>
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

          <Field label="Quick proof names (comma-separated · legacy)"
            helper="Just the names — fast way to seed the rotation. For typed proofs with results, use the Proofs section below."
            placeholder="e.g. Eric, Adam, Belinda, Morgan"
            value={form.default_proof_characters}
            onChange={v => setForm({ ...form, default_proof_characters: v })} />

          {/* Structured per-offer proof roster (migration 120). Numbered
              rows — Proof 1, Proof 2, etc — that apply across every script
              generated for this offer, on top of any per-angle proofs. */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.12em', textTransform: 'uppercase',
                          color: 'var(--ink-3)', marginBottom: 6 }}>
              Proofs (apply across all scripts for this offer)
            </label>
            <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic',
                        fontSize: 12.5, color: 'var(--ink-4)',
                        margin: '0 0 10px', lineHeight: 1.5 }}>
              Numbered proof items the generator can pull from on top of any
              per-angle proofs. Mix types — case studies build specificity,
              statistics build scale, authority builds borrowed credibility.
              Add 3-5 for healthy rotation.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(form.offer_proof_items || []).map((p, i) => (
                <OfferProofRow key={i}
                  index={i}
                  proof={p}
                  onChange={(patch) => {
                    const next = [...(form.offer_proof_items || [])]
                    next[i] = { ...next[i], ...patch }
                    setForm({ ...form, offer_proof_items: next })
                  }}
                  onRemove={() => {
                    const next = (form.offer_proof_items || []).filter((_, j) => j !== i)
                    setForm({ ...form, offer_proof_items: next })
                  }}
                />
              ))}
              <button type="button"
                onClick={() => setForm({
                  ...form,
                  offer_proof_items: [...(form.offer_proof_items || []), emptyOfferProof()],
                })}
                style={{
                  padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                  letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
                  border: '1px dashed var(--ink-3)', background: 'transparent',
                  color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  alignSelf: 'flex-start',
                }}>
                <Plus size={12} /> Add proof {(form.offer_proof_items?.length || 0) + 1}
              </button>
            </div>
          </div>

          <Field label="Brand voice notes (optional)"
            helper="Banned phrases, tone, or specific words/cadence to use. Markdown OK."
            placeholder="Tight, declarative. No adjectives like 'amazing' or 'incredible'. Use mit/water mit not 'restoration' literally."
            value={form.brand_voice_md}
            onChange={v => setForm({ ...form, brand_voice_md: v })}
            multiline />

          <div style={{ marginTop: 16, padding: 14, background: 'var(--paper)', border: '1px solid var(--rule)',
                        borderRadius: 9 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.has_dual_guarantee} style={{ marginTop: 3 }}
                onChange={e => setForm({ ...form, has_dual_guarantee: e.target.checked })} />
              <span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                              textTransform: 'uppercase', color: 'var(--ink)', fontWeight: 600 }}>
                  Dual guarantee
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
                              textTransform: 'uppercase', color: 'var(--ink-4)', marginLeft: 8 }}>
                  Optional
                </span>
                <div style={{ marginTop: 4, fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                              color: 'var(--ink-3)', lineHeight: 1.45 }}>
                  Enables the "top 3 ranking + crews booked, money back if neither" close on every script.
                  Leave unchecked if you'd rather phrase the guarantee yourself inside the mechanism name
                  (e.g. "The Direct Call Engine — money back if no calls in 90 days") — the scripts will
                  pick that up.
                </div>
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          {/* Retire lives on the left so destructive action is visually
              separated from the primary Save action. Edit mode only —
              creating a new offer + immediately retiring it makes no sense. */}
          <div>
            {isEdit && (
              <button onClick={() => setRetireConfirmOpen(true)} disabled={saving || retiring}
                title="Soft delete — hides from picker, keeps historical references intact"
                style={{ padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 11,
                        letterSpacing: '0.12em', textTransform: 'uppercase',
                        border: '1px solid #b53e3e', background: 'transparent',
                        color: '#b53e3e', cursor: (saving || retiring) ? 'wait' : 'pointer',
                        opacity: (saving || retiring) ? 0.5 : 1, borderRadius: 9,
                        display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Trash2 size={12} />
                Retire offer
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose}
              style={{ padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: '1px solid var(--rule)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9 }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              style={{ padding: '10px 22px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                      border: '2px solid var(--ink)', background: 'var(--ink)',
                      color: 'var(--paper)', cursor: saving ? 'wait' : 'pointer',
                      opacity: saving ? 0.6 : 1, borderRadius: 9,
                      boxShadow: !saving ? '3px 3px 0 var(--accent)' : 'none' }}>
              <Check size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
              {saving ? 'Saving…' : isEdit ? 'Save offer' : 'Create offer'}
            </button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={retireConfirmOpen}
        onClose={() => !retiring && setRetireConfirmOpen(false)}
        onConfirm={performRetire}
        title={`Retire "${existing?.name || ''}"?`}
        message="It will disappear from the offer picker and all dropdowns. Historical scripts that reference this offer keep working — this is a soft delete (sets retired = true)."
        confirmLabel="Retire offer"
        variant="danger"
        loading={retiring}
      />
    </div>
  )
}

// Single row in the offer-proofs editor — numbered card with a type
// dropdown, name + result inputs, and a remove button. Saves on form
// submit (parent controls dirty state).
function OfferProofRow({ index, proof, onChange, onRemove }) {
  const typeMeta = OFFER_PROOF_TYPES.find(t => t.value === proof.proof_type) || OFFER_PROOF_TYPES[0]
  return (
    <div style={{
      padding: 12, background: 'var(--paper)',
      border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent)',
      borderRadius: 9,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)',
          minWidth: 60,
        }}>Proof {index + 1}</span>
        <select value={proof.proof_type || 'case_study'}
          onChange={e => onChange({ proof_type: e.target.value })}
          style={{
            padding: '5px 8px', fontFamily: 'var(--mono)', fontSize: 10.5,
            letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600,
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', borderRadius: 9, outline: 'none', cursor: 'pointer',
          }}>
          {OFFER_PROOF_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button type="button" onClick={onRemove}
          style={{
            marginLeft: 'auto', padding: 6, background: 'transparent',
            border: '1px solid var(--rule)', color: 'var(--ink-4)',
            cursor: 'pointer', borderRadius: 9,
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = '#b53e3e'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-4)'}>
          <Trash2 size={12} />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
        <input type="text" value={proof.name || ''} placeholder={typeMeta.namePh}
          onChange={e => onChange({ name: e.target.value })}
          style={{
            padding: '8px 10px', fontFamily: 'var(--sans)', fontSize: 13,
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', borderRadius: 9, outline: 'none',
          }} />
        <input type="text" value={proof.result_short || ''} placeholder={typeMeta.resultPh}
          onChange={e => onChange({ result_short: e.target.value })}
          style={{
            padding: '8px 10px', fontFamily: 'var(--sans)', fontSize: 13,
            border: '1px solid var(--rule)', background: 'var(--paper)',
            color: 'var(--ink)', borderRadius: 9, outline: 'none',
          }} />
      </div>
    </div>
  )
}

function Field({ label, required, helper, value, onChange, placeholder, multiline, disabled }) {
  const baseStyle = {
    width: '100%', padding: '10px 12px',
    fontFamily: 'var(--sans)', fontSize: 14,
    border: '1px solid var(--rule)', background: disabled ? 'var(--paper-2)' : 'var(--paper)',
    color: disabled ? 'var(--ink-4)' : 'var(--ink)',
    borderRadius: 9, resize: multiline ? 'vertical' : undefined,
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
