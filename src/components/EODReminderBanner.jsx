import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// Surfaces in-app from 8pm local closer time until EOD is filed.
// Closer-only (not manager/owner). Auto-dismisses once today's EOD is confirmed.
//
// Logic: pull closer's timezone from team_members. If now (in that tz) is between 8pm and midnight
// AND closer has no confirmed EOD for today (in that tz), show the banner.

export default function EODReminderBanner() {
  const { profile } = useAuth()
  const [show, setShow] = useState(false)
  const [hoursLeft, setHoursLeft] = useState(null)

  useEffect(() => {
    if (profile?.role !== 'closer' || !profile?.teamMemberId) return
    let cancelled = false

    async function check() {
      // 1. Get closer's timezone
      const { data: member } = await supabase
        .from('team_members')
        .select('timezone')
        .eq('id', profile.teamMemberId)
        .maybeSingle()
      if (cancelled) return
      const tz = member?.timezone || 'America/Los_Angeles'

      // 2. What time is it in closer's tz?
      const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
      const hour = nowLocal.getHours()
      const todayLocal = nowLocal.toISOString().split('T')[0]

      // 3. Has closer filed today's EOD?
      const { data: report } = await supabase
        .from('closer_eod_reports')
        .select('id, is_confirmed')
        .eq('closer_id', profile.teamMemberId)
        .eq('report_date', todayLocal)
        .eq('is_confirmed', true)
        .maybeSingle()

      if (cancelled) return
      const filed = !!report?.id
      const inWindow = hour >= 20 && hour < 24   // 8pm to midnight local
      setShow(inWindow && !filed)
      setHoursLeft(inWindow ? Math.max(0, 24 - hour) : null)
    }

    check()
    const id = setInterval(check, 5 * 60 * 1000)  // re-check every 5 min
    return () => { cancelled = true; clearInterval(id) }
  }, [profile])

  if (!show) return null
  const minutesUntilDeadline = hoursLeft != null ? `${hoursLeft}h` : ''

  return (
    <Link
      to="/sales/eod"
      style={{
        display: 'block', padding: '10px 16px',
        background: 'linear-gradient(90deg, rgba(184,90,63,0.12) 0%, rgba(184,90,63,0.06) 100%)',
        borderBottom: '1px solid rgba(184,90,63,0.25)',
        color: 'var(--color-ink)',
        textDecoration: 'none',
        fontSize: 13,
      }}
    >
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-clay)',
            padding: '3px 8px', border: '1px solid rgba(184,90,63,0.3)', borderRadius: 4,
          }}>
            EOD due
          </span>
          <span>
            File today's EOD before midnight. <span style={{ color: 'var(--color-ink-2)' }}>{minutesUntilDeadline} left.</span>
          </span>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-accent)' }}>
          Open EOD →
        </span>
      </div>
    </Link>
  )
}
