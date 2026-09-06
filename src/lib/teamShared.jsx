import { supabase } from './supabase'

// Shared between TeamPage and TeamMemberPage. Kept out of the page files so
// Vite fast-refresh keeps working (pages should export only components).
export const ROLE_OPTIONS = [
  { value: 'closer',  label: 'Closer',  hint: 'Runs strategy calls, files closer EODs' },
  { value: 'setter',  label: 'Setter',  hint: 'Dials leads, files setter EODs' },
  { value: 'manager', label: 'Manager', hint: 'Full dashboard, can invite people' },
  { value: 'admin',   label: 'Admin',   hint: 'Everything, including settings' },
  { value: 'viewer',  label: 'Viewer',  hint: 'Read-only dashboard' },
]

export function initialsOf(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function ConnectionPill({ ok, label, icon: Icon }) {
  return (
    <span
      className="pill"
      title={ok ? `${label}: connected` : `${label}: not connected`}
      style={{ gap: 7, color: ok ? 'var(--ink)' : 'var(--ink-4)', borderColor: ok ? 'rgba(22,163,74,.35)' : 'var(--rule)' }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: ok ? 'var(--house-good)' : 'var(--ink-5)', flex: 'none' }} />
      {Icon && <Icon size={12} style={{ opacity: .7 }} />}
      {label}
    </span>
  )
}

export function RolePill({ role }) {
  return (
    <span className="pill" style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#1a1700' }}>
      {ROLE_OPTIONS.find(r => r.value === role)?.label || role || 'Member'}
    </span>
  )
}

export async function sendDashboardInvite({ name, email, role, team_member_id }) {
  const { data: { session } } = await supabase.auth.getSession()
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-team-member`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ name, email, role, team_member_id: team_member_id || undefined }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error || 'Invite failed')
  return data
}

