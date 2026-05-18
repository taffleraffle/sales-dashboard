import { useEffect, useState } from 'react'
import Modal from '../editorial/Modal'
import { Eyebrow } from '../editorial/atoms'
import { createTestBatch } from '../../services/testBatches'
import { listOffers } from '../../services/creativeTagger'

/*
  Lightweight modal to create a draft test batch. Just name + hypothesis +
  optional offer + notes. Operator can attach scripts later from the
  detail modal.
*/

export default function CreateTestBatchModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [hypothesis, setHypothesis] = useState('')
  const [offerSlug, setOfferSlug] = useState('')
  const [notes, setNotes] = useState('')
  const [offers, setOffers] = useState([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) return
    listOffers().then(setOffers).catch(() => setOffers([]))
    setName(''); setHypothesis(''); setOfferSlug(''); setNotes('')
    setErr(null); setSaving(false)
  }, [open])

  async function handleSave() {
    if (!name.trim()) { setErr('Name required'); return }
    setSaving(true); setErr(null)
    try {
      const batch = await createTestBatch({
        name: name.trim(),
        hypothesis: hypothesis.trim() || null,
        offer_slug: offerSlug || null,
        notes: notes.trim() || null,
      })
      onCreated?.(batch)
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} size="md"
      eyebrow="New test draft"
      title="Create a test"
      subtitle="A test is a named bundle of scripts. Add scripts after creating it, review the density, then launch when you film the ads."
      footer={
        <>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={saving} style={btnGhost}>Cancel</button>
            <button onClick={handleSave} disabled={saving || !name.trim()} style={btnPrimary}>
              {saving ? 'Creating…' : 'Create draft'}
            </button>
          </div>
        </>
      }>
      <div style={{ padding: 24 }}>
        {err && (
          <div style={{
            padding: '10px 12px', marginBottom: 16,
            background: '#fef2f2', border: '1px solid #fca5a5',
            color: '#b53e3e', fontSize: 13,
          }}>{err}</div>
        )}

        <div style={{ marginBottom: 18 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Name</Eyebrow>
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="Q2 — diagnostic vs conditional hook"
            autoFocus
            style={inputStyle} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Hypothesis</Eyebrow>
          <textarea value={hypothesis} onChange={e => setHypothesis(e.target.value)}
            placeholder="What are you testing? e.g. 'Diagnostic hook beats conditional hook on TPA-dependent restoration owners.'"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Offer</Eyebrow>
          <select value={offerSlug} onChange={e => setOfferSlug(e.target.value)}
            style={inputStyle}>
            <option value="">— Any —</option>
            {offers.filter(o => !o.slug.includes('template')).map(o => (
              <option key={o.slug} value={o.slug}>{o.name}</option>
            ))}
          </select>
        </div>

        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Notes</Eyebrow>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Optional. Any context the team should know."
            rows={2}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
      </div>
    </Modal>
  )
}

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  fontFamily: 'var(--sans)', fontSize: 14,
  border: '1px solid var(--rule)', background: 'white',
  color: 'var(--ink)', outline: 'none',
}

const btnGhost = {
  padding: '8px 14px',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule-2)', cursor: 'pointer',
}

const btnPrimary = {
  padding: '8px 18px',
  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
}
