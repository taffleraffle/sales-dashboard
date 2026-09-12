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
  ['opt_rep_name', 'Fallback OPT signer name', 'Used only if nobody is picked in step 2.'],
  ['opt_rep_email', 'Fallback OPT signer email', ''],
  ['fee_retainer', 'Retainer fee (monthly)', 'Digits only.'],
  ['fee_trial', 'Trial fee', 'Digits only.'],
  ['template_retainer', 'PandaDoc template: retainer', 'The default picked when the deal type is Retainer.'],
  ['template_trial', 'PandaDoc template: trial', 'The default picked when the deal type is Trial.'],
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

function SharedLogin({ tool }) {
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
    try { setCreds(await callCloserHub('login', { tool })); setShow(false); setMissing(false) }
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

/* The app's own logo, pulled once into public/app-icons (Ben, 12 Sep 2026:
   "the icons of each of those apps rather than the letters"). Falls back to
   the letters only if the file is missing. */
function Badge({ tool }) {
  const [broken, setBroken] = useState(false)
  const box = { width: 30, height: 30, borderRadius: 9, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
  if (tool.icon && !broken) {
    return (
      <span style={{ ...box, background: '#fff', border: '1px solid var(--rule)' }}>
        <img src={tool.icon} alt="" width={22} height={22} style={{ width: 22, height: 22, objectFit: 'contain', display: 'block' }} onError={() => setBroken(true)} />
      </span>
    )
  }
  return (
    <span style={{ ...box, background: 'rgba(244,225,74,.55)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: tool.chip.length > 2 ? 10 : 14, fontWeight: 500 }}>{tool.chip}</span>
  )
}

function AppLink({ tool, first }) {
  const badge = <Badge tool={tool} />
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
      {tool.shared && <div style={{ paddingLeft: 42 }}><SharedLogin tool={tool.shared} /></div>}
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

const BLANK = { company: '', email: '', name: '', offer: 'retainer', template: '', fee: '', extra: '', signer: '' }

function NewDeal({ settings, onDone, profile }) {
  const toast = useToast()
  const [form, setForm] = useState(BLANK)
  const [templates, setTemplates] = useState([])
  const [signers, setSigners] = useState([])
  const [contract, setContract] = useState(null)
  const [channel, setChannel] = useState(null)
  const [sent, setSent] = useState(null)
  const [busy, setBusy] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  // The account's PandaDoc templates and the people who can sign for OPT.
  useEffect(() => {
    callCloserHub('templates').then(r => setTemplates(r.templates || [])).catch(() => setTemplates([]))
    supabase.from('team_members').select('id, name, email, role, is_active').eq('role', 'closer').order('name')
      .then(({ data }) => {
        const list = (data || []).filter(m => m.email)
        if (profile?.email && !list.some(m => (m.email || '').toLowerCase() === profile.email.toLowerCase())) {
          list.unshift({ id: 'me', name: profile.name || profile.email, email: profile.email, role: 'admin', is_active: true })
        }
        setSigners(list)
      })
  }, [profile?.email])  // eslint-disable-line react-hooks/exhaustive-deps

  // Defaults: the signer is whoever is logged in, the template follows the deal type.
  useEffect(() => {
    if (!form.signer && signers.length) {
      const me = signers.find(m => (m.email || '').toLowerCase() === (profile?.email || '').toLowerCase())
      setForm(f => ({ ...f, signer: (me || signers[0]).email }))
    }
  }, [signers, profile?.email])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setForm(f => ({ ...f, template: settings[`template_${f.offer}`] || '', fee: '' }))
  }, [form.offer, settings])

  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const standard = (settings[`conditions_${form.offer}`] || '').trim()
  const ready = form.company.trim().length > 0 && form.email.includes('@')
  const dim = ready ? {} : { opacity: .55, pointerEvents: 'none' }
  const signer = signers.find(m => m.email === form.signer)
  const templateName = templates.find(t => t.id === form.template)?.name

  const draft = async () => {
    if (!form.template) return toast.error('Pick a contract template first.')
    setBusy('contract')
    try {
      const r = await callCloserHub('create_contract', {
        company: form.company, email: form.email, signer_name: form.name, offer: form.offer, template: form.template,
        fee, extra_conditions: form.extra, opt_rep_name: signer?.name || '', opt_rep_email: signer?.email || '',
      })
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
      toast.success('Channels ready.')
      onDone?.()
    } catch (e) { toast.error(e.message); setChannel({ error: e.message, ...(e.data || {}) }) }
    finally { setBusy('') }
  }

  const reset = () => { setForm({ ...BLANK, signer: form.signer, template: settings.template_retainer || '' }); setContract(null); setChannel(null); setSent(null); setConfirmSend(false); setBusy('') }
  const p = channel?.prospect
  const ch = channel?.channels

  return (
    <div className="grid gap-4">
      {/* 1. who */}
      <div className="tile" style={{ padding: '22px 24px' }}>
        <div className="flex items-start justify-between gap-3">
          <StepHead n={1} title="Who" note="Company, the client's email, and whether this is a trial or a retainer." />
          {(form.company || contract || channel) && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={reset}>Reset</button>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Company"><input value={form.company} onChange={set('company')} placeholder="Kings Roofing LLC" /></Field>
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} placeholder="owner@kingsroofing.com" /></Field>
          <Field label="Client name" hint="Optional. They can type it when signing."><input value={form.name} onChange={set('name')} placeholder="Jane Smith" /></Field>
          <Field label="Deal type">
            <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value }))}>
              <option value="trial">Trial</option>
              <option value="retainer">Retainer</option>
            </select>
          </Field>
        </div>
      </div>

      {/* 2. contract */}
      <div className="tile" style={{ padding: '22px 24px', ...dim }}>
        <StepHead n={2} title="Contract" note="Pick the template and who signs for OPT. Drafting is private; sending is a separate click." />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Contract template" hint={templates.length ? '' : 'Loading the list from PandaDoc.'}>
            <select value={form.template} onChange={set('template')}>
              <option value="">Pick one</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Signing for OPT">
            <select value={form.signer} onChange={set('signer')}>
              {signers.map(m => <option key={m.id} value={m.email}>{m.name}{m.is_active === false ? ' (inactive)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Monthly fee" hint="Change only with sign-off."><input inputMode="numeric" value={fee} onChange={set('fee')} /></Field>
          <Field label="Extra details" hint="Optional. Only goes into the contract if you write something."><input value={form.extra} onChange={set('extra')} placeholder="Anything extra on this deal" /></Field>
          {standard && (
            <div className="sm:col-span-2">
              <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Standard conditions (set by admin)</span>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)', whiteSpace: 'pre-wrap' }}>{standard}</p>
            </div>
          )}
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
            <b>{contract.name}</b> is drafted{sent ? ' and sent' : ''} from {contract.template_name || templateName || 'the template'}{contract.opt_signer_name ? `, ${contract.opt_signer_name} signing for OPT` : ''}. <a href={contract.url} target="_blank" rel="noopener">Open in PandaDoc <ExternalLink size={ICON.sm} style={{ display: 'inline', verticalAlign: '-2px' }} /></a>
            {!contract.renamed && !sent && <span style={{ display: 'block', color: 'var(--house-warn)' }}>Check the name for a &quot;[DEV]&quot; prefix before sending.</span>}
          </Result>
        )}
      </div>

      {/* 3. channels */}
      <div className="tile" style={{ padding: '22px 24px', ...dim }}>
        <StepHead n={3} title="Channels" note="Makes both Slack channels: client-<business> for the team, and opt-<business> for the team and the client. The client is invited to opt- by email." />
        <button type="button" className="editorial-btn-primary" onClick={make} disabled={busy === 'channel'}>{busy === 'channel' ? 'Making the channels' : 'Make the channels'}</button>
        {channel?.error && <Result tone="bad">Could not make the channel: {channel.error}</Result>}
        {channel?.ok && ch && (
          <Result>
            {['internal', 'external'].map(k => (
              <div key={k}>
                <b>#{ch[k]?.name}</b> {ch[k]?.created ? 'created' : 'already existed, reused'}, {ch[k]?.invited?.length || 0} team member{(ch[k]?.invited?.length || 0) === 1 ? '' : 's'}{k === 'internal' && channel.closer_invited ? ' including you' : ''}.
                {ch[k]?.id && <> <a href={`https://slack.com/app_redirect?channel=${ch[k].id}`} target="_blank" rel="noopener">Open</a></>}
              </div>
            ))}
            <div style={{ marginTop: 6 }}>
              {p?.skipped && 'No client email, so nobody outside the team was invited.'}
              {p?.ok && <>Invite to #{p.channel} emailed to <b>{p.email}</b>.</>}
              {p && !p.ok && !p.skipped && <>Slack could not invite <b>{p.email}</b> by itself. In Slack, open <b>#{p.channel}</b>, <i>Add people</i>, paste the email, pick <i>guest</i>.</>}
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
        <div className="mt-5"><button type="button" className="editorial-btn-ghost" onClick={reset}>Start another deal</button></div>
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
      <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--ink-3)' }}>Defaults for step 2. Standard conditions are off unless you write some here.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Standard conditions: retainer" hint="Leave blank to add none. Anything here goes on every retainer contract." span><textarea rows={4} value={draft.conditions_retainer || ''} onChange={upd('conditions_retainer')} /></Field>
        <Field label="Standard conditions: trial" hint="Leave blank to add none." span><textarea rows={3} value={draft.conditions_trial || ''} onChange={upd('conditions_trial')} /></Field>
        {SETTING_FIELDS.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><input value={draft[key] || ''} onChange={upd(key)} /></Field>)}
      </div>
      <div className="mt-5 mb-2"><button type="button" className="editorial-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save settings'}</button></div>
    </details>
  )
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function CloserHub() {
  const { isAdmin, profile } = useAuth()
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
          <NewDeal settings={settings} onDone={bump} profile={profile} />
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
