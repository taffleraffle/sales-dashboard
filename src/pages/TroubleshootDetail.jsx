import { useState, useEffect } from 'react'
import { Link, useParams, useLocation } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, Download, Bell, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { ICON } from '../utils/constants'
import { URGENCY_META, STATUS_META, REPRO_LABELS, reportToMarkdown } from '../utils/bugReports'
import { StatusChip } from './Troubleshoot'

export default function TroubleshootDetail() {
  const { id } = useParams()
  const location = useLocation()

  const [report, setReport]       = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [shots, setShots]         = useState([]) // { path, url }
  const [zipping, setZipping]     = useState(false)
  const [renotifying, setRenotifying] = useState(false)
  const [notice, setNotice]       = useState(() => {
    if (!location.state?.justSubmitted) return null
    return location.state.slackFailed
      ? { tone: 'warn', text: 'Request saved — but the Slack ping to #optimus-qa failed. Use "Re-send Slack ping" below or flag it to Will.' }
      : { tone: 'ok', text: 'Request submitted. Optimus has posted it to #optimus-qa.' }
  })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error } = await supabase.from('bug_reports').select('*').eq('id', id).single()
      if (cancelled) return
      if (error || !data) { setLoadError(error?.message || 'Report not found'); return }
      setReport(data)
      if (data.screenshot_paths?.length) {
        const { data: signed } = await supabase.storage
          .from('bug-screenshots')
          .createSignedUrls(data.screenshot_paths, 3600)
        if (!cancelled && signed) {
          setShots(signed.filter(s => s.signedUrl).map((s, i) => ({ path: data.screenshot_paths[i], url: s.signedUrl })))
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  async function setStatus(status) {
    const prev = report.status
    setReport(r => ({ ...r, status }))
    const { error } = await supabase.from('bug_reports').update({ status }).eq('id', id)
    if (error) {
      setReport(r => ({ ...r, status: prev }))
      setNotice({ tone: 'warn', text: `Couldn't update status: ${error.message}` })
    }
  }

  async function downloadZip() {
    setZipping(true)
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      zip.file('report.md', reportToMarkdown(report))
      zip.file('report.json', JSON.stringify(report, null, 2))
      for (const shot of shots) {
        const res = await fetch(shot.url)
        if (res.ok) zip.file(`screenshots/${shot.path.split('/').pop()}`, await res.blob())
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `bug-report-${report.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) {
      setNotice({ tone: 'warn', text: `Zip failed: ${err.message}` })
    } finally {
      setZipping(false)
    }
  }

  async function resendSlack() {
    setRenotifying(true)
    try {
      const { data, error } = await supabase.functions.invoke('notify-bug-report', {
        body: { report_id: id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setNotice({ tone: 'ok', text: 'Posted to #optimus-qa.' })
    } catch (err) {
      setNotice({ tone: 'warn', text: `Slack ping failed: ${err.message}` })
    } finally {
      setRenotifying(false)
    }
  }

  if (loadError) return (
    <div className="max-w-[760px] mx-auto">
      <Link to="/sales/troubleshoot" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All requests
      </Link>
      <div className="flex items-start gap-2">
        <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 2 }} />
        <p style={{ fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>{loadError}</p>
      </div>
    </div>
  )

  if (!report) return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <Loader size={ICON.lg} className="animate-spin" style={{ color: 'var(--ink-3)' }} />
    </div>
  )

  return (
    <div className="max-w-[760px] mx-auto">
      <Link to="/sales/troubleshoot" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All requests
      </Link>

      {notice && (
        <div
          className="flex items-start gap-2 p-3 mb-4"
          style={{
            background: notice.tone === 'ok' ? 'rgba(40,140,80,0.08)' : 'rgba(200,60,50,0.08)',
            border: `1px solid ${notice.tone === 'ok' ? 'rgba(40,140,80,0.3)' : 'rgba(200,60,50,0.3)'}`,
            borderRadius: 9,
          }}
        >
          {notice.tone === 'ok'
            ? <Check size={14} style={{ color: 'var(--up)', marginTop: 1 }} />
            : <AlertCircle size={14} style={{ color: 'var(--down)', marginTop: 1 }} />}
          <p style={{ fontSize: 12.5, color: 'var(--ink)', margin: 0 }}>{notice.text}</p>
        </div>
      )}

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="eyebrow eyebrow-accent">OPT Digital · Troubleshoot · Request</span>
          <StatusChip status={report.status} />
        </div>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', margin: '8px 0 0' }}>
          {report.title}
        </h1>
        <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6, fontFamily: 'var(--mono)' }}>
          {report.requester_name} · {new Date(report.created_at).toLocaleString()} · {URGENCY_META[report.urgency]?.label || report.urgency} urgency
        </p>
      </div>

      <div className="tile tile-feedback p-6 space-y-5">
        <MetaRow label="Where in the dashboard" value={report.page_location} />
        <MetaRow label="Reproducible" value={REPRO_LABELS[report.reproducibility]} />
        <MetaRow label="Browser & device" value={report.browser_device} />
        <TextBlock label="What happened" value={report.what_happened} />
        <TextBlock label="Expected behavior" value={report.expected_behavior} />
        <TextBlock label="Steps to reproduce" value={report.steps_to_reproduce} />
        <TextBlock label="Extra notes" value={report.extra_notes} />

        {shots.length > 0 && (
          <div>
            <SectionLabel label={`Screenshots (${shots.length})`} />
            <div className="flex flex-wrap gap-3 mt-2">
              {shots.map(s => (
                <a key={s.path} href={s.url} target="_blank" rel="noreferrer">
                  <img
                    src={s.url} alt={s.path.split('/').pop()}
                    style={{ maxHeight: 180, maxWidth: 280, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--rule)' }}
                  />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="tile tile-feedback p-4 mt-4 flex items-center justify-between flex-wrap gap-3">
        {/* RLS gates status writes — buttons render for all, Supabase rejects unauthorized updates */}
        <div className="flex items-center gap-2 flex-wrap">
          {Object.keys(STATUS_META).map(s => (
            <button
              key={s} type="button" onClick={() => setStatus(s)}
              className="px-2.5 py-1"
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: report.status === s ? 'var(--ink)' : 'var(--ink-3)',
                background: report.status === s ? 'var(--accent-soft)' : 'transparent',
                border: report.status === s ? '1px solid var(--accent)' : '1px solid var(--rule)',
                borderRadius: 999, cursor: 'pointer',
              }}
            >
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={resendSlack} disabled={renotifying} className="editorial-btn-ghost">
            {renotifying ? <Loader size={ICON.sm} className="animate-spin" /> : <Bell size={ICON.sm} />} Re-send Slack ping
          </button>
          <button type="button" onClick={downloadZip} disabled={zipping} className="editorial-btn-primary">
            {zipping ? <Loader size={ICON.sm} className="animate-spin" /> : <Download size={ICON.sm} />} Download zip for Claude Code
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ label }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
      {label}
    </span>
  )
}

function MetaRow({ label, value }) {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-3">
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', minWidth: 180 }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: 'var(--ink)' }}>{value}</span>
    </div>
  )
}

function TextBlock({ label, value }) {
  if (!value) return null
  return (
    <div>
      <SectionLabel label={label} />
      <p style={{ fontSize: 13, color: 'var(--ink)', margin: '6px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
        {value}
      </p>
    </div>
  )
}
