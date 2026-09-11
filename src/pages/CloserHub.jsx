import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Eye, EyeOff, Copy, Check, Plus, Settings2, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import Modal from '../components/editorial/Modal'
import { ICON } from '../utils/constants'
import { CLOSER_TOOLS } from '../data/closerTools'
import { callCloserHub, loadCloserHubSettings, saveCloserHubSettings } from '../lib/closerHub'

/* Closer Hub (Ben, 12 Sep 2026): the apps a closer opens, the shared Semrush
   login, and one "New deal" pop-up that drafts the contract and makes the
   client's Slack channel. Closers and admins only (CloserRoute).
   Redesigned the same day: "more like a pop-up ... app icons and text next to
   them ... I don't need Calendly, Google links." */

const SETTING_FIELDS = [
  ['opt_rep_name', 'OPT signer name', 'Who signs for Opt Digital on every agreement.'],
  ['opt_rep_email', 'OPT signer email', 'Must be a PandaDoc member.'],
  ['fee_retainer', 'Retainer fee (monthly)', 'Digits only.'],
  ['fee_trial', 'Trial fee', 'Digits only.'],
  ['template_retainer', 'PandaDoc template: retainer', 'The Local SEO client agreement template id.'],
  ['template_trial', 'PandaDoc template: trial', 'Blank until a trial template exists in PandaDoc.'],
  ['role_opt', 'Template role: OPT', 'Usually "Role 1".'],
  ['role_client', 'Template role: client', '"Client" on the retainer template.'],
  ['send_subject', 'Email subject when sending', ''],
  ['send_message', 'Email message when sending', ''],
]

function Field({ label, hint, children, span }) {
  return (
    <label className={`flex flex-col gap-2${span ? ' sm:col-span-2' : ''}`}>
      <span className="eyebrow">{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: -2 }}>{hint}</span>}
    </label>
  )
}

function CopyButton({ value }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12 }} title="Copy"
      onClick={async () => { try { await navigator.clipboard.writeText(value || ''); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked */ } }}>
      {done ? <Check size={ICON.sm} /> : <Copy size={ICON.sm} />} {done ? 'Copied' : 'Copy'}
    </button>
  )
}

/* ── Apps ──────────────────────────────────────────────────────────────── */

function Chip({ text }) {
  return (
    <span style={{
      width: 44, height: 44, borderRadius: 14, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(244,225,74,.55)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: text.length > 2 ? 13 : 18, fontWeight: 500, letterSpacing: '.01em',
    }}>{text}</span>
  )
}

function SharedLogin() {
  const toast = useToast()
  const [creds, setCreds] = useState(null)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!creds) return undefined
    const t = setTimeout(() => { setCreds(null); setShow(false) }, 90_000)
    return () => clearTimeout(t)
  }, [creds])

  const reveal = async () => {
    setBusy(true)
    try { setCreds(await callCloserHub('semrush')); setShow(false); setMissing(false) }
    catch (e) { if (e.status === 404) setMissing(true); else toast.error(e.message) }
    finally { setBusy(false) }
  }

  if (missing) return <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--house-warn)', fontWeight: 600 }}>Login not set yet. Ben adds it on the backend.</p>
  if (!creds) return (
    <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5, marginTop: 10 }} onClick={reveal} disabled={busy}>
      <Eye size={ICON.sm} /> {busy ? 'Fetching' : 'Show login'}
    </button>
  )
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 13 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="eyebrow" style={{ width: 76 }}>User</span>
        <code>{creds.username}</code>
        <CopyButton value={creds.username} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="eyebrow" style={{ width: 76 }}>Password</span>
        <code>{show ? creds.password : '••••••••••'}</code>
        <button type="button" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => setShow(v => !v)}>
          {show ? <EyeOff size={ICON.sm} /> : <Eye size={ICON.sm} />} {show ? 'Hide' : 'Show'}
        </button>
        <CopyButton value={creds.password} />
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>Hides itself after 90 seconds.</span>
    </div>
  )
}

function AppRow({ tool }) {
  const inner = (
    <div className="flex items-center gap-3">
      <Chip text={tool.chip} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, lineHeight: 1.1 }}>{tool.name}</span>
          {tool.shared && <span className="pill pill-soft">Shared login</span>}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 3 }}>{tool.what}</div>
      </div>
      <ArrowUpRight size={ICON.md} style={{ color: 'var(--ink-4)', flex: 'none' }} />
    </div>
  )
  const pad = { padding: '14px 16px' }
  if (tool.internal) return <Link to={tool.url} className="tile tile-hover block" style={pad}>{inner}</Link>
  if (!tool.shared) return <a href={tool.url} target="_blank" rel="noopener" className="tile tile-hover block" style={pad}>{inner}</a>
  return (
    <div className="tile" style={pad}>
      <a href={tool.url} target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>{inner}</a>
      <SharedLogin />
    </div>
  )
}

/* ── New deal ──────────────────────────────────────────────────────────── */

const STEP_LABEL = { contract: 'Draft the contract', channel: 'Make the Slack channel', send: 'Send the contract' }

function StatusPill({ status }) {
  const cls = status === 'done' ? 'pill pill-up' : status === 'failed' ? 'pill pill-down' : status === 'running' ? 'pill pill-accent' : 'pill pill-flat'
  const text = status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : status === 'running' ? 'Working' : 'Skipped'
  return <span className={cls}>{text}</span>
}

function NewDealModal({ open, onClose, settings, onDone }) {
  const toast = useToast()
  const blank = { company: '', email: '', name: '', offer: 'retainer', fee: '', extra: '' }
  const [form, setForm] = useState(blank)
  const [steps, setSteps] = useState({ contract: true, channel: true, send: false })
  const [run, setRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const trialReady = !!(settings.template_trial || '').trim()
  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const standard = settings[`conditions_${form.offer}`] || ''

  useEffect(() => { if (open) { setRun(null); setBusy(false) } }, [open])

  const close = () => { if (busy) return; setForm(blank); setRun(null); onClose() }

  const go = async () => {
    if (!form.company.trim()) return toast.error('Company name first.')
    if ((steps.contract || steps.send) && !form.email.includes('@')) return toast.error('A client email is needed for the contract.')
    if (!steps.contract && !steps.channel) return toast.error('Tick at least one step.')
    setBusy(true)
    const r = {}
    const paint = () => setRun({ ...r })
    if (steps.contract) {
      r.contract = { status: 'running' }; paint()
      try {
        const c = await callCloserHub('create_contract', { company: form.company, email: form.email, signer_name: form.name, offer: form.offer, fee, extra_conditions: form.extra })
        r.contract = { status: 'done', ...c }
      } catch (e) { r.contract = { status: 'failed', error: e.message } }
      paint()
    }
    if (steps.channel) {
      r.channel = { status: 'running' }; paint()
      try {
        const c = await callCloserHub('make_channel', { company: form.company, email: form.email, prospect_name: form.name })
        r.channel = { status: 'done', ...c }
      } catch (e) { r.channel = { status: 'failed', error: e.message, ...(e.data || {}) } }
      paint()
    }
    if (steps.send && r.contract?.doc_id) {
      r.send = { status: 'running' }; paint()
      try {
        const s = await callCloserHub('send_contract', { doc_id: r.contract.doc_id, email: form.email })
        r.send = { status: 'done', ...s }
      } catch (e) { r.send = { status: 'failed', error: e.message } }
      paint()
    }
    setBusy(false)
    onDone?.()
  }

  const sendNow = async () => {
    setBusy(true)
    const r = { ...run, send: { status: 'running' } }
    setRun(r)
    try {
      const s = await callCloserHub('send_contract', { doc_id: run.contract.doc_id, email: form.email })
      setRun({ ...r, send: { status: 'done', ...s } })
      toast.success(`Sent to ${form.email}.`)
    } catch (e) { setRun({ ...r, send: { status: 'failed', error: e.message } }); toast.error(e.message) }
    finally { setBusy(false); onDone?.() }
  }

  const p = run?.channel?.prospect
  const canSend = run?.contract?.status === 'done' && run?.send?.status !== 'done' && run?.send?.status !== 'running'

  return (
    <Modal open={open} onClose={close} size="lg" eyebrow="Closer Hub"
      title={run ? `${form.company}` : 'New deal'}
      subtitle={run ? 'What happened, step by step.' : 'Company and email, tick what you want, go.'}
      footer={run ? (
        <div className="flex justify-between items-center gap-2 flex-wrap">
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>{busy ? 'Working' : 'Finished'}</span>
          <div className="flex gap-2">
            {canSend && <button type="button" className="editorial-btn-primary" onClick={sendNow} disabled={busy}>Send contract to {form.email}</button>}
            <button type="button" className="editorial-btn-ghost" onClick={close} disabled={busy}>Close</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <button type="button" className="editorial-btn-ghost" onClick={close}>Cancel</button>
          <button type="button" className="editorial-btn-primary" onClick={go} disabled={busy}>Go</button>
        </div>
      )}>
      {!run ? (
        <div className="grid gap-4" style={{ padding: '4px 0' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Company"><input value={form.company} onChange={set('company')} placeholder="Kings Roofing LLC" autoFocus /></Field>
            <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} placeholder="owner@kingsroofing.com" /></Field>
            <Field label="Client name" hint="Optional. They can type it when signing."><input value={form.name} onChange={set('name')} placeholder="Jane Smith" /></Field>
            <Field label="Agreement">
              <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value, fee: '' }))}>
                <option value="retainer">Retainer, {settings.fee_retainer ? `$${settings.fee_retainer}` : ''} a month</option>
                <option value="trial" disabled={!trialReady}>{trialReady ? `Trial, $${settings.fee_trial}` : 'Trial (no template set yet)'}</option>
              </select>
            </Field>
          </div>

          <div className="grid gap-2" style={{ padding: '14px 16px', border: '1px solid var(--rule)', borderRadius: 'var(--house-radius-tile)' }}>
            <span className="eyebrow">What to do</span>
            <label className="flex items-center gap-3" style={{ fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={steps.contract} onChange={(e) => setSteps(s => ({ ...s, contract: e.target.checked, send: e.target.checked && s.send }))} />
              <span>Draft the contract in PandaDoc <span style={{ color: 'var(--ink-4)' }}>(standard conditions added)</span></span>
            </label>
            <label className="flex items-center gap-3" style={{ fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={steps.channel} onChange={(e) => setSteps(s => ({ ...s, channel: e.target.checked }))} />
              <span>Make the Slack channel and invite the team and the client</span>
            </label>
            <label className="flex items-center gap-3" style={{ fontSize: 14, cursor: steps.contract ? 'pointer' : 'default', opacity: steps.contract ? 1 : .5 }}>
              <input type="checkbox" checked={steps.send} disabled={!steps.contract} onChange={(e) => setSteps(s => ({ ...s, send: e.target.checked }))} />
              <span>Send the contract straight away <span style={{ color: 'var(--ink-4)' }}>(untick to look it over first)</span></span>
            </label>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--ink-2)' }}>Fee and conditions</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <Field label="Monthly fee" hint="Change only with sign-off."><input inputMode="numeric" value={fee} onChange={set('fee')} /></Field>
              <Field label="Extra for this deal" hint="Optional, goes under the standard conditions."><input value={form.extra} onChange={set('extra')} /></Field>
              <div className="sm:col-span-2" style={{ fontSize: 12.5, color: 'var(--ink-3)', whiteSpace: 'pre-wrap' }}>
                <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Standard conditions</span>{standard || 'None set for this agreement.'}
              </div>
            </div>
          </details>
        </div>
      ) : (
        <div className="grid gap-3" style={{ padding: '4px 0' }}>
          {['contract', 'channel', 'send'].map(k => {
            const s = run[k]
            if (!s && !steps[k]) return null
            const st = s?.status || 'skipped'
            return (
              <div key={k} className="flex items-start gap-3" style={{ padding: '12px 14px', border: '1px solid var(--rule)', borderRadius: 'var(--house-radius-tile)' }}>
                <div className="min-w-0 flex-1" style={{ fontSize: 13.5 }}>
                  <div className="flex items-center gap-2"><b>{STEP_LABEL[k]}</b><StatusPill status={st} /></div>
                  <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>
                    {k === 'contract' && st === 'done' && <><a href={s.url} target="_blank" rel="noopener">Open in PandaDoc <ExternalLink size={ICON.sm} style={{ display: 'inline', verticalAlign: '-2px' }} /></a>{!s.renamed && <span style={{ color: 'var(--house-warn)' }}> Check for a &quot;[DEV]&quot; prefix.</span>}</>}
                    {k === 'channel' && st === 'done' && (
                      <>
                        #{s.channel?.name} {s.channel?.created ? 'created' : 'already existed'}, {s.invited?.length || 0} team member{(s.invited?.length || 0) === 1 ? '' : 's'} invited{s.closer_invited ? ' including you' : ''}.
                        {s.channel?.id && <> <a href={`https://slack.com/app_redirect?channel=${s.channel.id}`} target="_blank" rel="noopener">Open in Slack</a>.</>}
                        <div style={{ marginTop: 3 }}>
                          {p?.skipped && 'No client email, so nobody outside the team was invited.'}
                          {p?.ok && <>Invite emailed to {p.email}.</>}
                          {p && !p.ok && !p.skipped && <>Slack could not invite {p.email} by itself. In Slack, open the channel, <i>Add people</i>, paste the email, pick <i>guest</i>.</>}
                        </div>
                      </>
                    )}
                    {k === 'send' && st === 'done' && <>Emailed to {form.email}.</>}
                    {st === 'failed' && <span style={{ color: 'var(--house-bad)' }}>{s.error}</span>}
                    {st === 'skipped' && 'Not asked for.'}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

/* ── Settings (admin) ──────────────────────────────────────────────────── */

function SettingsModal({ open, onClose, settings, onSaved }) {
  const toast = useToast()
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setDraft(settings) }, [open, settings])
  const save = async () => {
    setBusy(true)
    try { await saveCloserHubSettings(draft); toast.success('Saved.'); onSaved(draft); onClose() }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  const upd = (k) => (e) => setDraft(d => ({ ...d, [k]: e.target.value }))
  return (
    <Modal open={open} onClose={onClose} size="lg" eyebrow="Closer Hub" title="Hub settings" subtitle="The conditions go into a legal document on every contract. Read them before you rely on them."
      footer={<div className="flex justify-end gap-2"><button type="button" className="editorial-btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="editorial-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save'}</button></div>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" style={{ padding: '4px 0' }}>
        <Field label="Standard conditions: retainer" span><textarea rows={4} value={draft.conditions_retainer || ''} onChange={upd('conditions_retainer')} /></Field>
        <Field label="Standard conditions: trial" span><textarea rows={3} value={draft.conditions_trial || ''} onChange={upd('conditions_trial')} /></Field>
        {SETTING_FIELDS.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><input value={draft[key] || ''} onChange={upd(key)} /></Field>)}
      </div>
    </Modal>
  )
}

/* ── Recent ────────────────────────────────────────────────────────────── */

function Recent({ refreshKey }) {
  const [rows, setRows] = useState([])
  useEffect(() => {
    let alive = true
    supabase.from('closer_hub_actions').select('id, actor_name, action, client_name, ok, created_at, result')
      .order('created_at', { ascending: false }).limit(8)
      .then(({ data }) => { if (alive) setRows(data || []) })
    return () => { alive = false }
  }, [refreshKey])
  if (rows.length === 0) return null
  const label = { make_channel: 'Channel', create_contract: 'Contract drafted', send_contract: 'Contract sent' }
  return (
    <div>
      <h2 className="eyebrow" style={{ margin: '0 0 10px' }}>Recent</h2>
      <div className="tile" style={{ padding: '4px 18px' }}>
        {rows.map((r, i) => (
          <div key={r.id} className="flex items-center gap-3 flex-wrap" style={{ padding: '10px 0', borderTop: i ? '1px solid var(--rule)' : 0, fontSize: 13 }}>
            <span style={{ color: 'var(--ink-4)', width: 96, flex: 'none' }}>{new Date(r.created_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className={`pill ${r.ok === false ? 'pill-down' : 'pill-soft'}`}>{label[r.action] || r.action}</span>
            <span style={{ fontWeight: 600 }} className="truncate">{r.client_name || r.result?.name || ''}</span>
            <span style={{ color: 'var(--ink-4)' }}>{r.actor_name}</span>
            <span className="flex-1" />
            {r.result?.url && <a href={r.result.url} target="_blank" rel="noopener">Open</a>}
            {r.result?.channel?.id && <a href={`https://slack.com/app_redirect?channel=${r.result.channel.id}`} target="_blank" rel="noopener">Open</a>}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function CloserHub() {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const [settings, setSettings] = useState({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [dealOpen, setDealOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const bump = () => setRefreshKey(k => k + 1)

  useEffect(() => {
    loadCloserHubSettings().then(setSettings).catch((e) => toast.error(`Settings did not load: ${e.message}`))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Closer Hub</span>
          <h1 className="h2 mt-2">The <em>closer</em> hub.</h1>
          <p className="lede mt-2" style={{ fontSize: 14 }}>Your apps, the shared login, and one button for a new deal.</p>
        </div>
        <div className="flex gap-2">
          {isAdmin && <button type="button" className="editorial-btn-ghost" onClick={() => setSettingsOpen(true)}><Settings2 size={ICON.md} /> Settings</button>}
          <button type="button" className="editorial-btn-primary" onClick={() => setDealOpen(true)}><Plus size={ICON.md} /> New deal</button>
        </div>
      </div>

      <h2 className="eyebrow" style={{ margin: '0 0 10px' }}>Apps</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-7">
        {CLOSER_TOOLS.map(t => <AppRow key={t.key} tool={t} />)}
      </div>

      <Recent refreshKey={refreshKey} />

      <NewDealModal open={dealOpen} onClose={() => setDealOpen(false)} settings={settings} onDone={bump} />
      {isAdmin && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSaved={setSettings} />}
    </div>
  )
}
