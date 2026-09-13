import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Eye, EyeOff, Copy, Check, ExternalLink, Phone, Mail, Globe, Video, FolderOpen, FileText, User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import Modal from '../components/editorial/Modal'
import { ICON } from '../utils/constants'
import { CLOSER_TOOLS } from '../data/closerTools'
import { callCloserHub, loadCloserHubSettings, saveCloserHubSettings } from '../lib/closerHub'
import { listOpenDeals, listFinishedDeals, createDeal, updateDeal } from '../lib/closerHubDeals'

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
  ['template_active_ids', 'Templates shown in the picker', 'Comma-separated PandaDoc template ids. Templates with ACTIVE in their name show too.'],
  ['role_opt', 'Template role: OPT', 'Usually "Role 1".'],
  ['role_client', 'Template role: client', '"Client" on the retainer template.'],
  ['pay_link_us_trial', 'Payment link: US trial', ''],
  ['pay_link_us_monthly', 'Payment link: US monthly', ''],
  ['pay_link_au_trial', 'Payment link: AU trial', ''],
  ['pay_link_au_monthly', 'Payment link: AU monthly', ''],
  ['pay_link_nz_trial', 'Payment link: NZ trial', ''],
  ['pay_link_nz_monthly', 'Payment link: NZ monthly', ''],
  ['pay_link_us_quarterly', 'Payment link: US quarterly', ''],
  ['pay_link_au_quarterly', 'Payment link: AU quarterly', ''],
  ['pay_link_nz_quarterly', 'Payment link: NZ quarterly', ''],
  ['commas_login_url', 'Commas login', 'Where a closer goes to make a custom US link.'],
  ['simpleinvoice_login_url', 'Simple Invoice login', 'Where a closer goes to make a custom AU link.'],
  ['stripe_currency', 'Stripe currency', 'usd or aud. Used only for the Stripe fallback link.'],
  ['onboarding_page_url', 'Onboarding page link', 'The welcome page the client lands on.'],
  ['onboarding_calendar_url', 'Onboarding calendar link', 'Where the onboarding call is booked.'],
  ['notes_summariser_url', 'Call summariser link', 'The ChatGPT or Claude summariser used for post-call notes.'],
  ['ghl_location_id', 'GoHighLevel location id', 'Lets the checklist open the contact card directly.'],
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

/* Payment links, under Apps. Ben, 12 Sep 2026: "filter between Australia and
   New Zealand payment links. I have the trial link and then the monthly link.
   In case you need to make something custom, it can be logged in to go and
   make something custom." Links are Hub settings; the login is Commas. */
function PaymentLinks({ settings, copy, dealRegion }) {
  // US / AU / NZ only (Ben, 12 Sep 2026: "I don't want to have an All tab").
  // Follows the open deal's region, else the last one picked on this device.
  const [region, setRegionState] = useState(() => { try { return dealRegion || localStorage.getItem('closer-hub-pay-region') || 'us' } catch { return dealRegion || 'us' } })
  // The open deal's region is where the tab starts; a click always wins
  // (12 Sep 2026: the deal's region was overriding every click).
  useEffect(() => { if (dealRegion) setRegionState(dealRegion) }, [dealRegion])
  const setRegion = (r) => { setRegionState(r); try { localStorage.setItem('closer-hub-pay-region', r) } catch { /* fine */ } }
  const rows = REGIONS.flatMap(([r, label]) => [['trial', 'Trial'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly']].map(([k, kl]) => ({
    region: r, label: `${label} ${kl}`, url: settings[`pay_link_${r}_${k}`] || '',
  })))
  const shown = rows.filter(x => x.region === region)
  const login = settings.commas_login_url || 'https://www.fanbasis.com/login'
  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-2">
        <div className="flex gap-1">
          {REGIONS.map(([v, l]) => (
            <button key={v} type="button" className={region === v ? 'editorial-btn-primary' : 'editorial-btn-ghost'} style={{ height: 26, fontSize: 11.5, padding: '0 9px' }} onClick={() => setRegion(v)}>{l}</button>
          ))}
        </div>
      </div>
      {shown.map((x, i) => (
        <div key={x.region + x.label} className="flex items-center gap-2" style={{ padding: '8px 0', borderTop: i ? '1px solid var(--rule)' : 0, fontSize: 13 }}>
          <span style={{ fontWeight: 600, flex: 1 }}>{x.label}</span>
          {x.url ? <LinkButton label="Copy" url={x.url} copy={copy} /> : <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Not set</span>}
        </div>
      ))}
      <div className="flex gap-2 flex-wrap" style={{ paddingTop: 10, marginTop: 4, borderTop: '1px solid var(--rule)', fontSize: 12.5 }}>
        <span style={{ color: 'var(--ink-4)', alignSelf: 'center' }}>Custom link:</span>
        <a href={login} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12.5 }}>Commas (US) <ExternalLink size={ICON.sm} /></a>
        <a href={settings.simpleinvoice_login_url || 'https://simpleinvoices.io/'} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12.5 }}>Simple Invoice (AU) <ExternalLink size={ICON.sm} /></a>
      </div>
    </div>
  )
}

/* Case studies, under the payment links. Ben, 12 Sep 2026: "a section that
   has case studies so we can link to different case studies. Put Complete
   Flood as one, and have his contact number and his website." Stored as a
   list in Hub settings; admins add and remove rows here. */
/* The referral's logo: its site's favicon through Google's lookup service,
   so an admin can add a referral and it gets a logo with no build step.
   Letters if the site has none. Ben, 12 Sep 2026. */
function SiteLogo({ website, name }) {
  const [broken, setBroken] = useState(false)
  let host = ''
  try { host = new URL(/^https?:/.test(website || '') ? website : `https://${website || ''}`).hostname } catch { host = '' }
  const box = { width: 30, height: 30, borderRadius: 9, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
  if (host && !broken) {
    return (
      <span style={{ ...box, background: '#fff', border: '1px solid var(--rule)' }}>
        <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`} alt="" width={20} height={20} style={{ width: 20, height: 20, objectFit: 'contain', display: 'block' }} onError={() => setBroken(true)} />
      </span>
    )
  }
  const letters = (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return <span style={{ ...box, background: 'rgba(244,225,74,.55)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: 13, fontWeight: 500 }}>{letters}</span>
}

/* A referral's card. Ben, 13 Sep 2026: "a little pop-up. I can click on
   them, and it gives me a list of all their GMBs, their website, a client
   video they've recorded, their phone number or contact details." GMBs,
   website and contact come live from the client dashboard; the videos are
   links kept on the referral. */
function ReferralCard({ item: r, onClose, copy }) {
  const [card, setCard] = useState(undefined)
  useEffect(() => {
    let alive = true
    setCard(undefined)
    callCloserHub('client_card', { company: r.name, email: r.email || '' }).then(c => { if (alive) setCard(c) }).catch(() => { if (alive) setCard(null) })
    return () => { alive = false }
  }, [r])
  const cl = card?.client
  const gmbs = card?.gmbs || []
  const videos = (r.videos || []).filter(Boolean)
  const phone = cl?.phone || r.phone
  const email = cl?.email || r.email
  const website = cl?.website || r.website
  const contact = cl?.contact_name || r.contact
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
  const Row = ({ children, first }) => <div className="flex items-center gap-3 flex-wrap" style={{ padding: '9px 0', borderTop: first ? 0 : '1px solid var(--rule)', fontSize: 13 }}>{children}</div>
  const small = { height: 28, fontSize: 12, padding: '0 10px' }
  // A small icon badge at the start of each row, so the card reads at a glance.
  const Icon = ({ children, tone }) => (
    <span style={{ width: 28, height: 28, borderRadius: 8, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: tone === 'accent' ? 'rgba(244,225,74,.55)' : '#fff', border: tone === 'accent' ? 0 : '1px solid var(--rule)', color: 'var(--ink-2)' }}>{children}</span>
  )
  const GoogleMark = () => (
    <span style={{ width: 28, height: 28, borderRadius: 8, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: '1px solid var(--rule)' }}>
      <img src="https://www.google.com/s2/favicons?domain=business.google.com&sz=64" alt="" width={16} height={16} style={{ width: 16, height: 16, display: 'block' }} />
    </span>
  )
  return (
    <Modal open onClose={onClose} size="md" eyebrow="Referral" title={r.name}
      subtitle={[contact, cl?.city && cl?.state ? `${cl.city}, ${cl.state}` : r.location, cl?.account_manager ? `account manager ${cl.account_manager}` : null].filter(Boolean).join(' · ')}
      footer={<div className="flex justify-end"><button type="button" className="editorial-btn-ghost" onClick={onClose}>Close</button></div>}>
      <div style={{ padding: '18px 24px 6px' }}>
        {card === undefined && <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-4)' }}>Reading the client book.</p>}
        {card === null && <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--house-warn)' }}>The client dashboard did not answer; showing what the referral holds.</p>}
        {card && !cl && <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--house-warn)' }}>Not found in the client book under this name; showing what the referral holds.</p>}

        <Section title="Contact">
          <Row first><Icon tone="accent"><User size={14} /></Icon><span style={{ fontWeight: 600, flex: 1 }}>{contact || 'No contact name'}</span></Row>
          {phone && <Row><Icon><Phone size={14} /></Icon><span style={{ flex: 1 }}>{phone}</span><a href={`tel:${phone.replace(/[^0-9+]/g, '')}`} className="editorial-btn-primary" style={small}><Phone size={ICON.sm} /> Call</a><button type="button" className="editorial-btn-ghost" style={small} onClick={() => copy(phone)} title="Copy"><Copy size={ICON.sm} /></button></Row>}
          {email && <Row><Icon><Mail size={14} /></Icon><span style={{ flex: 1 }} className="truncate">{email}</span><a href={`mailto:${email}`} className="editorial-btn-ghost" style={small}><Mail size={ICON.sm} /> Email</a><button type="button" className="editorial-btn-ghost" style={small} onClick={() => copy(email)} title="Copy"><Copy size={ICON.sm} /></button></Row>}
          {!phone && !email && <Row><Icon><Phone size={14} /></Icon><span style={{ color: 'var(--ink-4)' }}>No phone or email on record.</span></Row>}
        </Section>

        <Section title="Website">
          {website
            ? <Row first><Icon><Globe size={14} /></Icon><span style={{ flex: 1 }} className="truncate">{website.replace(/^https?:\/\//, '')}</span><a href={website} target="_blank" rel="noopener" className="editorial-btn-ghost" style={small}>Open <ExternalLink size={ICON.sm} /></a><button type="button" className="editorial-btn-ghost" style={small} onClick={() => copy(website)} title="Copy"><Copy size={ICON.sm} /></button></Row>
            : <Row first><Icon><Globe size={14} /></Icon><span style={{ color: 'var(--ink-4)' }}>No website on record.</span></Row>}
        </Section>

        <Section title={`Google Business Profiles${gmbs.length ? ` (${gmbs.length})` : ''}`}>
          {gmbs.length === 0 && <Row first><GoogleMark /><span style={{ color: 'var(--ink-4)' }}>{cl ? 'None on record.' : 'Unknown until the client book answers.'}</span></Row>}
          {gmbs.map((g, i) => (
            <Row key={g.url || g.name} first={i === 0}>
              <GoogleMark />
              <div className="min-w-0 flex-1">
                <div style={{ fontWeight: 600 }} className="truncate">{g.name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-4)' }} className="truncate">{[g.address, g.type === 'cloud' ? 'added profile' : g.type === 'regular' ? 'their own' : g.type].filter(Boolean).join(' · ')}</div>
              </div>
              {g.status && <span className={`pill ${g.status === 'active' ? 'pill-up' : 'pill-soft'}`}>{g.status}</span>}
              {g.url && <a href={g.url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={small}>Maps <ExternalLink size={ICON.sm} /></a>}
            </Row>
          ))}
        </Section>

        <Section title={`Videos${videos.length ? ` (${videos.length})` : ''}`}>
          {videos.length === 0 && <Row first><Icon><Video size={14} /></Icon><span style={{ color: 'var(--ink-4)' }}>No videos added yet. An admin adds links on the referral.</span></Row>}
          {videos.map((v, i) => (
            <Row key={v} first={i === 0}><Icon><Video size={14} /></Icon><span style={{ flex: 1 }} className="truncate">{v.replace(/^https?:\/\//, '')}</span><a href={v} target="_blank" rel="noopener" className="editorial-btn-ghost" style={small}>Watch <ExternalLink size={ICON.sm} /></a><button type="button" className="editorial-btn-ghost" style={small} onClick={() => copy(v)}><Copy size={ICON.sm} /></button></Row>
          ))}
        </Section>

        {(r.link || cl?.drive_folder_url) && (
          <Section title="More">
            {r.link && <Row first><Icon><FileText size={14} /></Icon><span style={{ flex: 1 }}>Case study or review</span><a href={r.link} target="_blank" rel="noopener" className="editorial-btn-ghost" style={small}>Open <ExternalLink size={ICON.sm} /></a></Row>}
            {cl?.drive_folder_url && <Row first={!r.link}><Icon><FolderOpen size={14} /></Icon><span style={{ flex: 1 }}>Drive folder</span><a href={cl.drive_folder_url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={small}>Open <ExternalLink size={ICON.sm} /></a></Row>}
          </Section>
        )}
      </div>
    </Modal>
  )
}

function CaseStudies({ settings, copy, isAdmin, onSaved, dealRegion }) {
  const toast = useToast()
  const list = (() => { try { const v = JSON.parse(settings.case_studies || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } })()
  // USA / AU / NZ, like the payment links: the open deal's region to start, a click wins.
  const [region, setRegionState] = useState(() => { try { return dealRegion || localStorage.getItem('closer-hub-ref-region') || 'us' } catch { return dealRegion || 'us' } })
  useEffect(() => { if (dealRegion) setRegionState(dealRegion) }, [dealRegion])
  const setRegion = (r) => { setRegionState(r); try { localStorage.setItem('closer-hub-ref-region', r) } catch { /* fine */ } }
  const shown = list.map((c, i) => ({ ...c, _i: i })).filter(c => (c.region || 'us') === region)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState(null)
  const [draft, setDraft] = useState({ name: '', contact: '', phone: '', website: '', link: '', note: '', videos: '', region: 'us' })
  const persist = async (next) => {
    try { await saveCloserHubSettings({ case_studies: JSON.stringify(next) }); onSaved({ ...settings, case_studies: JSON.stringify(next) }); toast.success('Saved.') }
    catch (e) { toast.error(e.message) }
  }
  const add = async () => {
    if (!draft.name.trim()) return toast.error('A name at least.')
    const videos = String(draft.videos || '').split(/\n|,/).map(x => x.trim()).filter(Boolean)
    await persist([...list, { ...draft, videos, website: draft.website && !/^https?:/.test(draft.website) ? `https://${draft.website}` : draft.website }])
    setDraft({ name: '', contact: '', phone: '', website: '', link: '', note: '', videos: '', region }); setAdding(false)
  }
  const remove = (i) => persist(list.filter((_, k) => k !== i))
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex gap-1">
          {REGIONS.map(([v, l]) => (
            <button key={v} type="button" className={region === v ? 'editorial-btn-primary' : 'editorial-btn-ghost'} style={{ height: 26, fontSize: 11.5, padding: '0 9px' }} onClick={() => setRegion(v)}>{l}</button>
          ))}
        </div>
        {isAdmin && <button type="button" className="editorial-btn-ghost" style={{ height: 26, fontSize: 11.5, padding: '0 9px' }} onClick={() => setAdding(v => !v)}>{adding ? 'Cancel' : 'Add a referral'}</button>}
      </div>
      {shown.length === 0 && !adding && <div style={{ fontSize: 12.5, color: 'var(--ink-4)', padding: '6px 0' }}>No {REGIONS.find(([v]) => v === region)?.[1]} referrals yet.</div>}
      {shown.map((c, i) => (
        <div key={c.name + c._i} className="flex items-start gap-2" style={{ borderTop: i ? '1px solid var(--rule)' : 0 }}>
          {/* The whole row opens the card (Ben, 13 Sep 2026: "hover over this whole thing"). */}
          <button type="button" className="house-plain tile-hover min-w-0 flex-1" style={{ background: 'none', border: 0, padding: '10px 8px', margin: '2px -8px', borderRadius: 12, textAlign: 'left', cursor: 'pointer', color: 'inherit', fontSize: 13 }} onClick={() => setOpen(c)} title="Open their card">
            <div className="flex items-center gap-3">
              <SiteLogo website={c.website} name={c.name} />
              <div className="min-w-0 flex-1">
                <div style={{ fontWeight: 600 }} className="truncate">{c.name}</div>
                {(c.contact || c.location) && <div style={{ fontSize: 12, color: 'var(--ink-4)' }} className="truncate">{[c.contact, c.location].filter(Boolean).join(' · ')}</div>}
              </div>
              <ArrowUpRight size={ICON.md} style={{ color: 'var(--ink-4)', flex: 'none' }} />
            </div>
            {c.note && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, paddingLeft: 42 }}>{c.note}</div>}
            <div className="flex gap-2 flex-wrap mt-1" style={{ paddingLeft: 42, fontSize: 12, color: 'var(--ink-4)' }}>
              {c.phone && <span className="inline-flex items-center gap-1"><Phone size={ICON.sm} /> {c.phone}</span>}
              {c.website && <span className="inline-flex items-center gap-1"><Globe size={ICON.sm} /> {c.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>}
              {(c.videos || []).length > 0 && <span className="inline-flex items-center gap-1"><Video size={ICON.sm} /> {c.videos.length}</span>}
            </div>
          </button>
          {isAdmin && <button type="button" className="editorial-btn-ghost" style={{ height: 24, fontSize: 11, padding: '0 7px', marginTop: 10 }} onClick={() => remove(c._i)} title="Remove">×</button>}
        </div>
      ))}
      {open && <ReferralCard item={open} onClose={() => setOpen(null)} copy={copy} />}
      {adding && (
        <div className="grid gap-2 mt-2" style={{ paddingTop: 10, borderTop: '1px solid var(--rule)' }}>
          <select value={draft.region} onChange={(e) => setDraft(d => ({ ...d, region: e.target.value }))} style={{ height: 34, fontSize: 13 }}>
            {REGIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {[['name', 'Business'], ['contact', 'Contact name'], ['phone', 'Phone'], ['website', 'Website'], ['link', 'Case study or review link'], ['note', 'One line about them']].map(([k, l]) => (
            <input key={k} value={draft[k]} onChange={(e) => setDraft(d => ({ ...d, [k]: e.target.value }))} placeholder={l} style={{ height: 34, fontSize: 13 }} />
          ))}
          <textarea rows={2} value={draft.videos} onChange={(e) => setDraft(d => ({ ...d, videos: e.target.value }))} placeholder="Video links, one per line" style={{ fontSize: 13 }} />
          <div><button type="button" className="editorial-btn-primary" style={{ height: 30, fontSize: 12.5 }} onClick={add}>Save referral</button></div>
        </div>
      )}
    </div>
  )
}

function AppsPanel() {
  return <div>{CLOSER_TOOLS.map((t, i) => <AppLink key={t.key} tool={t} first={i === 0} />)}</div>
}

/* One side panel, three tabs. Ben, 12 Sep 2026: "make this a switchable tab
   which has apps, payment links, and referrals". */
const SIDE_TABS = [['apps', 'Apps'], ['pay', 'Payment links'], ['refs', 'Referrals']]

function SidePanel({ settings, copy, isAdmin, onSaved, dealRegion }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('closer-hub-side-tab') || 'apps' } catch { return 'apps' } })
  const pick = (t) => { setTab(t); try { localStorage.setItem('closer-hub-side-tab', t) } catch { /* fine */ } }
  return (
    <div className="tile" style={{ padding: '12px 18px 10px' }}>
      <div className="flex gap-1 mb-2" role="tablist">
        {SIDE_TABS.map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? 'editorial-btn-primary' : 'editorial-btn-ghost'} style={{ height: 30, fontSize: 12.5, padding: '0 12px' }} onClick={() => pick(v)}>{l}</button>
        ))}
      </div>
      {tab === 'apps' && <AppsPanel />}
      {tab === 'pay' && <PaymentLinks settings={settings} copy={copy} dealRegion={dealRegion} />}
      {tab === 'refs' && <CaseStudies settings={settings} copy={copy} isAdmin={isAdmin} onSaved={onSaved} dealRegion={dealRegion} />}
    </div>
  )
}

/* ── The deal as a checklist ───────────────────────────────────────────── */

const slugOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 73)
const BLANK = { company: '', email: '', name: '', offer: 'retainer', template: '', fee: '', extra: '', signer: '', region: 'us' }
const REGIONS = [['us', 'USA'], ['au', 'AU'], ['nz', 'NZ']]
const regionOf = (country) => { const c = String(country || '').toUpperCase(); return c === 'AU' || c === 'AUSTRALIA' ? 'au' : c === 'NZ' || c === 'NEW ZEALAND' ? 'nz' : 'us' }

// Ben's list, 12 Sep 2026, in his order.
// Ben's list, 12 Sep 2026, in his order. Channels and the card move are done
// by hand in Slack and GoHighLevel ("there should be no button for that one").
const STEPS = [
  ['payment', 'Take payment', 'Commas by default. Stripe only if Commas will not work for them. Ticks itself when the payment lands.'],
  ['contract', 'Send contract', 'Drafts it in PandaDoc and sends the signing links in one go. Draft only if you want to look first.'],
  ['channel_client', 'Make client channel', 'In Slack: client-<business>, private, the account-management team.'],
  ['channel_opt', 'Make opt channel and add the client', 'In Slack: opt-<business>, private, the team plus the client as a guest.'],
  ['form', 'Send onboarding form and book onboarding call', 'Send the page after payment, then book the kickoff for the next day. On a trial, forward-book the ascension call too.'],
  ['ghl', 'Move in GoHighLevel', 'Closed for a trial, New Map Closes for a retainer. This posts the close and starts onboarding.'],
  ['notes', 'Leave post-call notes in the Slack channel', 'Who they are, what they are like, what was promised. Run the recording through the summariser first.'],
  ['eod', 'Log end of day', 'Closes only count once they are in.'],
]

/* One control per link: the button copies it for the client, the small arrow
   opens it. Ben, 12 Sep 2026: "just have one calendar link ... merge those". */
function LinkButton({ label, url, copy, primary }) {
  return (
    <span className="inline-flex items-center">
      <button type="button" className={primary ? 'editorial-btn-primary' : 'editorial-btn-ghost'} style={{ height: 32, fontSize: 12.5, borderTopRightRadius: 0, borderBottomRightRadius: 0 }} onClick={() => copy(url)} title="Copy the link for the client">
        <Copy size={ICON.sm} /> {label}
      </button>
      <a href={url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5, padding: '0 9px', borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }} title="Open it"><ExternalLink size={ICON.sm} /></a>
    </span>
  )
}

/* Where the agreement is up to, at a glance: drafted, sent, opened, signed,
   with the times PandaDoc reports and who has signed. */
function ContractStrip({ c }) {
  const t = (iso) => iso ? new Date(iso).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  const signed = c.status === 'document.completed'
  const declined = c.status === 'document.declined' || c.status === 'document.voided'
  const opened = !!c.opened
  const tone = signed ? 'pill-up' : declined ? 'pill-down' : opened ? 'pill-accent' : c.sent ? 'pill-soft' : 'pill-flat'
  const word = signed ? 'Signed' : declined ? (c.status === 'document.declined' ? 'Declined' : 'Voided') : opened ? 'Opened' : c.sent ? 'Sent, not opened yet' : 'Drafted, not sent'
  const clientSigned = (c.recipients || []).find(r => (r.role || '').toLowerCase() === 'client' || r.role === 'Role 2')?.has_completed
  const optSigned = (c.recipients || []).find(r => r.role === 'Role 1' || (r.role || '').toLowerCase() === 'opt' || (r.role || '').toLowerCase() === 'creator')?.has_completed
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }} className="flex items-center gap-2 flex-wrap">
      <span className={`pill ${tone}`}>{word}</span>
      <span>{c.name}{c.opt_signer_name ? `, ${c.opt_signer_name} for OPT` : ''}.</span>
      {c.date_sent && <span>Sent {t(c.date_sent)}.</span>}
      {opened && !signed && c.date_modified && <span>Last activity {t(c.date_modified)}.</span>}
      {signed && c.date_completed && <span>Signed {t(c.date_completed)}.</span>}
      {c.sent && !signed && (c.recipients || []).length > 0 && <span>{clientSigned ? 'Client has signed' : 'Client has not signed'}{optSigned ? ', OPT has signed' : ''}.</span>}
      {!c.renamed && !c.sent && <span style={{ color: 'var(--house-warn)' }}>Check for a &quot;[DEV]&quot; prefix.</span>}
      {c.checked_at && <span style={{ color: 'var(--ink-4)' }}>Checked {t(c.checked_at)}.</span>}
    </div>
  )
}

function Tick({ on, auto, onChange }) {
  return (
    <label className="flex items-center" style={{ cursor: auto ? 'default' : 'pointer', flex: 'none' }} title={auto ? 'Ticks itself' : 'Tick when done'}>
      <input type="checkbox" checked={!!on} onChange={(e) => onChange?.(e.target.checked)} disabled={auto && on} />
    </label>
  )
}

function Deal({ settings, onDone, profile, user, onRegion }) {
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
        const mine = (user?.email || profile?.email || '').toLowerCase()
        if (mine && !list.some(m => (m.email || '').toLowerCase() === mine)) {
          list.unshift({ id: 'me', name: profile?.name || user?.name || mine, email: mine, role: 'admin', is_active: true })
        }
        setSigners(list)
      })
    listOpenDeals().then(setOpenDeals).catch(() => setOpenDeals([]))
  }, [profile?.email])  // eslint-disable-line react-hooks/exhaustive-deps

  // Whoever is logged in signs for OPT unless they pick someone else. Admin
  // profiles carry no email in the app, so the login email is the key
  // (12 Sep 2026: Ben's deals defaulted to Ahmad, first alphabetically).
  const meEmail = (user?.email || profile?.email || '').toLowerCase()
  useEffect(() => {
    if (!form.signer && signers.length) {
      const me = signers.find(m => (m.email || '').toLowerCase() === meEmail)
      setForm(f => ({ ...f, signer: (me || signers[0]).email }))
    }
  }, [signers, meEmail])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (deal) return
    setForm(f => ({ ...f, template: settings[`template_${f.offer}`] || '', fee: '' }))
  }, [form.offer, settings])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onRegion?.(form.region) }, [form.region])  // eslint-disable-line react-hooks/exhaustive-deps
  const fee = form.fee || settings[`fee_${form.offer}`] || ''
  const signer = signers.find(m => m.email === form.signer)
  const filled = form.company.trim().length > 0 && form.email.includes('@')
  const ready = !!deal   // Ben, 12 Sep 2026: the checklist opens once the deal is saved

  // Save: the deal row is created the first time the checklist is used and
  // updated on every change after that.
  const save = async (patch = {}) => {
    const fields = { company: form.company.trim(), email: form.email.trim().toLowerCase(), client_name: form.name.trim(), offer: form.offer,
      template: form.template, fee, extra: form.extra, signer_email: form.signer,
      data: { ...(deal?.data || {}), region: form.region, ...(contact && !(deal?.data || {}).ghl_contact ? { ghl_contact: contact } : {}) } }
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
      template: row.template || '', fee: row.fee || '', extra: row.extra || '', signer: row.signer_email || form.signer, region: row.data?.region || 'us' })
    setConfirmSend(false); setNote({}); setContact(row.data?.ghl_contact || null); setHits(null); setQ('')
  }
  const reset = () => { setContact(null); setHits(null); setQ(''); setDeal(null); setForm({ ...BLANK, signer: form.signer, template: settings.template_retainer || '' }); setConfirmSend(false); setNote({}) }
  const finish = async () => { const id = deal?.id; await save({ status: 'done' }); setOpenDeals(o => o.filter(x => x.id !== id)); reset(); toast.success('Deal finished and saved. On to the next one.') }

  const run = async (key, fn) => {
    setBusy(key)
    try { await fn() } catch (e) { toast.error(e.message); if (!['send', 'contract'].includes(key)) setNote(n => ({ ...n, [key]: { bad: e.message } })); else if (key === 'contract') setNote(n => ({ ...n, contract: { bad: e.message } })) }
    finally { setBusy('') }
  }

  const search = () => run('search', async () => {
    const r = await callCloserHub('ghl_search', { query: q })
    setHits(r.contacts || [])
  })
  // Search as you type, a beat after the last keystroke.
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) { setHits(null); return undefined }
    const t = setTimeout(() => { callCloserHub('ghl_search', { query: text }).then(r => setHits(r.contacts || [])).catch(() => setHits([])) }, 350)
    return () => clearTimeout(t)
  }, [q])
  const pickContact = (c) => {
    setContact(c); setHits(null); setQ('')
    setForm(f => ({ ...f, company: c.company || f.company || c.name, email: c.email || f.email, name: c.name || f.name, region: c.country ? regionOf(c.country) : f.region }))
  }

  // ── automations ──
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Copied.') } catch { toast.error('Copy blocked, select it by hand.') } }
  const commasLink = settings[`pay_link_${form.region}_${form.offer === 'trial' ? 'trial' : 'monthly'}`] || settings[`pay_link_${form.offer}`] || ''
  const stripe = () => run('stripe', async () => {
    const r = await callCloserHub('stripe_link', { company: form.company, email: form.email, offer: form.offer, fee })
    await record('stripe', r); setNote(n => ({ ...n, payment: { ok: `Stripe link made for $${r.amount}.` } }))
  })
  const checkPayment = () => run('paycheck', async () => {
    const r = await callCloserHub('payment_check', { email: form.email, since: deal?.created_at })
    if (r.paid) { await record('payment', r.payment, 'payment'); setNote(n => ({ ...n, payment: { ok: `Paid ${r.payment.amount} via ${r.payment.source}.` } })) }
    else setNote(n => ({ ...n, payment: { warn: 'No payment from that email yet.' } }))
  })
  // "Send and sign contract in one": draft, then send the signing links, one click.
  // The draft is saved on the deal the moment PandaDoc returns it, so a failed
  // send never loses the link (12 Sep 2026: a 403 on send did exactly that).
  const say = (text) => setNote(n => ({ ...n, contract: { info: text } }))
  const makeDraft = async () => {
    if (!form.template) throw new Error('Pick a contract template first.')
    if (!form.name.trim()) throw new Error('Client name is needed: it goes on the agreement as the person signing.')
    if (!signer) throw new Error('Pick who signs for OPT.')
    say('Drafting in PandaDoc. It fills the template and settles the draft, usually 10 to 30 seconds.')
    const r = await callCloserHub('create_contract', { company: form.company, email: form.email, signer_name: form.name, offer: form.offer, template: form.template,
      fee, extra_conditions: form.extra, opt_rep_name: signer?.name || '', opt_rep_email: signer?.email || '' })
    const row = await save({ data: { ...(deal?.data || {}), contract: { ...r, sent: false } } })
    say(`Drafted: ${r.name}. Open it in PandaDoc to review.`)
    return { r, row }
  }
  const sendDoc = async (docId, current) => {
    say('Sending the signing links from PandaDoc.')
    try {
      const sent = await callCloserHub('send_contract', { doc_id: docId, email: form.email })
      const st = await callCloserHub('contract_status', { doc_id: docId }).catch(() => ({}))
      await save({ data: { ...current, contract: { ...current.contract, sent: true, status: st.status || sent.status, word: st.word, opened: st.opened, recipients: st.recipients, signing_link: st.signing_link || null, date_sent: st.date_sent } }, ticks: { ...ticks, contract: true } })
      setConfirmSend(false); setNote(n => ({ ...n, contract: { ok: `Sent to ${form.email}. PandaDoc emailed the signing links.` } })); toast.success(`Contract sent to ${form.email}.`); onDone?.()
    } catch (e) {
      setConfirmSend(false)
      setNote(n => ({ ...n, contract: { bad: e.data?.code === 'outside_org'
        ? 'PandaDoc refused to send from the API: this key can only send inside our organisation. The draft is ready, so open it in PandaDoc and press Send there. A production API key makes this one click again.'
        : `Not sent: ${e.message}. The draft is kept; open it in PandaDoc.` } }))
      throw e
    }
  }
  const sendContract = () => run('send', async () => {
    const { r, row } = await makeDraft()
    await sendDoc(r.doc_id, row.data || {})
  })
  const draft = () => run('contract', async () => {
    const { r } = await makeDraft()
    setConfirmSend(false); toast.success('Drafted in PandaDoc.'); onDone?.()
    return r
  })
  const send = () => run('send', async () => { await sendDoc(d.contract.doc_id, d) })
  const refreshContract = async (quiet = false) => {
    if (!d.contract?.doc_id) return
    const r = await callCloserHub('contract_status', { doc_id: d.contract.doc_id })
    await save({ data: { ...d, contract: { ...d.contract, status: r.status, word: r.word, opened: r.opened, recipients: r.recipients, signing_link: r.signing_link || d.contract.signing_link || null,
      date_modified: r.date_modified, date_sent: r.date_sent, date_completed: r.date_completed, checked_at: new Date().toISOString() } } })
    if (!quiet) setNote(n => ({ ...n, contract: r.status === 'document.completed' ? { ok: 'Signed.' } : r.opened ? { ok: 'They have opened it.' } : { warn: `Not opened yet (${r.word}).` } }))
  }
  const checkSigned = () => run('signed', () => refreshContract(false))
  // Opening a deal from the list asks PandaDoc where the contract is up to.
  useEffect(() => {
    const c = deal?.data?.contract
    if (c?.doc_id && c.status !== 'document.completed' && c.status !== 'document.declined') refreshContract(true).catch(() => {})
  }, [deal?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  // While a sent contract is still unsigned, look again every minute.
  useEffect(() => {
    const c = deal?.data?.contract
    if (!c?.doc_id || !c.sent || c.status === 'document.completed' || c.status === 'document.declined' || c.status === 'document.voided') return undefined
    const t = setInterval(() => { refreshContract(true).catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [deal?.id, deal?.data?.contract?.doc_id, deal?.data?.contract?.sent, deal?.data?.contract?.status])  // eslint-disable-line react-hooks/exhaustive-deps

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
            {(deal || form.company) && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={reset}>New deal</button>}
          </div>
        </div>
        <div className="mb-4" style={{ position: 'relative', maxWidth: 520 }}>
          <Field label="Find the lead in GoHighLevel">
            <div className="flex items-center gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } if (e.key === 'Escape') setHits(null) }} placeholder="Start typing a name, company or email" style={{ flex: 1 }} autoComplete="off" />
              <button type="button" className="editorial-btn-ghost" style={{ height: 40 }} onClick={search} disabled={busy === 'search' || q.trim().length < 2}>{busy === 'search' ? 'Searching' : 'Search'}</button>
            </div>
          </Field>
          {contact && <div className="mt-2"><span className="pill pill-up" title={contact.id}>GoHighLevel: {contact.company || contact.name}</span></div>}
          {hits && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, marginTop: 6, background: '#fff', border: '1px solid var(--house-line-strong)', borderRadius: 'var(--house-radius-tile)', boxShadow: 'var(--house-shadow-tile)', padding: '4px 14px', maxHeight: 320, overflowY: 'auto' }}>
              {hits.length === 0 && <div style={{ padding: '10px 0', fontSize: 13, color: 'var(--ink-3)' }}>Nobody in GoHighLevel matches. Fill the fields in by hand.</div>}
              {hits.map((c, i) => (
                <button key={c.id} type="button" className="house-plain flex items-center gap-3 flex-wrap w-full" style={{ padding: '9px 0', borderTop: i ? '1px solid var(--rule)' : 0, fontSize: 13, background: 'none', border: 0, borderRadius: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }} onClick={() => pickContact(c)}>
                  <span style={{ fontWeight: 600 }}>{c.company || c.name || '(no name)'}</span>
                  {c.company && c.name && <span style={{ color: 'var(--ink-3)' }}>{c.name}</span>}
                  <span style={{ color: 'var(--ink-4)' }}>{c.email}{c.phone ? ` · ${c.phone}` : ''}{c.country ? ` · ${c.country}` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Company"><input value={form.company} onChange={set('company')} onBlur={() => deal && filled && save().catch(e => toast.error(e.message))} placeholder="Kings Roofing LLC" /></Field>
          <Field label="Client email"><input type="email" value={form.email} onChange={set('email')} onBlur={() => deal && filled && save().catch(e => toast.error(e.message))} placeholder="owner@kingsroofing.com" /></Field>
          <Field label="Client name" hint="The person who signs. Goes on the agreement."><input value={form.name} onChange={set('name')} onBlur={() => deal && filled && save().catch(e => toast.error(e.message))} placeholder="Jane Smith" /></Field>
          <Field label="Deal type">
            <select value={form.offer} onChange={(e) => setForm(f => ({ ...f, offer: e.target.value, template: settings[`template_${e.target.value}`] || '', fee: '' }))}>
              <option value="trial">Trial</option>
              <option value="retainer">Retainer</option>
            </select>
          </Field>
          <Field label="Region" hint="Picks the payment link. Set from the GoHighLevel contact's country.">
            <select value={form.region} onChange={set('region')}>
              {REGIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Contract template">
            <select value={form.template} onChange={set('template')}>
              <option value="">Pick one</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Signing for OPT">
            <select value={form.signer} onChange={(e) => { const v = e.target.value; setForm(f => ({ ...f, signer: v })); if (deal) updateDeal(deal.id, { signer_email: v }).then(setDeal).catch(err => toast.error(err.message)) }}>
              {signers.map(m => <option key={m.id} value={m.email}>{m.name}{m.is_active === false ? ' (inactive)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Monthly fee" hint="Change only with sign-off."><input inputMode="numeric" value={fee} onChange={set('fee')} /></Field>
          <Field label="Extra details" hint="Optional. Only goes into the contract if you write something."><input value={form.extra} onChange={set('extra')} placeholder="Anything extra on this deal" /></Field>
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap mt-5 pt-4" style={{ borderTop: '1px solid var(--rule)' }}>
          <span style={{ fontSize: 12.5, color: deal ? 'var(--ink-4)' : 'var(--house-warn)', fontWeight: deal ? 400 : 600 }}>
            {deal ? `Saved ${new Date(deal.updated_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}.` : filled ? 'Save the deal to open the checklist.' : 'Company and client email, then save.'}
          </span>
          <button type="button" className="editorial-btn-primary" onClick={() => save().then(() => toast.success(deal ? 'Deal saved.' : 'Deal saved. The checklist is open.')).catch(e => toast.error(e.message))} disabled={!filled || busy === 'save'}>{deal ? 'Save changes' : 'Save deal'}</button>
        </div>
        {openDeals.filter(x => x.id !== deal?.id).length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mt-4" style={{ fontSize: 12.5 }}>
            <span className="eyebrow">Open deals</span>
            {openDeals.filter(x => x.id !== deal?.id).map(x => (
              <button key={x.id} type="button" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12 }} onClick={() => load(x)}>
                {x.company}{x.data?.contract ? ` · contract ${x.data.contract.status === 'document.completed' ? 'signed' : x.data.contract.opened ? 'opened' : x.data.contract.sent ? 'sent, not opened' : 'drafted'}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* the checklist */}
      <div className="tile" style={{ padding: '22px 24px', ...(ready ? {} : { opacity: .55, pointerEvents: 'none' }) }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="eyebrow" style={{ margin: 0 }}>Checklist <span style={{ color: 'var(--ink-2)', letterSpacing: '.03em' }}>{doneCount}/{STEPS.length}</span></h2>
        </div>
        {STEPS.map(([key, title, hint], i) => {
          const n = note[key]
          const on = !!ticks[key]
          const auto = ['payment', 'contract'].includes(key)
          return (
            <div key={key} className="flex items-start gap-3" style={{ padding: '14px 0', borderTop: i ? '1px solid var(--rule)' : 0, opacity: on ? .72 : 1 }}>
              <div style={{ paddingTop: 2 }}><Tick on={on} auto={auto && on} onChange={(v) => tick(key, v).catch(e => toast.error(e.message))} /></div>
              <div className="min-w-0 flex-1">
                <div style={{ fontSize: 14.5, fontWeight: 600, textDecoration: on ? 'line-through' : 'none' }}>{title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 2 }}>{hint}</div>
                <div className="flex items-center gap-2 flex-wrap mt-2">
                  {key === 'payment' && (
                    <>
                      {commasLink ? <LinkButton label={`${form.region.toUpperCase()} ${form.offer === 'trial' ? 'trial' : 'monthly'} payment link`} url={commasLink} copy={copy} primary />
                                  : <span style={{ fontSize: 12.5, color: 'var(--house-warn)' }}>No {form.region.toUpperCase()} {form.offer === 'trial' ? 'trial' : 'monthly'} payment link set. Admin adds it in Hub settings.</span>}
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={stripe} disabled={busy === 'stripe'}>{busy === 'stripe' ? 'Making' : d.stripe ? 'New Stripe link' : 'Stripe link instead'}</button>
                      {d.stripe?.url && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(d.stripe.url)}>Copy Stripe link</button>}
                      {!on && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={checkPayment} disabled={busy === 'paycheck'}>{busy === 'paycheck' ? 'Checking' : 'Check for payment'}</button>}
                    </>
                  )}
                  {key === 'contract' && !d.contract?.doc_id && (
                    <>
                      <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={() => setConfirmSend(true)} disabled={busy === 'send' || busy === 'contract' || confirmSend}>{busy === 'send' ? 'Working' : 'Send contract'}</button>
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={draft} disabled={busy === 'contract' || busy === 'send'}>{busy === 'contract' ? 'Drafting' : 'Draft only'}</button>
                    </>
                  )}
                  {key === 'contract' && d.contract?.doc_id && !d.contract?.sent && (
                    <>
                      <button type="button" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={() => setConfirmSend(true)} disabled={busy === 'send' || confirmSend}>{busy === 'send' ? 'Sending' : `Send to ${form.email}`}</button>
                      <a href={d.contract.url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Review in PandaDoc <ExternalLink size={ICON.sm} /></a>
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={draft} disabled={busy === 'contract'}>{busy === 'contract' ? 'Drafting' : 'Draft again'}</button>
                    </>
                  )}
                  {key === 'contract' && d.contract?.sent && (
                    <>
                      <a href={d.contract.url} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open in PandaDoc <ExternalLink size={ICON.sm} /></a>
                      {d.contract.signing_link && <LinkButton label="Client signing link" url={d.contract.signing_link} copy={copy} />}
                      {d.contract.status !== 'document.completed' && <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={checkSigned} disabled={busy === 'signed'}>{busy === 'signed' ? 'Checking' : 'Refresh status'}</button>}
                    </>
                  )}
                  {key === 'contract' && confirmSend && !d.contract?.sent && (
                    <div className="flex items-center gap-2 flex-wrap w-full" style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--house-radius-input)', background: 'var(--paper-2)' }}>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{d.contract?.doc_id ? 'Emails' : 'Drafts it and emails'} the signing links now: <b>{signer?.name || 'nobody picked'}</b> signs for OPT, the client is <b>{form.name || 'no name yet'}</b> at <b>{form.email}</b>.</span>
                      <button type="button" className="editorial-btn-primary" style={{ height: 30, fontSize: 12.5 }} onClick={d.contract?.doc_id ? send : sendContract} disabled={busy === 'send'}>{busy === 'send' ? 'Working' : 'Yes, send'}</button>
                      <button type="button" className="editorial-btn-ghost" style={{ height: 30, fontSize: 12.5 }} onClick={() => setConfirmSend(false)}>Not yet</button>
                    </div>
                  )}
                  {key === 'channel_client' && <LinkButton label={`client-${slugOf(form.company)}`} url={`client-${slugOf(form.company)}`} copy={copy} />}
                  {key === 'channel_opt' && (
                    <>
                      <LinkButton label={`opt-${slugOf(form.company)}`} url={`opt-${slugOf(form.company)}`} copy={copy} />
                      <button type="button" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => copy(form.email)}><Copy size={ICON.sm} /> {form.email}</button>
                      <a href="https://app.slack.com/" target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open Slack <ExternalLink size={ICON.sm} /></a>
                    </>
                  )}
                  {key === 'ghl' && <a href={(d.ghl_contact || contact)?.id ? `https://app.gohighlevel.com/v2/location/${settings.ghl_location_id || ''}/contacts/detail/${(d.ghl_contact || contact).id}` : 'https://app.gohighlevel.com/'} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open in GoHighLevel <ExternalLink size={ICON.sm} /></a>}
                  {key === 'form' && (
                    <>
                      <LinkButton label="Onboarding page" url={settings.onboarding_page_url || 'https://onboard.optdigital.io/onboarding'} copy={copy} primary />
                      <LinkButton label="Onboarding calendar" url={settings.onboarding_calendar_url || 'https://calendly.com/d/dzy3-78x-dr3/opt-digital-onboarding'} copy={copy} />
                    </>
                  )}
                  {key === 'notes' && (
                    <>
                      {settings.notes_summariser_url
                        ? <a href={settings.notes_summariser_url} target="_blank" rel="noopener" className="editorial-btn-primary" style={{ height: 32, fontSize: 12.5 }}>Call summariser <ExternalLink size={ICON.sm} /></a>
                        : <span style={{ fontSize: 12.5, color: 'var(--house-warn)' }}>Summariser link not set. Admin adds it in Hub settings.</span>}
                      <a href="https://app.slack.com/" target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open Slack <ExternalLink size={ICON.sm} /></a>
                    </>
                  )}
                  {key === 'eod' && <Link to="/sales/eod" className="editorial-btn-ghost" style={{ height: 32, fontSize: 12.5 }}>Open End of Day</Link>}
                </div>
                {n?.info && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-2)' }}>{n.info}</div>}
                {n?.ok && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-good)' }}>{n.ok}</div>}
                {n?.warn && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-warn)' }}>{n.warn}</div>}
                {n?.bad && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--house-bad)' }}>{n.bad}</div>}
                {key === 'contract' && d.contract?.name && <ContractStrip c={d.contract} />}
              </div>
            </div>
          )
        })}
        <div className="flex items-center justify-between gap-3 flex-wrap mt-4 pt-4" style={{ borderTop: '1px solid var(--rule)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>Ticks save as you go.</span>
          <button type="button" className="editorial-btn-primary" onClick={finish} disabled={!deal}>Finish this deal</button>
        </div>
      </div>
    </div>
  )
}

/* ── Finished deals ────────────────────────────────────────────────────── */

function FinishedDeals({ refreshKey }) {
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState({})
  useEffect(() => {
    let alive = true
    listFinishedDeals(8).then(async (deals) => {
      if (!alive) return
      setRows(deals)
      // The client dashboard's view of each one: assignment, contract, onboarding call.
      for (const dl of deals.slice(0, 6)) {
        if (!dl.email && !dl.company) continue
        try {
          const st = await callCloserHub('deal_status', { email: dl.email, company: dl.company })
          if (alive) setStatus(m => ({ ...m, [dl.id]: st }))
        } catch { /* leave the row without it */ }
      }
    }).catch(() => setRows([]))
    return () => { alive = false }
  }, [refreshKey])
  if (rows.length === 0) return null
  const when = (iso) => iso ? new Date(iso).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <div className="tile" style={{ padding: '14px 18px 4px' }}>
      <h2 className="eyebrow" style={{ margin: '0 0 4px' }}>Finished deals</h2>
      {rows.map((r, i) => {
        const st = status[r.id]
        const contract = r.data?.contract
        const ch = r.data?.channels?.channels
        const contractUrl = contract?.url || st?.assignment?.contract_url
        return (
          <div key={r.id} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--rule)' : 0, fontSize: 13 }}>
            <div className="flex items-center gap-3 flex-wrap">
              <span style={{ fontWeight: 600 }}>{r.company}</span>
              <span className="pill pill-soft">{r.offer === 'trial' ? 'Trial' : 'Retainer'}</span>
              <span style={{ color: 'var(--ink-4)' }}>{r.closer_name} · finished {new Date(r.updated_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</span>
              <span className="flex-1" />
              {contractUrl && <a href={contractUrl} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12 }}>Contract{contract?.status === 'document.completed' ? ' (signed)' : contract?.opened ? ' (opened)' : contract?.sent ? ' (sent, not opened)' : ''}</a>}
              {ch?.external?.id && <a href={`https://slack.com/app_redirect?channel=${ch.external.id}`} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12 }}>#{ch.external.name}</a>}
              {st?.client?.slug && <a href={`https://dashboard.optdigital.io/company/assignments`} target="_blank" rel="noopener" className="editorial-btn-ghost" style={{ height: 28, fontSize: 12 }}>Assignments</a>}
            </div>
            <div style={{ marginTop: 4, color: 'var(--ink-3)', fontSize: 12.5 }}>
              {st === undefined && 'Checking the client dashboard.'}
              {st && !st.client && !st.assignment && 'Not in the client dashboard yet: it appears once the card is moved in GoHighLevel or Optimus is told the deal closed.'}
              {st?.client && <>In the client dashboard as <b>{st.client.name}</b>{st.account_manager ? `, account manager ${st.account_manager.name}` : ''}{st.assignment ? `, assignment ${st.assignment.status}` : ''}. </>}
              {st?.onboarding_call
                ? <>Onboarding call <b>{when(st.onboarding_call.start_time)}</b>{st.onboarding_call.join_url && <> <a href={st.onboarding_call.join_url} target="_blank" rel="noopener">Join</a></>}.</>
                : (st && (st.client || st.assignment) ? 'No onboarding call booked yet.' : '')}
            </div>
          </div>
        )
      })}
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
  const [dealRegion, setDealRegion] = useState('')
  const bump = () => setRefreshKey(k => k + 1)
  const copyLink = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Copied.') } catch { toast.error('Copy blocked, select it by hand.') } }

  useEffect(() => {
    loadCloserHubSettings().then(setSettings).catch((e) => toast.error(`Settings did not load: ${e.message}`))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Sales · Closer Hub</span>
        <h1 className="h2 mt-2">The <em>closer</em> hub.</h1>
        <p className="lede mt-2" style={{ fontSize: 14 }}>The deal as a checklist, with your apps, payment links and referrals beside it.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 grid gap-4">
          <Deal settings={settings} onDone={bump} profile={profile} user={{ id: session?.user?.id, name: profile?.name, email: profile?.email || session?.user?.email }} onRegion={setDealRegion} />
          <FinishedDeals refreshKey={refreshKey} />
          <Recent refreshKey={refreshKey} />
          {isAdmin && <SettingsSection settings={settings} onSaved={setSettings} />}
        </div>
        <div className="xl:sticky" style={{ top: 16 }}>
          <SidePanel settings={settings} copy={copyLink} isAdmin={isAdmin} onSaved={setSettings} dealRegion={dealRegion} />
        </div>
      </div>
    </div>
  )
}
