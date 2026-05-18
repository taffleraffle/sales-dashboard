import { useEffect, useState } from 'react'
import { X, Search, Link2, FileText, Upload, Check, AlertCircle, Sparkles, ArrowRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { listGeneratedScripts, linkScriptToAd } from '../../services/scriptGenerator'
import { tagAd, listOffers } from '../../services/creativeTagger'
import { uploadAdVideoToStorage, transcribeUploadedAd } from '../../services/adAnalyst'
import AdThumbnail from './AdThumbnail'

/*
  Unified drawer for adding a creative to the system OR linking an existing
  draft script to a Meta ad. Replaces the centered AssignCreativeModal.

  Three tabs:
    1. Existing draft  — pick generated_scripts row → search Meta ad → link
    2. Paste transcript — pick Meta ad → paste text → insert+auto-tag
    3. Upload MP4       — pick Meta ad → upload → transcribe+auto-tag

  Props:
    open — boolean
    onClose — callback
    onSaved — callback(result) once a creative is saved or linked
    presetScript — optional generated_scripts row to preselect (when
                   opened from a Generator history "Link to ad" button)
*/

const TABS = [
  { key: 'existing', label: 'Existing draft', icon: Link2,    desc: 'Pick a generated script and link it to a filmed Meta ad.' },
  { key: 'paste',    label: 'Paste transcript', icon: FileText, desc: 'Already have the script text? Paste it and we auto-tag.' },
  { key: 'upload',   label: 'Upload MP4',    icon: Upload,   desc: 'Drag-drop the video. We transcribe + auto-tag.' },
]

export default function AddOrLinkCreativeDrawer({ open, onClose, onSaved, presetScript }) {
  const [tab, setTab] = useState('existing')
  const [scripts, setScripts] = useState([])
  const [offers, setOffers] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  // Shared state across tabs
  const [chosenScript, setChosenScript] = useState(null)
  const [chosenAd, setChosenAd] = useState(null)
  const [adQuery, setAdQuery] = useState('')
  const [ads, setAds] = useState([])
  const [searching, setSearching] = useState(false)

  // Tab-specific state
  const [pasteText, setPasteText] = useState('')
  const [pasteOffer, setPasteOffer] = useState('')
  const [uploadFile, setUploadFile] = useState(null)
  const [working, setWorking] = useState(false)
  const [workStage, setWorkStage] = useState(null)  // 'uploading' | 'transcribing' | 'tagging' | 'linking'

  const presetScriptId = presetScript?.id || null

  // Initial load
  useEffect(() => {
    if (!open) return
    setErr(null); setChosenScript(presetScript || null); setChosenAd(null); setAdQuery('')
    setPasteText(''); setPasteOffer(''); setUploadFile(null)

    setLoading(true)
    Promise.all([listGeneratedScripts({ limit: 50 }), listOffers()])
      .then(([s, o]) => {
        const drafts = s.filter(x => x.status !== 'shipped')
        setScripts(drafts)
        setOffers(o)
        // Default tab: existing-draft if drafts exist + no presetScript, otherwise paste
        if (presetScriptId) setTab('existing')
        else if (drafts.length === 0) setTab('paste')
        else setTab('existing')
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [open, presetScriptId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Server-side debounced ad search (used by all 3 tabs)
  useEffect(() => {
    if (!open) return
    const q = adQuery.trim()
    const fire = (query) => {
      setSearching(true)
      let req = supabase.from('ads')
        .select('ad_id, ad_name, campaign_name, thumbnail_url, asset_url, asset_type, last_synced_at')
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(30)
      if (query) {
        req = req.or(`ad_name.ilike.%${query}%,campaign_name.ilike.%${query}%,ad_id.ilike.%${query}%`)
      }
      req.then(({ data, error }) => {
        if (error) setErr(error.message)
        else setAds(data || [])
      }).finally(() => setSearching(false))
    }
    if (!q) { fire(null); return }
    const handle = setTimeout(() => fire(q), 250)
    return () => clearTimeout(handle)
  }, [adQuery, open])

  // Escape close
  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape' && !working) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, working, onClose])

  if (!open) return null

  // ── Actions ───────────────────────────────────────────────────────
  async function doExistingDraft() {
    if (!chosenScript || !chosenAd) return
    setWorking(true); setWorkStage('linking'); setErr(null)
    try {
      const res = await linkScriptToAd(chosenScript.id, chosenAd.ad_id)
      onSaved?.({ kind: 'linked', ad_id: chosenAd.ad_id, ad_name: chosenAd.ad_name, result: res })
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setWorking(false); setWorkStage(null)
    }
  }

  async function doPasteTranscript() {
    if (!chosenAd || !pasteText.trim()) return
    setWorking(true); setErr(null)
    try {
      setWorkStage('saving')
      // 1. Upsert transcript with source='manual'
      const { error: te } = await supabase.from('lib_creative_transcripts').upsert({
        ad_id: chosenAd.ad_id, source: 'manual', full_text: pasteText.trim(),
      }, { onConflict: 'ad_id,source' })
      if (te) throw new Error(`transcript save: ${te.message}`)

      // 2. Optionally set offer_slug on creative_attributes
      if (pasteOffer) {
        await supabase.from('creative_attributes').upsert({
          ad_id: chosenAd.ad_id, offer_slug: pasteOffer,
        }, { onConflict: 'ad_id' })
      }

      // 3. Call creative-tag-ad to auto-classify
      setWorkStage('tagging')
      await tagAd(chosenAd.ad_id)

      onSaved?.({ kind: 'pasted', ad_id: chosenAd.ad_id, ad_name: chosenAd.ad_name })
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setWorking(false); setWorkStage(null)
    }
  }

  async function doUploadMp4() {
    if (!chosenAd || !uploadFile) return
    setWorking(true); setErr(null)
    try {
      // Step 1: upload to storage (~5-15s)
      setWorkStage('uploading')
      const storagePath = await uploadAdVideoToStorage(chosenAd.ad_id, uploadFile)

      // Step 2: transcribe via Whisper (~30-120s — explicit 3min timeout)
      setWorkStage('transcribing')
      await transcribeUploadedAd(chosenAd.ad_id, storagePath, { timeoutMs: 180_000 })

      // Step 3: auto-tag attributes (~5-15s)
      setWorkStage('tagging')
      await tagAd(chosenAd.ad_id)

      onSaved?.({ kind: 'uploaded', ad_id: chosenAd.ad_id, ad_name: chosenAd.ad_name })
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setWorking(false); setWorkStage(null)
    }
  }

  function handleSubmit() {
    if (tab === 'existing') return doExistingDraft()
    if (tab === 'paste')    return doPasteTranscript()
    if (tab === 'upload')   return doUploadMp4()
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.45)',
        backdropFilter: 'blur(2px)', zIndex: 99,
      }} />

      <div onClick={e => e.stopPropagation()} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: '100%', maxWidth: 640, height: '100vh',
        background: 'var(--paper)',
        borderLeft: '3px solid var(--accent)',
        boxShadow: '-12px 0 32px rgba(10,10,10,0.15)',
        zIndex: 100,
        display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--rule)',
          background: 'white',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        }}>
          <div>
            <div className="eyebrow eyebrow-accent">Add or link <em>creative</em></div>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400, margin: '4px 0 0' }}>
              {tab === 'existing' && 'Link a draft to a Meta ad'}
              {tab === 'paste'    && 'Paste a transcript'}
              {tab === 'upload'   && 'Upload a video'}
            </h2>
          </div>
          <button onClick={onClose} disabled={working}
            style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)',
                    cursor: working ? 'wait' : 'pointer', padding: 4, opacity: working ? 0.4 : 1 }}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)', background: 'var(--paper)' }}>
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button key={t.key} onClick={() => setTab(t.key)} disabled={working}
                style={{
                  flex: 1, padding: '12px 14px', textAlign: 'left',
                  background: active ? 'white' : 'transparent',
                  border: 'none', borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: working ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                <Icon size={14} color={active ? 'var(--ink)' : 'var(--ink-4)'} />
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                  textTransform: 'uppercase', fontWeight: 600,
                  color: active ? 'var(--ink)' : 'var(--ink-4)',
                }}>{t.label}</span>
              </button>
            )
          })}
        </div>

        {err && (
          <div style={{ margin: 14, padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                        color: '#b53e3e', fontSize: 13, borderRadius: 2 }}>
            <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                      fontSize: 13, margin: '0 0 16px' }}>
            {TABS.find(t => t.key === tab).desc}
          </p>

          {/* Tab 1: Existing draft */}
          {tab === 'existing' && (
            <>
              <FieldLabel>Step 1 · Pick a draft</FieldLabel>
              {loading ? <Empty>Loading drafts…</Empty> : scripts.length === 0 ? (
                <Empty>
                  No drafts yet. Switch to <button onClick={() => setTab('paste')}
                    style={{ background: 'transparent', border: 'none', color: 'var(--ink)',
                            textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit' }}>Paste transcript</button> or <button onClick={() => setTab('upload')}
                    style={{ background: 'transparent', border: 'none', color: 'var(--ink)',
                            textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit' }}>Upload MP4</button>.
                </Empty>
              ) : (
                <div style={{ display: 'grid', gap: 6, marginBottom: 24 }}>
                  {scripts.map(s => (
                    <Row key={s.id} selected={chosenScript?.id === s.id} onClick={() => setChosenScript(s)}>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ fontFamily: 'var(--serif)', fontSize: 14, lineHeight: 1.2 }}>
                          {s.title || '(untitled)'}
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10,
                                      color: chosenScript?.id === s.id ? 'var(--accent)' : 'var(--ink-4)',
                                      letterSpacing: '0.06em', marginTop: 2 }}>
                          {s.offer_slug?.replace('opt-', '')} · {s.frame} · {new Date(s.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </Row>
                  ))}
                </div>
              )}
              <FieldLabel>Step 2 · Pick the Meta ad</FieldLabel>
              <AdPicker {...{ adQuery, setAdQuery, ads, searching, chosenAd, setChosenAd }} />
            </>
          )}

          {/* Tab 2: Paste transcript */}
          {tab === 'paste' && (
            <>
              <FieldLabel>Step 1 · Pick the Meta ad this is for</FieldLabel>
              <AdPicker {...{ adQuery, setAdQuery, ads, searching, chosenAd, setChosenAd }} />

              <FieldLabel style={{ marginTop: 20 }}>Step 2 · Offer (optional)</FieldLabel>
              <select value={pasteOffer} onChange={e => setPasteOffer(e.target.value)}
                style={inputStyle}>
                <option value="">— skip —</option>
                {offers.map(o => (
                  <option key={o.slug} value={o.slug}>{o.name}</option>
                ))}
              </select>

              <FieldLabel style={{ marginTop: 20 }}>Step 3 · Paste the full transcript</FieldLabel>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                rows={10}
                placeholder="Paste the script body here. It'll be saved as the manual transcript and auto-tagged for hook type, mechanism reveal, pain angle, etc."
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)', lineHeight: 1.5 }} />
              <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10,
                            color: 'var(--ink-4)', letterSpacing: '0.06em' }}>
                {pasteText.trim().split(/\s+/).filter(Boolean).length} words
              </div>
            </>
          )}

          {/* Tab 3: Upload MP4 */}
          {tab === 'upload' && (
            <>
              <FieldLabel>Step 1 · Pick the Meta ad this video is for</FieldLabel>
              <AdPicker {...{ adQuery, setAdQuery, ads, searching, chosenAd, setChosenAd }} />

              {chosenAd && (
                <div style={{
                  marginTop: 12, padding: '10px 14px', background: 'white',
                  border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent)',
                  borderRadius: 2,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <AdThumbnail ad={chosenAd} size="sm" />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                                  textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                      Attaching MP4 to
                    </div>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chosenAd.ad_name || chosenAd.ad_id}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                                  letterSpacing: '0.04em',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chosenAd.campaign_name || '(no campaign)'}
                    </div>
                  </div>
                </div>
              )}

              <FieldLabel style={{ marginTop: 20 }}>Step 2 · Pick or drop the MP4</FieldLabel>
              <DropZone file={uploadFile} setFile={setUploadFile} />

              {/* Pipeline explanation */}
              <div style={{ marginTop: 16, padding: 14, background: 'var(--paper)',
                            border: '1px solid var(--rule)', borderRadius: 2 }}>
                <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--ink-3)' }}>
                  What happens when you click Save & tag
                </div>
                <ol style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: 'var(--sans)',
                            fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.7 }}>
                  <li><span style={pipelineNumStyle}>1</span> Upload MP4 to <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>ad-source-videos</code> bucket (~5-15s)</li>
                  <li><span style={pipelineNumStyle}>2</span> OpenAI Whisper transcribes the audio (~30-120s) — stored as <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>lib_creative_transcripts</code> linked to this ad</li>
                  <li><span style={pipelineNumStyle}>3</span> Claude reads the transcript + ad copy and classifies hook type, mechanism reveal, pain angle, funnel stage, awareness level (~5-15s)</li>
                  <li><span style={pipelineNumStyle}>4</span> The ad shows up in Insights with its tags, ready to compare against other creatives</li>
                </ol>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule)',
                              fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12,
                              color: 'var(--ink-4)' }}>
                  Note: we don't currently search past generated scripts for a fuzzy text match.
                  If this video matches an existing draft, use the <strong style={{ color: 'var(--ink)' }}>Existing draft</strong> tab
                  instead — that carries over the original target attributes exactly.
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px', borderTop: '1px solid var(--rule)',
          background: 'white',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)',
                        flex: 1, overflow: 'hidden' }}>
            {workStage && (
              <StageIndicator stage={workStage} target={chosenAd?.ad_name || chosenAd?.ad_id} />
            )}
            {!workStage && tab === 'existing' && chosenScript && chosenAd && <>Will link <strong>{chosenScript.title}</strong> → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
            {!workStage && tab === 'paste' && chosenAd && pasteText && <>Will paste {pasteText.trim().split(/\s+/).filter(Boolean).length} words → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
            {!workStage && tab === 'upload' && chosenAd && uploadFile && <>Will upload {(uploadFile.size / 1024 / 1024).toFixed(1)}MB → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={working}
              style={{ padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: '1px solid var(--rule)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: working ? 'wait' : 'pointer',
                      borderRadius: 2, opacity: working ? 0.4 : 1 }}>
              Cancel
            </button>
            <button onClick={handleSubmit} disabled={working || !canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile })}
              style={{ padding: '10px 20px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                      border: '2px solid var(--ink)', background: 'var(--ink)',
                      color: 'var(--paper)', cursor: working ? 'wait' : 'pointer',
                      opacity: !canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile }) ? 0.4 : 1,
                      borderRadius: 2 }}>
              <Check size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
              {working ? 'Working…' : tab === 'existing' ? 'Link' : 'Save & tag'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0.4; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  )
}

function canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile }) {
  if (tab === 'existing') return !!(chosenScript && chosenAd)
  if (tab === 'paste')    return !!(chosenAd && pasteText.trim().length > 50)
  if (tab === 'upload')   return !!(chosenAd && uploadFile)
  return false
}

const inputStyle = {
  width: '100%', padding: '10px 12px', fontFamily: 'var(--sans)', fontSize: 13,
  border: '1px solid var(--rule)', background: 'white', borderRadius: 2,
  color: 'var(--ink)',
}

const pipelineNumStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, borderRadius: 9, fontFamily: 'var(--mono)',
  fontSize: 10, fontWeight: 700, background: 'var(--ink)', color: 'var(--accent)',
  marginRight: 8, verticalAlign: 'middle',
}

function FieldLabel({ children, style: extra = {} }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8,
      ...extra,
    }}>{children}</div>
  )
}

function Empty({ children }) {
  return (
    <div style={{
      padding: 24, textAlign: 'center', color: 'var(--ink-4)',
      fontStyle: 'italic', fontFamily: 'var(--serif)', fontSize: 13,
      border: '1px dashed var(--rule)', borderRadius: 2, marginBottom: 16,
    }}>
      {children}
    </div>
  )
}

function Row({ selected, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      textAlign: 'left', padding: '10px 12px',
      background: selected ? 'var(--ink)' : 'white',
      color: selected ? 'var(--paper)' : 'var(--ink)',
      border: `1px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
      borderRadius: 2, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    }}>
      {children}
    </button>
  )
}

function AdPicker({ adQuery, setAdQuery, ads, searching, chosenAd, setChosenAd }) {
  return (
    <>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--ink-4)' }} />
        <input type="text" value={adQuery} onChange={e => setAdQuery(e.target.value)}
          placeholder="Search by ad name, campaign, or ID…"
          style={{ ...inputStyle, paddingLeft: 32 }} />
      </div>
      <div style={{ display: 'grid', gap: 4, maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
        {searching ? (
          <Empty>Searching…</Empty>
        ) : ads.length === 0 ? (
          <Empty>No ads match.</Empty>
        ) : ads.map(a => (
          <Row key={a.ad_id} selected={chosenAd?.ad_id === a.ad_id} onClick={() => setChosenAd(a)}>
            <AdThumbnail ad={a} size="sm" />
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.ad_name || a.ad_id}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10,
                            color: chosenAd?.ad_id === a.ad_id ? 'var(--accent)' : 'var(--ink-4)',
                            letterSpacing: '0.06em', marginTop: 2,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.campaign_name || '(no campaign)'} · {a.ad_id}
              </div>
            </div>
          </Row>
        ))}
      </div>
    </>
  )
}

/* Multi-step pill that lights up by stage so the user sees real progress
   instead of "Working…" forever. Stages: uploading → transcribing → tagging.
   For non-upload tabs we still get saving → tagging or just linking. */
function StageIndicator({ stage, target }) {
  // For the upload pipeline, show 3-step progress
  const uploadStages = ['uploading', 'transcribing', 'tagging']
  if (uploadStages.includes(stage)) {
    const stageIdx = uploadStages.indexOf(stage)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontStyle: 'normal' }}>
        {uploadStages.map((s, i) => {
          const done = i < stageIdx, active = i === stageIdx
          return (
            <span key={s} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px',
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
              textTransform: 'uppercase', fontWeight: 600,
              background: active ? 'var(--ink)' : done ? 'var(--accent)' : 'var(--paper)',
              color: active ? 'var(--accent)' : done ? 'var(--ink)' : 'var(--ink-4)',
              border: '1px solid ' + (active ? 'var(--ink)' : done ? 'var(--accent)' : 'var(--rule)'),
              borderRadius: 2,
            }}>
              {done && <Check size={10} />}
              {active && <Sparkles size={10} className="pulse" />}
              {s}
            </span>
          )
        })}
        {target && <span style={{ color: 'var(--ink-4)', fontSize: 11, marginLeft: 4 }}>→ {target}</span>}
        <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } } .pulse { animation: pulse 1.2s ease-in-out infinite; }`}</style>
      </div>
    )
  }
  // Simpler stages (saving / linking)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Sparkles size={11} className="pulse" style={{ color: 'var(--accent)' }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                    textTransform: 'uppercase', color: 'var(--ink)', fontWeight: 600 }}>
        {stage}…
      </span>
      {target && <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>→ {target}</span>}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } } .pulse { animation: pulse 1.2s ease-in-out infinite; }`}</style>
    </div>
  )
}

function DropZone({ file, setFile }) {
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && f.type.startsWith('video/')) setFile(f)
  }

  return (
    <label htmlFor="upload-mp4" style={{
      display: 'block', padding: 24,
      border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule)'}`,
      background: dragOver ? 'var(--paper)' : 'white',
      borderRadius: 2, cursor: 'pointer', textAlign: 'center',
      transition: 'all 120ms ease',
    }}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input id="upload-mp4" type="file" accept="video/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f) }} />
      <Upload size={28} color="var(--ink-4)" style={{ margin: '0 auto 12px', display: 'block' }} />
      {file ? (
        <>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>
            {file.name}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>
            {(file.size / 1024 / 1024).toFixed(1)} MB · click to change
          </div>
        </>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>
            Drop an MP4 or click to pick
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                        letterSpacing: '0.06em' }}>
            up to 100MB
          </div>
        </>
      )}
    </label>
  )
}
