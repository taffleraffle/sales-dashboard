import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

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
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}/editor-view`,
        shouldCreateUser: true,
      },
    })
    setSending(false)
    if (error) {
      setErr(error.message)
    } else {
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
                background: 'white', border: '1px solid var(--rule)',
                borderRadius: 2, marginBottom: 16,
              }}
            />
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
                border: 'none', borderRadius: 2,
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
                border: '1px solid var(--rule)', borderRadius: 2,
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
