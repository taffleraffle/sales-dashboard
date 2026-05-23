import { createContext, useContext, useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = loading, null = no session
  const [profile, setProfile] = useState(null)
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (session) {
        loadProfile(session.user.id)
        // Detect invite/recovery flow — user needs to set a password
        if (event === 'PASSWORD_RECOVERY' || event === 'INITIAL_SESSION') {
          const hash = window.location.hash
          if (hash.includes('type=invite') || hash.includes('type=recovery')) {
            setNeedsPasswordSetup(true)
          }
        }
      } else {
        setProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(authUserId) {
    // Try to find a team member linked to this auth user
    const { data: member } = await supabase
      .from('team_members')
      .select('*')
      .eq('auth_user_id', authUserId)
      .single()

    if (member) {
      setProfile({
        id: member.id,
        name: member.name,
        role: member.role,        // 'closer', 'setter'
        appRole: 'member',        // app-level role
        teamMemberId: member.id,
        email: member.email,
      })
      return
    }

    // Try user_profiles table (admin/manager accounts)
    const { data: up } = await supabase
      .from('user_profiles')
      .select('*, team_member:team_members(*)')
      .eq('auth_user_id', authUserId)
      .single()

    if (up) {
      setProfile({
        id: up.id,
        name: up.display_name,
        role: up.team_member?.role || null,
        appRole: up.role,         // 'admin', 'manager', 'viewer'
        teamMemberId: up.team_member_id,
        email: null,
      })
      return
    }

    // Try lib_creative_editors — magic-link editor accounts.
    // First by auth_user_id (fast path for editors who've logged in
    // before), then by email (first-login path — claim auth_user_id
    // so future loads short-circuit on the first query). Without this
    // editors would fall through to `viewer` below and could navigate
    // the whole sales dashboard.
    let editor = null
    {
      const { data } = await supabase
        .from('lib_creative_editors')
        .select('id, name, email, tier, format, auth_user_id, active')
        .eq('auth_user_id', authUserId)
        .maybeSingle()
      if (data) editor = data
    }
    if (!editor) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.email) {
        const { data } = await supabase
          .from('lib_creative_editors')
          .select('id, name, email, tier, format, auth_user_id, active')
          .ilike('email', user.email)
          .maybeSingle()
        if (data) {
          editor = data
          // Claim the row by writing auth_user_id so future page loads
          // hit the fast path above. Fire-and-forget — non-blocking.
          supabase.from('lib_creative_editors')
            .update({ auth_user_id: authUserId })
            .eq('id', data.id)
            .then(() => {})
        }
      }
    }
    if (editor) {
      // tier='admin' creative editors get full admin access (none today
      // but future-proofs the schema). tier='editor' get appRole='editor'
      // which the ProtectedRoute gate redirects out of /sales/* into
      // /editor-view.
      const isAdminEditor = editor.tier === 'admin'
      setProfile({
        id: editor.id,
        name: editor.name,
        role: null,
        appRole: isAdminEditor ? 'admin' : 'editor',
        teamMemberId: null,
        email: editor.email,
        editorFormat: editor.format,
        editorTier: editor.tier,
      })
      return
    }

    // No profile found — user exists in auth but not linked
    const { data: { user } } = await supabase.auth.getUser()
    setProfile({
      id: null,
      name: user?.email || 'Unknown',
      role: null,
      appRole: 'viewer',
      teamMemberId: null,
      email: user?.email,
    })
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setProfile(null)
  }

  async function setPassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
    setNeedsPasswordSetup(false)
    // Clear the hash so refresh doesn't re-trigger
    window.location.hash = ''
  }

  const isLoading = session === undefined
  const isAuthenticated = !!session
  const isAdmin = profile?.appRole === 'admin' || profile?.appRole === 'manager'
  const isEditor = profile?.appRole === 'editor'
  const isCloser = profile?.role === 'closer'
  const isSetter = profile?.role === 'setter'

  // Can this user file an EOD for the given tab?
  function canFileEOD(tab) {
    if (isAdmin) return true
    if (tab === 'closer' && isCloser) return true
    if (tab === 'setter' && isSetter) return true
    return false
  }

  // Get the team_member_id this user should be locked to for EOD filing (null = can pick anyone)
  function getEODMemberId(tab) {
    if (isAdmin) return null // admins can file for anyone
    return profile?.teamMemberId || null
  }

  return (
    <AuthContext.Provider value={{
      session, profile, isLoading, isAuthenticated, isAdmin, isEditor, isCloser, isSetter,
      needsPasswordSetup, signIn, signOut, setPassword, canFileEOD, getEODMemberId,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
