import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, KeyRound, Link2, CalendarCheck, PhoneCall, MessageSquare, Save, RefreshCw, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import { BASE_URL, GHL_LOCATION_ID, ghlFetch } from '../services/ghlClient'
import Dropdown from '../components/Dropdown'
import ConfirmModal from '../components/ConfirmModal'
import { ICON } from '../utils/constants'
import { ROLE_OPTIONS, initialsOf, ConnectionPill, RolePill, sendDashboardInvite, resolveSlackUser, offboardTeamMember } from '../lib/teamShared'

/*
  One person, four connections, each its own card with its own Save:

    1. Dashboard login   -> Supabase auth user (invite email)
    2. GoHighLevel user  -> team_members.ghl_user_id (picked from the GHL
                            user list when the API allows it, typed otherwise)
    3. Calendar          -> bookings are matched through that GHL user, so
                            "Check calendar" pulls their next 30 days of
                            events and proves the link end to end
    4. WAVV dialer       -> team_members.wavv_user_id (setters)

  Every card explains, in one line, what the connection is used for.
*/

function Card({ icon: Icon, title, sub, ok, step, children }) {
  return (
    <section className="tile" style={{ padding: '22px 24px' }}>
      <div className="flex items-start gap-3 mb-4">
        <span style={{ width: 38, height: 38, borderRadius: 12, background: 'rgba(244,225,74,.55)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Icon size={ICON.md} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="eyebrow" style={{ margin: 0 }}>{step ? `Step ${step} · ` : ''}{title}</h2>
            <ConnectionPill ok={ok} label={ok ? 'Connected' : 'Not connected'} />
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>{sub}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

export default function TeamMemberPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const { push: toast } = useToast()
  const [m, setM] = useState(null)
  const [loading, setLoading] = useState(true)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmOffboard, setConfirmOffboard] = useState(false)
  const [offboardReason, setOffboardReason] = useState('')
  const [offboarding, setOffboarding] = useState(false)

  const load = async () => {
    const { data, error } = await supabase.from('team_members').select('*').eq('id', id).single()
    if (error) toast({ kind: 'error', title: 'Could not load this person', message: error.message })
    setM(data || null)
    setLoading(false)
  }
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch, okMessage) => {
    const { error } = await supabase.from('team_members').update(patch).eq('id', id)
    if (error) { toast({ kind: 'error', title: 'Save failed', message: error.message }); return false }
    setM(prev => ({ ...prev, ...patch }))
    if (okMessage) toast({ kind: 'success', title: 'Saved', message: okMessage })
    return true
  }

  if (loading) return <div className="animate-pulse"><div className="tile h-24 mb-4" /><div className="tile h-48" /></div>
  if (!m) return (
    <div className="w-full">
      <div className="placeholder-card">That person is not on the roster. <Link to="/sales/team" style={{ textDecoration: 'underline' }}>Back to the team</Link>.</div>
    </div>
  )

  const inactive = m.is_active === false
  const former = !!m.offboarded_at

  return (
    <div className="w-full">
      <Link to="/sales/team" className="editorial-btn-ghost" style={{ height: 34, fontSize: 12.5, marginBottom: 18 }}>
        <ArrowLeft size={ICON.sm} /> Team
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-4">
          <div style={{ width: 62, height: 62, borderRadius: 18, background: 'rgba(244,225,74,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500 }}>
            {initialsOf(m.name)}
          </div>
          <div>
            <span className="eyebrow eyebrow-accent">OPT Sales · Team</span>
            <h1 className="h2 mt-1" style={{ fontSize: 'clamp(28px, 3vw, 38px)' }}>{m.name}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <RolePill role={m.role} />
              {former
              ? <span className="pill" style={{ borderColor: 'var(--house-line-strong)', color: 'var(--ink-2)' }}>Former team member</span>
              : inactive && <span className="pill">Paused</span>}
              {m.email && <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>{m.email}</span>}
            </div>
          </div>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            {(m.role === 'closer' || m.role === 'setter') && (
              <Link to={`/sales/${m.role}s/${m.id}`} className="editorial-btn-ghost">Performance <ArrowLeft size={ICON.sm} style={{ transform: 'rotate(135deg)' }} /></Link>
            )}
            {former ? (
              <button type="button" className="editorial-btn-primary" disabled={offboarding} onClick={async () => {
                setOffboarding(true)
                try {
                  await offboardTeamMember(m.id, null, true)
                  toast({ kind: 'success', title: `${m.name} is back`, message: 'Their login works again and they are back on the rosters.' })
                  await load()
                } catch (err) { toast({ kind: 'error', title: 'Could not reinstate them', message: err.message }) }
                setOffboarding(false)
              }}>Reinstate</button>
            ) : (
              <>
                {inactive
                  ? <button type="button" className="editorial-btn-ghost" onClick={() => save({ is_active: true }, `${m.name} is active again.`)}>Unpause</button>
                  : <button type="button" className="editorial-btn-ghost" onClick={() => setConfirmDeactivate(true)}>Pause</button>}
                <button type="button" className="editorial-btn-ghost" style={{ color: 'var(--house-bad)' }} onClick={() => { setOffboardReason(''); setConfirmOffboard(true) }}>Offboard</button>
              </>
            )}
          </div>
        )}
      </div>

      {former && (
        <div className="callout" style={{ marginBottom: 16, borderLeftColor: 'var(--house-bad)' }}>
          <b>{m.name} has left.</b> Offboarded {new Date(m.offboarded_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })}
          {m.offboard_reason ? ` — ${m.offboard_reason}` : ''}. Their login is blocked and they are off every roster and rotation.
          Everything they logged is kept and still counts on the historical pages.
        </div>
      )}
      {!former && <OnboardingStrip m={m} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProfileCard m={m} save={save} canEdit={isAdmin} />
        <LoginCard m={m} canEdit={isAdmin} reload={load} />
        <GhlCard m={m} save={save} canEdit={isAdmin} />
        <CalendarCard m={m} />
        {m.role === 'setter' && <WavvCard m={m} save={save} canEdit={isAdmin} />}
        <SlackCard m={m} save={save} canEdit={isAdmin} reload={load} />
      </div>

      <ConfirmModal
        open={confirmOffboard}
        onClose={() => !offboarding && setConfirmOffboard(false)}
        loading={offboarding}
        confirmLabel="Offboard"
        title={`Offboard ${m.name}?`}
        message="They will be signed out now and will not be able to sign in again. They come off the leaderboards, the rotations and the EOD chase list. Every EOD, call and booking they logged is kept, and their history still shows on the closer and setter pages."
        onConfirm={async () => {
          setOffboarding(true)
          try {
            const res = await offboardTeamMember(m.id, offboardReason, false)
            const bits = []
            if (res?.sessions_ended) bits.push(`signed out of ${res.sessions_ended} session${res.sessions_ended === 1 ? '' : 's'}`)
            if (res?.future_appointments) bits.push(`${res.future_appointments} upcoming call${res.future_appointments === 1 ? '' : 's'} still assigned to them`)
            if (res?.unconfirmed_eods) bits.push(`${res.unconfirmed_eods} unconfirmed EOD${res.unconfirmed_eods === 1 ? '' : 's'}`)
            toast({ kind: 'success', title: `${m.name} is offboarded`, message: bits.length ? bits.join(' · ') : 'Login blocked. Their history is kept.' })
            setConfirmOffboard(false)
            await load()
          } catch (err) {
            toast({ kind: 'error', title: 'Could not offboard them', message: err.message })
          }
          setOffboarding(false)
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Reason (optional)</span>
          <input type="text" value={offboardReason} onChange={e => setOffboardReason(e.target.value)} placeholder="e.g. left the business, 6 Sep 2026" disabled={offboarding} />
        </label>
      </ConfirmModal>

      <ConfirmModal
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={async () => { const ok = await save({ is_active: false }, `${m.name} is paused. Their history stays.`); setConfirmDeactivate(false); if (ok) navigate('/sales/team') }}
        title={`Pause ${m.name}?`}
        message="They drop off the leaderboards and rotations, but their login still works. Use this for a break, not for someone leaving. Nothing is deleted."
        confirmLabel="Pause"
        variant="danger"
      />
    </div>
  )
}

function ProfileCard({ m, save, canEdit }) {
  const [name, setName] = useState(m.name || '')
  const [email, setEmail] = useState(m.email || '')
  const [role, setRole] = useState(m.role || 'closer')
  const dirty = name !== (m.name || '') || email !== (m.email || '') || role !== (m.role || '')
  return (
    <Card step={1} icon={Check} title="Profile" sub="Name shows on leaderboards and EODs. Email is also how Fathom recordings are matched to them." ok={!!m.email}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="flex flex-col gap-2"><span className="eyebrow">Full name</span><input type="text" value={name} onChange={e => setName(e.target.value)} disabled={!canEdit} /></label>
        <label className="flex flex-col gap-2"><span className="eyebrow">Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@optdigital.io" disabled={!canEdit} /></label>
        <div className="sm:col-span-2"><Dropdown label="Role" value={role} options={ROLE_OPTIONS.filter(r => ['closer', 'setter'].includes(r.value) || r.value === m.role)} onChange={canEdit ? setRole : () => {}} width="100%" /></div>
      </div>
      {canEdit && (
        <div className="mt-4">
          <button type="button" className="editorial-btn-primary" disabled={!dirty || name.trim().length < 2} onClick={() => save({ name: name.trim(), email: email.trim() || null, role }, 'Profile updated.')}>
            <Save size={ICON.sm} /> Save profile
          </button>
        </div>
      )}
    </Card>
  )
}

function LoginCard({ m, canEdit, reload }) {
  const { push: toast } = useToast()
  const [busy, setBusy] = useState(false)
  const linked = !!m.auth_user_id
  const invite = async () => {
    if (!m.email) { toast({ kind: 'error', title: 'Add an email first', message: 'The invite goes to the email on their profile.' }); return }
    setBusy(true)
    try {
      await sendDashboardInvite({ name: m.name, email: m.email, role: ['closer', 'setter'].includes(m.role) ? m.role : 'viewer', team_member_id: m.id })
      toast({ kind: 'success', title: 'Invite sent', message: `${m.email} will get a link to set their password.` })
      await reload()
    } catch (err) {
      toast({ kind: 'error', title: 'Invite failed', message: err.message })
    }
    setBusy(false)
  }
  return (
    <Card step={2} icon={KeyRound} title="Dashboard login" sub={linked ? 'They can sign in at sales-dashboard-ftct.onrender.com with their email.' : 'They cannot sign in yet. Send the invite and they choose a password from the email.'} ok={linked}>
      {canEdit && (
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" className={linked ? 'editorial-btn-ghost' : 'editorial-btn-primary'} onClick={invite} disabled={busy}>
            <RefreshCw size={ICON.sm} className={busy ? 'animate-spin' : ''} /> {busy ? 'Sending…' : linked ? 'Resend invite' : 'Send login invite'}
          </button>
          {!m.email && <span style={{ fontSize: 13, color: 'var(--house-bad)' }}>Needs an email on the profile card first.</span>}
        </div>
      )}
      {!canEdit && <p style={{ fontSize: 13.5, color: 'var(--ink-4)', margin: 0 }}>Ask an admin to send a login invite.</p>}
    </Card>
  )
}

function GhlCard({ m, save, canEdit }) {
  const [users, setUsers] = useState(null)   // null = not loaded, [] = API refused
  const [value, setValue] = useState(m.ghl_user_id || '')
  const [loadingUsers, setLoadingUsers] = useState(false)
  const dirty = value !== (m.ghl_user_id || '')

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoadingUsers(true)
      try {
        const res = await ghlFetch(`${BASE_URL}/users/?locationId=${GHL_LOCATION_ID}`)
        if (!res.ok) throw new Error(`GHL ${res.status}`)
        const j = await res.json()
        const list = (j.users || []).map(u => ({ value: u.id, label: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id, hint: u.email || u.id }))
        if (alive) setUsers(list)
      } catch (err) {
        // users.readonly scope may not be on the key; fall back to typing the ID.
        if (alive) setUsers([])
        void err
      }
      if (alive) setLoadingUsers(false)
    })()
    return () => { alive = false }
  }, [])

  const options = users && users.length
    ? [{ value: '', label: 'Not linked', hint: 'Pick the matching GHL user' }, ...users, ...(value && !users.some(u => u.value === value) ? [{ value, label: value, hint: 'Current value (not in the user list)' }] : [])]
    : null

  return (
    <Card step={3} icon={Link2} title="GoHighLevel" sub="Links this person to their GHL user, so calls assigned to them in GHL land on their EOD and their calendar syncs. This also sets their dialler ID, so a setter’s dials, pickups and speed to lead start counting straight away." ok={!!m.ghl_user_id}>
      {loadingUsers ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-4)', margin: 0 }}>Loading GHL users…</p>
      ) : options ? (
        <Dropdown label="GHL user" value={value} options={options} onChange={canEdit ? setValue : () => {}} width="100%" />
      ) : (
        <label className="flex flex-col gap-2">
          <span className="eyebrow">GHL user ID</span>
          <input type="text" value={value} onChange={e => setValue(e.target.value)} placeholder="Paste the user ID from GHL, Settings, My Staff" disabled={!canEdit} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>The API key on this dashboard cannot list users, so paste the ID. In GHL: Settings, My Staff, open the person, copy the ID from the address bar.</span>
        </label>
      )}
      {canEdit && (
        <div className="mt-4">
          <button type="button" className="editorial-btn-primary" disabled={!dirty} onClick={async () => { const ok = await save({ ghl_user_id: value.trim() || null }, value ? 'GoHighLevel user linked.' : 'GoHighLevel user unlinked.'); void ok }}>
            <Save size={ICON.sm} /> Save GHL link
          </button>
        </div>
      )}
    </Card>
  )
}

function CalendarCard({ m }) {
  const [state, setState] = useState({ status: 'idle', events: [], error: null })
  const check = async () => {
    if (!m.ghl_user_id) return
    setState({ status: 'loading', events: [], error: null })
    try {
      const start = Date.now() - 7 * 86400000
      const end = Date.now() + 30 * 86400000
      const url = `${BASE_URL}/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${encodeURIComponent(m.ghl_user_id)}&startTime=${start}&endTime=${end}`
      const res = await ghlFetch(url)
      if (!res.ok) {
        const why = res.status === 429 ? 'GoHighLevel is rate-limiting this dashboard right now. Wait a minute and check again.'
          : res.status === 401 || res.status === 403 ? 'GoHighLevel rejected the API key on this dashboard (not this person). Check VITE_GHL_API_KEY.'
          : `GoHighLevel replied ${res.status}. The GHL user ID above is probably wrong.`
        throw new Error(why)
      }
      const j = await res.json()
      const events = (j.events || []).sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      setState({ status: 'done', events, error: null })
    } catch (err) {
      setState({ status: 'error', events: [], error: err.message })
    }
  }
  const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <Card step={4} icon={CalendarCheck} title="Calendar" sub="Bookings reach this dashboard through the GHL user above. Checking pulls the last week and next 30 days of their GHL calendar to prove it works." ok={!!m.ghl_user_id}>
      {!m.ghl_user_id ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-4)', margin: 0 }}>Link their GoHighLevel user first, then come back and check the calendar.</p>
      ) : (
        <>
          <button type="button" className="editorial-btn-ghost" onClick={check} disabled={state.status === 'loading'}>
            <RefreshCw size={ICON.sm} className={state.status === 'loading' ? 'animate-spin' : ''} /> {state.status === 'loading' ? 'Checking…' : 'Check calendar'}
          </button>
          {state.status === 'error' && <p style={{ fontSize: 13.5, color: 'var(--house-bad)', margin: '12px 0 0' }}>{state.error}</p>}
          {state.status === 'done' && (
            <div className="mt-4">
              <div className="callout" style={{ marginBottom: state.events.length ? 12 : 0 }}>
                <b>{state.events.length}</b> {state.events.length === 1 ? 'call' : 'calls'} found on their calendar (last 7 days plus next 30). {state.events.length ? 'The connection is working.' : 'If they definitely have calls booked, the GHL user is probably wrong.'}
              </div>
              {state.events.slice(0, 6).map(ev => (
                <div key={ev.id} className="flex items-center justify-between gap-3" style={{ padding: '10px 0', borderTop: '1px solid var(--rule)', fontSize: 13.5 }}>
                  <span className="truncate" style={{ fontWeight: 500 }}>{ev.title || 'Untitled call'}</span>
                  <span style={{ color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>{fmt(ev.startTime)} ET</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function WavvCard({ m, save, canEdit }) {
  const [value, setValue] = useState(m.wavv_user_id || '')
  const [start, setStart] = useState(m.stl_start_hour ?? '')
  const [end, setEnd] = useState(m.stl_end_hour ?? '')
  const [ids, setIds] = useState([])
  useEffect(() => {
    supabase.from('wavv_calls').select('user_id').order('started_at', { ascending: false }).limit(1000)
      .then(({ data }) => setIds([...new Set((data || []).map(r => r.user_id).filter(Boolean))]))
  }, [])
  const dirty = value !== (m.wavv_user_id || '') || String(start) !== String(m.stl_start_hour ?? '') || String(end) !== String(m.stl_end_hour ?? '')
  return (
    <Card step={4} icon={PhoneCall} title="WAVV dialer" sub="Dials, pickups and speed-to-lead come from WAVV. The user ID is the one WAVV stamps on their calls." ok={!!m.wavv_user_id}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <label className="flex flex-col gap-2 sm:col-span-3">
          <span className="eyebrow">WAVV user ID</span>
          <input type="text" list={`wavv-${m.id}`} value={value} onChange={e => setValue(e.target.value)} placeholder={ids[0] ? `e.g. ${ids[0]}` : 'WAVV user ID'} disabled={!canEdit} />
          <datalist id={`wavv-${m.id}`}>{ids.map(i => <option key={i} value={i} />)}</datalist>
          {ids.length > 0 && <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>{ids.length} IDs seen in recent WAVV calls, start typing to pick one.</span>}
        </label>
        <label className="flex flex-col gap-2"><span className="eyebrow">Dial window starts (hour, ET)</span><input type="number" min="0" max="23" value={start} onChange={e => setStart(e.target.value)} placeholder="9" disabled={!canEdit} /></label>
        <label className="flex flex-col gap-2"><span className="eyebrow">Dial window ends (hour, ET)</span><input type="number" min="0" max="23" value={end} onChange={e => setEnd(e.target.value)} placeholder="17" disabled={!canEdit} /></label>
      </div>
      {canEdit && (
        <div className="mt-4">
          <button type="button" className="editorial-btn-primary" disabled={!dirty} onClick={() => save({ wavv_user_id: value.trim() || null, stl_start_hour: start === '' ? null : parseInt(start, 10), stl_end_hour: end === '' ? null : parseInt(end, 10) }, 'WAVV settings saved.')}>
            <Save size={ICON.sm} /> Save WAVV
          </button>
        </div>
      )}
    </Card>
  )
}

/* Slack member ID: Optimus mentions people by this on speed-to-lead stamps
   and hand-offs. Without it Optimus guesses from the first name, which
   breaks as soon as two people share one. */
function SlackCard({ m, save, canEdit, reload }) {
  const { push: toast } = useToast()
  const [value, setValue] = useState(m.slack_user_id || '')
  const [finding, setFinding] = useState(false)
  const find = async () => {
    setFinding(true)
    try {
      const res = await resolveSlackUser(m.id)
      if (res.slack_user_id) {
        setValue(res.slack_user_id)
        toast({ kind: 'success', title: 'Found them', message: `Matched on their ${res.source === 'email' ? 'work email' : 'name'}. Optimus will mention them from the next dial.` })
        reload?.()
      } else {
        toast({ kind: 'error', title: 'No match in Slack', message: res.error || 'Paste the member ID in by hand.' })
      }
    } catch (err) {
      toast({ kind: 'error', title: 'Lookup failed', message: err.message })
    }
    setFinding(false)
  }
  const clean = value.trim().toUpperCase()
  const valid = clean === '' || /^[UW][A-Z0-9]{7,}$/.test(clean)
  const dirty = clean !== (m.slack_user_id || '')
  return (
    <Card step={5} icon={MessageSquare} title="Slack" sub="Optimus replies in the new-leads channel when they dial a lead and mentions them by this ID. Found automatically when they are invited; use Find it for me if their Slack sits on a different email." ok={!!m.slack_user_id}>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-4 items-end">
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Slack member ID</span>
          <input type="text" value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. U09JBF3PNE4" disabled={!canEdit} style={!valid ? { borderColor: 'var(--house-bad)' } : undefined} />
          <span style={{ fontSize: 12.5, color: valid ? 'var(--ink-4)' : 'var(--house-bad)' }}>
            {valid ? 'Usually filled in automatically. Otherwise: open their Slack profile, click the three dots, then Copy member ID.' : 'That does not look like a Slack member ID. It starts with U and has no spaces.'}
          </span>
        </label>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button type="button" className="editorial-btn-ghost" disabled={finding} onClick={find}>
              <RefreshCw size={ICON.sm} className={finding ? 'animate-spin' : undefined} /> {finding ? 'Looking…' : 'Find it for me'}
            </button>
            <button type="button" className="editorial-btn-primary" disabled={!dirty || !valid} onClick={() => save({ slack_user_id: clean || null }, clean ? 'Slack ID saved. Optimus will mention them from the next dial.' : 'Slack ID cleared.')}>
              <Save size={ICON.sm} /> Save Slack
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}

/* Where they are in onboarding, and what to do next. */
function OnboardingStrip({ m }) {
  const steps = [
    { label: 'Profile', done: !!m.name && !!m.email, hint: 'add their email' },
    { label: 'Login', done: !!m.auth_user_id, hint: 'send the login invite' },
    { label: 'GoHighLevel', done: !!m.ghl_user_id, hint: 'link their GHL user' },
    { label: m.role === 'setter' ? 'Calendar and WAVV' : 'Calendar', done: !!m.ghl_user_id && (m.role !== 'setter' || !!m.wavv_user_id), hint: m.role === 'setter' ? 'check the calendar and link WAVV' : 'check the calendar' },
    { label: 'Slack', done: !!m.slack_user_id, hint: 'click Find it for me on the Slack card' },
  ]
  const next = steps.find(s => !s.done)
  const done = steps.filter(s => s.done).length
  return (
    <div className="tile mb-4" style={{ padding: '16px 22px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, background: next ? 'rgba(244,225,74,.08)' : '#fff', borderColor: next ? 'rgba(244,225,74,.6)' : 'var(--rule)' }}>
      <div className="flex items-center gap-3 flex-wrap">
        {steps.map((s, i) => (
          <span key={s.label} className="flex items-center gap-2" style={{ fontSize: 13.5, fontWeight: 600, color: s.done ? 'var(--ink)' : 'var(--ink-4)' }}>
            <span style={{ width: 26, height: 26, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: s.done ? 'var(--house-good)' : '#fff', border: `1px solid ${s.done ? 'var(--house-good)' : 'var(--house-line-strong)'}`, color: s.done ? '#fff' : 'var(--ink-4)', fontSize: 12, fontWeight: 700 }}>{s.done ? '✓' : i + 1}</span>
            {s.label}
            {i < steps.length - 1 && <span style={{ width: 22, height: 1, background: 'var(--house-line-strong)', display: 'inline-block', marginLeft: 6 }} />}
          </span>
        ))}
      </div>
      <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 600, color: next ? 'var(--ink)' : 'var(--house-good)' }}>
        {next ? `${done} of ${steps.length} done · next: ${next.hint}` : 'Fully connected'}
      </span>
    </div>
  )
}
