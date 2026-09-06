import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserPlus, ArrowUpRight, KeyRound, CalendarCheck, PhoneCall, Link2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import Dropdown from '../components/Dropdown'
import { ICON } from '../utils/constants'
import { ROLE_OPTIONS, initialsOf, ConnectionPill, RolePill, sendDashboardInvite } from '../lib/teamShared'

/*
  Team: the one place to bring someone onto the dashboard.

  Roster of every team member as a house tile showing, at a glance, which
  of the four connections are done (dashboard login, GoHighLevel user,
  calendar, WAVV dialer). "Add a person" is a card on this page, not a
  modal (house rule 9). It creates the team_members row and, optionally,
  sends the Supabase invite in the same step, then lands on the person's
  own page to wire up their accounts.
*/

export default function TeamPage() {
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const { push: toast } = useToast()
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  const load = async () => {
    const { data, error } = await supabase.from('team_members').select('*').order('role').order('name')
    if (error) toast({ kind: 'error', title: 'Could not load the team', message: error.message })
    setMembers(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => members.filter(m => showInactive || m.is_active !== false), [members, showInactive])
  const inactiveCount = members.filter(m => m.is_active === false).length

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Team</span>
          <h1 className="h2 mt-2">The <em>team</em>.</h1>
          <p className="lede mt-2" style={{ fontSize: 14 }}>
            Everyone on the sales floor, and whether their login, GoHighLevel account, calendar and dialer are connected.
          </p>
        </div>
        {isAdmin && (
          <button type="button" className="editorial-btn-primary" onClick={() => setShowAdd(v => !v)}>
            <UserPlus size={ICON.md} /> {showAdd ? 'Close' : 'Add a person'}
          </button>
        )}
      </div>

      {showAdd && isAdmin && (
        <AddPersonCard
          onDone={(member) => { setShowAdd(false); load(); if (member?.id) navigate(`/sales/team/${member.id}`) }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Roster <span style={{ color: 'var(--ink-2)', letterSpacing: '.03em' }}>{visible.length}</span>
        </h2>
        {inactiveCount > 0 && (
          <button type="button" className="editorial-btn-ghost" style={{ height: 34, fontSize: 12.5 }} onClick={() => setShowInactive(v => !v)}>
            {showInactive ? 'Hide inactive' : `Show ${inactiveCount} inactive`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse">
          {[1, 2, 3].map(i => <div key={i} className="tile h-40" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="placeholder-card">Nobody on the roster yet. Add the first person above.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visible.map(m => <PersonTile key={m.id} member={m} />)}
        </div>
      )}
    </div>
  )
}

function PersonTile({ member: m }) {
  const inactive = m.is_active === false
  return (
    <Link
      to={`/sales/team/${m.id}`}
      className="tile tile-hover block"
      style={{ padding: '20px 22px', opacity: inactive ? .62 : 1 }}
    >
      <div className="flex items-start gap-4">
        <div
          style={{
            width: 46, height: 46, borderRadius: 14, flex: 'none',
            background: 'rgba(244,225,74,.55)', color: 'var(--ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500,
          }}
        >
          {initialsOf(m.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, margin: 0, lineHeight: 1.1 }} className="truncate">{m.name}</h3>
            <ArrowUpRight size={ICON.sm} style={{ color: 'var(--ink-4)', flex: 'none' }} />
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <RolePill role={m.role} />
            {inactive && <span className="pill">Inactive</span>}
            {m.email && <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }} className="truncate">{m.email}</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <ConnectionPill ok={!!m.auth_user_id} label="Login" icon={KeyRound} />
        <ConnectionPill ok={!!m.ghl_user_id} label="GoHighLevel" icon={Link2} />
        <ConnectionPill ok={!!m.ghl_user_id} label="Calendar" icon={CalendarCheck} />
        {m.role === 'setter' && <ConnectionPill ok={!!m.wavv_user_id} label="WAVV" icon={PhoneCall} />}
      </div>
    </Link>
  )
}

function AddPersonCard({ onDone, onCancel }) {
  const { push: toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('closer')
  const [invite, setInvite] = useState(true)
  const [busy, setBusy] = useState(false)

  const canSubmit = name.trim().length > 1 && (!invite || /\S+@\S+\.\S+/.test(email))

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      let member = null
      if (invite) {
        // The edge function creates the auth user AND the team_members row
        // (closer/setter) or user_profiles row (admin/manager/viewer).
        await sendDashboardInvite({ name: name.trim(), email: email.trim(), role })
        const { data } = await supabase.from('team_members').select('*').ilike('email', email.trim()).order('created_at', { ascending: false }).limit(1)
        member = data?.[0] || null
        toast({ kind: 'success', title: 'Invite sent', message: `${name.trim()} will get an email to set their password.` })
      } else {
        const { data, error } = await supabase
          .from('team_members')
          .insert({ name: name.trim(), email: email.trim() || null, role, is_active: true })
          .select('*')
          .single()
        if (error) throw error
        member = data
        toast({ kind: 'success', title: 'Added to the roster', message: `${name.trim()} is on the team. Connect their accounts next.` })
      }
      onDone(member)
    } catch (err) {
      toast({ kind: 'error', title: 'Could not add them', message: err.message })
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="tile mb-6" style={{ padding: '24px 26px' }}>
      <div className="flex items-center gap-3 mb-4">
        <span style={{ width: 38, height: 38, borderRadius: 12, background: 'rgba(244,225,74,.55)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <UserPlus size={ICON.md} />
        </span>
        <div>
          <h2 className="eyebrow" style={{ margin: 0 }}>Add a person</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>Name and role now, accounts on the next screen.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Full name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jordan Smith" autoFocus />
        </label>
        <label className="flex flex-col gap-2">
          <span className="eyebrow">Email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@optdigital.io" />
        </label>
        <div className="flex flex-col gap-2">
          <Dropdown label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} width="100%" />
        </div>
      </div>

      <label className="flex items-center gap-3 mt-5" style={{ fontSize: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={invite} onChange={e => setInvite(e.target.checked)} />
        <span>Send them a dashboard login invite now <span style={{ color: 'var(--ink-4)' }}>(they set their own password from the email)</span></span>
      </label>

      <div className="flex items-center gap-3 mt-6">
        <button type="submit" className="editorial-btn-primary" disabled={!canSubmit || busy}>
          {busy ? 'Adding…' : invite ? 'Add and send invite' : 'Add to roster'}
        </button>
        <button type="button" className="editorial-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}
