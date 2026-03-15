import { useState, useEffect } from 'react'
import { BarChart3 } from 'lucide-react'

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState('enter') // enter → hold → exit

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('hold'), 100)
    const t2 = setTimeout(() => setPhase('exit'), 1600)
    const t3 = setTimeout(() => onComplete(), 2200)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onComplete])

  return (
    <div
      className={`fixed inset-0 z-[9999] bg-bg-primary flex flex-col items-center justify-center transition-all duration-500 ${
        phase === 'exit' ? 'opacity-0 scale-105' : 'opacity-100 scale-100'
      }`}
    >
      {/* Glow ring */}
      <div className={`relative transition-all duration-700 ${phase === 'enter' ? 'scale-50 opacity-0' : 'scale-100 opacity-100'}`}>
        <div className="absolute inset-0 rounded-full bg-opt-yellow/20 blur-2xl animate-pulse" style={{ width: 120, height: 120, margin: '-20px' }} />
        <div className="w-20 h-20 rounded-full bg-opt-yellow flex items-center justify-center shadow-[0_0_60px_rgba(212,245,12,0.3)]">
          <BarChart3 size={36} className="text-bg-primary" />
        </div>
      </div>

      {/* Title */}
      <div className={`mt-8 transition-all duration-700 delay-300 ${phase === 'enter' ? 'opacity-0 translate-y-4' : 'opacity-100 translate-y-0'}`}>
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">OPT Sales</h1>
        <p className="text-sm text-text-400 text-center mt-1">Performance Dashboard</p>
      </div>

      {/* Loading bar */}
      <div className={`mt-10 w-48 h-0.5 bg-border-default rounded-full overflow-hidden transition-opacity duration-500 delay-500 ${phase === 'enter' ? 'opacity-0' : 'opacity-100'}`}>
        <div className="h-full bg-opt-yellow rounded-full animate-load-bar" />
      </div>
    </div>
  )
}
