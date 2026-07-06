import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import AdsCreativeLibrary from './AdsCreativeLibrary'
import { TabBtn } from './library/shared'
import {
  getPreference, setPreference, expiresAt, signOutEditor,
  hasChosenLifetime, markChoiceMade, ensureSignedInAt,
  requestPersistentStorage,
} from '../../lib/editorSession'

/*
  /editor-view              — auth-gated. Magic-link login required.
                              Editor resolved by auth.user.email matching
                              lib_creative_editors.email.
  /editor-view/:token       — legacy token route. No login required.
                              Still working during rollout so already-
                              shared share links don't break overnight.
                              Removed once every editor has logged in
                              via the new flow.

  Both routes resolve to an `editor` (or null = team-wide view) and pass
  it via editorScope to AdsCreativeLibrary. The library renders the same
  surface; the scope flags lock down admin-only bits.

  Permissions threaded through:
    canDelete:       false  — editor can't delete creatives
    canUpload:       depends on auth + per-editor token vs team-wide
    canEditCreative: false  — editor can't change canonical_name/type/etc
    canEditTask:     true   — editor can update status/notes/due + feedback
    canAssignSelf:   true   — only for self-assign from unassigned pile
    canAssignEditor: depends on auth (team-wide get true)
    canDeleteTask:   false  — editor can't delete tasks
*/

export default function EditorView() {
  const { token } = useParams()
  const nav = useNavigate()
  const [editor, setEditor] = useState(null)   // resolved editor row, or null = team-wide
  const [isTeamWide, setIsTeamWide] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [authMode, setAuthMode] = useState(null)   // 'token' | 'auth' — drives the deprecation banner

  useEffect(() => {
    let mounted = true
    const init = async () => {
      // ROUTE A: token-based legacy access. No login needed.
      if (token) {
        setAuthMode('token')
        const { data: linkData, error: linkErr } = await supabase
          .from('lib_editor_share_links')
          .select('*, editor:lib_creative_editors(*)')
          .eq('token', token)
          .is('revoked_at', null)
          .maybeSingle()
        if (!mounted) return
        if (linkErr || !linkData) {
          setErr('Invalid or revoked share link. Use the new login at /editor-login.')
          setLoading(false)
          return
        }
        setEditor(linkData.editor || null)
        setIsTeamWide(!linkData.editor)
        setLoading(false)
        // Touch last_used_at (fire and forget)
        supabase.from('lib_editor_share_links')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', linkData.id)
          .then(() => {})
        return
      }

      // ROUTE B: auth-based. Resolve session → match editor by email.
      setAuthMode('auth')
      const { data: { session } } = await supabase.auth.getSession()
      if (!mounted) return
      if (!session) {
        nav('/editor-login', { replace: true })
        return
      }
      // Full sales admins/managers are never trapped in the editor portal —
      // even if they ALSO have a lib_creative_editors row and logged in via
      // the editor magic-link (which redirects here). The sales dashboard's
      // creative library is a superset of this portal, so send them there.
      // (Ben 2026-07-03: Kirill has an editor row + an admin profile and kept
      // landing in the editor view instead of the full dashboard.)
      {
        const { data: prof } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('auth_user_id', session.user.id)
          .maybeSingle()
        if (!mounted) return
        if (prof && ['admin', 'manager'].includes(prof.role)) {
          nav('/sales', { replace: true })
          return
        }
      }
      const userEmail = session.user.email?.toLowerCase()
      if (!userEmail) {
        setErr('Logged in but your account has no email address. Contact your admin.')
        setLoading(false)
        return
      }
      // Try matching by auth_user_id first (fast path for editors who've
      // logged in before), then by email (first-login path — claim the
      // editor row by populating auth_user_id).
      let editorRow = null
      const byAuth = await supabase.from('lib_creative_editors')
        .select('*').eq('auth_user_id', session.user.id).maybeSingle()
      if (byAuth.data) editorRow = byAuth.data
      if (!editorRow) {
        const byEmail = await supabase.from('lib_creative_editors')
          .select('*').ilike('email', userEmail).maybeSingle()
        if (byEmail.data) {
          // Claim the row by writing auth_user_id so future logins are O(1).
          await supabase.from('lib_creative_editors')
            .update({ auth_user_id: session.user.id })
            .eq('id', byEmail.data.id)
          editorRow = { ...byEmail.data, auth_user_id: session.user.id }
        }
      }
      if (!mounted) return
      if (!editorRow) {
        setErr(`You're logged in as ${userEmail} but your admin hasn't added you to the editor roster yet. Ask them to add your email in Manage Editors.`)
        setLoading(false)
        return
      }
      // Authenticated editors get team-wide visibility by default per
      // Ben (2026-05-23): "everyone on the team can see everyone else's
      // projects". The editor's own work is still highlighted (their
      // editor_id is the default filter chip; they can switch to 'all'
      // anytime via the existing editor multi-select).
      setEditor(editorRow)
      setIsTeamWide(true)
      setLoading(false)
    }
    init()
    return () => { mounted = false }
  }, [token, nav])

  const handleLogout = async () => {
    // signOutEditor clears the lifetime-preference state in
    // localStorage too, so a fresh login on the same device starts
    // with a clean 14-day clock.
    await signOutEditor()
    nav('/editor-login', { replace: true })
  }

  // Local UI state for the "Stay signed in" toggle in the header.
  // Read once on mount; user can flip it without re-logging-in.
  const [sessionPref, setSessionPref] = useState(() => getPreference())
  const togglePref = () => {
    const next = sessionPref === 'forever' ? '14d' : 'forever'
    setPreference(next)
    setSessionPref(next)
    // The header toggle is a "choice" too. Without these calls a
    // bookmark-into-editor-view user who never saw the modal could
    // flip to "14d" and the clock would never start (no stamp), so
    // their session would silently behave like "forever". Treat any
    // explicit toggle as a deliberate choice with a fresh clock.
    markChoiceMade()
    ensureSignedInAt()
  }
  const expiry = sessionPref === '14d' ? expiresAt() : null
  const expiryLabel = expiry
    ? new Date(expiry).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null

  // First-visit "Stay signed in?" prompt. Editors who clicked the
  // magic link directly from their inbox (skipping /editor-login)
  // never got to pick. Show a one-time modal asking them — once they
  // pick, we stamp choice_made + signed_in_at and the lifetime guard
  // in AuthContext starts enforcing the choice.
  // Category switcher — the admin dashboard splits Ads vs Shorts into two
  // separate pages, but the editor portal is a single page and used to be
  // hard-locked to category='ad'. Editors assigned shorts tasks (which carry
  // content_category='short') saw an empty queue with no way to reach them
  // (Ben 2026-07-06: Rafid, format='shorts', couldn't see his assignments).
  // Null until a choice is made; the effective default comes from the
  // editor's format so shorts specialists land on their own queue.
  const [category, setCategory] = useState(() => {
    try {
      const saved = localStorage.getItem('editorView.category')
      if (saved === 'ad' || saved === 'short') return saved
    } catch { /* localStorage unavailable — fall through to format default */ }
    return null
  })
  const effectiveCategory = category ?? (editor?.format === 'shorts' ? 'short' : 'ad')
  const pickCategory = (c) => {
    setCategory(c)
    try { localStorage.setItem('editorView.category', c) } catch { /* non-fatal */ }
  }

  const [needsLifetimeChoice, setNeedsLifetimeChoice] = useState(false)
  useEffect(() => {
    // Only prompt for editors authenticated via the magic-link route.
    // Token-share legacy users + admin-on-editor-view shouldn't see it.
    if (authMode !== 'auth') return
    if (!editor) return
    if (hasChosenLifetime()) return
    setNeedsLifetimeChoice(true)
  }, [authMode, editor])
  const acceptLifetime = (choice) => {
    setPreference(choice)
    setSessionPref(choice)
    markChoiceMade()
    ensureSignedInAt()
    requestPersistentStorage()
    setNeedsLifetimeChoice(false)
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--paper)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--sans)', fontStyle: 'italic', color: 'var(--ink-3)',
      }}>Loading…</div>
    )
  }

  if (err) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--paper)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 40,
      }}>
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10,
          }}>Access</div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500,
            lineHeight: 1.3, color: 'var(--ink)', marginBottom: 16,
          }}>{err}</h1>
          {authMode === 'auth' && (
            <button onClick={handleLogout} style={{
              marginTop: 8, padding: '10px 16px',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              background: 'transparent', color: 'var(--ink-2)',
              border: '1px solid var(--rule)', cursor: 'pointer',
            }}>Sign out + try a different email</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)' }}>
      {/* First-visit prompt — blocks the portal until the editor picks
          how long they want to stay signed in. Skipped automatically
          for editors who came through /editor-login (which sets the
          choice via markChoiceMade) and for legacy token-share users
          and admin sessions. */}
      {needsLifetimeChoice && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(10,10,10,0.55)', backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            maxWidth: 460, width: '100%',
            background: 'var(--paper)', border: '1px solid var(--rule)',
            borderTop: '3px solid var(--accent)',
            boxShadow: '0 24px 60px rgba(10,10,10,0.18)',
            padding: '32px 28px',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8,
            }}>One quick question</div>
            <h2 style={{
              margin: '0 0 8px', fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500,
              lineHeight: 1.25, color: 'var(--ink)',
            }}>Stay signed in?</h2>
            <p style={{
              margin: '0 0 20px', fontFamily: 'var(--serif)', fontSize: 14,
              color: 'var(--ink-3)', lineHeight: 1.55,
            }}>
              We'll keep you logged in on this device so you don't have to request
              a new magic link every time. Pick how long.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button"
                onClick={() => acceptLifetime('14d')}
                style={{
                  padding: '14px 16px', cursor: 'pointer', textAlign: 'left',
                  background: 'var(--paper)', border: '1px solid var(--rule)',
                  borderLeft: '3px solid var(--accent)', borderRadius: 9,
                }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 700, color: 'var(--ink)' }}>
                  For 14 days
                </div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                  Recommended for shared devices. We'll ask you to log in again on {new Date(Date.now() + 14*24*60*60*1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.
                </div>
              </button>
              <button type="button"
                onClick={() => acceptLifetime('forever')}
                style={{
                  padding: '14px 16px', cursor: 'pointer', textAlign: 'left',
                  background: 'var(--paper)', border: '1px solid var(--rule)',
                  borderLeft: '3px solid transparent', borderRadius: 9,
                }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 700, color: 'var(--ink)' }}>
                  Indefinitely
                </div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                  For personal devices only. Stay signed in until you explicitly sign out.
                </div>
              </button>
            </div>
            <div style={{
              marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', lineHeight: 1.55,
            }}>
              You can change this anytime from the header — just click the "Signed in" button.
            </div>
          </div>
        </div>
      )}
      <header style={{
        padding: '14px 32px', borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--ink-3)',
          }}>OPT Digital · Editor portal</div>
          <h1 style={{
            margin: '4px 0 0', fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500,
            color: 'var(--ink)',
          }}>
            {editor ? `${editor.name}'s view` : 'Editing team portal'}
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {editor ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: 'var(--paper)', border: '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <span style={{
                width: 9, height: 9, borderRadius: 9,
                background: '#3e7eba',
              }} />
              <span style={{ color: 'var(--ink-3)' }}>Logged in as</span>
              <span style={{ fontWeight: 600 }}>{editor.name}</span>
            </div>
          ) : (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: '#fffaea', border: '1px solid #e8b408',
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <span style={{ width: 9, height: 9, borderRadius: 9, background: '#e8b408' }} />
              <span style={{ color: '#7a4e08' }}>Team-wide view · all editors</span>
            </div>
          )}
          {authMode === 'auth' && (
            <>
              {/* Stay-signed-in indicator + toggle. Editors who picked
                  "14 days" at login see when the window expires; click
                  to flip to "indefinitely" without re-logging-in. */}
              <button onClick={togglePref}
                title={sessionPref === 'forever'
                  ? 'Currently signed in indefinitely. Click to switch to 14-day auto-logout.'
                  : `Auto-logout on ${expiryLabel || 'soon'}. Click to stay signed in indefinitely instead.`}
                style={{
                  padding: '6px 12px',
                  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'transparent', color: 'var(--ink-3)',
                  border: '1px solid var(--rule)', cursor: 'pointer',
                }}>
                {sessionPref === 'forever'
                  ? 'Signed in: indefinitely'
                  : `Signed in until ${expiryLabel || '…'}`}
              </button>
              <button onClick={handleLogout} style={{
                padding: '6px 12px',
                fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-3)',
                border: '1px solid var(--rule)', cursor: 'pointer',
              }}>Sign out</button>
            </>
          )}
        </div>
      </header>

      {/* Deprecation banner — visible only on the legacy token route to
          nudge editors toward the new login. Stays up until Ben flips
          the cutover and removes the /editor-view/:token route. */}
      {authMode === 'token' && (
        <div style={{
          padding: '8px 32px', background: '#fffaea',
          borderBottom: '1px solid #e8b408',
          fontFamily: 'var(--mono)', fontSize: 11, color: '#7a4e08',
        }}>
          You're using a legacy share link. Ask your admin for your account
          email and log in at <a href="/editor-login" style={{ color: '#7a4e08', textDecoration: 'underline' }}>/editor-login</a> to
          get notifications + your own login that survives across devices.
        </div>
      )}

      <div style={{
        maxWidth: 1400, margin: '0 auto', padding: '0 32px',
      }}>
        {/* Ad creatives ↔ YouTube shorts. Mirrors the admin dashboard's
            Library/Shorts page split — every editor sees both, regardless
            of their format specialty (format only picks the default). */}
        <div style={{ paddingTop: 20 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--rule)', background: 'var(--paper)' }}>
            <TabBtn active={effectiveCategory === 'ad'} onClick={() => pickCategory('ad')}>Ad creatives</TabBtn>
            <TabBtn active={effectiveCategory === 'short'} onClick={() => pickCategory('short')}>YouTube shorts</TabBtn>
          </div>
        </div>
        {/* key remounts the library on switch so each category restores its
            own remembered sub-tab (lib.tab.ad vs lib.tab.short) and none of
            the filter state bleeds across categories. */}
        <AdsCreativeLibrary key={effectiveCategory} category={effectiveCategory} editorScope={(() => {
          // tier='admin' editors (e.g. Kirill the assignment coordinator) get
          // full editorial control — they need to set creators, assign offers,
          // and delete bad takes. Regular editors stay read-only on creatives.
          const isCoordinator = editor?.tier === 'admin'
          return {
            isEditorView: true,
            isTeamWide,
            editorId: editor?.id || null,
            editorName: editor?.name || null,
            editorEmail: editor?.email || null,
            canDelete: isCoordinator,
            canUpload: authMode === 'auth' ? true : !editor,
            canEditCreative: isCoordinator,
            canAssignEditor: authMode === 'auth' ? true : !editor,
            canEditTask: true,
            canAssignSelf: true,
            canDeleteTask: isCoordinator,
            canManageEditors: isCoordinator,
          }
        })()} />
      </div>
    </div>
  )
}
