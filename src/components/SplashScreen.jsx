import { useState, useEffect } from 'react'

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
      className={`fixed inset-0 z-[9999] bg-paper flex flex-col items-center justify-center transition-all duration-500 ${
        phase === 'exit' ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {/* Eyebrow over the title */}
      <div
        className={`transition-all duration-700 ${
          phase === 'enter' ? 'opacity-0 -translate-y-2' : 'opacity-100 translate-y-0'
        }`}
      >
        <span className="eyebrow eyebrow-accent">OPT Digital · Sales</span>
      </div>

      {/* Title — serif with italic emphasis */}
      <h1
        className={`mt-5 text-center transition-all duration-700 delay-200 ${
          phase === 'enter' ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0'
        }`}
        style={{
          fontFamily: 'var(--serif)',
          fontWeight: 500,
          fontSize: 'clamp(36px, 5vw, 56px)',
          lineHeight: 1.05,
          letterSpacing: '-0.025em',
          color: 'var(--ink)',
          margin: 0,
        }}
      >
        Performance, <em>quietly</em> measured.
      </h1>

      {/* Sub-lede */}
      <p
        className={`mt-3 transition-all duration-700 delay-300 text-center ${
          phase === 'enter' ? 'opacity-0' : 'opacity-100'
        }`}
        style={{
          fontFamily: 'var(--serif)',
          fontSize: 15,
          color: 'var(--ink-2)',
          maxWidth: '42ch',
        }}
      >
        Booking, calls, conversion · daily.
      </p>

      {/* Loading bar — single yellow accent */}
      <div
        className={`mt-10 w-48 h-px overflow-hidden transition-opacity duration-500 delay-500 ${
          phase === 'enter' ? 'opacity-0' : 'opacity-100'
        }`}
        style={{ background: 'var(--rule)' }}
      >
        <div className="h-full animate-load-bar" style={{ background: 'var(--accent)' }} />
      </div>
    </div>
  )
}
