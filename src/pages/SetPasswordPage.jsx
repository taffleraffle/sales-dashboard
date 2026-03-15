import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Loader, Lock, Eye, EyeOff, BarChart3, Check } from 'lucide-react'

export default function SetPasswordPage() {
  const { setPassword, profile } = useAuth()
  const [password, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      await setPassword(password)
      setDone(true)
      setTimeout(() => { window.location.href = '/sales' }, 1500)
    } catch (err) {
      setError(err.message)
    }
    setSubmitting(false)
  }

  if (done) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center px-4">
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4">
            <Check size={28} className="text-success" />
          </div>
          <h2 className="text-xl font-bold text-text-primary mb-2">You're all set!</h2>
          <p className="text-text-400 text-sm">Redirecting to dashboard...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="w-14 h-14 rounded-2xl bg-opt-yellow flex items-center justify-center mx-auto mb-4 shadow-[0_0_40px_rgba(212,245,12,0.15)]">
            <BarChart3 size={28} className="text-bg-primary" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Welcome to OPT SALES</h1>
          <p className="text-text-400 text-sm mt-1">
            {profile?.name ? `Hey ${profile.name}, set` : 'Set'} your password to get started
          </p>
        </div>

        <div className="bg-bg-card border border-border-default rounded-2xl p-7">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs text-text-400 uppercase tracking-wider mb-2 font-medium">New Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPass(e.target.value)}
                  required
                  autoFocus
                  className="w-full bg-bg-primary border border-border-default rounded-xl px-4 py-3 pr-11 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                  placeholder="Min 6 characters"
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

            <div>
              <label className="block text-xs text-text-400 uppercase tracking-wider mb-2 font-medium">Confirm Password</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                className="w-full bg-bg-primary border border-border-default rounded-xl px-4 py-3 text-sm text-text-primary placeholder-text-400 focus:outline-none focus:border-opt-yellow/50 focus:ring-1 focus:ring-opt-yellow/20 transition-all"
                placeholder="Re-enter password"
              />
            </div>

            {error && (
              <div className="bg-danger/10 border border-danger/20 rounded-xl px-4 py-3 text-xs text-danger">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 bg-opt-yellow text-bg-primary font-semibold rounded-xl px-4 py-3 text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-[0_0_20px_rgba(212,245,12,0.1)]"
            >
              {submitting ? <Loader size={16} className="animate-spin" /> : <Lock size={16} />}
              {submitting ? 'Setting password...' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
