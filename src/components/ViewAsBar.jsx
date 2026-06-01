import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// Top-of-screen impersonation bar.
// - Hidden for closers/setters (no permission)
// - Owner: dropdown of all managers + all closers (not themselves)
// - Manager: dropdown of closers only (not other managers, not owner)
//
// When impersonating, a sticky banner shows above the topbar with an Exit button.

export default function ViewAsBar() {
  const { realProfile, viewAs, setViewAs, canImpersonate } = useAuth()
  const [targets, setTargets] = useState([])
  const [open, setOpen] = useState(false)
  const role = realProfile?.appRole

  useEffect(() => {
    if (role !== 'owner' && role !== 'manager' && role !== 'admin') return

    async function load() {
      // Pull all team members + their app_role from user_profiles
      const { data } = await supabase
        .from('team_members')
        .select('id, name, email, role, region, app_role')
        .eq('is_active', true)
        .order('name')
      if (!data) return

      const filtered = data.filter(m =>
        canImpersonate({
          teamMemberId: m.id, role: m.role, region: m.region,
          name: m.name, email: m.email,
        })
      )
      setTargets(filtered)
    }
    load()
  }, [role, realProfile?.teamMemberId])

  // Closer/setter — no bar
  if (role !== 'owner' && role !== 'manager' && role !== 'admin') {
    if (!viewAs) return null
    // Edge case: someone is impersonating but their realProfile changed. Show exit only.
    return <ImpersonationBanner viewAs={viewAs} onExit={() => setViewAs(null)} />
  }

  return (
    <>
      {viewAs && <ImpersonationBanner viewAs={viewAs} onExit={() => setViewAs(null)} />}
      {!viewAs && targets.length > 0 && (
        <div style={{
          position: 'relative',
          background: 'rgba(31,77,60,0.04)',
          borderBottom: '1px solid var(--color-hairline)',
          padding: '6px 28px',
        }}>
          <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setOpen(!open)}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--color-ink-2)', background: 'transparent', border: 0,
                cursor: 'pointer', padding: '4px 8px',
              }}
            >
              View as ↓
            </button>
            {open && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 28, zIndex: 100,
                background: 'var(--color-bg-alt)', border: '1px solid var(--color-hairline)',
                borderRadius: 6, padding: '8px 0', minWidth: 240,
                boxShadow: '0 4px 16px rgba(15,46,34,0.08)',
              }}>
                {targets.map(t => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setViewAs({
                        teamMemberId: t.id, name: t.name, role: t.role,
                        region: t.region, email: t.email,
                      })
                      setOpen(false)
                      // Hard reload so all hooks re-fetch with new identity
                      window.location.reload()
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 16px', border: 0, background: 'transparent',
                      cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                      color: 'var(--color-ink)',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(31,77,60,0.06)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{ fontWeight: 500 }}>{t.name}</div>
                    <div style={{
                      fontSize: 10, color: 'var(--color-ink-3)', marginTop: 2,
                      fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                    }}>
                      {t.role?.toUpperCase()} · {t.region}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function ImpersonationBanner({ viewAs, onExit }) {
  return (
    <div style={{
      background: 'linear-gradient(90deg, rgba(184,90,63,0.15) 0%, rgba(184,90,63,0.06) 100%)',
      borderBottom: '1px solid rgba(184,90,63,0.3)', padding: '8px 28px',
      position: 'sticky', top: 0, zIndex: 60,
    }}>
      <div style={{
        maxWidth: 1240, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.18em', textTransform: 'uppercase',
            color: 'var(--color-clay)',
            padding: '3px 8px', border: '1px solid rgba(184,90,63,0.4)', borderRadius: 4,
          }}>Viewing as</span>
          <span style={{ fontWeight: 600, color: 'var(--color-ink)', fontSize: 13 }}>
            {viewAs.name}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-ink-2)',
            letterSpacing: '0.08em',
          }}>
            {viewAs.role?.toUpperCase()} · {viewAs.region}
          </span>
        </div>
        <button
          onClick={() => { onExit(); window.location.reload() }}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--color-clay)', background: 'transparent',
            border: '1px solid rgba(184,90,63,0.4)', borderRadius: 4,
            padding: '4px 10px', cursor: 'pointer',
          }}
        >
          Exit
        </button>
      </div>
    </div>
  )
}
