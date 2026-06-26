import { useEffect, useState } from 'react'
import { Search, Link2, FileText, Upload, Check, AlertCircle, Sparkles, ArrowRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { listGeneratedScripts, linkScriptToAd } from '../../services/scriptGenerator'
import { tagAd, listOffers } from '../../services/creativeTagger'
import { uploadAdVideoToStorage, transcribeUploadedAd } from '../../services/adAnalyst'
import { extractAudioFromVideo, shouldExtractAudio } from '../../services/audioExtract'
import { extractTextFromFile, isSupportedDocFile, getSupportedExtensionsLabel } from '../../services/docExtract'
import AdThumbnail from './AdThumbnail'
import Modal from '../editorial/Modal'

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
  // Bulk upload queue — array of { file, chosenAd, status, error, stage }
  // When non-empty AND length > 1, drawer enters bulk mode.
  const [uploadQueue, setUploadQueue] = useState([])
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
      // Step 0: if the video is >20MB, extract audio in browser first
      // so we stay under Whisper's 25MB API limit
      let toUpload = uploadFile
      if (shouldExtractAudio(uploadFile)) {
        setWorkStage('extracting')
        const { blob, suggestedName } = await extractAudioFromVideo(uploadFile)
        toUpload = new File([blob], suggestedName, { type: 'audio/mp4' })
      }

      setWorkStage('uploading')
      const storagePath = await uploadAdVideoToStorage(chosenAd.ad_id, toUpload)
      setWorkStage('transcribing')
      await transcribeUploadedAd(chosenAd.ad_id, storagePath, { timeoutMs: 180_000 })
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

  // Bulk: process the queue sequentially. Mutates uploadQueue in-place
  // via setUploadQueue so each row's status renders live.
  async function doUploadQueue() {
    const items = uploadQueue.filter(q => q.chosenAd)
    if (items.length === 0) return
    setWorking(true); setErr(null)

    for (let idx = 0; idx < uploadQueue.length; idx++) {
      const q = uploadQueue[idx]
      if (!q.chosenAd) continue  // skip unpaired
      if (q.status === 'done') continue  // skip already-done (retry support)

      const update = (patch) => setUploadQueue(prev => {
        const next = [...prev]
        if (next[idx]) next[idx] = { ...next[idx], ...patch }
        return next
      })

      try {
        let toUpload = q.file
        if (shouldExtractAudio(q.file)) {
          update({ status: 'extracting', error: null })
          const { blob, suggestedName } = await extractAudioFromVideo(q.file)
          toUpload = new File([blob], suggestedName, { type: 'audio/mp4' })
        }
        update({ status: 'uploading', error: null })
        const storagePath = await uploadAdVideoToStorage(q.chosenAd.ad_id, toUpload)
        update({ status: 'transcribing' })
        await transcribeUploadedAd(q.chosenAd.ad_id, storagePath, { timeoutMs: 180_000 })
        update({ status: 'tagging' })
        await tagAd(q.chosenAd.ad_id)
        update({ status: 'done' })
      } catch (e) {
        update({ status: 'error', error: e.message })
      }
    }

    setWorking(false)
    // Don't auto-close in bulk mode — operator wants to see the results
    onSaved?.({ kind: 'bulk_uploaded', count: items.length })
  }

  // Fuzzy filename → ad suggestion. Strips extension, splits on
  // dashes/underscores, searches ads.ad_name via ilike for each token.
  async function suggestAdForFile(file) {
    const name = file.name.replace(/\.[^.]+$/, '')  // strip extension
    // Pull top-5 best matches
    const tokens = name.split(/[\s_\-.]+/).filter(t => t.length > 2)
    if (tokens.length === 0) return null
    // Use the longest token first
    tokens.sort((a, b) => b.length - a.length)
    for (const tok of tokens.slice(0, 3)) {
      const { data } = await supabase.from('ads')
        .select('ad_id, ad_name, campaign_name, thumbnail_url, asset_url, asset_type')
        .ilike('ad_name', `%${tok}%`)
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(1)
      if (data?.[0]) return data[0]
    }
    return null
  }

  // Called when files are dropped/picked. If exactly 1 → single-file mode.
  // If 2+ → bulk mode: build the queue with auto-suggested ads.
  async function handleFilesDropped(files) {
    const list = Array.from(files).filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|webm|m4v)$/i))
    if (list.length === 0) return
    if (list.length === 1) {
      setUploadFile(list[0])
      setUploadQueue([])
      return
    }
    setUploadFile(null)
    setErr(null)
    // Build queue with auto-suggested ads
    const queue = list.map(f => ({ file: f, chosenAd: null, status: 'pending', error: null }))
    setUploadQueue(queue)
    // Fire suggestions in parallel
    list.forEach(async (f, i) => {
      const suggested = await suggestAdForFile(f)
      if (suggested) {
        setUploadQueue(prev => {
          const next = [...prev]
          if (next[i] && !next[i].chosenAd) next[i] = { ...next[i], chosenAd: suggested }
          return next
        })
      }
    })
  }

  function handleSubmit() {
    if (tab === 'existing') return doExistingDraft()
    if (tab === 'paste')    return doPasteTranscript()
    if (tab === 'upload') {
      if (uploadQueue.length > 0) return doUploadQueue()
      return doUploadMp4()
    }
  }

  // ── Render ────────────────────────────────────────────────────────
  const headerTitle = tab === 'existing' ? 'Link a draft to a Meta ad'
    : tab === 'paste' ? 'Paste a transcript'
    : 'Upload a video'

  return (
    <Modal open={open} onClose={working ? () => {} : onClose} size="lg"
      eyebrow="Add or link creative"
      title={headerTitle}
      footer={
        <>
          <div style={{ fontFamily: 'var(--sans)', fontSize: 12.5, color: 'var(--ink-3)',
                        flex: 1, overflow: 'hidden', minWidth: 0,
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {workStage && (
              <StageIndicator stage={workStage} target={chosenAd?.ad_name || chosenAd?.ad_id} />
            )}
            {!workStage && tab === 'existing' && chosenScript && chosenAd && <>Will link <strong>{chosenScript.title}</strong> → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
            {!workStage && tab === 'paste' && chosenAd && pasteText && <>Will paste {pasteText.trim().split(/\s+/).filter(Boolean).length} words → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
            {!workStage && tab === 'upload' && chosenAd && uploadFile && <>Will upload {(uploadFile.size / 1024 / 1024).toFixed(1)}MB → <strong>{chosenAd.ad_name || chosenAd.ad_id}</strong></>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={working}
              style={{ padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      border: '1px solid var(--rule-2)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: working ? 'wait' : 'pointer',
                      opacity: working ? 0.4 : 1 }}>
              Cancel
            </button>
            <button onClick={handleSubmit} disabled={working || !canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile, uploadQueue })}
              style={{ padding: '8px 18px', fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
                      border: '1px solid var(--ink)', background: 'var(--ink)',
                      color: 'var(--paper)', cursor: working ? 'wait' : 'pointer',
                      opacity: !canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile, uploadQueue }) ? 0.4 : 1,
                      display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Check size={13} />
              {working ? 'Working…'
                : tab === 'existing' ? 'Link'
                : (tab === 'upload' && uploadQueue.length > 0) ? `Run all (${uploadQueue.filter(q => q.chosenAd && q.status !== 'done').length})`
                : 'Save & tag'}
            </button>
          </div>
        </>
      }>
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)', background: 'var(--paper)' }}>
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button key={t.key} onClick={() => setTab(t.key)} disabled={working}
                style={{
                  flex: 1, padding: '12px 14px', textAlign: 'left',
                  background: active ? 'var(--paper)' : 'transparent',
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
                        color: '#b53e3e', fontSize: 13, borderRadius: 9 }}>
            <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
          </div>
        )}

        {/* Body — Modal owns scrolling; we just pad. */}
        <div style={{ padding: 24 }}>
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

              <FieldLabel style={{ marginTop: 20 }}>Step 3 · Paste the transcript or drop a script file</FieldLabel>
              <DocDropZone
                onText={(text, meta) => {
                  setPasteText(text)
                  setErr(null)
                }}
                onError={(msg) => setErr(msg)} />
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                rows={10}
                placeholder="Paste the script body here, or drop a .pdf/.docx/.txt/.md file above to extract the text. It'll be saved as the manual transcript and auto-tagged for hook type, mechanism reveal, pain angle, etc."
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--sans)', lineHeight: 1.5,
                        marginTop: 8 }} />
              <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10,
                            color: 'var(--ink-4)', letterSpacing: '0.06em' }}>
                {pasteText.trim().split(/\s+/).filter(Boolean).length} words
              </div>
            </>
          )}

          {/* Tab 3: Upload MP4 */}
          {tab === 'upload' && (
            <>
              {uploadQueue.length === 0 && (
                <>
                  <FieldLabel>Step 1 · Pick or drop one or more MP4s</FieldLabel>
                  <DropZone file={uploadFile} setFile={setUploadFile}
                    onFiles={handleFilesDropped} multiple />

                  {uploadFile && (
                    <>
                      <FieldLabel style={{ marginTop: 20 }}>Step 2 · Pick the Meta ad this video is for</FieldLabel>
                      <AdPicker {...{ adQuery, setAdQuery, ads, searching, chosenAd, setChosenAd }} />

                      {chosenAd && (
                        <div style={{
                          marginTop: 12, padding: '10px 14px', background: 'var(--paper)',
                          border: '1px solid var(--rule)', borderLeft: '3px solid var(--accent)',
                          borderRadius: 9,
                          display: 'flex', alignItems: 'center', gap: 12,
                        }}>
                          <AdThumbnail ad={chosenAd} size="sm" />
                          <div style={{ flex: 1, overflow: 'hidden' }}>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                                          textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                              Attaching <strong style={{ color: 'var(--ink)' }}>{uploadFile.name}</strong> to
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

                      {shouldExtractAudio(uploadFile) && (
                        <div style={extractHintStyle}>
                          <Sparkles size={14} style={{ flexShrink: 0, color: 'var(--accent)' }} />
                          <span>
                            File is {(uploadFile.size / 1024 / 1024).toFixed(1)}MB — over the 20MB threshold.
                            We'll extract the audio track in your browser (~10-30s) before uploading,
                            so Whisper can transcribe it cleanly.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* Bulk mode — queue rendered */}
              {uploadQueue.length > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <FieldLabel style={{ margin: 0 }}>
                      Bulk upload · {uploadQueue.length} files
                    </FieldLabel>
                    <button onClick={() => { setUploadQueue([]); setUploadFile(null) }} disabled={working}
                      style={{ padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                              letterSpacing: '0.1em', textTransform: 'uppercase',
                              border: '1px solid var(--rule)', background: 'transparent',
                              color: 'var(--ink-4)', cursor: working ? 'wait' : 'pointer',
                              borderRadius: 9 }}>
                      Clear queue
                    </button>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {uploadQueue.map((q, i) => (
                      <QueueRow key={i} item={q} index={i}
                        onRemove={() => setUploadQueue(prev => prev.filter((_, j) => j !== i))}
                        onChangeAd={(ad) => setUploadQueue(prev => {
                          const next = [...prev]; next[i] = { ...next[i], chosenAd: ad }; return next
                        })}
                        disabled={working} />
                    ))}
                  </div>
                </>
              )}

              {/* Pipeline explanation — only when nothing dropped yet */}
              {!uploadFile && uploadQueue.length === 0 && (
                <div style={{ marginTop: 16, padding: 14, background: 'var(--paper)',
                              border: '1px solid var(--rule)', borderRadius: 9 }}>
                  <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--ink-3)' }}>
                    What happens when you click Save & tag
                  </div>
                  <ol style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: 'var(--sans)',
                              fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.7 }}>
                    <li><span style={pipelineNumStyle}>1</span> Upload to <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>ad-source-videos</code> (~5-15s per file)</li>
                    <li><span style={pipelineNumStyle}>2</span> Whisper transcribes the audio (~30-120s per file, 25MB limit)</li>
                    <li><span style={pipelineNumStyle}>3</span> Claude classifies attributes (hook, mechanism, pain, etc.)</li>
                    <li><span style={pipelineNumStyle}>4</span> Ad appears in Insights with full tags + thumbnail</li>
                  </ol>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule)',
                                fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12,
                                color: 'var(--ink-4)' }}>
                    Drop multiple files at once for bulk processing. We'll auto-suggest the Meta ad for each filename — you confirm each pairing before clicking Run all.
                  </div>
                </div>
              )}
            </>
          )}
        </div>

    </Modal>
  )
}

function canSubmit({ tab, chosenScript, chosenAd, pasteText, uploadFile, uploadQueue }) {
  if (tab === 'existing') return !!(chosenScript && chosenAd)
  if (tab === 'paste')    return !!(chosenAd && pasteText.trim().length > 50)
  if (tab === 'upload') {
    if (uploadQueue?.length > 0) {
      // Bulk: at least one paired and at least one not already done
      return uploadQueue.some(q => q.chosenAd && q.status !== 'done')
    }
    return !!(chosenAd && uploadFile)
  }
  return false
}

const inputStyle = {
  width: '100%', padding: '10px 12px', fontFamily: 'var(--sans)', fontSize: 13,
  border: '1px solid var(--rule)', background: 'var(--paper)', borderRadius: 9,
  color: 'var(--ink)',
}

const pipelineNumStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, borderRadius: 9, fontFamily: 'var(--mono)',
  fontSize: 10, fontWeight: 700, background: 'var(--ink)', color: 'var(--accent)',
  marginRight: 8, verticalAlign: 'middle',
}

const whisperWarnStyle = {
  marginTop: 10, padding: '8px 12px',
  background: '#fef9e7', border: '1px solid #e0a93e', borderRadius: 9,
  color: '#7a5c12', fontSize: 12, lineHeight: 1.4,
  display: 'flex', alignItems: 'flex-start', gap: 8,
}

const extractHintStyle = {
  marginTop: 10, padding: '8px 12px',
  background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9,
  color: 'var(--ink-3)', fontSize: 12, lineHeight: 1.4,
  display: 'flex', alignItems: 'flex-start', gap: 8,
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
      border: '1px dashed var(--rule)', borderRadius: 9, marginBottom: 16,
    }}>
      {children}
    </div>
  )
}

function Row({ selected, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      textAlign: 'left', padding: '10px 12px',
      background: selected ? 'var(--ink)' : 'var(--paper)',
      color: selected ? 'var(--paper)' : 'var(--ink)',
      border: `1px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
      borderRadius: 9, cursor: 'pointer',
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
  // For the upload pipeline, show progress through the stages.
  // 'extracting' only appears when source file is >20MB.
  const uploadStages = ['extracting', 'uploading', 'transcribing', 'tagging']
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
              borderRadius: 9,
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

function DropZone({ file, setFile, onFiles, multiple = false }) {
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false)
    const fs = e.dataTransfer.files
    if (!fs || fs.length === 0) return
    if (multiple && onFiles) {
      onFiles(fs)
    } else {
      const f = fs[0]
      if (f && (f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|webm|m4v)$/i))) setFile(f)
    }
  }

  function handlePick(e) {
    const fs = e.target.files
    if (!fs || fs.length === 0) return
    if (multiple && onFiles && fs.length > 1) {
      onFiles(fs)
    } else {
      const f = fs[0]
      if (f) setFile(f)
    }
  }

  return (
    <label htmlFor="upload-mp4" style={{
      display: 'block', padding: 24,
      border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule)'}`,
      background: dragOver ? 'var(--paper)' : 'var(--paper)',
      borderRadius: 9, cursor: 'pointer', textAlign: 'center',
      transition: 'all 120ms ease',
    }}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input id="upload-mp4" type="file" accept="video/*" multiple={multiple} style={{ display: 'none' }}
        onChange={handlePick} />
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
            Drop one or more MP4s, or click to pick
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                        letterSpacing: '0.06em' }}>
            up to 500MB · 25MB recommended for transcription
          </div>
        </>
      )}
    </label>
  )
}

/* One row in the bulk-upload queue. Renders filename + size + status pill +
   inline ad-picker (auto-suggested via filename) + remove button. */
function QueueRow({ item, index, onRemove, onChangeAd, disabled }) {
  const [adQuery, setAdQuery] = useState('')
  const [adResults, setAdResults] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!pickerOpen) return
    const q = adQuery.trim()
    const handle = setTimeout(() => {
      let req = supabase.from('ads')
        .select('ad_id, ad_name, campaign_name, thumbnail_url, asset_url, asset_type, last_synced_at')
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(15)
      if (q) req = req.or(`ad_name.ilike.%${q}%,campaign_name.ilike.%${q}%,ad_id.ilike.%${q}%`)
      req.then(({ data }) => setAdResults(data || []))
    }, 200)
    return () => clearTimeout(handle)
  }, [adQuery, pickerOpen])

  const sizeMB = item.file.size / 1024 / 1024
  const willExtract = sizeMB > 20
  const statusBadge = STATUS_STYLES[item.status] || STATUS_STYLES.pending

  return (
    <div style={{
      padding: '12px 14px',
      background: item.status === 'done' ? 'var(--paper)' : 'var(--paper)',
      border: '1px solid var(--rule)',
      borderLeft: `3px solid ${statusBadge.accent}`,
      borderRadius: 9,
      opacity: item.status === 'done' ? 0.7 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', minWidth: 22 }}>
          #{String(index + 1).padStart(2, '0')}
        </span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', fontWeight: 500,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.file.name}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                        letterSpacing: '0.04em', marginTop: 2 }}>
            {sizeMB.toFixed(1)} MB
            {willExtract && (
              <span style={{ marginLeft: 8, padding: '1px 6px', background: 'var(--paper)',
                            color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 9 }}>
                will auto-extract audio
              </span>
            )}
          </div>
        </div>
        <span style={{
          padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 9,
          letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
          background: statusBadge.bg, color: statusBadge.fg,
          border: `1px solid ${statusBadge.accent}`, borderRadius: 9,
        }}>
          {item.status}
        </span>
        {item.status === 'pending' && !disabled && (
          <button onClick={onRemove} title="Remove" style={{
            background: 'transparent', border: 'none', color: 'var(--ink-4)',
            cursor: 'pointer', padding: 2,
          }}><X size={14} /></button>
        )}
      </div>

      {/* Ad pairing */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <ArrowRight size={14} color="var(--ink-4)" />
        {item.chosenAd ? (
          <button onClick={() => setPickerOpen(o => !o)} disabled={disabled}
            style={{
              flex: 1, textAlign: 'left',
              padding: '6px 10px',
              background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9,
              cursor: disabled ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
            <AdThumbnail ad={item.chosenAd} size="sm" />
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.chosenAd.ad_name}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                            letterSpacing: '0.04em',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.chosenAd.campaign_name || '—'}
              </div>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)',
                          letterSpacing: '0.1em' }}>
              CHANGE
            </span>
          </button>
        ) : (
          <button onClick={() => setPickerOpen(true)} disabled={disabled}
            style={{
              flex: 1, padding: '8px 12px',
              background: 'transparent', border: '1px dashed var(--rule)',
              color: 'var(--ink-3)', fontFamily: 'var(--sans)', fontSize: 12,
              cursor: disabled ? 'wait' : 'pointer', borderRadius: 9,
              textAlign: 'left',
            }}>
            Pick Meta ad…
          </button>
        )}
      </div>

      {/* Inline picker */}
      {pickerOpen && (
        <div style={{ marginTop: 8, padding: 8, background: 'var(--paper)',
                      border: '1px solid var(--rule)', borderRadius: 9 }}>
          <input type="text" value={adQuery} onChange={e => setAdQuery(e.target.value)}
            placeholder="Search ads…" autoFocus
            style={{ width: '100%', padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: 12,
                    border: '1px solid var(--rule)', background: 'var(--paper)', borderRadius: 9,
                    marginBottom: 8 }} />
          <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 3 }}>
            {adResults.map(a => (
              <button key={a.ad_id}
                onClick={() => { onChangeAd(a); setPickerOpen(false); setAdQuery('') }}
                style={{
                  textAlign: 'left', padding: '6px 8px',
                  background: 'var(--paper)', border: '1px solid var(--rule)',
                  cursor: 'pointer', borderRadius: 9,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                <AdThumbnail ad={a} size="sm" />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 500,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.ad_name}
                  </div>
                </div>
              </button>
            ))}
            {adResults.length === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--ink-4)', fontSize: 11,
                            fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
                No matches
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {item.error && (
        <div style={{ marginTop: 8, padding: '6px 10px', background: '#fef2f2',
                      border: '1px solid #fca5a5', color: '#b53e3e', fontSize: 11,
                      borderRadius: 9 }}>
          {item.error}
        </div>
      )}
    </div>
  )
}

/* Compact drop zone for script docs (pdf/docx/txt/md). On successful
   extraction, calls onText with the cleaned plain-text body so the
   parent Paste-transcript textarea can populate. */
function DocDropZone({ onText, onError }) {
  const [dragOver, setDragOver] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [stage, setStage] = useState(null)
  const [lastMeta, setLastMeta] = useState(null)

  async function handleFile(file) {
    if (!file) return
    if (!isSupportedDocFile(file)) {
      onError?.(`Unsupported file. Try ${getSupportedExtensionsLabel()}.`)
      return
    }
    setExtracting(true); setStage(null)
    try {
      const { text, sourceFormat, wordCount } = await extractTextFromFile(file, {
        onProgress: s => setStage(s),
      })
      if (!text.trim()) {
        onError?.('No text could be extracted from this file. If the PDF is scanned (image-only), it needs OCR first.')
        return
      }
      onText?.(text, { sourceFormat, wordCount, fileName: file.name })
      setLastMeta({ fileName: file.name, sourceFormat, wordCount })
    } catch (e) {
      onError?.(e.message)
    } finally {
      setExtracting(false); setStage(null)
    }
  }

  function onDrop(e) {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }
  function onPick(e) {
    const f = e.target.files?.[0]
    if (f) handleFile(f)
  }

  return (
    <label htmlFor="upload-doc"
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{
        display: 'block', padding: '14px 16px',
        border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule)'}`,
        background: dragOver ? 'var(--paper)' : 'var(--paper)',
        borderRadius: 9, cursor: extracting ? 'wait' : 'pointer',
        transition: 'all 120ms ease',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
      <input id="upload-doc" type="file" accept=".pdf,.docx,.txt,.md,.markdown" style={{ display: 'none' }}
        onChange={onPick} disabled={extracting} />
      <FileText size={18} color={dragOver ? 'var(--ink)' : 'var(--ink-4)'} />
      <div style={{ flex: 1 }}>
        {extracting ? (
          <>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                          letterSpacing: '0.06em' }}>
              <Sparkles size={11} className="pulse" style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle', color: 'var(--accent)' }} />
              {stage || 'Extracting…'}
            </div>
          </>
        ) : lastMeta ? (
          <>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)' }}>
              <strong>{lastMeta.fileName}</strong> · {lastMeta.wordCount} words extracted
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                          letterSpacing: '0.06em', marginTop: 2 }}>
              Drop another file to replace
            </div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)' }}>
              Drop a script file or click to pick
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                          letterSpacing: '0.06em', marginTop: 2 }}>
              {getSupportedExtensionsLabel()} · text extracted in browser
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } } .pulse { animation: pulse 1.2s ease-in-out infinite; }`}</style>
    </label>
  )
}

const STATUS_STYLES = {
  pending:      { bg: 'white',     fg: 'var(--ink-4)', accent: 'var(--rule)' },
  extracting:   { bg: 'var(--ink)', fg: 'var(--accent)', accent: 'var(--ink)' },
  uploading:    { bg: 'var(--ink)', fg: 'var(--accent)', accent: 'var(--ink)' },
  transcribing: { bg: 'var(--ink)', fg: 'var(--accent)', accent: 'var(--ink)' },
  tagging:      { bg: 'var(--ink)', fg: 'var(--accent)', accent: 'var(--ink)' },
  done:         { bg: 'var(--accent)', fg: 'var(--ink)', accent: 'var(--accent)' },
  error:        { bg: '#fef2f2', fg: '#b53e3e', accent: '#fca5a5' },
}
