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
      session, profile, isLoading, isAuthenticated, isAdmin, isCloser, isSetter,
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
