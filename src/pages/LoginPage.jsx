import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Navigate, useLocation } from 'react-router-dom'
import { Loader, LogIn, Eye, EyeOff, ArrowLeft, Mail } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Split-screen sign-in: dark brand panel on the left, the sign-in card on the
// right. Ben (6 Sep 2026): no headline copy and no dashboard mock on the left,
// just the logo, a tagline and a graphic that does not look like the product.

function BrandPanel() {
  // A quiet piece of line art: a rising path through a field of points, with
  // one yellow node where it turns. Nothing here is a chart from the app.
  const dots = []
  for (let r = 0; r < 9; r++) for (let c = 0; c < 13; c++) dots.push({ x: 40 + c * 42, y: 40 + r * 42, k: `${r}-${c}` })
  return (
    <aside
      aria-hidden="true"
      className="relative hidden lg:flex flex-col overflow-hidden bg-ink text-white px-16 pt-14 pb-12"
    >
      <div
        className="pointer-events-none absolute rounded-full"
        style={{ left: -220, top: -260, width: 640, height: 640, background: 'radial-gradient(closest-side, rgba(244,225,74,.16), rgba(244,225,74,0))' }}
      />

      <div className="relative flex items-center gap-3">
        <img src="/opt-logo-white.png" alt="" className="w-[72px] h-auto block" />
        <span className="text-[12.5px] text-white/60 pl-3 border-l border-white/20">Sales dashboard</span>
      </div>

      <div className="relative flex-1 flex items-center justify-center py-10">
        <svg viewBox="0 0 590 420" className="w-full max-w-[560px] h-auto" fill="none">
          {dots.map(d => <circle key={d.k} cx={d.x} cy={d.y} r="1.6" fill="rgba(255,255,255,.18)" />)}
          <path d="M 40 330 C 150 330, 190 290, 250 250 S 360 190, 420 140 S 500 80, 550 60" stroke="rgba(255,255,255,.35)" strokeWidth="2" strokeLinecap="round" />
          <path d="M 40 330 C 150 330, 190 290, 250 250 S 360 190, 420 140" stroke="#f4e14a" strokeWidth="3" strokeLinecap="round" />
          <circle cx="420" cy="140" r="9" fill="#f4e14a" />
          <circle cx="420" cy="140" r="20" stroke="rgba(244,225,74,.35)" strokeWidth="2" />
          <circle cx="420" cy="140" r="34" stroke="rgba(244,225,74,.14)" strokeWidth="2" />
          <circle cx="40" cy="330" r="5" fill="rgba(255,255,255,.6)" />
          <circle cx="550" cy="60" r="5" fill="rgba(255,255,255,.35)" />
        </svg>
      </div>

      <div className="relative">
        <p className="font-serif font-medium text-white leading-[1.05]" style={{ fontSize: 'clamp(30px, 3vw, 44px)', margin: 0 }}>
          OPT Digital <span className="text-accent">Sales</span>
        </p>
        <p className="text-[15px] text-white/60 mt-3" style={{ margin: '12px 0 0' }}>Where the floor stands, every day.</p>
      </div>
    </aside>
  )
}

export default function LoginPage() {
  const { isAuthenticated, isLoading, signIn } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [forgotMode, setForgotMode] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  if (isLoading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <Loader className="animate-spin text-text-primary" size={32} />
      </div>
    )
  }

  // ProtectedRoute stashes the URL the user originally tried to hit
  // (incl. ?creative=<id>) on location.state.from. After successful auth
  // we bounce them back there so shared deep-links survive the login wall.
  // Only honor in-app paths — guard against open-redirect via /\\ checks.
  if (isAuthenticated) {
    const from = location.state?.from
    const target = from?.pathname?.startsWith('/') && !from.pathname.startsWith('//')
      ? `${from.pathname}${from.search || ''}${from.hash || ''}`
      : '/sales'
    return <Navigate to={target} replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err.message === 'Invalid login credentials'
        ? 'Invalid email or password'
        : err.message)
    }
    setSubmitting(false)
  }

  async function handleForgotPassword(e) {
    e.preventDefault()
    if (!email) { setError('Enter your email address'); return }
    setError(null)
    setSubmitting(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`,
      })
      if (error) throw error
      setResetSent(true)
    } catch (err) {
      setError(err.message)
    }
    setSubmitting(false)
  }

  const input = 'w-full bg-white border border-border-default rounded-[12px] px-4 py-3 text-[14.5px] text-text-primary placeholder-text-400 focus:outline-none focus:ring-2 focus:ring-opt-yellow focus:border-transparent transition'
  const label = 'block text-[12.5px] font-bold text-ink mb-1.5'
  const primary = 'w-full flex items-center justify-center gap-2 bg-opt-yellow text-ink font-bold rounded-full px-4 py-3.5 text-[15px] hover:brightness-95 disabled:opacity-60 transition'

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] bg-bg-primary">
      <BrandPanel />

      <section className="flex items-center justify-center px-5 py-10 lg:px-8 lg:py-12">
        <div className="w-full max-w-[400px]">
          <div className="flex items-center gap-2.5 font-bold text-[17px] text-ink mb-8">
            <img src="/opt-logo-white.png" alt="OPT Digital" className="w-[34px] h-auto" style={{ filter: 'invert(1) hue-rotate(180deg) saturate(2)' }} />
            OPT Digital
          </div>

          {forgotMode ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4">
                  <Mail size={24} className="text-success" />
                </div>
                <h2 className="font-serif font-medium text-[30px] leading-[1.05] text-ink mb-2">Check your email</h2>
                <p className="text-[13.5px] text-ink-3 mb-5">
                  We sent a reset link to <strong className="text-ink">{email}</strong>
                </p>
                <button
                  onClick={() => { setForgotMode(false); setResetSent(false); setError(null) }}
                  className="text-[13.5px] font-bold text-ink underline underline-offset-[3px]"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                <h2 className="font-serif font-medium text-[34px] leading-[1.05] text-ink mb-1.5">Reset your password</h2>
                <p className="text-[14.5px] text-ink-3 mb-6">We will email you a link to choose a new one</p>
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <div>
                    <label className={label} htmlFor="email">Email address</label>
                    <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus className={input} placeholder="Enter your email address" />
                  </div>
                  {error && <div className="bg-danger/10 border border-danger/20 rounded-[12px] px-4 py-3 text-xs text-danger">{error}</div>}
                  <button type="submit" disabled={submitting} className={primary}>
                    {submitting ? <Loader size={16} className="animate-spin" /> : <Mail size={16} />}
                    {submitting ? 'Sending...' : 'Send reset link'}
                  </button>
                  <button type="button" onClick={() => { setForgotMode(false); setError(null) }} className="w-full flex items-center justify-center gap-1.5 text-[13px] text-ink-3 hover:text-ink transition-colors">
                    <ArrowLeft size={12} /> Back to sign in
                  </button>
                </form>
              </>
            )
          ) : (
            <>
              <h2 className="font-serif font-medium text-[34px] leading-[1.05] text-ink mb-1.5">Welcome back</h2>
              <p className="text-[14.5px] text-ink-3 mb-6">Sign in to your sales dashboard</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className={label} htmlFor="email">Email address</label>
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" autoFocus className={input} placeholder="Enter your email address" />
                </div>
                <div>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <label className={`${label} mb-0`} htmlFor="password">Password</label>
                    <button type="button" onClick={() => { setForgotMode(true); setError(null) }} className="text-[12.5px] text-ink underline underline-offset-[3px]">
                      Forgot it?
                    </button>
                  </div>
                  <div className="relative">
                    <input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" className={`${input} pr-11`} placeholder="Enter your password" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors" tabIndex={-1} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                {error && <div className="bg-danger/10 border border-danger/20 rounded-[12px] px-4 py-3 text-xs text-danger">{error}</div>}
                <button type="submit" disabled={submitting} className={primary}>
                  {submitting ? <Loader size={16} className="animate-spin" /> : <LogIn size={16} />}
                  {submitting ? 'Signing in...' : 'Continue'}
                </button>
              </form>
            </>
          )}

          <div className="mt-8 pt-5 border-t border-border-default text-center text-[12.5px] leading-[1.6] text-ink-3">
            <p className="mb-2">This dashboard is operated by OPT Digital for its sales team. Accounts are created by OPT Digital; contact your manager if you need one.</p>
            <p className="mb-2">OPT Digital will never ask for your password by email, text or phone.</p>
            <a href="https://optdigital.io" target="_blank" rel="noopener noreferrer" className="underline underline-offset-[3px]">Company website</a>
          </div>
        </div>
      </section>
    </div>
  )
}
