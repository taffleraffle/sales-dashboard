import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import {
  setPreference, markChoiceMade, ensureSignedInAt, requestPersistentStorage,
} from '../../lib/editorSession'

/*
  /editor-login — magic-link login page for editors.

  Flow:
    1. Editor enters their email.
    2. supabase.auth.signInWithOtp() sends them a 6-digit code + magic link.
    3. They click the link OR enter the code, which lands them at
       /editor-view authenticated.
    4. /editor-view's mount logic matches them to their lib_creative_editors
       row by email and they see their queue.

  Admin must add the editor's email to lib_creative_editors BEFORE the
  editor logs in. We allow login for ANY email (Supabase Auth signup is
  on by default), but /editor-view shows a "not provisioned" message if
  there's no matching editor row — admin then adds them and the editor
  retries.
*/

export default function EditorLogin() {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState(null)
  // Default: stay signed in for 14 days. Editor can opt up to
  // "indefinitely" if they're on their own device. See lib/editorSession.js
  // for how the choice is enforced after login.
  const [rememberMe, setRememberMe] = useState('14d')  // '14d' | 'forever'

  // If already authenticated, jump straight to /editor-view — no point
  // sitting on a login page if we already have a session.
  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      if (data.session) nav('/editor-view', { replace: true })
    })
    return () => { mounted = false }
  }, [nav])

  const sendMagicLink = async (e) => {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed || !trimmed.includes('@')) {
      setErr('Enter a valid email address')
      return
    }
    setErr(null); setSending(true)
    // Persist the "Stay signed in" preference BEFORE sending the link
    // so it's already in localStorage when the user clicks back into
    // this device. Same-device click-through is the common case; if
    // they request on phone + click on desktop, the desktop just
    // defaults to '14d' which is the safe default.
    setPreference(rememberMe)
    // Editor picked deliberately — skip the on-arrival prompt on
    // /editor-view so we don't double-ask the same question.
    markChoiceMade()
    // Start the 14-day clock NOW. Without this, isLifetimeExpired's
    // null-stamp short-circuit means the clock never starts and "14
    // days" silently behaves like "forever" for editors who picked
    // via the login radio. (Code review caught it 2026-05-23 —
    // editor portal's most-common entry path was a no-op for this
    // feature.)
    ensureSignedInAt()
    // Ask the browser to mark our localStorage persistent so iOS
    // Safari ITP can't auto-clear it after 7 days of inactivity.
    // Fire-and-forget — best effort.
    requestPersistentStorage()
    // Use the send-editor-magic-link Edge Function instead of
    // supabase.auth.signInWithOtp directly. Reasons:
    //   1. Supabase's runtime mailer ignores email-template patches set
    //      via the management API, so the default ugly Supabase HTML
    //      gets sent. The Edge Function bypasses this by generating the
    //      action_link server-side + delivering via Resend with our own
    //      OPT-branded HTML.
    //   2. The function validates the email exists on the active editor
    //      roster before generating the link — random people can't use
    //      /editor-login to request mail to arbitrary inboxes.
    const { data, error } = await supabase.functions.invoke('send-editor-magic-link', {
      body: { email: trimmed, redirect_to: `${window.location.origin}/editor-view` },
    })
    setSending(false)
    if (error) {
      setErr(error.message || 'Unknown error')
    } else {
      // Always show the "check your inbox" state on a 200, regardless
      // of whether the email was actually on the roster. This prevents
      // an attacker from enumerating who's on the editor roster by
      // submitting emails and reading distinct success-vs-not-found
      // responses. If the email is bogus, no email is sent and they
      // wonder forever. If it's real, they get a magic link.
      setSent(true)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        maxWidth: 440, width: '100%',
        background: 'var(--paper)', border: '1px solid var(--rule)',
        borderTop: '3px solid var(--accent)',
        boxShadow: '0 24px 60px rgba(10,10,10,0.10)',
        padding: '36px 32px',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.16em',
          textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8,
        }}>OPT Digital · Editor portal</div>
        <h1 style={{
          margin: 0, fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 500,
          lineHeight: 1.1, color: 'var(--ink)', marginBottom: 8,
        }}>{sent ? 'Check your email' : 'Log in'}</h1>
        <p style={{
          margin: '0 0 24px', fontFamily: 'var(--serif)', fontSize: 14,
          color: 'var(--ink-3)', lineHeight: 1.5,
        }}>
          {sent
            ? `We sent a magic link to ${email.trim()}. Click it from your inbox and you'll be logged in. No password needed.`
            : 'Enter your work email and we\'ll send you a one-click link to log in. No password needed.'}
        </p>

        {!sent && (
          <form onSubmit={sendMagicLink}>
            <label style={{
              display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--ink-3)', marginBottom: 6,
            }}>Email</label>
            <input
              type="email" required autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@opt.co.nz"
              disabled={sending}
              style={{
                width: '100%', padding: '10px 12px',
                fontFamily: 'var(--sans)', fontSize: 15,
                background: 'var(--paper)', border: '1px solid var(--rule)',
                borderRadius: 9, marginBottom: 16,
              }}
            />
            {/* Stay-signed-in preference. Default 14 days. Editors on
                personal devices can opt into 'indefinitely' to skip
                re-login. Browser session-cleanup (private mode, ITP)
                can still log them out earlier; this only enforces the
                ceiling. */}
            <label style={{
              display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--ink-3)', marginBottom: 6,
            }}>Stay signed in</label>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16,
            }}>
              {[
                { value: '14d',     label: 'For 14 days', sub: 'Recommended for shared devices' },
                { value: 'forever', label: 'Indefinitely', sub: 'Personal device only' },
              ].map(opt => {
                const selected = rememberMe === opt.value
                return (
                  <button key={opt.value} type="button"
                    onClick={() => setRememberMe(opt.value)}
                    disabled={sending}
                    style={{
                      padding: '10px 12px', cursor: sending ? 'not-allowed' : 'pointer',
                      textAlign: 'left',
                      background: selected ? 'var(--paper-2)' : 'var(--paper)',
                      border: `1px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                      borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                      borderRadius: 9,
                    }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                      color: 'var(--ink)', marginBottom: 2,
                    }}>{opt.label}</div>
                    <div style={{
                      fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-3)',
                    }}>{opt.sub}</div>
                  </button>
                )
              })}
            </div>
            {err && (
              <div style={{
                padding: '8px 12px', marginBottom: 12,
                background: 'rgba(181,62,62,0.08)', border: '1px solid rgba(181,62,62,0.3)',
                color: '#b53e3e', fontFamily: 'var(--mono)', fontSize: 11.5,
              }}>{err}</div>
            )}
            <button
              type="submit" disabled={sending}
              style={{
                width: '100%', padding: '12px',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                background: 'var(--ink)', color: 'var(--paper)',
                border: 'none', borderRadius: 9,
                cursor: sending ? 'wait' : 'pointer',
              }}>{sending ? 'Sending…' : 'Send magic link'}</button>
          </form>
        )}

        {sent && (
          <>
            <div style={{
              padding: '12px 14px', marginBottom: 16,
              background: '#fffaea', border: '1px solid #e8b408',
              borderLeft: '3px solid #e8b408',
              fontFamily: 'var(--mono)', fontSize: 11.5, color: '#7a4e08',
              lineHeight: 1.55,
            }}>
              The link expires in <strong>1 hour</strong>. Didn't get it? Check spam, then resend.
            </div>
            <button
              onClick={() => { setSent(false); setEmail(''); setErr(null) }}
              style={{
                width: '100%', padding: '10px',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: 'transparent', color: 'var(--ink-2)',
                border: '1px solid var(--rule)', borderRadius: 9,
                cursor: 'pointer',
              }}>Send to a different email</button>
          </>
        )}

        <div style={{
          marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--rule)',
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
          lineHeight: 1.6,
        }}>
          Trouble logging in? Your admin needs to add your email to the editor
          roster first. Once added, this page works for any new device or
          browser — no setup required.
        </div>
      </div>
    </div>
  )
}
