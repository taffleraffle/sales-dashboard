import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, UserPlus, KeyRound, Link2, CalendarCheck, MessageSquare, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../hooks/useToast'
import Dropdown from '../components/Dropdown'
import { ICON } from '../utils/constants'
import { ROLE_OPTIONS, sendDashboardInvite } from '../lib/teamShared'

/*
  Add a person: its own page, not a card on the roster (house rule 9).

  Left: the form (name, email, role, send invite). Right: what happens next,
  as the four steps the person's page will walk you through. On save you land
  on their page with step 1 done.
*/

const STEPS = [
  { icon: Check, title: 'Profile', text: 'Name, email and role. Their name goes on leaderboards and EODs.' },
  { icon: KeyRound, title: 'Dashboard login', text: 'One email with a link to set a password. Sent now if you tick the box.' },
  { icon: Link2, title: 'GoHighLevel', text: 'Pick their GHL user so calls assigned to them land on their EOD.' },
  { icon: CalendarCheck, title: 'Calendar and dialer', text: 'Check their calendar syncs, and link WAVV for setters.' },
  { icon: MessageSquare, title: 'Slack', text: 'Their Slack member ID, so Optimus can mention them on speed to lead and hand-offs.' },
]

export default function TeamNewPage() {
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const { push: toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('closer')
  const [invite, setInvite] = useState(true)
  const [busy, setBusy] = useState(false)

  const canSubmit = isAdmin && name.trim().length > 1 && (!invite || /\S+@\S+\.\S+/.test(email))

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      let member = null
      if (invite) {
        await sendDashboardInvite({ name: name.trim(), email: email.trim(), role })
        const { data } = await supabase.from('team_members').select('*').ilike('email', email.trim()).order('created_at', { ascending: false }).limit(1)
        member = data?.[0] || null
        toast({ kind: 'success', title: 'Invite sent', message: `${name.trim()} will get an email to set their password.` })
      } else {
        const { data, error } = await supabase.from('team_members').insert({ name: name.trim(), email: email.trim() || null, role, is_active: true }).select('*').single()
        if (error) throw error
        member = data
        toast({ kind: 'success', title: 'Added to the roster', message: `${name.trim()} is on the team. Connect their accounts next.` })
      }
      navigate(member?.id ? `/sales/team/${member.id}` : '/sales/team')
    } catch (err) {
      toast({ kind: 'error', title: 'Could not add them', message: err.message })
    }
    setBusy(false)
  }

  return (
    <div className="w-full">
      <Link to="/sales/team" className="editorial-btn-ghost" style={{ height: 34, fontSize: 12.5, marginBottom: 18 }}>
        <ArrowLeft size={ICON.sm} /> Team
      </Link>
      <div className="mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Sales · Team</span>
        <h1 className="h2 mt-2">Add <em>someone</em>.</h1>
      </div>

      {!isAdmin && <div className="callout" style={{ marginBottom: 18 }}><b>Admins only.</b> Ask Ben or a manager to add people.</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-5 items-start">
        <form onSubmit={submit} className="tile" style={{ padding: '26px 28px' }}>
          <div className="flex items-center gap-3 mb-5">
            <span style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(244,225,74,.55)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><UserPlus size={ICON.md} /></span>
            <div>
              <h2 className="eyebrow" style={{ margin: 0 }}>Step 1 of 5 · Profile</h2>
              <p style={{ margin: '2px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>Two fields and a role. Accounts come on the next screen.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-2 sm:col-span-2"><span className="eyebrow">Full name</span><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jordan Smith" autoFocus disabled={!isAdmin} /></label>
            <label className="flex flex-col gap-2"><span className="eyebrow">Work email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@optdigital.io" disabled={!isAdmin} /></label>
            <div className="flex flex-col gap-2"><Dropdown label="Role" value={role} options={ROLE_OPTIONS} onChange={isAdmin ? setRole : () => {}} width="100%" /></div>
          </div>
          <label className="flex items-center gap-3 mt-5" style={{ fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={invite} onChange={e => setInvite(e.target.checked)} disabled={!isAdmin} />
            <span>Send the dashboard login invite now <span style={{ color: 'var(--ink-4)' }}>(they choose their own password from the email)</span></span>
          </label>
          <div className="flex items-center gap-3 mt-6">
            <button type="submit" className="editorial-btn-primary" disabled={!canSubmit || busy}>{busy ? 'Adding…' : invite ? 'Add and send invite' : 'Add to roster'}</button>
            <Link to="/sales/team" className="editorial-btn-ghost">Cancel</Link>
          </div>
        </form>

        <div className="tile" style={{ padding: '24px 26px' }}>
          <h2 className="eyebrow" style={{ margin: '0 0 14px' }}>What happens next</h2>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 14 }}>
            {STEPS.map((st, i) => (
              <li key={st.title} className="flex items-start gap-3">
                <span style={{ width: 34, height: 34, borderRadius: 10, flex: 'none', background: i === 0 ? 'var(--accent)' : 'rgba(244,225,74,.35)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><st.icon size={15} /></span>
                <span>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>{i + 1}. {st.title}</span>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--ink-2)' }}>{st.text}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="callout" style={{ marginTop: 18 }}>
            <b>You create the GoHighLevel, WAVV and Slack accounts in those tools.</b> Their page links each account to the person so their calls, calendar, dials and Slack mentions all line up.
          </div>
        </div>
      </div>
    </div>
  )
}
