import { useState, useEffect } from 'react'
import { X, Check, AlertCircle } from 'lucide-react'
import { upsertMechanism } from '../../services/scriptGenerator'

/*
  Mechanism config modal (Ben 2026-05-31).

  Mirrors OfferConfigModal's UX so the two makers feel like siblings.
  A "mechanism" = WHAT OPT DOES to deliver an outcome. It's the layer
  between an angle (the prospect's problem/desire door) and an offer
  (the package + audience + guarantee).

  Required-for-good-output fields:
    slug, name, mechanism_short, mechanism_long

  Strongly recommended (drives body Beat 5):
    beat_5a, beat_5b, beat_5c — the 3-part HOW

  Optional:
    summary, offer_slugs (tags), angle_slugs (tags), notes
*/

export default function MechanismConfigModal({ open, onClose, onSaved, existing, offers = [], angles = [] }) {
  const [form, setForm] = useState({
    slug: '',
    name: '',
    summary: '',
    mechanism_short: '',
    mechanism_long: '',
    beat_5a: '',
    beat_5b: '',
    beat_5c: '',
    offer_slugs: [],
    angle_slugs: [],
    notes: '',
    active: true,
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (existing) {
      setForm({
        slug: existing.slug || '',
        name: existing.name || '',
        summary: existing.summary || '',
        mechanism_short: existing.mechanism_short || '',
        mechanism_long: existing.mechanism_long || '',
        beat_5a: existing.beat_5a || '',
        beat_5b: existing.beat_5b || '',
        beat_5c: existing.beat_5c || '',
        offer_slugs: existing.offer_slugs || [],
        angle_slugs: existing.angle_slugs || [],
        notes: existing.notes || '',
        active: existing.active !== false,
      })
    } else if (open) {
      setForm({
        slug: '', name: '', summary: '',
        mechanism_short: '', mechanism_long: '',
        beat_5a: '', beat_5b: '', beat_5c: '',
        offer_slugs: [], angle_slugs: [], notes: '', active: true,
      })
    }
    setErr(null)
  }, [existing, open])

  if (!open) return null

  const isEdit = !!existing

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const saved = await upsertMechanism(form)
      onSaved?.(saved)
    } catch (e) {
      setErr(e.message || 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggleTag = (field, slug) => {
    setForm(prev => {
      const set = new Set(prev[field] || [])
      if (set.has(slug)) set.delete(slug)
      else set.add(slug)
      return { ...prev, [field]: Array.from(set) }
    })
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--paper)', maxWidth: 760, width: '100%', maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--rule)',
          borderTop: '3px solid var(--accent)',
          borderRadius: 2,
          boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
        }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow eyebrow-accent">{isEdit ? 'Configure mechanism' : 'New mechanism'}</div>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 400, margin: '6px 0 0' }}>
              {isEdit ? `Configure ${existing.name}` : 'Add a new mechanism'}
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
            A mechanism is <strong>what OPT does to deliver the outcome</strong>. Same mechanism
            can pair with multiple angles (e.g. the "Advisory Shift" mechanism answers both
            the "Bench eating bookkeeping" pain AND the "$30k/mo recurring" desire). The fields
            below feed straight into the generator's prompt — be specific about the short
            phrasing for hooks and the 3-part HOW for body Beat 5.
          </p>

          {err && (
            <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                          color: '#b53e3e', fontSize: 13, marginBottom: 16, borderRadius: 2 }}>
              <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <Field label="Slug (URL-safe)" required
              helper="e.g. advisory-shift, referral-chain-rebuild, rank-1-in-ai-restoration"
              value={form.slug}
              disabled={isEdit}
              onChange={v => setForm({ ...form, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            <Field label="Display name" required
              helper='e.g. "Compliance → Advisory Shift"'
              value={form.name}
              onChange={v => setForm({ ...form, name: v })} />
          </div>

          <Field label="Summary"
            helper="One-line description of what this mechanism delivers. Shown on the picker pills."
            placeholder="e.g. Move a CPA practice off the tax-return treadmill into recurring advisory retainers."
            value={form.summary}
            onChange={v => setForm({ ...form, summary: v })}
            multiline />

          <Field label="Mechanism (short — for hook use)" required
            helper={`Goes into the "We'll {mechanism_short}" slot in every hook. Should sound natural in that grammar.`}
            placeholder="e.g. move your book from compliance to recurring advisory retainers"
            value={form.mechanism_short}
            onChange={v => setForm({ ...form, mechanism_short: v })}
            multiline />

          <Field label="Mechanism (long — for body Beat 4 reveal)" required
            helper="2-4 sentences. The body's mechanism-reveal beat (after the proof roster). Expand the short form with the specifics that make it credible."
            placeholder="e.g. move your book from one-off compliance work into recurring advisory retainers. We audit your existing client base, identify which clients are upgrade candidates vs which to drop, build the advisory packaging and upsell sequence so the upgrade conversation is easy, and run outbound to backfill freed capacity with mid-market clients Bench and Pilot can't serve."
            value={form.mechanism_long}
            onChange={v => setForm({ ...form, mechanism_long: v })}
            multiline />

          <div style={{
            marginTop: 6, padding: '14px 16px', background: 'var(--paper-2)',
            border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent)',
            marginBottom: 16,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
              marginBottom: 10,
            }}>3-part HOW (body Beat 5a / 5b / 5c)</div>
            <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12.5,
                        color: 'var(--ink-4)', margin: '0 0 12px', lineHeight: 1.5 }}>
              One sentence each. These become the three "First, we... Second, we... Third, we..."
              lines in every body for this mechanism. Convention: 5a = foundation, 5b = surface,
              5c = authority / differentiator.
            </p>
            <Field label="Beat 5a — Foundation"
              placeholder="e.g. audit the existing client base + identify upgrade candidates vs drop candidates"
              value={form.beat_5a}
              onChange={v => setForm({ ...form, beat_5a: v })}
              multiline />
            <Field label="Beat 5b — Surface / mechanism"
              placeholder="e.g. build advisory packaging + the upsell sequence that makes the conversation easy"
              value={form.beat_5b}
              onChange={v => setForm({ ...form, beat_5b: v })}
              multiline />
            <Field label="Beat 5c — Authority / differentiator"
              placeholder="e.g. run outbound to backfill freed capacity with mid-market clients commodity players can't touch"
              value={form.beat_5c}
              onChange={v => setForm({ ...form, beat_5c: v })}
              multiline />
          </div>

          {/* Compat tags */}
          {(offers.length > 0 || angles.length > 0) && (
            <div style={{ marginTop: 6, marginBottom: 16 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)',
                marginBottom: 8,
              }}>Where it applies</div>
              <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12.5,
                          color: 'var(--ink-4)', margin: '0 0 10px', lineHeight: 1.5 }}>
                Tag this mechanism to specific offers and angles it works with. Empty = available
                everywhere; the picker shows it for any selection.
              </p>
              {offers.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                                letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                    Offers
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {offers.map(o => {
                      const on = form.offer_slugs.includes(o.slug)
                      return (
                        <button key={o.slug} type="button"
                          onClick={() => toggleTag('offer_slugs', o.slug)}
                          style={{
                            padding: '5px 10px', fontSize: 12,
                            fontFamily: 'var(--sans)',
                            border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                            background: on ? 'var(--ink)' : 'white',
                            color: on ? 'var(--paper)' : 'var(--ink-3)',
                            cursor: 'pointer', borderRadius: 2,
                          }}>
                          {o.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {angles.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                                letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                    Angles
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {angles.map(a => {
                      const on = form.angle_slugs.includes(a.slug)
                      return (
                        <button key={a.slug} type="button"
                          onClick={() => toggleTag('angle_slugs', a.slug)}
                          style={{
                            padding: '5px 10px', fontSize: 12,
                            fontFamily: 'var(--sans)',
                            border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                            background: on ? 'var(--ink)' : 'white',
                            color: on ? 'var(--paper)' : 'var(--ink-3)',
                            cursor: 'pointer', borderRadius: 2,
                          }}>
                          {a.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <Field label="Notes (optional)"
            helper="Internal notes — what this is for, when to use it, anything the generator doesn't see."
            value={form.notes}
            onChange={v => setForm({ ...form, notes: v })}
            multiline />
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
            {saving ? 'Saving…' : isEdit ? 'Save mechanism' : 'Create mechanism'}
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
    <div style={{ marginBottom: 14 }}>
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
