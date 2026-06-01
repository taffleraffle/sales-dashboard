import { useState, useEffect } from 'react'
import { Check, X, RefreshCw, Brain, Calendar, Save, Lock, Eye, EyeOff, KeyRound, UserPlus, Send, Loader } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { syncFathomTranscripts } from '../services/fathomSync'
import { syncMetaAds } from '../services/metaAdsSync'
import { syncHyrosAttribution } from '../services/hyrosSync'
import { analyzeObjections } from '../services/objectionAnalysis'
import { syncGHLAppointments } from '../services/ghlCalendar'

const apiConfigs = [
  { key: 'meta', label: 'Meta Ads API', envVar: 'VITE_META_ADS_ACCESS_TOKEN', description: 'Pulls ad spend, CPL, CPC, impressions, leads' },
  { key: 'hyros', label: 'Hyros API', envVar: 'VITE_HYROS_API_KEY', description: 'Pulls revenue attribution, ROAS per campaign' },
  { key: 'fathom', label: 'Fathom API', envVar: 'VITE_FATHOM_API_KEY', description: 'Pulls call transcripts for objection analysis' },
  { key: 'ghl', label: 'GHL Calendar', envVar: 'VITE_GHL_API_KEY', description: 'Pulls closer calendar appointments for EOD review' },
]

export default function SettingsPage() {
  const { isAdmin } = useAuth()
  const [syncing, setSyncing] = useState(null)
  const [lastResult, setLastResult] = useState(null)

  const getStatus = (envVar) => {
    const val = import.meta.env[envVar]
    return val && val.length > 0
  }

  const [ghlProgress, setGhlProgress] = useState('')

  const handleSync = async (key) => {
    setSyncing(key)
    setLastResult(null)
    try {
      if (key === 'fathom') {
        const result = await syncFathomTranscripts()
        setLastResult({ key, success: true, message: `Synced ${result.synced} transcripts (${result.skipped} skipped)` })
      } else if (key === 'meta') {
        const result = await syncMetaAds()
        setLastResult({ key, success: true, message: `Synced ${result.synced} ad records (${result.skipped} skipped)` })
      } else if (key === 'hyros') {
        const result = await syncHyrosAttribution()
        setLastResult({ key, success: true, message: `Synced ${result.synced} attribution records (${result.skipped} skipped)` })
      } else if (key === 'ghl') {
        // Sync current week's appointments
        const today = new Date()
        const startOfWeek = new Date(today)
        startOfWeek.setDate(today.getDate() - today.getDay()) // Sunday
        const endOfWeek = new Date(startOfWeek)
        endOfWeek.setDate(startOfWeek.getDate() + 6) // Saturday
        const fmt = d => d.toISOString().split('T')[0]

        const result = await syncGHLAppointments(fmt(startOfWeek), fmt(endOfWeek), (msg) => {
          setGhlProgress(msg)
        })
        setGhlProgress('')
        setLastResult({ key, success: true, message: `Synced ${result.synced} appointments (scanned ${result.scanned} contacts)` })
      }
    } catch (err) {
      setGhlProgress('')
      setLastResult({ key, success: false, message: err.message })
    }
    setSyncing(null)
  }

  return (
    <div>
      <div className="mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Sales · Settings</span>
        <h1 className="h2 mt-2">The <em>back</em> office.</h1>
      </div>

      <div className="space-y-4">
        <h2 className="kicker" style={{ marginBottom: 12 }}>API Connections</h2>

        {apiConfigs.map(api => {
          const connected = getStatus(api.envVar)
          const result = lastResult?.key === api.key ? lastResult : null
          return (
            <div key={api.key} className="tile tile-feedback p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    {connected ? (
                      <Check size={14} className="text-success" />
                    ) : (
                      <X size={14} className="text-danger" />
                    )}
                    <span className="font-medium text-sm">{api.label}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded ${connected ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                      {connected ? 'Connected' : 'Not configured'}
                    </span>
                  </div>
                  <p className="text-xs text-text-400">{api.description}</p>
                </div>
                {connected && (
                  <button
                    onClick={() => handleSync(api.key)}
                    disabled={syncing === api.key}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={syncing === api.key ? 'animate-spin' : ''} />
                    {syncing === api.key ? 'Syncing...' : 'Sync Now'}
                  </button>
                )}
              </div>
              {result && (
                <p className={`text-xs mt-2 ${result.success ? 'text-success' : 'text-danger'}`}>
                  {result.message}
                </p>
              )}
              {api.key === 'ghl' && syncing === 'ghl' && ghlProgress && (
                <p className="text-xs mt-2 text-text-primary">{ghlProgress}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-text-secondary mb-3">Supabase</h2>
        <div className="tile tile-feedback p-5">
          <div className="flex items-center gap-2 mb-1">
            <Check size={14} className="text-success" />
            <span className="font-medium text-sm">Supabase</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-success/15 text-success">Connected</span>
          </div>
          <p className="text-xs text-text-400">{import.meta.env.VITE_SUPABASE_URL}</p>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-text-secondary mb-3">AI Analysis</h2>
        <div className="tile tile-feedback p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Brain size={14} className="text-text-primary" />
                <span className="font-medium text-sm">Objection Analysis</span>
              </div>
              <p className="text-xs text-text-400">Analyzes Fathom transcripts with Claude to identify common objections per closer</p>
            </div>
            <button
              onClick={async () => {
                setSyncing('objections')
                setLastResult(null)
                try {
                  const result = await analyzeObjections()
                  setLastResult({ key: 'objections', success: true, message: `Analyzed ${result.analyzed} transcripts across ${result.closers} closers` })
                } catch (err) {
                  setLastResult({ key: 'objections', success: false, message: err.message })
                }
                setSyncing(null)
              }}
              disabled={syncing === 'objections'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw size={12} className={syncing === 'objections' ? 'animate-spin' : ''} />
              {syncing === 'objections' ? 'Analyzing...' : 'Run Analysis'}
            </button>
          </div>
          {lastResult?.key === 'objections' && (
            <p className={`text-xs mt-2 ${lastResult.success ? 'text-success' : 'text-danger'}`}>
              {lastResult.message}
            </p>
          )}
        </div>
      </div>

      {isAdmin && <PasswordResetSection />}

      {isAdmin && <InviteSection />}

      <TeamMembersSection />

      {isAdmin && <AudiencesSection />}
    </div>
  )
}

function InviteSection() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('closer')
  const [members, setMembers] = useState([])
  const [linkExisting, setLinkExisting] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    // Load team members without auth accounts for linking
    supabase
      .from('team_members')
      .select('id, name, role')
      .is('auth_user_id', null)
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setMembers(data || []))
  }, [])

  const handleInvite = async () => {
    if (!name || !email) return
    setSending(true)
    setResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-team-member`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            name,
            email,
            role,
            team_member_id: linkExisting || undefined,
          }),
        }
      )
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Invite failed')
      setResult({ success: true, message: `Invite sent to ${email}` })
      setName('')
      setEmail('')
      setLinkExisting('')
      // Refresh unlinked members
      const { data: updated } = await supabase
        .from('team_members')
        .select('id, name, role')
        .is('auth_user_id', null)
        .eq('is_active', true)
        .order('name')
      setMembers(updated || [])
    } catch (err) {
      setResult({ success: false, message: err.message })
    }
    setSending(false)
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-text-secondary mb-3">Invite Team Members</h2>
      <div className="tile tile-feedback p-5">
        <div className="flex items-center gap-2 mb-4">
          <UserPlus size={14} className="text-text-primary" />
          <span className="font-medium text-sm">Send Dashboard Invite</span>
        </div>
        <p className="text-xs text-text-400 mb-4">
          They'll receive an email with a link to set their password and access the dashboard.
        </p>

        {members.length > 0 && (
          <div className="mb-4">
            <label className="text-[11px] text-text-400 block mb-1">Link to existing team member (optional)</label>
            <select
              value={linkExisting}
              onChange={e => {
                setLinkExisting(e.target.value)
                if (e.target.value) {
                  const m = members.find(m => m.id === e.target.value)
                  if (m) { setName(m.name); setRole(m.role) }
                }
              }}
              className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
            >
              <option value="">Create new team member</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label className="text-[11px] text-text-400 block mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Daniel"
              className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
            />
          </div>
          <div>
            <label className="text-[11px] text-text-400 block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="daniel@optdigital.io"
              className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
            />
          </div>
          <div>
            <label className="text-[11px] text-text-400 block mb-1">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
            >
              <option value="closer">Closer</option>
              <option value="setter">Setter</option>
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <button
            onClick={handleInvite}
            disabled={!name || !email || sending}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs bg-opt-yellow/15 text-text-primary border border-opt-yellow/30 hover:bg-opt-yellow/25 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
            {sending ? 'Sending...' : 'Send Invite'}
          </button>
        </div>

        {result && (
          <p className={`text-xs mt-3 ${result.success ? 'text-success' : 'text-danger'}`}>
            {result.message}
          </p>
        )}
      </div>
    </div>
  )
}

function PasswordResetSection() {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedMember, setSelectedMember] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('team_members')
        .select('id, name, role, email, auth_user_id, is_active')
        .not('auth_user_id', 'is', null)
        .order('name')
      setMembers(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const handleReset = async () => {
    if (!selectedMember || !newPassword) return
    if (newPassword.length < 6) {
      setResult({ success: false, message: 'Password must be at least 6 characters' })
      return
    }
    setResetting(true)
    setResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-reset-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ user_id: selectedMember.auth_user_id, new_password: newPassword }),
        }
      )
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Reset failed')
      setResult({ success: true, message: `Password reset for ${selectedMember.name}` })
      setNewPassword('')
      setSelectedMember(null)
    } catch (err) {
      setResult({ success: false, message: err.message })
    }
    setResetting(false)
  }

  if (loading) return null

  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-text-secondary mb-3">Password Management</h2>
      <div className="tile tile-feedback p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound size={14} className="text-text-primary" />
          <span className="font-medium text-sm">Reset Team Member Password</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="text-[11px] text-text-400 block mb-1">Team Member</label>
            <select
              value={selectedMember?.id || ''}
              onChange={e => {
                const m = members.find(m => m.id === e.target.value)
                setSelectedMember(m || null)
                setResult(null)
              }}
              className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
            >
              <option value="">Select member...</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role}){!m.is_active ? ' — inactive' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] text-text-400 block mb-1">New Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min 6 characters"
                className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary pr-7"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-400 hover:text-text-primary"
              >
                {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          </div>

          <button
            onClick={handleReset}
            disabled={!selectedMember || !newPassword || resetting}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs bg-opt-yellow/15 text-text-primary border border-opt-yellow/30 hover:bg-opt-yellow/25 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Lock size={12} />
            {resetting ? 'Resetting...' : 'Reset Password'}
          </button>
        </div>

        {result && (
          <p className={`text-xs mt-3 ${result.success ? 'text-success' : 'text-danger'}`}>
            {result.message}
          </p>
        )}

        {selectedMember && (
          <p className="text-[10px] text-text-400 mt-3">
            Resetting password for <strong className="text-text-secondary">{selectedMember.email || selectedMember.name}</strong>. They will need to log in with the new password.
          </p>
        )}
      </div>
    </div>
  )
}

function TeamMembersSection() {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(null)
  const [wavvUserIds, setWavvUserIds] = useState([])
  const [edits, setEdits] = useState({})

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('team_members').select('*').order('role').order('name')
      setMembers(data || [])
      setLoading(false)

      // Fetch distinct WAVV user IDs for dropdown suggestions
      const { data: wavvIds } = await supabase.from('wavv_calls').select('user_id').limit(1000)
      const unique = [...new Set((wavvIds || []).map(w => w.user_id).filter(Boolean))]
      setWavvUserIds(unique)
    }
    load()
  }, [])

  const handleSave = async (member) => {
    const updates = edits[member.id]
    if (!updates) return
    setSaving(member.id)
    const { error } = await supabase.from('team_members').update(updates).eq('id', member.id)
    if (error) {
      console.error('Failed to update member:', error)
    } else {
      setMembers(prev => prev.map(m => m.id === member.id ? { ...m, ...updates } : m))
      setEdits(prev => { const n = { ...prev }; delete n[member.id]; return n })
    }
    setSaving(null)
  }

  const updateField = (id, field, value) => {
    setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value || null } }))
  }

  const getVal = (member, field) => edits[member.id]?.[field] !== undefined ? edits[member.id][field] : (member[field] || '')

  if (loading) return <div className="mt-8 text-xs text-text-400">Loading team...</div>

  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-text-secondary mb-3">Team Members</h2>
      <div className="space-y-2">
        {members.map(m => (
          <div key={m.id} className="tile tile-feedback p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{m.name}</span>
                <span className={`text-[11px] px-2 py-0.5 rounded ${m.role === 'closer' ? 'bg-bg-card-hover text-text-secondary' : 'bg-success/15 text-success'}`}>
                  {m.role}
                </span>
                {!m.is_active && <span className="text-[11px] px-2 py-0.5 rounded bg-red-500/15 text-red-400">Inactive</span>}
              </div>
              {edits[m.id] && (
                <button
                  onClick={() => handleSave(m)}
                  disabled={saving === m.id}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-success/20 text-success hover:bg-success/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  {saving === m.id ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] text-text-400 block mb-1">Email</label>
                <input
                  type="text"
                  value={getVal(m, 'email')}
                  onChange={e => updateField(m.id, 'email', e.target.value)}
                  placeholder="for Fathom matching"
                  className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                />
              </div>
              <div>
                <label className="text-[11px] text-text-400 block mb-1">GHL User ID</label>
                <input
                  type="text"
                  value={getVal(m, 'ghl_user_id')}
                  onChange={e => updateField(m.id, 'ghl_user_id', e.target.value)}
                  placeholder="GHL user ID"
                  className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                />
              </div>
              <div>
                <label className="text-[11px] text-text-400 block mb-1">WAVV User ID</label>
                <input
                  type="text"
                  value={getVal(m, 'wavv_user_id')}
                  onChange={e => updateField(m.id, 'wavv_user_id', e.target.value)}
                  placeholder={wavvUserIds.length > 0 ? `e.g. ${wavvUserIds[0]}` : 'WAVV user ID'}
                  list={`wavv-ids-${m.id}`}
                  className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                />
                <datalist id={`wavv-ids-${m.id}`}>
                  {wavvUserIds.map(id => <option key={id} value={id} />)}
                </datalist>
              </div>
            </div>
            {m.role === 'setter' && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="text-[11px] text-text-400 block mb-1">STL Start Hour (e.g. 9 = 9am)</label>
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={getVal(m, 'stl_start_hour')}
                    onChange={e => updateField(m.id, 'stl_start_hour', e.target.value ? parseInt(e.target.value) : null)}
                    placeholder="e.g. 9"
                    className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-text-400 block mb-1">STL End Hour (e.g. 17 = 5pm)</label>
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={getVal(m, 'stl_end_hour')}
                    onChange={e => updateField(m.id, 'stl_end_hour', e.target.value ? parseInt(e.target.value) : null)}
                    placeholder="e.g. 17"
                    className="w-full px-2 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-primary"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {wavvUserIds.length > 0 && (
        <p className="text-[11px] text-text-400 mt-2">
          Found {wavvUserIds.length} WAVV user ID{wavvUserIds.length !== 1 ? 's' : ''} in call data: {wavvUserIds.join(', ')}
        </p>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// AudiencesSection — self-service audience management.
//
// Adds/edits/deletes rows in public.audience_definitions (migration 131).
// Every parser/view/page reads from the same table, so saving an audience
// here makes it appear on Marketing tabs, the AttributionCoverage kanban,
// the booking resolver, etc. — no deploy needed.
//
// Live preview: when editing keywords, queries `ads` table and shows how
// many campaign names the keyword list would match. Lets Ben confirm the
// keywords are right before saving.
// ───────────────────────────────────────────────────────────────────────

function AudiencesSection() {
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)
  const [editing, setEditing] = useState(null)         // row being edited, or 'new'
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setBusy(true)
    supabase
      .from('audience_definitions')
      .select('*')
      .order('sort_order', { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return
        if (error) { setErr(error.message); setRows([]); return }
        setRows(data || [])
        setErr(null)
      })
      .then(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [reloadKey])

  const refresh = () => setReloadKey(k => k + 1)

  return (
    <div className="space-y-4 mt-8">
      <div className="flex items-center justify-between">
        <h2 className="kicker">Audiences</h2>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-secondary hover:text-text-primary">
          <UserPlus size={12} /> Add audience
        </button>
      </div>

      <p className="text-[11px] text-text-400 max-w-xl">
        Drives audience tabs, kanban columns, and the parser that auto-classifies
        new campaigns. Keywords ILIKE the campaign name — lowest <em>sort order</em>
        wins, so put narrow brand keywords (TRADIES → Australia) above broad ones
        (electrician). Adding a row here flows through to Marketing &amp;
        Attribution Coverage immediately.
      </p>

      {err && (
        <div className="text-xs text-danger">{err}</div>
      )}

      {busy ? (
        <div className="text-xs text-text-400">Loading…</div>
      ) : (
        <div className="border border-border-default rounded">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-primary border-b border-border-default">
                <th className="text-left px-3 py-2 font-medium text-text-secondary">Audience</th>
                <th className="text-left px-3 py-2 font-medium text-text-secondary">Keywords</th>
                <th className="text-right px-3 py-2 font-medium text-text-secondary">Sort</th>
                <th className="text-left px-3 py-2 font-medium text-text-secondary">Active</th>
                <th className="text-right px-3 py-2 font-medium text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.slug} className="border-b border-border-default last:border-b-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {r.color && (
                        <span style={{
                          display: 'inline-block', width: 10, height: 10,
                          borderRadius: 2, background: r.color, flexShrink: 0,
                        }} />
                      )}
                      <span className="font-medium">{r.display_name}</span>
                      <span className="text-[10px] text-text-400">{r.slug}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    <div className="flex flex-wrap gap-1">
                      {(r.keywords || []).map(k => (
                        <code key={k} className="px-1.5 py-0.5 bg-bg-primary rounded text-[10px]">{k}</code>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.sort_order}</td>
                  <td className="px-3 py-2">
                    {r.is_active ? <Check size={12} className="text-success" /> : <X size={12} className="text-text-400" />}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setEditing(r)}
                      className="text-text-secondary hover:text-text-primary underline underline-offset-2">
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="text-center p-4 text-text-400">No audiences yet — click <em>Add audience</em> to create one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <AudienceEditorModal
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function AudienceEditorModal({ row, onClose, onSaved }) {
  const isNew = !row
  const [slug, setSlug] = useState(row?.slug || '')
  const [displayName, setDisplayName] = useState(row?.display_name || '')
  const [keywords, setKeywords] = useState((row?.keywords || []).join(', '))
  const [color, setColor] = useState(row?.color || '#0e7c86')
  const [sortOrder, setSortOrder] = useState(row?.sort_order ?? 100)
  const [exampleUtm, setExampleUtm] = useState(row?.example_utm || '')
  const [isActive, setIsActive] = useState(row?.is_active ?? true)
  const [calendarIdsCsv, setCalendarIdsCsv] = useState((row?.calendar_ids || []).join(', '))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [preview, setPreview] = useState({ matched: 0, total: 0, sample: [], busy: false })

  // Live preview: how many current campaigns would this keyword list match?
  const kwArray = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  useEffect(() => {
    let alive = true
    if (kwArray.length === 0) { setPreview({ matched: 0, total: 0, sample: [], busy: false }); return }
    setPreview(p => ({ ...p, busy: true }))
    supabase.from('ads').select('campaign_name', { count: 'exact', head: false }).limit(2000)
      .then(({ data, count }) => {
        if (!alive) return
        const unique = [...new Set((data || []).map(r => r.campaign_name).filter(Boolean))]
        const matched = unique.filter(cn => {
          const s = cn.toLowerCase()
          return kwArray.some(kw => s.includes(kw))
        })
        setPreview({ matched: matched.length, total: unique.length, sample: matched.slice(0, 8), busy: false })
      })
    return () => { alive = false }
  }, [keywords])  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!slug.trim() || !displayName.trim() || kwArray.length === 0) {
      setErr('Slug, display name, and at least one keyword are required.')
      return
    }
    setSaving(true); setErr(null)
    try {
      const payload = {
        slug: slug.trim().toLowerCase().replace(/\s+/g, '_'),
        display_name: displayName.trim(),
        keywords: kwArray,
        color: color || null,
        sort_order: Number(sortOrder) || 100,
        example_utm: exampleUtm.trim() || null,
        is_active: !!isActive,
        calendar_ids: calendarIdsCsv.split(',').map(s => s.trim()).filter(Boolean),
      }
      const { error } = await supabase
        .from('audience_definitions')
        .upsert(payload, { onConflict: 'slug' })
      if (error) throw new Error(error.message)
      onSaved()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!row || !confirm(`Delete audience "${row.display_name}"? Campaigns currently overridden to this slug will fall back to the parser.`)) return
    setSaving(true); setErr(null)
    try {
      const { error } = await supabase.from('audience_definitions').delete().eq('slug', row.slug)
      if (error) throw new Error(error.message)
      onSaved()
    } catch (e) {
      setErr(e.message); setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(10,10,10,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-bg-card border border-border-default rounded-sm w-full"
        style={{ maxWidth: 640, maxHeight: '88vh', overflow: 'auto' }}
      >
        <div className="px-5 py-3 border-b border-border-default flex items-center justify-between">
          <h3 className="text-sm font-semibold">{isNew ? 'Add audience' : `Edit ${row.display_name}`}</h3>
          <button onClick={onClose} className="text-text-400 hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Slug</label>
              <input
                value={slug}
                onChange={e => setSlug(e.target.value)}
                placeholder="dentists"
                disabled={!isNew}
                className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary font-mono disabled:opacity-60"
              />
              <p className="text-[10px] text-text-400 mt-1">Stored in campaign_audience_overrides. Lowercase + underscores.</p>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Display name</label>
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Dentists"
                className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary"
              />
              <p className="text-[10px] text-text-400 mt-1">Shown on tabs, kanban, drilldowns.</p>
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Keywords (comma-separated)</label>
            <input
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="dentist, dental, orthodontist"
              className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary font-mono"
            />
            <p className="text-[10px] text-text-400 mt-1">Any campaign or form name containing one of these substrings auto-classifies to this audience.</p>
          </div>

          {/* Live preview */}
          <div className="border border-border-default rounded p-3 bg-bg-primary">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] uppercase tracking-wide text-text-400">Live match preview</span>
              {preview.busy && <span className="text-[10px] text-text-400">Checking…</span>}
            </div>
            {kwArray.length === 0 ? (
              <p className="text-xs text-text-400">Type one or more keywords to see what they match.</p>
            ) : (
              <>
                <p className="text-xs text-text-secondary mb-2">
                  Matches <strong className="text-text-primary tabular-nums">{preview.matched}</strong> of {preview.total} unique campaign names in the ad library.
                </p>
                {preview.sample.length > 0 && (
                  <div className="space-y-1">
                    {preview.sample.map(name => (
                      <div key={name} className="text-[10.5px] font-mono text-text-secondary truncate">{name}</div>
                    ))}
                    {preview.matched > preview.sample.length && (
                      <div className="text-[10px] text-text-400 italic">+ {preview.matched - preview.sample.length} more</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Color</label>
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="w-full h-7 rounded border border-border-default bg-bg-primary"
              />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Sort order</label>
              <input
                type="number"
                value={sortOrder}
                onChange={e => setSortOrder(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary tabular-nums"
              />
              <p className="text-[10px] text-text-400 mt-1">Lower wins first.</p>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Active</label>
              <label className="flex items-center gap-2 mt-1.5">
                <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                <span className="text-xs">{isActive ? 'Yes' : 'No'}</span>
              </label>
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">GHL strategy-call calendar IDs (optional, comma-separated)</label>
            <input
              value={calendarIdsCsv}
              onChange={e => setCalendarIdsCsv(e.target.value)}
              placeholder="cEyqCFAsPLDkUV8n982h, woLoGzGKe5fPKZU1jxY7"
              className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary font-mono"
            />
            <p className="text-[10px] text-text-400 mt-1">Bookings on these calendars fall back to this audience when typeform/email resolution misses.</p>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-text-400 block mb-1">Example utm_campaign (optional)</label>
            <input
              value={exampleUtm}
              onChange={e => setExampleUtm(e.target.value)}
              placeholder="SCIO - Dentists - VSL"
              className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border-default rounded text-text-primary font-mono"
            />
            <p className="text-[10px] text-text-400 mt-1">Used by the QA bulk-tag buttons on Attribution Coverage.</p>
          </div>

          {err && <div className="text-xs text-danger">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-border-default flex items-center justify-between">
          <div>
            {!isNew && (
              <button
                onClick={handleDelete}
                disabled={saving}
                className="text-xs text-danger underline underline-offset-2 hover:opacity-80 disabled:opacity-40">
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs bg-text-primary text-bg-primary border border-text-primary hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save audience'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
