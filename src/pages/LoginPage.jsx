import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Navigate } from 'react-router-dom'
import { Loader, LogIn, Eye, EyeOff, BarChart3, ArrowLeft, Mail } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function LoginPage() {
  const { isAuthenticated, isLoading, signIn } = useAuth()
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

  if (isAuthenticated) return <Navigate to="/hq" replace />

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

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo + masthead — ROM Sage Forest brand */}
        <div className="text-center mb-10">
          <div
            className="flex items-center justify-center mx-auto mb-5"
            style={{ width: 64, height: 64 }}
          >
            <svg viewBox="0 0 512 512" role="img" aria-label="Rank On Maps" width="64" height="64">
              <path fill="#1F4D3C" d="M256 56c-66.3 0-120 53.7-120 120 0 24 7 46.4 19.2 65.2L256 388l100.8-146.8C369 222.4 376 200 376 176c0-66.3-53.7-120-120-120zm0 162c-23.2 0-42-18.8-42-42s18.8-42 42-42 42 18.8 42 42-18.8 42-42 42z"/>
              <path fill="none" stroke="#1F4D3C" strokeWidth="10" strokeLinecap="round"
                d="M222 360 C 110 365, 56 388, 56 412 C 56 444, 145 466, 256 466 C 367 466, 456 444, 456 412 C 456 388, 402 365, 290 360"/>
            </svg>
          </div>
          <span className="eyebrow" style={{ justifyContent: 'center', color: '#1F4D3C', fontWeight: 600 }}>Rank On Maps</span>
          <h1 className="h2 mt-3" style={{ fontSize: 36, lineHeight: 1.05 }}>
            HQ <em>Dashboard</em>.
          </h1>
          <p
            className="mt-3"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
            }}
          >
            {forgotMode ? 'Reset · password' : 'Sign in · continue'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-bg-card border border-border-default rounded-sm p-7">
          {forgotMode ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4">
                  <Mail size={24} className="text-success" />
                </div>
                <p className="text-sm text-text-primary font-medium mb-2">Check your email</p>
                <p className="text-xs text-text-400 mb-5">
                  We sent a reset link to <strong className="text-text-secondary">{email}</strong>
                </p>
                <button
                  onClick={() => { setForgotMode(false); setResetSent(false); setError(null) }}
                  className="text-xs text-text-primary hover:underline"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-5">
                <div>
                  <label className="block text-xs text-text-400 uppercase tracking-wider mb-2 font-medium">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full bg-bg-primary border border-border-default rounded-sm px-4 py-3 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                    placeholder="you@rankonmaps.io"
                  />
                </div>

                {error && (
                  <div className="bg-danger/10 border border-danger/20 rounded-sm px-4 py-3 text-xs text-danger">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  style={{ background: '#1F4D3C', color: '#F4EFE3' }}
                  className="w-full flex items-center justify-center gap-2 font-semibold rounded-sm px-4 py-3 text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-[0_0_20px_rgba(31,77,60,0.15)]"
                >
                  {submitting ? <Loader size={16} className="animate-spin" /> : <Mail size={16} />}
                  {submitting ? 'Sending...' : 'Send Reset Link'}
                </button>

                <button
                  type="button"
                  onClick={() => { setForgotMode(false); setError(null) }}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-text-400 hover:text-text-primary transition-colors"
                >
                  <ArrowLeft size={12} />
                  Back to sign in
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Email */}
              <div>
                <label className="block text-xs text-text-400 uppercase tracking-wider mb-2 font-medium">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                  className="w-full bg-bg-primary border border-border-default rounded-sm px-4 py-3 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                  placeholder="you@rankonmaps.io"
                />
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs text-text-400 uppercase tracking-wider font-medium">Password</label>
                  <button
                    type="button"
                    onClick={() => { setForgotMode(true); setError(null) }}
                    className="text-[11px] text-text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full bg-bg-primary border border-border-default rounded-sm px-4 py-3 pr-11 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                    placeholder="Enter password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-400 hover:text-text-primary transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-danger/10 border border-danger/20 rounded-sm px-4 py-3 text-xs text-danger">
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={submitting}
                style={{ background: '#1F4D3C', color: '#F4EFE3' }}
                className="w-full flex items-center justify-center gap-2 font-semibold rounded-sm px-4 py-3 text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-[0_0_20px_rgba(31,77,60,0.15)]"
              >
                {submitting ? <Loader size={16} className="animate-spin" /> : <LogIn size={16} />}
                {submitting ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-text-400 mt-6">
          Contact your manager if you need an account
        </p>
      </div>
    </div>
  )
}
