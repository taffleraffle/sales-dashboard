import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Eye, EyeOff, Copy, Check, Hash, FileSignature, Send, Settings2, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import { SectionHead } from '../components/editorial/atoms'
import Modal from '../components/editorial/Modal'
import { ICON } from '../utils/constants'
import { CLOSER_TOOLS } from '../data/closerTools'
import { callCloserHub, loadCloserHubSettings, saveCloserHubSettings } from '../lib/closerHub'

/* Closer Hub (Ben, 12 Sep 2026): one page with the tool stack, the shared
   Semrush login, "Make Channel" for a new client, and a PandaDoc contract from
   just an email and a company name. Closers and admins only (CloserRoute). */

const SETTING_FIELDS = [
  ['opt_rep_name', 'OPT signer name', 'Who signs for Opt Digital on every agreement.'],
  ['opt_rep_email', 'OPT signer email', 'Must be a PandaDoc member.'],
  ['fee_retainer', 'Retainer fee (monthly)', 'Digits only.'],
  ['fee_trial', 'Trial fee', 'Digits only.'],
  ['template_retainer', 'PandaDoc template: retainer', 'The Local SEO client agreement template id.'],
  ['template_trial', 'PandaDoc template: trial', 'Leave blank until a trial template exists in PandaDoc.'],
  ['role_opt', 'Template role: OPT', 'Usually "Role 1".'],
  ['role_client', 'Template role: client', '"Client" on the retainer template, "Role 2" on older ones.'],
  ['send_subject', 'Email subject when sending', ''],
  ['send_message', 'Email message when sending', ''],
]

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>{label}</span>
      {children}
      {hint && <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-4)', marginTop: 5 }}>{hint}</span>}
    </label>
  )
}

function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12 }}
      onClick={async () => { try { await navigator.clipboard.writeText(value || '') ; setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked */ } }}>
      {done ? <Check size={ICON.sm} /> : <Copy size={ICON.sm} />} {done ? 'Copied' : label}
    </button>
  )
}

/* ── Tools ─────────────────────────────────────────────────────────────── */

function SemrushLogin() {
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
    try {
      const c = await callCloserHub('semrush')
      setCreds(c); setShow(false); setMissing(false)
    } catch (e) {
      if (e.status === 404) setMissing(true)
      else toast.error(e.message)
    } finally { setBusy(false) }
  }

  if (missing) return <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--house-warn)', fontWeight: 600 }}>Login not set yet. An admin adds it as SEMRUSH_USERNAME and SEMRUSH_PASSWORD on the backend.</p>
  if (!creds) return (
    <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5, marginTop: 10 }} onClick={reveal} disabled={busy}>
      <Eye size={ICON.sm} /> {busy ? 'Fetching' : 'Show shared login'}
    </button>
  )
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 13 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: 'var(--ink-4)', width: 72 }}>Username</span>
        <code style={{ fontSize: 13 }}>{creds.username}</code>
        <CopyButton value={creds.username} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: 'var(--ink-4)', width: 72 }}>Password</span>
        <code style={{ fontSize: 13 }}>{show ? creds.password : '•'.repeat(Math.min(12, creds.password.length || 8))}</code>
        <button type="button" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => setShow(v => !v)}>
          {show ? <EyeOff size={ICON.sm} /> : <Eye size={ICON.sm} />} {show ? 'Hide' : 'Show'}
        </button>
        <CopyButton value={creds.password} />
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>Hides itself after 90 seconds.</span>
    </div>
  )
}

function ToolTile({ tool }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, margin: 0, lineHeight: 1.1 }}>{tool.name}</h3>
        <ExternalLink size={ICON.sm} style={{ color: 'var(--ink-4)', flex: 'none' }} />
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.45 }}>{tool.what}</p>
    </>
  )
  if (tool.shared) {
    return (
      <div className="tile" style={{ padding: '18px 20px' }}>
        <a href={tool.url} target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'none' }}>{body}</a>
        <span className="pill" style={{ marginTop: 8, display: 'inline-flex' }}>Shared login</span>
        <SemrushLogin />
      </div>
    )
  }
  if (tool.internal) return <Link to={tool.url} className="tile tile-hover block" style={{ padding: '18px 20px' }}>{body}</Link>
  return <a href={tool.url} target="_blank" rel="noopener" className="tile tile-hover block" style={{ padding: '18px 20px' }}>{body}</a>
}

/* ── Make Channel ──────────────────────────────────────────────────────── */

function ChannelPanel() {
  const toast = useToast()
  const [form, setForm] = useState({ company: '', email: '', prospect_name: '' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    if (!form.company.trim()) return toast.error('Company name first.')
    setBusy(true); setResult(null)
    try {
      const r = await callCloserHub('make_channel', form)
      setResult(r)
      toast.success(`#${r.channel?.name} ${r.channel?.created ? 'created' : 'was already there'}.`)
    } catch (err) {
      toast.error(err.message)
      setResult({ ok: false, error: err.message, ...(err.data || {}) })
    } finally { setBusy(false) }
  }

  const p = result?.prospect
  return (
    <div className="tile" style={{ padding: '22px 24px' }}>
      <div className="flex items-center gap-2 mb-1"><Hash size={ICON.md} /><h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: 0 }}>New client channel</h2></div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-3)' }}>Makes <code>client-&lt;business&gt;</code>, invites the account-management team and you, and invites the client by email.</p>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Company"><input value={form.company} onChange={set('company')} placeholder="Kings Roofing" required /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} placeholder="owner@kingsroofing.com" /></Field>
          <Field label="Client name"><input value={form.prospect_name} onChange={set('prospect_name')} placeholder="Jane Smith" /></Field>
        </div>
        <div><button type="submit" className="editorial-btn-primary" disabled={busy}>{busy ? 'Making the channel' : 'Make Channel'}</button></div>
      </form>
      {result && (
        <div className="callout" style={{ marginTop: 16, fontSize: 13 }}>
          {result.ok ? (
            <>
              <b>#{result.channel?.name}</b> {result.channel?.created ? 'created' : 'already existed, reused'}.
              {' '}Invited {result.invited?.length || 0} team member{(result.invited?.length || 0) === 1 ? '' : 's'}{result.closer_invited ? ', including you' : ''}.
              {result.channel?.id && <> <a href={`https://slack.com/app_redirect?channel=${result.channel.id}`} target="_blank" rel="noopener">Open in Slack</a>.</>}
              <div style={{ marginTop: 8 }}>
                {p?.skipped && <>No client email given, so nobody outside the team was invited.</>}
                {p?.ok && <>Invite sent to <b>{p.email}</b>. They get an email from Slack and join the channel from it.</>}
                {p && !p.ok && !p.skipped && (
                  <>
                    Slack could not invite <b>{p.email}</b> by itself ({p.error || 'refused'}). Invite them by hand: in Slack open <b>#{result.channel?.name}</b>, choose <i>Add people</i>, paste their email, and pick <i>guest</i>.
                    {p.needed_scope && <span style={{ display: 'block', color: 'var(--ink-4)', marginTop: 4 }}>Automatic invites need the Optimus Slack app re-authorised with <code>{p.needed_scope}</code>.</span>}
                  </>
                )}
              </div>
            </>
          ) : (
            <>Could not make the channel: {result.error || 'unknown error'}.</>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Contract ──────────────────────────────────────────────────────────── */

function ContractPanel({ settings }) {
  const toast = useToast()
  const [form, setForm] = useState({ company: '', email: '', signer_name: '', offer: 'retainer', fee: '', extra_conditions: '' })
  const [busy, setBusy] = useState(false)
  const [doc, setDoc] = useState(null)
  const [confirmSend, setConfirmSend] = useState(false)
  const [sending, setSending] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const trialReady = !!(settings.template_trial || '').trim()
  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const standard = settings[`conditions_${form.offer}`] || ''

  const create = async (e) => {
    e.preventDefault()
    if (!form.company.trim() || !form.email.trim()) return toast.error('Company and client email first.')
    setBusy(true); setDoc(null)
    try {
      const r = await callCloserHub('create_contract', { ...form, fee })
      setDoc(r)
      toast.success('Contract drafted in PandaDoc.')
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const send = async () => {
    setSending(true)
    try {
      const r = await callCloserHub('send_contract', { doc_id: doc.doc_id, email: form.email })
      setDoc(d => ({ ...d, status: r.status, sent: true }))
      setConfirmSend(false)
      toast.success(`Sent to ${form.email}.`)
    } catch (err) { toast.error(err.message) } finally { setSending(false) }
  }

  return (
    <div className="tile" style={{ padding: '22px 24px' }}>
      <div className="flex items-center gap-2 mb-1"><FileSignature size={ICON.md} /><h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: 0 }}>Contract</h2></div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-3)' }}>Drafts the agreement in PandaDoc with the standard special conditions added. Sending to the client is a second, separate click.</p>
      <form onSubmit={create} className="grid gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Company"><input value={form.company} onChange={set('company')} placeholder="Kings Roofing LLC" required /></Field>
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} placeholder="owner@kingsroofing.com" required /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Signer name" hint="Optional. They can type it when signing."><input value={form.signer_name} onChange={set('signer_name')} placeholder="Jane Smith" /></Field>
          <Field label="Agreement">
            <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value, fee: '' }))}>
              <option value="retainer">Retainer (Local SEO)</option>
              <option value="trial" disabled={!trialReady}>{trialReady ? 'Trial' : 'Trial (no template set)'}</option>
            </select>
          </Field>
          <Field label="Monthly fee" hint="Prefilled from the offer. Change only with sign-off."><input inputMode="numeric" value={fee} onChange={set('fee')} /></Field>
        </div>
        <Field label="Standard special conditions (added automatically)">
          <div style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 'var(--house-radius-input)', padding: '10px 12px' }}>
            {standard || 'None set for this agreement.'}
          </div>
        </Field>
        <Field label="Anything extra for this deal" hint="Optional. Goes under the standard conditions, word for word."><textarea rows={2} value={form.extra_conditions} onChange={set('extra_conditions')} /></Field>
        <div><button type="submit" className="editorial-btn-primary" disabled={busy}>{busy ? 'Drafting in PandaDoc' : 'Create contract'}</button></div>
      </form>
      {doc && (
        <div className="callout" style={{ marginTop: 16, fontSize: 13 }}>
          <b>{doc.name}</b> is drafted{doc.sent ? ' and sent' : ''}. Status <code>{doc.status}</code>.
          {' '}<a href={doc.url} target="_blank" rel="noopener">Open in PandaDoc</a>.
          {!doc.renamed && !doc.sent && <span style={{ display: 'block', color: 'var(--house-warn)', marginTop: 4 }}>Check the name for a "[DEV]" prefix before sending.</span>}
          {!doc.sent && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="editorial-btn-primary" style={{ height: 34, fontSize: 12.5 }} onClick={() => setConfirmSend(true)}>
                <Send size={ICON.sm} /> Send to {form.email}
              </button>
            </div>
          )}
        </div>
      )}
      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} size="sm" title="Send the agreement?" subtitle={`PandaDoc emails ${form.email} and ${settings.opt_rep_email || 'the OPT signer'} their signing links. This cannot be undone.`}
        footer={(
          <div className="flex justify-end gap-2">
            <button type="button" className="editorial-btn-ghost" onClick={() => setConfirmSend(false)}>Not yet</button>
            <button type="button" className="editorial-btn-primary" onClick={send} disabled={sending}>{sending ? 'Sending' : 'Send it'}</button>
          </div>
        )} />
    </div>
  )
}

/* ── Admin settings ────────────────────────────────────────────────────── */

function SettingsPanel({ settings, onSaved }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft(settings) }, [settings])

  const save = async () => {
    setBusy(true)
    try { await saveCloserHubSettings(draft); toast.success('Saved.'); onSaved(draft) }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="tile" style={{ padding: '18px 24px' }}>
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center justify-between w-full" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }}>
        <span className="flex items-center gap-2"><Settings2 size={ICON.md} /><span style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500 }}>Hub settings</span><span className="pill">Admin</span></span>
        {open ? <ChevronUp size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
      </button>
      {open && (
        <div className="grid gap-3 mt-4">
          <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-3)' }}>The special conditions go into a legal document on every contract. Read them before you rely on them.</p>
          <Field label="Standard special conditions: retainer"><textarea rows={4} value={draft.conditions_retainer || ''} onChange={(e) => setDraft(d => ({ ...d, conditions_retainer: e.target.value }))} /></Field>
          <Field label="Standard special conditions: trial"><textarea rows={3} value={draft.conditions_trial || ''} onChange={(e) => setDraft(d => ({ ...d, conditions_trial: e.target.value }))} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SETTING_FIELDS.map(([key, label, hint]) => (
              <Field key={key} label={label} hint={hint}><input value={draft[key] || ''} onChange={(e) => setDraft(d => ({ ...d, [key]: e.target.value }))} /></Field>
            ))}
          </div>
          <div><button type="button" className="editorial-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save settings'}</button></div>
        </div>
      )}
    </div>
  )
}

/* ── Recent ────────────────────────────────────────────────────────────── */

function RecentActions({ refreshKey }) {
  const [rows, setRows] = useState([])
  useEffect(() => {
    let alive = true
    supabase.from('closer_hub_actions').select('id, actor_name, action, client_name, ok, created_at, result')
      .order('created_at', { ascending: false }).limit(12)
      .then(({ data }) => { if (alive) setRows(data || []) })
    return () => { alive = false }
  }, [refreshKey])
  if (rows.length === 0) return null
  const label = { make_channel: 'Channel', create_contract: 'Contract drafted', send_contract: 'Contract sent' }
  return (
    <div className="tile" style={{ padding: '18px 24px' }}>
      <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: '0 0 10px' }}>Recent</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--rule)' }}>
                <td style={{ padding: '8px 6px 8px 0', whiteSpace: 'nowrap', color: 'var(--ink-4)' }}>{new Date(r.created_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td style={{ padding: '8px 6px' }}>{r.actor_name}</td>
                <td style={{ padding: '8px 6px' }}><span className="pill">{label[r.action] || r.action}</span></td>
                <td style={{ padding: '8px 6px', fontWeight: 600 }}>{r.client_name || r.result?.name || ''}</td>
                <td style={{ padding: '8px 0 8px 6px', textAlign: 'right' }}>
                  {r.result?.url && <a href={r.result.url} target="_blank" rel="noopener">Open</a>}
                  {r.result?.channel?.id && <a href={`https://slack.com/app_redirect?channel=${r.result.channel.id}`} target="_blank" rel="noopener">Open</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function CloserHub() {
  const { isAdmin, profile } = useAuth()
  const toast = useToast()
  const [settings, setSettings] = useState({})
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    loadCloserHubSettings().then(setSettings).catch((e) => toast.error(`Settings did not load: ${e.message}`))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const tools = useMemo(() => CLOSER_TOOLS, [])

  return (
    <div className="space-y-6">
      <SectionHead level="page" eyebrow="Sales" title="Closer Hub" tagline={`Everything for the call and the close, in the order you use it${profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}.`} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" onClickCapture={() => setRefreshKey(k => k + 1)}>
        <ChannelPanel />
        <ContractPanel settings={settings} />
      </div>

      <div>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, margin: '0 0 12px' }}>Tools</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {tools.map(t => <ToolTile key={t.key} tool={t} />)}
        </div>
      </div>

      <RecentActions refreshKey={refreshKey} />
      {isAdmin && <SettingsPanel settings={settings} onSaved={setSettings} />}
    </div>
  )
}
