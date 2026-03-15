import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Navigate } from 'react-router-dom'
import { Loader, LogIn, Eye, EyeOff, BarChart3 } from 'lucide-react'

export default function LoginPage() {
  const { isAuthenticated, isLoading, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  if (isLoading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <Loader className="animate-spin text-opt-yellow" size={32} />
      </div>
    )
  }

  if (isAuthenticated) return <Navigate to="/sales" replace />

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

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="w-14 h-14 rounded-2xl bg-opt-yellow flex items-center justify-center mx-auto mb-4 shadow-[0_0_40px_rgba(212,245,12,0.15)]">
            <BarChart3 size={28} className="text-bg-primary" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">OPT SALES</h1>
          <p className="text-text-400 text-sm mt-1">Sign in to your dashboard</p>
        </div>

        {/* Login Card */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-7">
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
                className="w-full bg-bg-primary border border-border-default rounded-xl px-4 py-3 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                placeholder="you@optdigital.io"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs text-text-400 uppercase tracking-wider mb-2 font-medium">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full bg-bg-primary border border-border-default rounded-xl px-4 py-3 pr-11 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
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
              <div className="bg-danger/10 border border-danger/20 rounded-xl px-4 py-3 text-xs text-danger">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 bg-opt-yellow text-bg-primary font-semibold rounded-xl px-4 py-3 text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-[0_0_20px_rgba(212,245,12,0.1)]"
            >
              {submitting ? <Loader size={16} className="animate-spin" /> : <LogIn size={16} />}
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-text-400 mt-6">
          Contact your manager if you need an account
        </p>
      </div>
    </div>
  )
}
