import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader, AlertCircle, Send, ImagePlus, X, Wrench, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ICON } from '../utils/constants'
import { URGENCY_META, STATUS_META } from '../utils/bugReports'

const MAX_SCREENSHOTS = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const PAGE_SUGGESTIONS = [
  'Overview', 'Closers', 'Forecast', 'Setters', 'Marketing', 'Ads',
  'Library', 'Shorts', 'Ad Library', 'EOD', 'Contracts', 'Downsells',
  'Commissions', 'Settings', 'Login',
]

function defaultBrowserInfo() {
  const ua = navigator.userAgent
  const browser =
    ua.includes('Edg/') ? 'Edge'
    : ua.includes('Chrome/') ? 'Chrome'
    : ua.includes('Safari/') ? 'Safari'
    : ua.includes('Firefox/') ? 'Firefox'
    : 'Unknown browser'
  const os =
    ua.includes('Mac') ? 'Mac'
    : ua.includes('Windows') ? 'Windows'
    : ua.includes('iPhone') || ua.includes('iPad') ? 'iOS'
    : ua.includes('Android') ? 'Android'
    : 'Unknown OS'
  return `${browser} on ${os} · ${window.innerWidth}×${window.innerHeight}`
}

export default function Troubleshoot() {
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [title, setTitle]           = useState('')
  const [urgency, setUrgency]       = useState('medium')
  const [pageLocation, setPageLocation] = useState('')
  const [whatHappened, setWhatHappened] = useState('')
  const [expected, setExpected]     = useState('')
  const [steps, setSteps]           = useState('')
  const [repro, setRepro]           = useState('')
  const [browserInfo, setBrowserInfo] = useState(defaultBrowserInfo)
  const [notes, setNotes]           = useState('')
  const [images, setImages]         = useState([]) // { file, previewUrl }
  const [dragging, setDragging]     = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress]     = useState('')
  const [error, setError]           = useState(null)

  const [reports, setReports]       = useState(null)
  const fileInputRef = useRef(null)

  const canSubmit = title.trim() && !submitting

  useEffect(() => {
    let cancelled = false
    supabase
      .from('bug_reports')
      .select('id, created_at, requester_name, title, urgency, status')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => { if (!cancelled) setReports(data || []) })
    return () => { cancelled = true }
  }, [])

  // Revoke object URLs when previews are removed / page unmounts
  useEffect(() => () => { images.forEach(i => URL.revokeObjectURL(i.previewUrl)) }, [images])

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList).filter(f => f.type.startsWith('image/'))
    if (!incoming.length) return
    setError(null)
    setImages(prev => {
      const room = MAX_SCREENSHOTS - prev.length
      const accepted = []
      for (const f of incoming.slice(0, room)) {
        if (f.size > MAX_IMAGE_BYTES) {
          setError(`${f.name} is over 10 MB — screenshots should be well under that.`)
          continue
        }
        accepted.push({ file: f, previewUrl: URL.createObjectURL(f) })
      }
      if (incoming.length > room) setError(`Max ${MAX_SCREENSHOTS} screenshots per request.`)
      return [...prev, ...accepted]
    })
  }, [])

  // Pasting a screenshot straight from the clipboard also works
  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || [])
      if (files.length) addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  function removeImage(idx) {
    setImages(prev => {
      URL.revokeObjectURL(prev[idx].previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  async function submit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setError(null)

    try {
      const reportId = crypto.randomUUID()

      // 1. Upload screenshots first so paths exist before the row insert
      const paths = []
      for (let i = 0; i < images.length; i++) {
        setProgress(`Uploading screenshot ${i + 1} of ${images.length}…`)
        const f = images[i].file
        const safeName = f.name.replace(/[^a-z0-9.\-_]/gi, '_').slice(0, 100)
        const path = `${reportId}/${String(i + 1).padStart(2, '0')}_${safeName}`
        const { error: upErr } = await supabase.storage
          .from('bug-screenshots')
          .upload(path, f, { contentType: f.type, upsert: false })
        if (upErr) throw new Error(`Screenshot upload failed: ${upErr.message}`)
        paths.push(path)
      }

      // 2. Insert the report
      setProgress('Saving request…')
      const { error: insErr } = await supabase.from('bug_reports').insert({
        id: reportId,
        requester_auth_id: (await supabase.auth.getUser()).data.user?.id,
        requester_name: profile?.name || 'Unknown',
        title: title.trim(),
        urgency,
        page_location: pageLocation.trim() || null,
        what_happened: whatHappened.trim() || null,
        expected_behavior: expected.trim() || null,
        steps_to_reproduce: steps.trim() || null,
        reproducibility: repro || null,
        browser_device: browserInfo.trim() || null,
        extra_notes: notes.trim() || null,
        screenshot_paths: paths,
      })
      if (insErr) {
        if (paths.length) await supabase.storage.from('bug-screenshots').remove(paths).catch(() => {})
        throw new Error(`Save failed: ${insErr.message}`)
      }

      // 3. Ping #optimus-qa. Soft-fail — the report exists either way and
      //    the notify can be re-fired from the detail page.
      setProgress('Pinging Optimus…')
      let slackFailed = false
      try {
        const { data, error: fnErr } = await supabase.functions.invoke('notify-bug-report', {
          body: { report_id: reportId },
        })
        if (fnErr) throw fnErr
        if (data?.error) throw new Error(data.error)
      } catch (err) {
        console.warn('notify-bug-report failed:', err)
        slackFailed = true
      }

      navigate(`/sales/troubleshoot/${reportId}`, { state: { justSubmitted: true, slackFailed } })
    } catch (err) {
      setError(err.message || String(err))
      setProgress('')
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-[860px] mx-auto">
      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · Troubleshoot</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Request a <em style={{ fontStyle: 'italic' }}>fix</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 620 }}>
          Something broken or behaving weird? Only the title is required, but every extra detail
          (and especially screenshots) makes the fix faster. Submitting pings the QA channel straight away.
        </p>
      </div>

      <form onSubmit={submit} className="tile tile-feedback p-6 space-y-5">
        <Field label="What's the problem, in one line?" required>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            required
            className="editorial-input"
            placeholder="e.g. Commission page shows $0 for every closer since Monday"
          />
        </Field>

        <div>
          <FieldLabel label="How urgent is it?" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
            {Object.entries(URGENCY_META).map(([key, meta]) => (
              <button
                key={key}
                type="button"
                onClick={() => setUrgency(key)}
                className="text-left p-2.5"
                style={{
                  background: urgency === key ? 'var(--accent-soft)' : 'var(--paper)',
                  border: urgency === key ? '2px solid var(--accent)' : '1px solid var(--rule)',
                  borderRadius: 9, cursor: 'pointer', transition: 'background 160ms, border-color 160ms',
                }}
              >
                <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink)' }}>{meta.label}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 1 }}>{meta.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Where in the dashboard? (optional)">
            <input
              type="text"
              value={pageLocation}
              onChange={e => setPageLocation(e.target.value)}
              className="editorial-input"
              list="troubleshoot-pages"
              placeholder="e.g. EOD page, Contracts detail…"
            />
            <datalist id="troubleshoot-pages">
              {PAGE_SUGGESTIONS.map(p => <option key={p} value={p} />)}
            </datalist>
          </Field>
          <Field label="Does it happen every time? (optional)">
            <select value={repro} onChange={e => setRepro(e.target.value)} className="editorial-input">
              <option value="">Not sure</option>
              <option value="every_time">Yes, every time</option>
              <option value="sometimes">Sometimes</option>
              <option value="once">Happened once</option>
            </select>
          </Field>
        </div>

        <Field label="What happened? (optional)">
          <textarea
            value={whatHappened} onChange={e => setWhatHappened(e.target.value)}
            rows={3} className="editorial-input" style={{ resize: 'vertical' }}
            placeholder="Describe what you saw — error messages, wrong numbers, blank screens…"
          />
        </Field>

        <Field label="What did you expect to happen? (optional)">
          <textarea
            value={expected} onChange={e => setExpected(e.target.value)}
            rows={2} className="editorial-input" style={{ resize: 'vertical' }}
            placeholder="e.g. The table should show last week's EOD numbers"
          />
        </Field>

        <Field label="Steps to make it happen again (optional)">
          <textarea
            value={steps} onChange={e => setSteps(e.target.value)}
            rows={3} className="editorial-input" style={{ resize: 'vertical' }}
            placeholder={'1. Open Contracts\n2. Click any pending contract\n3. Scroll to the bottom'}
          />
        </Field>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Browser & device (auto-filled, edit if wrong)">
            <input
              type="text" value={browserInfo} onChange={e => setBrowserInfo(e.target.value)}
              className="editorial-input"
            />
          </Field>
          <Field label="Anything else? (optional)">
            <input
              type="text" value={notes} onChange={e => setNotes(e.target.value)}
              className="editorial-input" placeholder="Any other context"
            />
          </Field>
        </div>

        {/* Screenshots — drag & drop, click, or paste */}
        <div>
          <FieldLabel label={`Screenshots (optional · up to ${MAX_SCREENSHOTS})`} />
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 p-4 cursor-pointer"
            style={{
              background: dragging ? 'var(--accent-soft)' : 'var(--paper)',
              border: dragging ? '2px dashed var(--accent)' : '1px dashed var(--rule)',
              borderRadius: 9, transition: 'background 160ms, border-color 160ms',
            }}
          >
            {images.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-5 pointer-events-none">
                <ImagePlus size={20} style={{ color: 'var(--ink-3)', marginBottom: 8 }} />
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Drag screenshots here, click to browse, or just paste</span>
                <span style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>PNG / JPG / GIF · 10 MB max each</span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                {images.map((img, i) => (
                  <div key={img.previewUrl} className="relative" onClick={e => e.stopPropagation()}>
                    <img
                      src={img.previewUrl} alt={img.file.name}
                      style={{ height: 90, width: 120, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--rule)' }}
                    />
                    <button
                      type="button" onClick={() => removeImage(i)} aria-label="Remove screenshot"
                      className="absolute -top-2 -right-2 flex items-center justify-center"
                      style={{ width: 20, height: 20, borderRadius: 999, background: 'var(--ink)', color: '#fff', border: 'none', cursor: 'pointer' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-center" style={{ height: 90, width: 120, border: '1px dashed var(--rule)', borderRadius: 6 }}>
                  <ImagePlus size={16} style={{ color: 'var(--ink-3)' }} />
                </div>
              </div>
            )}
            <input
              ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
              onChange={e => { addFiles(e.target.files); e.target.value = '' }}
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)', margin: 0 }}>{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--rule)' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            {progress || 'Optimus posts this to #optimus-qa the moment you submit.'}
          </span>
          <button type="submit" disabled={!canSubmit} className="editorial-btn-primary">
            {submitting ? <><Loader size={ICON.sm} className="animate-spin" /> {progress || 'Working…'}</> : <><Send size={ICON.sm} /> Submit request</>}
          </button>
        </div>
      </form>

      {/* ── Recent requests ── */}
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-3">
          <Wrench size={ICON.sm} style={{ color: 'var(--ink-3)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            Recent requests
          </span>
        </div>
        {reports === null ? (
          <div className="tile tile-feedback p-6 flex items-center justify-center">
            <Loader size={ICON.md} className="animate-spin" style={{ color: 'var(--ink-3)' }} />
          </div>
        ) : reports.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>Nothing reported yet.</p>
        ) : (
          <div className="tile tile-feedback divide-y" style={{ borderColor: 'var(--rule)' }}>
            {reports.map(r => (
              <Link
                key={r.id} to={`/sales/troubleshoot/${r.id}`}
                className="flex items-center gap-3 p-3 hover:bg-black/[0.03]"
                style={{ borderColor: 'var(--rule)' }}
              >
                <StatusChip status={r.status} />
                <div className="min-w-0 flex-1">
                  <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: 0, fontFamily: 'var(--mono)' }}>
                    {r.requester_name} · {new Date(r.created_at).toLocaleDateString()} · {URGENCY_META[r.urgency]?.label || r.urgency}
                  </p>
                </div>
                <ChevronRight size={ICON.sm} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FieldLabel({ label, required }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
      {label}{required && <span style={{ color: 'var(--down)', marginLeft: 4 }}>*</span>}
    </span>
  )
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <FieldLabel label={label} required={required} />
      <div className="mt-1">{children}</div>
    </label>
  )
}

export function StatusChip({ status }) {
  const meta = STATUS_META[status] || STATUS_META.open
  return (
    <span
      className="flex-shrink-0 px-2 py-0.5"
      style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: meta.fg, background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 999,
      }}
    >
      {meta.label}
    </span>
  )
}
