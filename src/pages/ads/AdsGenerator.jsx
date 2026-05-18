import { useEffect, useState } from 'react'
import { Sparkles, Copy, AlertCircle, FileText } from 'lucide-react'
import { generateScripts, listGeneratedScripts } from '../../services/scriptGenerator'
import { listOffers, getAttributeVocab } from '../../services/creativeTagger'

/*
  Generic ad-script generator. Reads offers + vocab, lets operator pick
  an offer + N concepts + optional target attributes, then calls the
  creative-generate-script Edge Function and renders the returned scripts.

  Each script can be copied to clipboard or saved as a draft in
  public.generated_scripts.
*/

const TARGET_ATTR_FIELDS = [
  'hook_type', 'message_frame', 'mechanism_reveal',
  'pain_angle', 'funnel_stage', 'awareness_level', 'length_bucket',
]
const FIELD_LABELS = {
  hook_type: 'Hook type',
  message_frame: 'Message frame',
  mechanism_reveal: 'Mechanism reveal',
  pain_angle: 'Pain angle',
  funnel_stage: 'Funnel stage',
  awareness_level: 'Awareness level',
  length_bucket: 'Length bucket',
}

export default function AdsGenerator() {
  const [offers, setOffers] = useState([])
  const [vocab, setVocab] = useState(null)
  const [offerSlug, setOfferSlug] = useState('')
  const [nConcepts, setNConcepts] = useState(3)
  const [targets, setTargets] = useState({})
  const [saveAsDrafts, setSaveAsDrafts] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [err, setErr] = useState(null)

  useEffect(() => {
    Promise.all([listOffers(), getAttributeVocab(), listGeneratedScripts({ limit: 25 })])
      .then(([o, v, h]) => {
        setOffers(o); setVocab(v); setHistory(h)
        if (o[0]) setOfferSlug(o[0].slug)
      })
      .catch(e => setErr(e.message))
  }, [])

  async function handleGenerate() {
    setGenerating(true); setErr(null); setResult(null)
    try {
      const clean = Object.fromEntries(Object.entries(targets).filter(([_, v]) => v))
      const res = await generateScripts({
        offer_slug: offerSlug,
        n_concepts: nConcepts,
        target_attributes: clean,
        save_as_drafts: saveAsDrafts,
      })
      setResult(res)
      // Surface partial-success: scripts returned but save-as-drafts failed
      if (res.save_error) setErr(`Scripts generated but save-as-drafts failed: ${res.save_error}`)
      // Refresh history
      const h = await listGeneratedScripts({ limit: 25 })
      setHistory(h)
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ marginBottom: 16 }}>
        <div className="eyebrow eyebrow-accent">OPT Sales · Script <em>generator</em></div>
        <h1 className="h2" style={{ marginTop: 4 }}>Generate <em>new</em> scripts.</h1>
        <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)',
                    fontSize: 14, marginTop: 6 }}>
          Pick an offer + number of concepts + optional target attributes. The generator
          applies all locked principles (Truth-vs-Trust, Schwartz awareness, hook
          qualification gate, no structural tics, one named proof character).
        </p>
      </div>

      {err && (
        <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, marginBottom: 16 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6 }} />{err}
        </div>
      )}

      {/* Form */}
      <div style={{ padding: 24, background: 'var(--paper)', border: '1px solid var(--rule)', marginBottom: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.12em', textTransform: 'uppercase',
                          color: 'var(--ink-3)', marginBottom: 6 }}>Offer</label>
            <select value={offerSlug} onChange={e => setOfferSlug(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', fontFamily: 'var(--sans)',
                      fontSize: 14, border: '1px solid var(--rule)', background: 'white' }}>
              {offers.map(o => (
                <option key={o.slug} value={o.slug}>{o.name} ({o.vertical})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.12em', textTransform: 'uppercase',
                          color: 'var(--ink-3)', marginBottom: 6 }}>Concepts</label>
            <input type="number" min={1} max={10} value={nConcepts}
              onChange={e => setNConcepts(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              style={{ width: '100%', padding: '10px 12px', fontFamily: 'var(--mono)',
                      fontSize: 14, border: '1px solid var(--rule)', background: 'white' }} />
          </div>
        </div>

        {/* Target attributes (optional) */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                       textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8 }}>
            Target attributes <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic',
                                            textTransform: 'none', color: 'var(--ink-4)' }}>(optional — bias generation)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {TARGET_ATTR_FIELDS.map(field => (
              <div key={field}>
                <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
                              letterSpacing: '0.1em', textTransform: 'uppercase',
                              color: 'var(--ink-4)', marginBottom: 4 }}>{FIELD_LABELS[field]}</label>
                <select value={targets[field] || ''}
                  onChange={e => setTargets({ ...targets, [field]: e.target.value || undefined })}
                  style={{ width: '100%', padding: '6px 8px', fontFamily: 'var(--sans)',
                          fontSize: 12, border: '1px solid var(--rule)', background: 'white' }}>
                  <option value="">— any —</option>
                  {(vocab?.[field] || []).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleGenerate} disabled={generating || !offerSlug}
            style={{ padding: '12px 20px', fontFamily: 'var(--mono)', fontSize: 11,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    border: '1px solid var(--ink)', background: 'var(--ink)',
                    color: 'var(--paper)', cursor: generating ? 'wait' : 'pointer',
                    opacity: generating ? 0.6 : 1 }}>
            <Sparkles size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            {generating ? 'Generating…' : `Generate ${nConcepts} concept${nConcepts > 1 ? 's' : ''}`}
          </button>
          <label style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
                        display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={saveAsDrafts} onChange={e => setSaveAsDrafts(e.target.checked)} />
            Save as drafts
          </label>
        </div>
      </div>

      {/* Result panel */}
      {result?.scripts?.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="eyebrow eyebrow-accent" style={{ marginBottom: 12 }}>
            <Sparkles size={13} style={{ display: 'inline', marginRight: 6 }} />
            {result.scripts.length} <em>generated</em> · {result.model}
          </div>
          <div style={{ display: 'grid', gap: 16 }}>
            {result.scripts.map((s, i) => <ScriptCard key={i} script={s} />)}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>
            <FileText size={13} style={{ display: 'inline', marginRight: 6 }} />
            Recent drafts
          </div>
          <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
            <table style={{ width: '100%', fontSize: 12, fontFamily: 'var(--sans)' }}>
              <thead>
                <tr style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
                            textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Created</th>
                  <th style={{ textAlign: 'left' }}>Offer</th>
                  <th style={{ textAlign: 'left' }}>Ref</th>
                  <th style={{ textAlign: 'left' }}>Title</th>
                  <th style={{ textAlign: 'left' }}>Frame</th>
                  <th style={{ textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} style={{ borderTop: '1px solid var(--rule)' }}>
                    <td style={{ padding: '6px 10px', fontFamily: 'var(--mono)' }}>
                      {new Date(h.created_at).toLocaleDateString()}
                    </td>
                    <td>{h.offer_slug}</td>
                    <td style={{ fontFamily: 'var(--mono)' }}>{h.ref || '—'}</td>
                    <td>{h.title || '—'}</td>
                    <td>{h.frame || '—'}</td>
                    <td>{h.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ScriptCard({ script }) {
  const [copied, setCopied] = useState(false)

  function copyBody() {
    navigator.clipboard.writeText(script.body || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div style={{ padding: 20, background: 'white', border: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                       textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 4 }}>
            {script.ref} · {script.frame} · {script.length_bucket}
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)', fontWeight: 400 }}>
            {script.title}
          </div>
        </div>
        <button onClick={copyBody}
          style={{ padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  border: '1px solid var(--rule)', background: copied ? 'var(--accent)' : 'transparent',
                  color: copied ? 'var(--ink)' : 'var(--ink-3)', cursor: 'pointer' }}>
          <Copy size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Attribute pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[
          ['hook', script.hook_type],
          ['mech', script.mechanism_reveal],
          ['pain', script.pain_angle],
          ['proof', script.proof_character],
          ['aware', script.awareness_level],
          ['funnel', script.funnel_stage],
        ].filter(([_, v]) => v).map(([k, v]) => (
          <span key={k} style={{ padding: '2px 8px', background: 'var(--paper)',
                                fontFamily: 'var(--mono)', fontSize: 10,
                                letterSpacing: '0.08em', color: 'var(--ink-3)',
                                border: '1px solid var(--rule)' }}>
            {k}={v}
          </span>
        ))}
      </div>

      {/* Body */}
      <div style={{ fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.6,
                    color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
        {script.body}
      </div>
    </div>
  )
}
