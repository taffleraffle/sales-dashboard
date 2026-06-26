import { useEffect, useState } from 'react'
import { RefreshCw, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import {
  tagAd,
  getAttributeVocab,
  getAdAttributes,
  updateAdAttributes,
  listOffers,
} from '../../services/creativeTagger'
import ColoredSelect from '../editorial/ColoredSelect'
import { displayValue } from '../editorial/atoms'

/*
  Test-variable tagging panel for AdDetail.jsx.

  Wraps:
    - LLM extraction (Re-extract button → calls creative-tag-ad Edge Function)
    - 11 dropdowns sourced from creative_attribute_vocab
    - Confidence pills next to LLM-extracted fields
    - Winner-state override (manual override beats auto-detection)
    - Free-text notes
*/

// Trimmed 2026-05-18: dropped proof_character, funnel_stage, length_bucket,
// format, actor, vertical. Per Ben's request to simplify the tracked set.
const LLM_EXTRACTABLE = [
  'hook_type', 'message_frame', 'mechanism_reveal',
  'pain_angle', 'awareness_level',
]
const ALL_FIELDS = [...LLM_EXTRACTABLE]

const FIELD_LABELS = {
  hook_type:        'Hook type',
  message_frame:    'Message frame',
  mechanism_reveal: 'Mechanism reveal',
  pain_angle:       'Pain angle',
  awareness_level:  'Awareness level',
}

function ConfidencePill({ score }) {
  if (score == null) return null
  const color =
    score >= 0.85 ? 'var(--accent)' :
    score >= 0.65 ? '#e0a93e' :
    score >= 0.45 ? '#d97847' : '#b53e3e'
  const label = score >= 0.85 ? 'high' : score >= 0.65 ? 'med' : score >= 0.45 ? 'low' : 'guess'
  return (
    <span style={{
      marginLeft: 6,
      padding: '1px 6px',
      fontSize: 10,
      fontFamily: 'var(--mono)',
      letterSpacing: '0.06em',
      borderRadius: 9,
      color: 'white',
      background: color,
      textTransform: 'uppercase',
    }} title={`Confidence ${(score * 100).toFixed(0)}%`}>{label}</span>
  )
}

function WinnerToggle({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      <button
        onClick={() => onChange(value === true ? null : true)}
        style={{
          padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
          textTransform: 'uppercase', border: `1px solid ${value === true ? 'var(--accent)' : 'var(--rule)'}`,
          background: value === true ? 'var(--accent)' : 'transparent',
          color: value === true ? 'var(--ink)' : 'var(--ink-3)', cursor: 'pointer',
        }}>
        <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
        Winner
      </button>
      <button
        onClick={() => onChange(value === false ? null : false)}
        style={{
          padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
          textTransform: 'uppercase', border: `1px solid ${value === false ? '#b53e3e' : 'var(--rule)'}`,
          background: value === false ? '#b53e3e' : 'transparent',
          color: value === false ? 'white' : 'var(--ink-3)', cursor: 'pointer',
        }}>
        <XCircle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
        Loser
      </button>
      {value !== null && value !== undefined && (
        <button onClick={() => onChange(null)} style={{
          padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11,
          border: '1px solid var(--rule)', background: 'transparent',
          color: 'var(--ink-4)', cursor: 'pointer',
        }} title="Clear override">×</button>
      )}
    </div>
  )
}

export default function CreativeAttributesPanel({ ad_id }) {
  const [vocab, setVocab] = useState(null)
  const [offers, setOffers] = useState([])
  const [attrs, setAttrs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  // Load vocab + offers + existing attrs in parallel
  useEffect(() => {
    let cancel = false
    setLoading(true)
    Promise.all([getAttributeVocab(), listOffers(), getAdAttributes(ad_id)])
      .then(([v, o, a]) => {
        if (cancel) return
        setVocab(v); setOffers(o); setAttrs(a || { ad_id })
      })
      .catch(e => { if (!cancel) setErr(e.message) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [ad_id])

  async function handleExtract() {
    setExtracting(true); setErr(null)
    try {
      const extracted = await tagAd(ad_id)
      // Refresh attrs from DB (includes confidence + raw response)
      const fresh = await getAdAttributes(ad_id)
      setAttrs(fresh)
    } catch (e) {
      setErr(e.message)
    } finally {
      setExtracting(false)
    }
  }

  async function handleChange(field, value) {
    const next = { ...attrs, [field]: value }
    setAttrs(next)
    setSaving(true)
    try {
      await updateAdAttributes(ad_id, { [field]: value })
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--ink-3)' }}>Loading creative attributes…</div>
  if (err && !attrs) return <div style={{ padding: 24, color: '#b53e3e' }}>Error: {err}</div>

  const confidence = attrs?.extraction_confidence || {}

  return (
    <div style={{
      border: '1px solid var(--rule)', background: 'var(--paper)',
      padding: 24, marginTop: 24,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 4 }}>
            Creative <em>· test attributes</em>
          </div>
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, margin: 0, fontWeight: 400 }}>
            Tag <em>this</em> creative
          </h2>
          {attrs?.extracted_at && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', marginTop: 6, letterSpacing: '0.06em' }}>
              EXTRACTED {new Date(attrs.extracted_at).toLocaleString()} · {attrs.extracted_by_model || 'unknown model'}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleExtract}
            disabled={extracting}
            style={{
              padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
              textTransform: 'uppercase', border: '1px solid var(--ink)', background: 'var(--ink)',
              color: 'var(--paper)', cursor: extracting ? 'wait' : 'pointer', opacity: extracting ? 0.6 : 1,
            }}>
            <RefreshCw size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            {extracting ? 'Extracting…' : (attrs?.extracted_at ? 'Re-extract' : 'Extract')}
          </button>
        </div>
      </div>

      {err && <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5', color: '#b53e3e', fontSize: 13, marginBottom: 16 }}>
        <AlertCircle size={14} style={{ display: 'inline', marginRight: 6 }} />{err}
      </div>}

      {/* Offer selector — top of form */}
      <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--rule)' }}>
        <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                       textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
          Offer
        </label>
        <select
          value={attrs?.offer_slug || ''}
          onChange={e => handleChange('offer_slug', e.target.value || null)}
          style={{
            width: '100%', padding: '10px 12px', fontFamily: 'var(--sans)', fontSize: 14,
            border: '1px solid var(--rule)', background: 'var(--paper)', color: 'var(--ink)',
          }}>
          <option value="">— Select offer —</option>
          {offers.map(o => (
            <option key={o.slug} value={o.slug}>{o.name} ({o.vertical})</option>
          ))}
        </select>
      </div>

      {/* Attribute grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {ALL_FIELDS.map(field => {
          const opts = vocab?.[field] || []
          const isLlm = LLM_EXTRACTABLE.includes(field)
          const conf = isLlm ? confidence[field] : null
          return (
            <div key={field}>
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6,
              }}>
                <span>{FIELD_LABELS[field]}</span>
                <span>{conf != null && <ConfidencePill score={conf} />}</span>
              </label>
              <ColoredSelect
                attr={field}
                value={attrs?.[field] || null}
                onChange={v => handleChange(field, v)}
                options={opts.map(o => ({
                  value: o.value,
                  // Normalize label casing through displayValue so we don't have
                  // "EXPLICIT" next to "Diagnostic" next to "Capacity mismatch".
                  label: displayValue(o.value),
                  description: o.description,
                }))}
              />
            </div>
          )
        })}
      </div>

      {/* Winner override */}
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--rule)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                       textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
            Winner override
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic', color: 'var(--ink-4)' }}>
            {attrs?.manual_winner_override === true && 'Manually marked winner — overrides auto-detection.'}
            {attrs?.manual_winner_override === false && 'Manually marked loser — overrides auto-detection.'}
            {(attrs?.manual_winner_override === null || attrs?.manual_winner_override === undefined) && 'Using auto-detection (spend ≥ $1k AND ≥2 booked AND CPB ≤ $300).'}
          </div>
        </div>
        <WinnerToggle
          value={attrs?.manual_winner_override}
          onChange={v => handleChange('manual_winner_override', v)}
        />
      </div>

      {/* Notes */}
      <div style={{ marginTop: 20 }}>
        <label style={{
          display: 'block', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6,
        }}>
          Notes {attrs?.notes && <span style={{ color: 'var(--ink-4)', fontStyle: 'italic',
                                              fontFamily: 'var(--serif)', textTransform: 'none' }}>
            (last extraction reasoning preserved)
          </span>}
        </label>
        <textarea
          value={attrs?.notes || ''}
          onChange={e => setAttrs({ ...attrs, notes: e.target.value })}
          onBlur={e => handleChange('notes', e.target.value)}
          rows={3}
          style={{
            width: '100%', padding: '10px 12px', fontFamily: 'var(--sans)', fontSize: 13,
            border: '1px solid var(--rule)', background: 'var(--paper)', color: 'var(--ink)',
            resize: 'vertical',
          }}
          placeholder="Operator notes on why this tagging or override was applied…"
        />
      </div>

      {saving && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                      letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 12 }}>
          Saving…
        </div>
      )}
    </div>
  )
}
