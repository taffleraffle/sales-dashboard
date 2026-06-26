import { useEffect, useState } from 'react'
import { Upload, FileText, Sparkles, Check, AlertCircle, X } from 'lucide-react'
import Modal from '../editorial/Modal'
import { Eyebrow, ValueChip, displayValue } from '../editorial/atoms'
import { parseScriptsFromDoc, bulkSaveScriptsToBatch } from '../../services/testBatches'
import { extractTextFromFile, isSupportedDocFile, getSupportedExtensionsLabel } from '../../services/docExtract'

/*
  Upload a doc → Claude parses every script in it → operator reviews →
  save all into the current test batch.

  Three steps:
    1. INPUT — drop file or paste text. We extract plain text client-side
       via docExtract (handles .docx/.pdf/.txt/.md/etc).
    2. PARSE — POST text to creative-parse-doc Edge Function. Returns
       N scripts with title + body + target_attributes.
    3. REVIEW — operator can edit titles + delete junk before saving.
       "Save N scripts" inserts into generated_scripts with test_batch_id
       set to this batch.
*/

const STEP = { INPUT: 'input', PARSING: 'parsing', REVIEW: 'review', SAVING: 'saving' }

export default function UploadScriptsModal({ open, onClose, batch, onSaved }) {
  const [step, setStep] = useState(STEP.INPUT)
  const [text, setText] = useState('')
  const [filename, setFilename] = useState(null)
  const [parsed, setParsed] = useState([])  // [{ title, body, target_attributes, reasoning, _checked }]
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) {
      // Reset on close so the next open starts clean
      setStep(STEP.INPUT); setText(''); setFilename(null); setParsed([]); setErr(null)
    }
  }, [open])

  async function handleFile(file) {
    if (!file) return
    if (!isSupportedDocFile(file)) {
      setErr(`Unsupported file type. Supported: ${getSupportedExtensionsLabel()}`)
      return
    }
    setErr(null); setFilename(file.name)
    try {
      // extractTextFromFile returns { text, sourceFormat, wordCount } — we
      // only want the string. The render below calls .trim() and .length
      // on whatever's in `text`, so a non-string crashes the page.
      const result = await extractTextFromFile(file)
      const extracted = typeof result === 'string' ? result : (result?.text || '')
      if (!extracted.trim()) {
        setErr('No text could be extracted from that file. Try pasting the content instead.')
        return
      }
      setText(extracted)
    } catch (e) {
      setErr(`Could not read file: ${e.message}`)
    }
  }

  async function handleParse() {
    if (!text.trim()) { setErr('Paste some text or drop a file first'); return }
    setErr(null); setStep(STEP.PARSING)
    try {
      const scripts = await parseScriptsFromDoc({ text, offer_slug: batch?.offer_slug || null })
      if (!scripts.length) { setErr('No scripts found in the document'); setStep(STEP.INPUT); return }
      setParsed(scripts.map(s => ({ ...s, _checked: true })))
      setStep(STEP.REVIEW)
    } catch (e) {
      setErr(e.message)
      setStep(STEP.INPUT)
    }
  }

  async function handleSave() {
    const toSave = parsed.filter(s => s._checked).map(s => ({
      title: s.title, body: s.body, target_attributes: s.target_attributes, reasoning: s.reasoning,
    }))
    if (!toSave.length) { setErr('Tick at least one script'); return }
    setErr(null); setStep(STEP.SAVING)
    try {
      await bulkSaveScriptsToBatch({
        batchId: batch.id,
        offer_slug: batch?.offer_slug || null,
        scripts: toSave,
      })
      onSaved?.()
      onClose()
    } catch (e) {
      setErr(e.message); setStep(STEP.REVIEW)
    }
  }

  function updateScript(i, patch) {
    setParsed(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }

  const working = step === STEP.PARSING || step === STEP.SAVING
  const checkedCount = parsed.filter(s => s._checked).length

  return (
    <Modal open={open} onClose={working ? () => {} : onClose} size="xl"
      eyebrow={`Add scripts to “${batch?.name || ''}”`}
      title={step === STEP.REVIEW
        ? `Review ${parsed.length} parsed script${parsed.length === 1 ? '' : 's'}`
        : 'Upload a doc'}
      subtitle={step === STEP.INPUT
        ? 'Paste a doc with one or many scripts. Claude will split it, tag each, and you review before saving.'
        : step === STEP.REVIEW
        ? "Tick the ones you want to keep. Edit titles if needed. Body text and tags are preserved as-extracted — fix tags on the edit drawer later."
        : null}
      footer={
        <>
          {err && (
            <span style={{
              flex: 1, fontFamily: 'var(--sans)', fontSize: 12.5, color: '#b53e3e',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <AlertCircle size={14} /> {err}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={working} style={btnGhost}>Cancel</button>
            {step === STEP.INPUT && (
              <button onClick={handleParse} disabled={!text.trim() || working} style={btnPrimary}>
                <Sparkles size={13} /> Parse {text.split(/\s+/).filter(Boolean).length} words
              </button>
            )}
            {step === STEP.REVIEW && (
              <button onClick={handleSave} disabled={!checkedCount || working} style={btnPrimary}>
                <Check size={13} /> Save {checkedCount} script{checkedCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </>
      }>
      {step === STEP.INPUT && (
        <div style={{ padding: 24 }}>
          {/* Drop zone */}
          <label style={{
            display: 'block', padding: 24, marginBottom: 16,
            border: '2px dashed var(--rule-2)', background: 'var(--paper-2)',
            textAlign: 'center', cursor: 'pointer',
            fontFamily: 'var(--sans)', color: 'var(--ink-3)',
          }}
            onDragOver={e => { e.preventDefault(); e.currentTarget.style.background = 'var(--accent-soft, #fdf6c5)' }}
            onDragLeave={e => { e.currentTarget.style.background = 'var(--paper-2)' }}
            onDrop={e => {
              e.preventDefault()
              e.currentTarget.style.background = 'var(--paper-2)'
              const f = e.dataTransfer?.files?.[0]
              if (f) handleFile(f)
            }}>
            <Upload size={22} style={{ marginBottom: 8, color: 'var(--ink-3)' }} />
            <div style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 4 }}>
              {filename
                ? <span><FileText size={12} style={{ display: 'inline', marginRight: 4 }} />{filename}</span>
                : 'Drop a file or click to browse'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)', letterSpacing: '0.04em' }}>
              {getSupportedExtensionsLabel()}
            </div>
            <input type="file" accept=".doc,.docx,.pdf,.txt,.md,.rtf"
              onChange={e => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }} />
          </label>

          <Eyebrow style={{ marginBottom: 6 }}>Or paste text</Eyebrow>
          <textarea value={text} onChange={e => { setText(e.target.value); setFilename(null) }}
            placeholder="Script 1: Eric here, from Eric's Carpet Cleaning…&#10;&#10;Script 2: Most restoration owners are losing $40k/month…"
            rows={12}
            style={{
              width: '100%', padding: '12px 14px', fontFamily: 'var(--sans)', fontSize: 14,
              border: '1px solid var(--rule)', background: 'var(--paper)',
              color: 'var(--ink)', outline: 'none', resize: 'vertical',
              lineHeight: 1.55,
            }} />
          <div style={{
            marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            {text ? `${text.length.toLocaleString()} chars · ${text.split(/\s+/).filter(Boolean).length} words` : '—'}
          </div>
        </div>
      )}

      {step === STEP.PARSING && (
        <div style={{
          padding: 80, textAlign: 'center', color: 'var(--ink-3)',
          fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 16,
        }}>
          Parsing scripts…
          <div style={{ marginTop: 8, fontFamily: 'var(--sans)', fontStyle: 'normal',
                        fontSize: 12, color: 'var(--ink-4)' }}>
            Claude is reading the doc and tagging each script with the attribute vocab.
          </div>
        </div>
      )}

      {step === STEP.REVIEW && (
        <div>
          {parsed.map((s, i) => (
            <ParsedScriptRow key={i} script={s}
              onToggle={() => updateScript(i, { _checked: !s._checked })}
              onTitleChange={t => updateScript(i, { title: t })} />
          ))}
          {parsed.length === 0 && (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-4)',
                          fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
              No scripts parsed.
            </div>
          )}
        </div>
      )}

      {step === STEP.SAVING && (
        <div style={{
          padding: 80, textAlign: 'center', color: 'var(--ink-3)',
          fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 16,
        }}>
          Saving {checkedCount} scripts to “{batch?.name}”…
        </div>
      )}
    </Modal>
  )
}

function ParsedScriptRow({ script, onToggle, onTitleChange }) {
  const t = script.target_attributes || {}
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '24px 1fr',
      gap: 14, padding: '14px 24px',
      borderBottom: '1px solid var(--rule)',
      alignItems: 'flex-start',
      opacity: script._checked ? 1 : 0.45,
      transition: 'opacity 0.12s',
    }}>
      <input type="checkbox" checked={script._checked} onChange={onToggle}
        style={{ marginTop: 6, accentColor: 'var(--ink)', width: 16, height: 16 }} />
      <div style={{ minWidth: 0 }}>
        <input type="text" value={script.title || ''}
          onChange={e => onTitleChange(e.target.value)}
          placeholder="(no title)"
          style={{
            width: '100%', padding: '6px 8px', marginBottom: 6,
            fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500, color: 'var(--ink)',
            border: '1px solid transparent', background: 'transparent', outline: 'none',
          }}
          onFocus={e => { e.currentTarget.style.border = '1px solid var(--rule-2)'; e.currentTarget.style.background = 'white' }}
          onBlur={e => { e.currentTarget.style.border = '1px solid transparent'; e.currentTarget.style.background = 'transparent' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {t.hook_type && <ValueChip attr="hook_type" value={t.hook_type} size="xs" />}
          {t.message_frame && <ValueChip attr="message_frame" value={t.message_frame} size="xs" />}
          {t.mechanism_reveal && <ValueChip attr="mechanism_reveal" value={t.mechanism_reveal} size="xs" />}
          {t.pain_angle && <ValueChip attr="pain_angle" value={t.pain_angle} size="xs" />}
          {t.awareness_level && <ValueChip attr="awareness_level" value={t.awareness_level} size="xs" />}
          {!t.hook_type && !t.message_frame && !t.pain_angle && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-5)',
                          letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              No tags — Claude couldn't determine
            </span>
          )}
        </div>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-2)',
          lineHeight: 1.55, whiteSpace: 'pre-wrap',
          maxHeight: 180, overflowY: 'auto',
          padding: '8px 10px', background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
        }}>
          {script.body}
        </div>
        {script.reasoning && (
          <div style={{
            marginTop: 6, fontFamily: 'var(--sans)', fontSize: 11.5,
            fontStyle: 'italic', color: 'var(--ink-4)', lineHeight: 1.5,
          }}>
            {script.reasoning}
          </div>
        )}
      </div>
    </div>
  )
}

const btnGhost = {
  padding: '8px 14px',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  background: 'transparent', color: 'var(--ink-3)',
  border: '1px solid var(--rule-2)', cursor: 'pointer',
}
const btnPrimary = {
  padding: '8px 16px',
  fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 600,
  background: 'var(--ink)', color: 'var(--paper)',
  border: '1px solid var(--ink)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
