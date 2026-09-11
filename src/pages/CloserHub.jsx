import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Eye, EyeOff, Copy, Check, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import { ICON } from '../utils/constants'
import { CLOSER_TOOLS } from '../data/closerTools'
import { callCloserHub, loadCloserHubSettings, saveCloserHubSettings } from '../lib/closerHub'

/* Closer Hub (Ben, 12 Sep 2026). No pop-ups: "I want everything in here in
   one hub." The page is a step-by-step new deal down the main column
   (who, contract, channel, finish) and a narrow side panel of app links with
   badges. Closers and admins only (CloserRoute). */

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
    <button type="button" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }} title="Copy"
      onClick={async () => { try { await navigator.clipboard.writeText(value || ''); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked */ } }}>
      {done ? <Check size={ICON.sm} /> : <Copy size={ICON.sm} />}
    </button>
  )
}

function StepHead({ n, title, note }) {
  return (
    <div className="mb-4">
      <h2 className="eyebrow" style={{ margin: 0 }}>Step {n} of 4 · {title}</h2>
      {note && <p style={{ margin: '2px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>{note}</p>}
    </div>
  )
}

function Result({ tone = 'ok', children }) {
  const color = tone === 'bad' ? 'var(--house-bad)' : tone === 'warn' ? 'var(--house-warn)' : 'var(--ink-2)'
  return <div className="callout" style={{ marginTop: 14, fontSize: 13, color }}>{children}</div>
}

/* ── Side panel: apps ──────────────────────────────────────────────────── */

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

  if (missing) return <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--house-warn)', fontWeight: 600 }}>Login not set yet. Ben adds it on the backend.</p>
  if (!creds) return (
    <button type="button" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12, padding: '0 10px', marginTop: 6 }} onClick={reveal} disabled={busy}>
      <Eye size={ICON.sm} /> {busy ? 'Fetching' : 'Login'}
    </button>
  )
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 5, fontSize: 12.5 }}>
      <div className="flex items-center gap-2"><code style={{ flex: 1 }} className="truncate">{creds.username}</code><CopyButton value={creds.username} /></div>
      <div className="flex items-center gap-2">
        <code style={{ flex: 1 }} className="truncate">{show ? creds.password : '••••••••••'}</code>
        <button type="button" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }} onClick={() => setShow(v => !v)} title={show ? 'Hide' : 'Show'}>
          {show ? <EyeOff size={ICON.sm} /> : <Eye size={ICON.sm} />}
        </button>
        <CopyButton value={creds.password} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Hides after 90 seconds.</span>
    </div>
  )
}

function AppLink({ tool, first }) {
  const badge = (
    <span style={{
      width: 30, height: 30, borderRadius: 9, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(244,225,74,.55)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: tool.chip.length > 2 ? 10 : 14, fontWeight: 500,
    }}>{tool.chip}</span>
  )
  const view = tool.internal
    ? <Link to={tool.url} className="editorial-btn-ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }}>View <ArrowUpRight size={ICON.sm} /></Link>
    : <a href={tool.url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12, padding: '0 10px' }}>View <ArrowUpRight size={ICON.sm} /></a>
  return (
    <div style={{ padding: '10px 0', borderTop: first ? 0 : '1px solid var(--rule)' }}>
      <div className="flex items-center gap-3">
        {badge}
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }} className="truncate">{tool.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.3 }} className="truncate">{tool.what}</div>
        </div>
        {view}
      </div>
      {tool.shared && <div style={{ paddingLeft: 42 }}><SharedLogin /></div>}
    </div>
  )
}

function AppsPanel() {
  return (
    <div className="tile" style={{ padding: '14px 18px 6px' }}>
      <h2 className="eyebrow" style={{ margin: '0 0 6px' }}>Apps</h2>
      {CLOSER_TOOLS.map((t, i) => <AppLink key={t.key} tool={t} first={i === 0} />)}
    </div>
  )
}

/* ── Main column: the deal, step by step ───────────────────────────────── */

function NewDeal({ settings, onDone }) {
  const toast = useToast()
  const [form, setForm] = useState({ company: '', email: '', name: '', offer: 'retainer', fee: '', extra: '' })
  const [contract, setContract] = useState(null)
  const [channel, setChannel] = useState(null)
  const [sent, setSent] = useState(null)
  const [busy, setBusy] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const trialReady = !!(settings.template_trial || '').trim()
  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const standard = settings[`conditions_${form.offer}`] || ''
  const ready = form.company.trim().length > 0 && form.email.includes('@')
  const dim = ready ? {} : { opacity: .55, pointerEvents: 'none' }

  const draft = async () => {
    setBusy('contract')
    try {
      const r = await callCloserHub('create_contract', { company: form.company, email: form.email, signer_name: form.name, offer: form.offer, fee, extra_conditions: form.extra })
      setContract(r); setSent(null); setConfirmSend(false)
      toast.success('Drafted in PandaDoc.')
      onDone?.()
    } catch (e) { toast.error(e.message); setContract({ error: e.message }) }
    finally { setBusy('') }
  }

  const send = async () => {
    setBusy('send')
    try {
      const r = await callCloserHub('send_contract', { doc_id: contract.doc_id, email: form.email })
      setSent(r); setConfirmSend(false)
      toast.success(`Sent to ${form.email}.`)
      onDone?.()
    } catch (e) { toast.error(e.message) }
    finally { setBusy('') }
  }

  const make = async () => {
    setBusy('channel')
    try {
      const r = await callCloserHub('make_channel', { company: form.company, email: form.email, prospect_name: form.name })
      setChannel(r)
      toast.success(`#${r.channel?.name} ${r.channel?.created ? 'created' : 'was already there'}.`)
      onDone?.()
    } catch (e) { toast.error(e.message); setChannel({ error: e.message, ...(e.data || {}) }) }
    finally { setBusy('') }
  }

  const startOver = () => { setForm({ company: '', email: '', name: '', offer: 'retainer', fee: '', extra: '' }); setContract(null); setChannel(null); setSent(null); setConfirmSend(false) }
  const p = channel?.prospect

  return (
    <div className="grid gap-4">
      {/* 1. who */}
      <div className="tile" style={{ padding: '22px 24px' }}>
        <StepHead n={1} title="Who" note="Company and the client's email. The rest fills itself in." />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Company"><input value={form.company} onChange={set('company')} placeholder="Kings Roofing LLC" /></Field>
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} placeholder="owner@kingsroofing.com" /></Field>
          <Field label="Client name" hint="Optional. They can type it when signing."><input value={form.name} onChange={set('name')} placeholder="Jane Smith" /></Field>
          <Field label="Agreement">
            <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value, fee: '' }))}>
              <option value="retainer">Retainer{settings.fee_retainer ? `, $${settings.fee_retainer} a month` : ''}</option>
              <option value="trial" disabled={!trialReady}>{trialReady ? `Trial, $${settings.fee_trial}` : 'Trial (no template set yet)'}</option>
            </select>
          </Field>
        </div>
      </div>

      {/* 2. contract */}
      <div className="tile" style={{ padding: '22px 24px', ...dim }}>
        <StepHead n={2} title="Contract" note="Drafts it in PandaDoc with the standard conditions. Sending is a separate click, so you can look it over first." />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Monthly fee" hint="Change only with sign-off."><input inputMode="numeric" value={fee} onChange={set('fee')} /></Field>
          <Field label="Extra for this deal" hint="Optional. Goes under the standard conditions."><input value={form.extra} onChange={set('extra')} /></Field>
          <div className="sm:col-span-2">
            <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Standard conditions</span>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)', whiteSpace: 'pre-wrap' }}>{standard || 'None set for this agreement.'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-5 flex-wrap">
          <button type="button" className="editorial-btn-primary" onClick={draft} disabled={busy === 'contract'}>{busy === 'contract' ? 'Drafting' : contract?.doc_id ? 'Draft again' : 'Draft the contract'}</button>
          {contract?.doc_id && !sent && !confirmSend && <button type="button" className="editorial-btn-ghost" onClick={() => setConfirmSend(true)}>Send to {form.email}</button>}
          {confirmSend && !sent && (
            <>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Emails the signing links now. Sure?</span>
              <button type="button" className="editorial-btn-primary" onClick={send} disabled={busy === 'send'}>{busy === 'send' ? 'Sending' : 'Yes, send'}</button>
              <button type="button" className="editorial-btn-ghost" onClick={() => setConfirmSend(false)}>Not yet</button>
            </>
          )}
        </div>
        {contract?.error && <Result tone="bad">{contract.error}</Result>}
        {contract?.doc_id && (
          <Result>
            <b>{contract.name}</b> is drafted{sent ? ' and sent' : ''}. <a href={contract.url} target="_blank" rel="noopener">Open in PandaDoc <ExternalLink size={ICON.sm} style={{ display: 'inline', verticalAlign: '-2px' }} /></a>
            {!contract.renamed && !sent && <span style={{ display: 'block', color: 'var(--house-warn)' }}>Check the name for a &quot;[DEV]&quot; prefix before sending.</span>}
          </Result>
        )}
      </div>

      {/* 3. channel */}
      <div className="tile" style={{ padding: '22px 24px', ...dim }}>
        <StepHead n={3} title="Channel" note="Makes client-<business> in Slack, invites the account-management team and you, and invites the client by email." />
        <button type="button" className="editorial-btn-primary" onClick={make} disabled={busy === 'channel'}>{busy === 'channel' ? 'Making the channel' : 'Make the channel'}</button>
        {channel?.error && <Result tone="bad">Could not make the channel: {channel.error}</Result>}
        {channel?.ok && (
          <Result>
            <b>#{channel.channel?.name}</b> {channel.channel?.created ? 'created' : 'already existed, reused'}. Invited {channel.invited?.length || 0} team member{(channel.invited?.length || 0) === 1 ? '' : 's'}{channel.closer_invited ? ', including you' : ''}.
            {channel.channel?.id && <> <a href={`https://slack.com/app_redirect?channel=${channel.channel.id}`} target="_blank" rel="noopener">Open in Slack</a>.</>}
            <div style={{ marginTop: 6 }}>
              {p?.skipped && 'No client email, so nobody outside the team was invited.'}
              {p?.ok && <>Invite emailed to <b>{p.email}</b>.</>}
              {p && !p.ok && !p.skipped && <>Slack could not invite <b>{p.email}</b> by itself. In Slack, open the channel, <i>Add people</i>, paste the email, pick <i>guest</i>.</>}
            </div>
          </Result>
        )}
      </div>

      {/* 4. finish */}
      <div className="tile" style={{ padding: '22px 24px', ...dim }}>
        <StepHead n={4} title="Finish" note="Two things the hub cannot do for you." />
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: 'var(--ink-2)', display: 'grid', gap: 6 }}>
          <li>Move the card in <a href="https://app.gohighlevel.com/" target="_blank" rel="noopener">GoHighLevel</a> to Closed or New Map Closes. That posts the close and starts onboarding.</li>
          <li>Log the call in <Link to="/sales/eod">End of Day</Link>.</li>
        </ol>
        <div className="mt-5"><button type="button" className="editorial-btn-ghost" onClick={startOver}>Start another deal</button></div>
      </div>
    </div>
  )
}

/* ── Recent + settings ─────────────────────────────────────────────────── */

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
    <div className="tile" style={{ padding: '14px 18px 4px' }}>
      <h2 className="eyebrow" style={{ margin: '0 0 4px' }}>Recent</h2>
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
  )
}

function SettingsSection({ settings, onSaved }) {
  const toast = useToast()
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft(settings) }, [settings])
  const upd = (k) => (e) => setDraft(d => ({ ...d, [k]: e.target.value }))
  const save = async () => {
    setBusy(true)
    try { await saveCloserHubSettings(draft); toast.success('Saved.'); onSaved(draft) }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <details className="tile" style={{ padding: '14px 24px' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none' }} className="flex items-center gap-2">
        <span className="eyebrow" style={{ margin: 0 }}>Hub settings</span><span className="pill pill-soft">Admin</span>
      </summary>
      <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--ink-3)' }}>The conditions go into a legal document on every contract. Read them before you rely on them.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Standard conditions: retainer" span><textarea rows={4} value={draft.conditions_retainer || ''} onChange={upd('conditions_retainer')} /></Field>
        <Field label="Standard conditions: trial" span><textarea rows={3} value={draft.conditions_trial || ''} onChange={upd('conditions_trial')} /></Field>
        {SETTING_FIELDS.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><input value={draft[key] || ''} onChange={upd(key)} /></Field>)}
      </div>
      <div className="mt-5 mb-2"><button type="button" className="editorial-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save settings'}</button></div>
    </details>
  )
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function CloserHub() {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const [settings, setSettings] = useState({})
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = () => setRefreshKey(k => k + 1)

  useEffect(() => {
    loadCloserHubSettings().then(setSettings).catch((e) => toast.error(`Settings did not load: ${e.message}`))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Sales · Closer Hub</span>
        <h1 className="h2 mt-2">The <em>closer</em> hub.</h1>
        <p className="lede mt-2" style={{ fontSize: 14 }}>A new deal, step by step, with your apps beside it.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 grid gap-4">
          <NewDeal settings={settings} onDone={bump} />
          <Recent refreshKey={refreshKey} />
          {isAdmin && <SettingsSection settings={settings} onSaved={setSettings} />}
        </div>
        <div className="xl:sticky" style={{ top: 16 }}>
          <AppsPanel />
        </div>
      </div>
    </div>
  )
}
