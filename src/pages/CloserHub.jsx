import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Eye, EyeOff, Copy, Check, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import { ICON } from '../utils/constants'
import { CLOSER_TOOLS } from '../data/closerTools'
import { callCloserHub, loadCloserHubSettings, saveCloserHubSettings } from '../lib/closerHub'
import { listOpenDeals, createDeal, updateDeal } from '../lib/closerHubDeals'

/* Closer Hub (Ben, 12 Sep 2026). No pop-ups: "I want everything in here in
   one hub." The main column is the deal as a saved checklist in the SOP's
   order (payment, contract, channels, guest, GHL card, form, notes, EOD,
   kickoff): the hub does what it can with a button and the rest are
   tickboxes. A narrow side panel holds the app links. Closers and admins
   only (CloserRoute). */

const SETTING_FIELDS = [
  ['opt_rep_name', 'Fallback OPT signer name', 'Used only if nobody is picked in step 2.'],
  ['opt_rep_email', 'Fallback OPT signer email', ''],
  ['fee_retainer', 'Retainer fee (monthly)', 'Digits only.'],
  ['fee_trial', 'Trial fee', 'Digits only.'],
  ['template_retainer', 'PandaDoc template: retainer', 'The default picked when the deal type is Retainer.'],
  ['template_trial', 'PandaDoc template: trial', 'The default picked when the deal type is Trial.'],
  ['role_opt', 'Template role: OPT', 'Usually "Role 1".'],
  ['role_client', 'Template role: client', '"Client" on the retainer template.'],
  ['pay_link_trial', 'Commas checkout link: trial', 'The Commas (FanBasis) checkout page for the $997 trial.'],
  ['pay_link_retainer', 'Commas checkout link: retainer', 'The Commas checkout page for the retainer.'],
  ['stripe_currency', 'Stripe currency', 'usd or aud. Used only for the Stripe fallback link.'],
  ['onboarding_form_url', 'Onboarding form link', ''],
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

/* ── The deal as a checklist ───────────────────────────────────────────── */

const BLANK = { company: '', email: '', name: '', offer: 'retainer', template: '', fee: '', extra: '', signer: '' }

const STEPS = [
  ['payment', 'Take payment', 'Commas by default. Stripe only if Commas will not work for them. Ticks itself when the payment lands.'],
  ['contract', 'Contract drafted and sent', 'Draft first, look it over, then send. Ticks itself when sent.'],
  ['signed', 'Contract signed', 'Checked against PandaDoc.'],
  ['channels', 'Slack channels made', 'client- for the team, opt- for the team and the client.'],
  ['guest', 'Client added to opt- as a guest', 'By hand in Slack: open the channel, Add people, paste the email, choose Guest.'],
  ['ghl', 'Card moved in GoHighLevel', 'Closed for a trial, New Map Closes for a retainer. This is what posts the close and starts onboarding.'],
  ['form', 'Onboarding form sent', 'Send the link after payment. Pre-fill what you can.'],
  ['notes', 'Notes and Fathom transcript on the card', 'Who they are, what they are like, the transcript for the account manager.'],
  ['eod', 'Logged in End of Day', 'Closes only count once they are in.'],
  ['kickoff', 'Kickoff booked', 'Next day. On a trial, forward-book the ascension call too.'],
]

function Tick({ on, auto, onChange }) {
  return (
    <label className="flex items-center" style={{ cursor: auto ? 'default' : 'pointer', flex: 'none' }} title={auto ? 'Ticks itself' : 'Tick when done'}>
      <input type="checkbox" checked={!!on} onChange={(e) => onChange?.(e.target.checked)} disabled={auto && on} />
    </label>
  )
}

function Deal({ settings, onDone, profile, user }) {
  const toast = useToast()
  const [deal, setDeal] = useState(null)          // the saved row
  const [form, setForm] = useState(BLANK)
  const [templates, setTemplates] = useState([])
  const [signers, setSigners] = useState([])
  const [openDeals, setOpenDeals] = useState([])
  const [busy, setBusy] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const [note, setNote] = useState({})
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const [contact, setContact] = useState(null)   // the GoHighLevel contact picked in step 1
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const d = deal?.data || {}
  const ticks = deal?.ticks || {}

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
    listOpenDeals().then(setOpenDeals).catch(() => setOpenDeals([]))
  }, [profile?.email])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.signer && signers.length) {
      const me = signers.find(m => (m.email || '').toLowerCase() === (profile?.email || '').toLowerCase())
      setForm(f => ({ ...f, signer: (me || signers[0]).email }))
    }
  }, [signers, profile?.email])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (deal) return
    setForm(f => ({ ...f, template: settings[`template_${f.offer}`] || '', fee: '' }))
  }, [form.offer, settings])  // eslint-disable-line react-hooks/exhaustive-deps

  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const signer = signers.find(m => m.email === form.signer)
  const ready = form.company.trim().length > 0 && form.email.includes('@')

  // Save: the deal row is created the first time the checklist is used and
  // updated on every change after that.
  const save = async (patch = {}) => {
    const fields = { company: form.company.trim(), email: form.email.trim().toLowerCase(), client_name: form.name.trim(), offer: form.offer,
      template: form.template, fee, extra: form.extra, signer_email: form.signer,
      ...(contact && !(deal?.data || {}).ghl_contact ? { data: { ...(deal?.data || {}), ghl_contact: contact } } : {}) }
    if (!deal) {
      const row = await createDeal({ ...fields, ...patch }, user)
      setDeal(row); setOpenDeals(o => [row, ...o.filter(x => x.id !== row.id)])
      return row
    }
    const row = await updateDeal(deal.id, { ...fields, ...patch })
    setDeal(row); setOpenDeals(o => o.map(x => x.id === row.id ? row : x))
    return row
  }
  const tick = async (key, on) => { const row = await save({ ticks: { ...ticks, [key]: on } }); return row }
  const record = async (key, value, tickIt) => save({ data: { ...d, [key]: value }, ...(tickIt ? { ticks: { ...ticks, [tickIt]: true } } : {}) })

  const load = (row) => {
    setDeal(row)
    setForm({ company: row.company || '', email: row.email || '', name: row.client_name || '', offer: row.offer || 'retainer',
      template: row.template || '', fee: row.fee || '', extra: row.extra || '', signer: row.signer_email || form.signer })
    setConfirmSend(false); setNote({}); setContact(row.data?.ghl_contact || null); setHits(null); setQ('')
  }
  const reset = () => { setContact(null); setHits(null); setQ(''); setDeal(null); setForm({ ...BLANK, signer: form.signer, template: settings.template_retainer || '' }); setConfirmSend(false); setNote({}) }
  const finish = async () => { await save({ status: 'done' }); setOpenDeals(o => o.filter(x => x.id !== deal?.id)); reset(); toast.success('Deal closed off.') }

  const run = async (key, fn) => {
    setBusy(key)
    try { await fn() } catch (e) { toast.error(e.message); setNote(n => ({ ...n, [key]: { bad: e.message } })) }
    finally { setBusy('') }
  }

  const search = () => run('search', async () => {
    const r = await callCloserHub('ghl_search', { query: q })
    setHits(r.contacts || [])
  })
  const pickContact = (c) => {
    setContact(c); setHits(null); setQ('')
    setForm(f => ({ ...f, company: c.company || f.company || c.name, email: c.email || f.email, name: c.name || f.name }))
  }

  // ── automations ──
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Copied.') } catch { toast.error('Copy blocked, select it by hand.') } }
  const commasLink = settings[`pay_link_${form.offer}`] || ''
  const stripe = () => run('stripe', async () => {
    const r = await callCloserHub('stripe_link', { company: form.company, email: form.email, offer: form.offer, fee })
    await record('stripe', r); setNote(n => ({ ...n, payment: { ok: `Stripe link made for $${r.amount}.` } }))
  })
  const checkPayment = () => run('paycheck', async () => {
    const r = await callCloserHub('payment_check', { email: form.email, since: deal?.created_at })
    if (r.paid) { await record('payment', r.payment, 'payment'); setNote(n => ({ ...n, payment: { ok: `Paid ${r.payment.amount} via ${r.payment.source}.` } })) }
    else setNote(n => ({ ...n, payment: { warn: 'No payment from that email yet.' } }))
  })
  const draft = () => run('contract', async () => {
    if (!form.template) throw new Error('Pick a contract template first.')
    const r = await callCloserHub('create_contract', { company: form.company, email: form.email, signer_name: form.name, offer: form.offer, template: form.template,
      fee, extra_conditions: form.extra, opt_rep_name: signer?.name || '', opt_rep_email: signer?.email || '' })
    await record('contract', r); setConfirmSend(false); toast.success('Drafted in PandaDoc.'); onDone?.()
  })
  const send = () => run('send', async () => {
    const r = await callCloserHub('send_contract', { doc_id: d.contract.doc_id, email: form.email })
    await save({ data: { ...d, contract: { ...d.contract, sent: true, status: r.status } }, ticks: { ...ticks, contract: true } })
    setConfirmSend(false); toast.success(`Sent to ${form.email}.`); onDone?.()
  })
  const checkSigned = () => run('signed', async () => {
    const r = await callCloserHub('contract_status', { doc_id: d.contract.doc_id })
    if (r.status === 'document.completed') { await save({ data: { ...d, contract: { ...d.contract, status: r.status } }, ticks: { ...ticks, signed: true } }); setNote(n => ({ ...n, signed: { ok: 'Signed.' } })) }
    else setNote(n => ({ ...n, signed: { warn: `Not yet: ${r.status.replace('document.', '')}.` } }))
  })
  const make = () => run('channels', async () => {
    const r = await callCloserHub('make_channel', { company: form.company, email: form.email, prospect_name: form.name })
    await record('channels', r, 'channels'); toast.success('Channels ready.'); onDone?.()
  })
  const moveCard = () => run('ghl', async () => {
    const r = await callCloserHub('ghl_move', { email: form.email, offer: form.offer, contact_id: (d.ghl_contact || contact)?.id })
    await record('ghl', r, r.ok ? 'ghl' : undefined)
    setNote(n => ({ ...n, ghl: r.ok ? { ok: r.already ? r.message : `Moved to ${r.stage} (${r.region}).` } : { warn: r.message } }))
  })

  const ch = d.channels?.channels
  const p = d.channels?.prospect
  const doneCount = STEPS.filter(([k]) => ticks[k]).length

  return (
    <div className="grid gap-4">
      {/* the deal */}
      <div className="tile" style={{ padding: '22px 24px' }}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="eyebrow" style={{ margin: 0 }}>{deal ? 'This deal' : 'New deal'}</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>Find the lead in GoHighLevel or type it in. Company, the client&apos;s email, trial or retainer.</p>
          </div>
          <div className="flex gap-2">
            {deal && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={finish}>Close off</button>}
            {(deal || form.company) && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={reset}>New deal</button>}
          </div>
        </div>
        <div className="flex items-end gap-2 mb-4">
          <Field label="Find the lead in GoHighLevel">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }} placeholder="Name, company or email" style={{ minWidth: 260 }} />
          </Field>
          <button type="button" className="editorial-btn-ghost" style={{ height: 40 }} onClick={search} disabled={busy === 'search' || q.trim().length < 2}>{busy === 'search' ? 'Searching' : 'Search'}</button>
          {contact && <span className="pill pill-up" title={contact.id}>GoHighLevel: {contact.name || contact.company}</span>}
        </div>
        {hits && (
          <div className="mb-4" style={{ border: '1px solid var(--rule)', borderRadius: 'var(--house-radius-tile)', padding: '4px 14px' }}>
            {hits.length === 0 && <div style={{ padding: '10px 0', fontSize: 13, color: 'var(--ink-3)' }}>Nobody in GoHighLevel matches. Fill the fields in by hand.</div>}
            {hits.map((c, i) => (
              <div key={c.id} className="flex items-center gap-3 flex-wrap" style={{ padding: '9px 0', borderTop: i ? '1px solid var(--rule)' : 0, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{c.name || '(no name)'}</span>
                <span style={{ color: 'var(--ink-3)' }}>{c.company}</span>
                <span style={{ color: 'var(--ink-4)' }}>{c.email}{c.phone ? ` · ${c.phone}` : ''}{c.country ? ` · ${c.country}` : ''}</span>
                <span className="flex-1" />
                <button type="button" className="editorial-btn-primary" style={{ height: 28, fontSize: 12 }} onClick={() => pickContact(c)}>Use</button>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Company"><input value={form.company} onChange={set('company')} onBlur={() => ready && save().catch(e => toast.error(e.message))} placeholder="Kings Roofing LLC" /></Field>
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} onBlur={() => ready && save().catch(e => toast.error(e.message))} placeholder="owner@kingsroofing.com" /></Field>
          <Field label="Client name" hint="Optional. They can type it when signing."><input value={form.name} onChange={set('name')} placeholder="Jane Smith" /></Field>
          <Field label="Deal type">
            <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value, template: settings[`template_${e.target.value}`] || '', fee: '' }))}>
              <option value="trial">Trial</option>
              <option value="retainer">Retainer</option>
            </select>
          </Field>
          <Field label="Contract template">
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
        </div>
        {openDeals.filter(x => x.id !== deal?.id).length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mt-4" style={{ fontSize: 12.5 }}>
            <span className="eyebrow">Open deals</span>
            {openDeals.filter(x => x.id !== deal?.id).map(x => (
              <button key={x.id} type="button" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12 }} onClick={() => load(x)}>{x.company}</button>
            ))}
          </div>
        )}
      </div>

      {/* the checklist */}
      <div className="tile" style={{ padding: '22px 24px', ...(ready ? {} : { opacity: .55, pointerEvents: 'none' }) }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="eyebrow" style={{ margin: 0 }}>Checklist <span style={{ color: 'var(--ink-2)', letterSpacing: '.03em' }}>{doneCount}/{STEPS.length}</span></h2>
          {deal && <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Saved. Pick it up again from Open deals.</span>}
        </div>
        {STEPS.map(([key, title, hint], i) => {
          const n = note[key]
          const on = !!ticks[key]
          const auto = ['payment', 'contract', 'signed', 'channels', 'ghl'].includes(key)
          return (
            <div key={key} className="flex items-start gap-3" style={{ padding: '14px 0', borderTop: i ? '1px solid var(--rule)' : 0, opacity: on ? .72 : 1 }}>
              <div style={{ paddingTop: 2 }}><Tick on={on} auto={auto && on} onChange={(v) => tick(key, v).catch(e => toast.error(e.message))} /></div>
              <div className="min-w-0 flex-1">
                <div style={{ fontSize: 14.5, fontWeight: 600, textDecoration: on ? 'line-through' : 'none' }}>{title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 2 }}>{hint}</div>
                <div className="flex items-center gap-2 flex-wrap mt-2">
                  {key === 'payment' && (
                    <>
                      {commasLink ? <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(commasLink)}>Copy Commas link</button>
                                  : <span style={{ fontSize: 12.5, color: 'var(--house-warn)' }}>No Commas link set for {form.offer}s. Admin adds it in Hub settings.</span>}
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={stripe} disabled={busy === 'stripe'}>{busy === 'stripe' ? 'Making' : d.stripe ? 'New Stripe link' : 'Stripe link instead'}</button>
                      {d.stripe?.url && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(d.stripe.url)}>Copy Stripe link</button>}
                      {!on && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={checkPayment} disabled={busy === 'paycheck'}>{busy === 'paycheck' ? 'Checking' : 'Check for payment'}</button>}
                    </>
                  )}
                  {key === 'contract' && (
                    <>
                      <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={draft} disabled={busy === 'contract'}>{busy === 'contract' ? 'Drafting' : d.contract?.doc_id ? 'Draft again' : 'Draft the contract'}</button>
                      {d.contract?.url && <a href={d.contract.url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open in PandaDoc <ExternalLink size={ICON.sm} /></a>}
                      {d.contract?.doc_id && !d.contract?.sent && !confirmSend && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => setConfirmSend(true)}>Send to {form.email}</button>}
                      {confirmSend && !d.contract?.sent && (
                        <>
                          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Emails the signing links now. Sure?</span>
                          <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={send} disabled={busy === 'send'}>{busy === 'send' ? 'Sending' : 'Yes, send'}</button>
                          <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => setConfirmSend(false)}>Not yet</button>
                        </>
                      )}
                    </>
                  )}
                  {key === 'signed' && d.contract?.doc_id && !on && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={checkSigned} disabled={busy === 'signed'}>{busy === 'signed' ? 'Checking' : 'Check PandaDoc'}</button>}
                  {key === 'channels' && (
                    <>
                      <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={make} disabled={busy === 'channels'}>{busy === 'channels' ? 'Making' : ch ? 'Make again' : 'Make the channels'}</button>
                      {ch && ['internal', 'external'].map(k => ch[k]?.id && <a key={k} href={`https://slack.com/app_redirect?channel=${ch[k].id}`} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>#{ch[k].name}</a>)}
                    </>
                  )}
                  {key === 'guest' && (
                    <>
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(form.email)}>Copy {form.email}</button>
                      {ch?.external?.id && <a href={`https://slack.com/app_redirect?channel=${ch.external.id}`} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open #{ch.external.name}</a>}
                      {p?.ok && <span style={{ fontSize: 12.5, color: 'var(--house-good)' }}>Slack emailed them an invite.</span>}
                    </>
                  )}
                  {key === 'ghl' && (
                    <>
                      <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={moveCard} disabled={busy === 'ghl' || on}>{busy === 'ghl' ? 'Moving' : 'Move the card'}</button>
                      <a href="https://app.gohighlevel.com/" target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open GoHighLevel</a>
                    </>
                  )}
                  {key === 'form' && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(settings.onboarding_form_url || 'https://onboard.optdigital.io/onboardingwd')}>Copy form link</button>}
                  {key === 'notes' && <a href="https://app.gohighlevel.com/" target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open the card</a>}
                  {key === 'eod' && <Link to="/sales/eod" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open End of Day</Link>}
                </div>
                {n?.ok && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-good)' }}>{n.ok}</div>}
                {n?.warn && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-warn)' }}>{n.warn}</div>}
                {n?.bad && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-bad)' }}>{n.bad}</div>}
                {key === 'contract' && d.contract?.name && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-3)' }}>{d.contract.name}{d.contract.opt_signer_name ? `, ${d.contract.opt_signer_name} signing for OPT` : ''}{d.contract.sent ? ', sent' : ', drafted'}.{!d.contract.renamed && !d.contract.sent ? ' Check for a "[DEV]" prefix.' : ''}</div>}
                {key === 'channels' && p && !p.ok && !p.skipped && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-3)' }}>Slack cannot invite the client by itself on our plan: add them as a guest in the next step.</div>}
                {key === 'ghl' && d.ghl?.candidates?.length > 1 && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-3)' }}>{d.ghl.candidates.map(c => `${c.name || c.id} (${c.region})`).join(', ')}</div>}
              </div>
            </div>
          )
        })}
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
  const { isAdmin, profile, session } = useAuth()
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
        <p className="lede mt-2" style={{ fontSize: 14 }}>The deal as a checklist, with your apps beside it.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 grid gap-4">
          <Deal settings={settings} onDone={bump} profile={profile} user={{ id: session?.user?.id, name: profile?.name, email: profile?.email || session?.user?.email }} />
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
