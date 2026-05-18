import { useEffect, useState, useMemo } from 'react'
import { Sparkles, Copy, AlertCircle, FileText, ChevronDown, ChevronUp, Check, Zap, Layers, Plus, Settings, Link2 } from 'lucide-react'
import { generateScripts, listGeneratedScripts, linkScriptToAd } from '../../services/scriptGenerator'
import { listOffers, getAttributeVocab } from '../../services/creativeTagger'
import OfferConfigModal from '../../components/ads/OfferConfigModal'
import { supabase } from '../../lib/supabase'

/*
  Script generator — rebuilt UX:
    - Big offer pills (not a dropdown)
    - "Diverse batch" mode is the default (no filters, max variance across attributes)
    - Optional "Targeted" mode reveals multi-select attribute chips
    - 1-30 concepts via slider with visual markers
    - Result cards with attribute pills + serif body + copy buttons
    - History table at bottom
*/

const FILTERABLE_ATTRS = [
  { key: 'hook_type',        label: 'Hook type' },
  { key: 'message_frame',    label: 'Message frame' },
  { key: 'mechanism_reveal', label: 'Mechanism reveal' },
  { key: 'pain_angle',       label: 'Pain angle' },
  { key: 'funnel_stage',     label: 'Funnel stage' },
  { key: 'awareness_level',  label: 'Awareness level' },
  { key: 'length_bucket',    label: 'Length bucket' },
]

export default function AdsGenerator() {
  const [offers, setOffers] = useState([])
  const [vocab, setVocab] = useState(null)
  const [offerSlug, setOfferSlug] = useState('')
  const [nConcepts, setNConcepts] = useState(10)
  const [mode, setMode] = useState('diverse')
  const [targets, setTargets] = useState({})
  const [saveAsDrafts, setSaveAsDrafts] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [err, setErr] = useState(null)
  const [offerModalOpen, setOfferModalOpen] = useState(false)
  const [offerModalExisting, setOfferModalExisting] = useState(null)

  async function refreshOffers() {
    const o = await listOffers()
    setOffers(o)
    return o
  }

  useEffect(() => {
    Promise.all([listOffers(), getAttributeVocab(), listGeneratedScripts({ limit: 25 })])
      .then(([o, v, h]) => {
        setOffers(o); setVocab(v); setHistory(h)
        const live = o.find(x => !x.slug.includes('stub') && !x.slug.includes('template')) || o[0]
        if (live) setOfferSlug(live.slug)
      })
      .catch(e => setErr(e.message))
  }, [])

  function openNewOffer() {
    setOfferModalExisting(null)
    setOfferModalOpen(true)
  }

  function openConfigureOffer(o) {
    setOfferModalExisting(o)
    setOfferModalOpen(true)
  }

  async function handleOfferSaved(saved) {
    setOfferModalOpen(false)
    await refreshOffers()
    if (saved?.slug) setOfferSlug(saved.slug)
  }

  function toggleTarget(field, value) {
    setTargets(prev => {
      const arr = prev[field] || []
      const next = arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]
      const cloned = { ...prev }
      if (next.length === 0) delete cloned[field]
      else cloned[field] = next
      return cloned
    })
  }

  async function handleGenerate() {
    setGenerating(true); setErr(null); setResult(null)
    try {
      // In diverse mode, send empty target_attributes so Edge Function uses
      // the "MAX VARIANCE" prompt branch.
      const payload = {
        offer_slug: offerSlug,
        n_concepts: nConcepts,
        target_attributes: mode === 'targeted' ? targets : {},
        save_as_drafts: saveAsDrafts,
      }
      const res = await generateScripts(payload)
      setResult(res)
      if (res.save_error) setErr(`Generated but save-as-drafts failed: ${res.save_error}`)
      const h = await listGeneratedScripts({ limit: 25 })
      setHistory(h)
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const selectedOffer = offers.find(o => o.slug === offerSlug)

  return (
    <div style={{ padding: '24px 0' }}>
      {/* Editorial header */}
      <div style={{ marginBottom: 32, position: 'relative' }}>
        <div className="eyebrow eyebrow-accent">OPT Sales · Script <em>generator</em></div>
        <h1 className="h1" style={{ marginTop: 6, marginBottom: 8 }}>
          Generate a <em>fresh</em> batch.
        </h1>
        <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                    fontSize: 16, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
          Pick an offer, choose how many concepts, and either let the system maximize
          variance across all attributes — or use targeted mode to constrain specific
          variables for an A/B test.
        </p>
      </div>

      {err && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5',
                      color: '#b53e3e', fontSize: 13, marginBottom: 20, borderRadius: 2 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
        </div>
      )}

      {/* Step 1: pick offer */}
      <Section label="01" title="Pick an offer">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {offers.map(o => {
            const selected = o.slug === offerSlug
            const isStub = o.slug.includes('stub') || o.slug.includes('template')
            const incomplete = !o.mechanism_name || !o.primary_audience
            return (
              <div key={o.slug} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                <button
                  onClick={() => setOfferSlug(o.slug)}
                  style={{
                    padding: '10px 14px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderRight: selected ? '2px solid var(--ink)' : 'none',
                    background: selected ? 'var(--ink)' : 'white',
                    color: selected ? 'var(--paper)' : isStub ? 'var(--ink-4)' : 'var(--ink)',
                    fontFamily: 'var(--sans)', fontSize: 14, fontWeight: selected ? 600 : 400,
                    cursor: 'pointer', borderRadius: '2px 0 0 2px',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    transition: 'all 140ms ease',
                  }}>
                  {selected && <Check size={14} />}
                  <span>{o.name}</span>
                  {incomplete && (
                    <span style={{ fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.1em',
                                  background: '#e0a93e', color: '#3b2a04', padding: '2px 5px',
                                  borderRadius: 2, textTransform: 'uppercase' }}>
                      needs config
                    </span>
                  )}
                </button>
                <button
                  onClick={() => openConfigureOffer(o)}
                  title="Configure offer"
                  style={{
                    padding: '10px 8px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderLeft: '1px solid var(--rule)',
                    background: selected ? 'var(--ink)' : 'white',
                    color: selected ? 'var(--paper)' : 'var(--ink-3)',
                    cursor: 'pointer', borderRadius: '0 2px 2px 0',
                    display: 'inline-flex', alignItems: 'center',
                  }}>
                  <Settings size={14} />
                </button>
              </div>
            )
          })}
          <button onClick={openNewOffer}
            style={{
              padding: '10px 16px',
              border: '2px dashed var(--rule)', background: 'transparent',
              color: 'var(--ink-3)',
              fontFamily: 'var(--sans)', fontSize: 14,
              cursor: 'pointer', borderRadius: 2,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              transition: 'all 140ms ease',
            }}>
            <Plus size={14} />
            New offer
          </button>
        </div>
        {(() => {
          const cur = offers.find(o => o.slug === offerSlug)
          if (!cur) return null
          if (!cur.mechanism_name || !cur.primary_audience) {
            return (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#fef9e7',
                            border: '1px solid #e0a93e', fontSize: 13, borderRadius: 2,
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: '#7a5c12' }}>
                  This offer is missing {[!cur.mechanism_name && 'mechanism', !cur.primary_audience && 'audience'].filter(Boolean).join(' + ')}.
                  Generated scripts will be generic without it.
                </span>
                <button onClick={() => openConfigureOffer(cur)}
                  style={{ padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
                          border: '1px solid #7a5c12', background: '#7a5c12', color: '#fef9e7',
                          cursor: 'pointer', borderRadius: 2 }}>
                  Configure now
                </button>
              </div>
            )
          }
          return null
        })()}
      </Section>

      <OfferConfigModal
        open={offerModalOpen}
        existing={offerModalExisting}
        onClose={() => setOfferModalOpen(false)}
        onSaved={handleOfferSaved}
      />

      {/* Step 2: how many concepts */}
      <Section label="02" title="How many concepts">
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {[5, 10, 15, 20, 30].map(n => (
              <button key={n} onClick={() => setNConcepts(n)}
                style={{
                  padding: '10px 20px',
                  border: `1px solid ${nConcepts === n ? 'var(--ink)' : 'var(--rule)'}`,
                  background: nConcepts === n ? 'var(--accent)' : 'white',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', borderRadius: 2,
                  transition: 'all 140ms ease',
                  minWidth: 70,
                }}>{n}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
                          textTransform: 'uppercase', color: 'var(--ink-4)' }}>Custom:</span>
            <input type="number" min={1} max={30} value={nConcepts}
              onChange={e => setNConcepts(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))}
              style={{
                width: 70, padding: '8px 10px',
                fontFamily: 'var(--mono)', fontSize: 14, textAlign: 'center',
                border: '1px solid var(--rule)', background: 'white',
                borderRadius: 2,
              }} />
          </div>
        </div>
      </Section>

      {/* Step 3: mode */}
      <Section label="03" title="Generation mode">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <ModeCard
            selected={mode === 'diverse'}
            onClick={() => setMode('diverse')}
            icon={<Layers size={18} />}
            title="Diverse batch"
            desc="Maximum variance across every attribute. Best for first-cycle exploration — produces a wide testing matrix where every concept has a different combination."
          />
          <ModeCard
            selected={mode === 'targeted'}
            onClick={() => setMode('targeted')}
            icon={<Zap size={18} />}
            title="Targeted"
            desc="Constrain specific attribute values. Best for A/B-isolated tests — e.g. fix mechanism_reveal=explicit, vary everything else."
          />
        </div>

        {/* Advanced — only relevant in targeted mode */}
        {mode === 'targeted' && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              style={{
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                border: '1px solid var(--rule)', background: 'transparent',
                color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 2,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              {advancedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {advancedOpen ? 'Hide constraints' : 'Add constraints'}
              {Object.keys(targets).length > 0 && (
                <span style={{ marginLeft: 6, padding: '1px 6px', fontSize: 9,
                              background: 'var(--accent)', color: 'var(--ink)',
                              fontWeight: 700, borderRadius: 2 }}>
                  {Object.keys(targets).length}
                </span>
              )}
            </button>

            {advancedOpen && (
              <div style={{ marginTop: 16, padding: 20, background: 'var(--paper)',
                            border: '1px solid var(--rule)', borderRadius: 2 }}>
                <p style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                            color: 'var(--ink-4)', margin: '0 0 16px' }}>
                  Pick values to include. Multiple values within one attribute = the system
                  will distribute scripts across those values. Leave empty = vary freely.
                </p>
                {FILTERABLE_ATTRS.map(f => {
                  const options = vocab?.[f.key] || []
                  const selected = targets[f.key] || []
                  return (
                    <div key={f.key} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11,
                                      letterSpacing: '0.12em', textTransform: 'uppercase',
                                      color: 'var(--ink-3)' }}>{f.label}</span>
                        {selected.length > 0 && (
                          <button onClick={() => setTargets(p => { const c = { ...p }; delete c[f.key]; return c })}
                            style={{ padding: '1px 6px', fontSize: 10, fontFamily: 'var(--mono)',
                                    background: 'transparent', color: 'var(--ink-4)',
                                    border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                            clear
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {options.map(o => {
                          const isOn = selected.includes(o.value)
                          return (
                            <button key={o.value}
                              onClick={() => toggleTarget(f.key, o.value)}
                              title={o.description}
                              style={{
                                padding: '6px 12px', fontSize: 12,
                                fontFamily: 'var(--sans)',
                                border: `1px solid ${isOn ? 'var(--ink)' : 'var(--rule)'}`,
                                background: isOn ? 'var(--ink)' : 'white',
                                color: isOn ? 'var(--paper)' : 'var(--ink-3)',
                                cursor: 'pointer', borderRadius: 2,
                                transition: 'all 120ms ease',
                              }}>
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Step 4: generate */}
      <Section label="04" title="Generate">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button onClick={handleGenerate} disabled={generating || !offerSlug}
            style={{
              padding: '14px 28px', fontFamily: 'var(--mono)', fontSize: 12,
              letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700,
              border: '2px solid var(--ink)',
              background: generating ? 'var(--ink-3)' : 'var(--ink)',
              color: 'var(--paper)', cursor: generating ? 'wait' : 'pointer',
              opacity: !offerSlug ? 0.4 : 1, borderRadius: 2,
              boxShadow: !generating && offerSlug ? '4px 4px 0 var(--accent)' : 'none',
              transition: 'all 140ms ease',
            }}>
            <Sparkles size={14} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
            {generating
              ? `Generating ${nConcepts}…`
              : `Generate ${nConcepts} ${mode === 'diverse' ? 'diverse' : 'targeted'} concept${nConcepts > 1 ? 's' : ''}`}
          </button>
          <label style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
                        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={saveAsDrafts} onChange={e => setSaveAsDrafts(e.target.checked)} />
            Save to drafts
          </label>
          {selectedOffer?.has_dual_guarantee && (
            <span style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                          color: 'var(--ink-4)' }}>
              Dual-guarantee close: top 3 Maps + crews booked, money back if neither.
            </span>
          )}
        </div>
      </Section>

      {/* Result panel */}
      {result?.scripts?.length > 0 && (
        <div style={{ marginTop: 40, marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 16 }}>
            <div className="eyebrow eyebrow-accent">
              <Sparkles size={13} style={{ display: 'inline', marginRight: 6 }} />
              {result.scripts.length} <em>generated</em>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)',
                          letterSpacing: '0.06em' }}>
              {result.model}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 16 }}>
            {result.scripts.map((s, i) => <ScriptCard key={i} script={s} index={i + 1} />)}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div style={{ marginTop: 48 }}>
          <div className="eyebrow" style={{ marginBottom: 12, color: 'var(--ink-3)' }}>
            <FileText size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Recent drafts
          </div>
          <div style={{ background: 'white', border: '1px solid var(--rule)' }}>
            <table style={{ width: '100%', fontSize: 13, fontFamily: 'var(--sans)' }}>
              <thead>
                <tr style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: 'var(--ink-4)',
                            borderBottom: '1px solid var(--rule)' }}>
                  <th style={{ textAlign: 'left', padding: '12px' }}>When</th>
                  <th style={{ textAlign: 'left' }}>Offer</th>
                  <th style={{ textAlign: 'left' }}>Title</th>
                  <th style={{ textAlign: 'left' }}>Frame</th>
                  <th style={{ textAlign: 'left' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} style={{ borderTop: '1px solid var(--rule)' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                      {new Date(h.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td>{h.offer_slug?.replace('opt-', '')}</td>
                    <td style={{ fontFamily: 'var(--serif)' }}>{h.title || '—'}</td>
                    <td>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10,
                                    padding: '2px 6px', background: 'var(--paper)',
                                    border: '1px solid var(--rule)' }}>
                        {h.frame || '—'}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{h.status}</td>
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

function Section({ label, title, children }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                      letterSpacing: '0.12em', color: 'var(--accent)',
                      background: 'var(--ink)', padding: '4px 8px' }}>
          {label}
        </span>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400,
                    margin: 0, color: 'var(--ink)' }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  )
}

function ModeCard({ selected, onClick, icon, title, desc }) {
  return (
    <button onClick={onClick}
      style={{
        flex: '1 1 280px', maxWidth: 400, padding: 20,
        border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
        background: selected ? 'var(--paper)' : 'white',
        cursor: 'pointer', textAlign: 'left', borderRadius: 2,
        transition: 'all 140ms ease',
        position: 'relative',
        boxShadow: selected ? '4px 4px 0 var(--accent)' : 'none',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ color: selected ? 'var(--ink)' : 'var(--ink-4)' }}>{icon}</span>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)' }}>
          {title}
        </span>
        {selected && <Check size={16} color="var(--ink)" style={{ marginLeft: 'auto' }} />}
      </div>
      <p style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
                  margin: 0, lineHeight: 1.5 }}>
        {desc}
      </p>
    </button>
  )
}

function ScriptCard({ script, index }) {
  const [copied, setCopied] = useState(false)

  function copyBody() {
    navigator.clipboard.writeText(script.body || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const frameColor = {
    PROBLEM: '#b53e3e',
    CIRCUMSTANCE: '#e0a93e',
    OUTCOME: '#3e8a5e',
  }[script.frame] || 'var(--ink-4)'

  return (
    <div style={{ padding: 20, background: 'white', border: '1px solid var(--rule)',
                  position: 'relative', borderRadius: 2 }}>
      {/* Top stripe — frame color */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                    background: frameColor }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    marginBottom: 12, marginTop: 4 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                          color: 'var(--ink-4)', letterSpacing: '0.08em' }}>
              #{String(index).padStart(2, '0')}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                          color: frameColor, letterSpacing: '0.12em',
                          textTransform: 'uppercase' }}>
              {script.frame}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                          letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              · {script.length_bucket?.replace('_', ' ')}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 19, color: 'var(--ink)',
                        fontWeight: 400, lineHeight: 1.3 }}>
            {script.title}
          </div>
        </div>
        <button onClick={copyBody}
          style={{ padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                  letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
                  border: `1px solid ${copied ? 'var(--accent)' : 'var(--rule)'}`,
                  background: copied ? 'var(--accent)' : 'white',
                  color: 'var(--ink)', cursor: 'pointer', borderRadius: 2,
                  display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Attribute pills */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
        {[
          ['hook', script.hook_type],
          ['mech', script.mechanism_reveal],
          ['pain', script.pain_angle],
          ['proof', script.proof_character],
          ['stage', script.funnel_stage],
        ].filter(([_, v]) => v && v !== 'none').map(([k, v]) => (
          <span key={k} style={{ padding: '3px 7px', background: 'var(--paper)',
                                fontFamily: 'var(--mono)', fontSize: 10,
                                letterSpacing: '0.04em', color: 'var(--ink-3)',
                                border: '1px solid var(--rule)', borderRadius: 2 }}>
            <span style={{ color: 'var(--ink-4)' }}>{k}</span>:&nbsp;
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{v}</span>
          </span>
        ))}
      </div>

      <div style={{ fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.55,
                    color: 'var(--ink)', whiteSpace: 'pre-wrap',
                    paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
        {script.body}
      </div>
    </div>
  )
}
