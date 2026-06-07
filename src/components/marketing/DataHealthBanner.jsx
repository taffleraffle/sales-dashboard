import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabase'

/*
  DataHealthBanner — surfaces the conditions that have historically caused
  silent data-accuracy regressions on the Marketing page. Sits at the top
  of `/sales/marketing` and auto-checks every 60s.

  Checks performed (all cheap, all read-only):

  1. MATVIEW AGE — minutes since last refresh_marketing_trend_mv() ran.
     Amber > 5 min · Red > 15 min · with a "Refresh now" button that calls
     the RPC directly (bypasses the autoSync throttle window).

  2. DRIFT — qualified-bookings computed TWO ways for last 7d:
       a. SUM(qualified_bookings) from the matview (what tiles read)
       b. COUNT(*) from lib_strategy_booking_resolved filtered to
          NOT is_dq AND NOT is_spam AND NOT EXISTS booking_excluded
          (the canonical definition the matview SHOULD produce)
     If they disagree, the matview is stale or the SQL diverged. Either
     way, the operator sees the gap before counting rows by hand.

  3. UNATTRIBUTED — count of bookings in last 7d where audience='Unknown',
     and count of typeforms in last 7d with no ad_id. These flag prospects
     who slipped through the resolver (the John-Ziello-class bug).

  Compact when healthy ("Data healthy"). Expanded when any check trips.
*/

const HEALTHY_AGE_MINUTES = 5
const STALE_AGE_MINUTES = 15
const RECHECK_INTERVAL_MS = 60_000

function last7dRange() {
  const today = new Date().toISOString().split('T')[0]
  const since = new Date(Date.now() - 6 * 86400 * 1000).toISOString().split('T')[0]
  return { since, today }
}

export default function DataHealthBanner() {
  const [state, setState] = useState({ loading: true, error: null })
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const check = useCallback(async () => {
    try {
      const { since, today } = last7dRange()

      // Run all checks in parallel — none depend on the others.
      const [refreshLog, mvRows, resolvedRows, exclRows, unknownRows, untrackedRows] =
        await Promise.all([
          supabase
            .from('_marketing_trend_refresh_log')
            .select('refreshed_at')
            .order('refreshed_at', { ascending: false })
            .limit(1),
          supabase
            .from('lib_marketing_by_audience_daily_mv')
            .select('qualified_bookings')
            .gte('date', since)
            .lte('date', today),
          supabase
            .from('lib_strategy_booking_resolved')
            .select('id')
            .eq('is_dq', false)
            .eq('is_spam', false)
            .gte('booked_at', since)
            .lte('booked_at', `${today} 23:59:59`),
          supabase
            .from('booking_excluded')
            .select('booking_id'),
          supabase
            .from('lib_strategy_booking_resolved')
            .select('id', { count: 'exact', head: true })
            .eq('audience', 'Unknown')
            .gte('booked_at', since)
            .lte('booked_at', `${today} 23:59:59`),
          supabase
            .from('typeform_responses')
            .select('response_id', { count: 'exact', head: true })
            .is('ad_id', null)
            .gte('submitted_at', `${since}T00:00:00Z`)
            .lte('submitted_at', `${today}T23:59:59Z`),
        ])

      // 1. Matview age — null if the log table is empty (first run / never refreshed).
      const lastRefreshAt = refreshLog.data?.[0]?.refreshed_at || null
      const matviewAgeMin = lastRefreshAt
        ? Math.floor((Date.now() - new Date(lastRefreshAt).getTime()) / 60_000)
        : null

      // 2. Drift — matview sum vs canonical resolver count, both honouring
      //    booking_excluded the way the matview SQL does. Computing the same
      //    way the operator counts rows in the drilldown.
      const mvSum = (mvRows.data || []).reduce(
        (n, r) => n + (Number(r.qualified_bookings) || 0), 0
      )
      const excludedSet = new Set((exclRows.data || []).map(r => r.booking_id))
      const canonicalQualified = (resolvedRows.data || [])
        .filter(r => !excludedSet.has(r.id))
        .length
      const drift = mvSum - canonicalQualified

      // 3. Unattributed signals — count of bookings + typeforms in window
      //    that didn't fully resolve. Non-zero → resolver coverage gap.
      const unknownBookings = unknownRows.count ?? 0
      const untrackedTypeforms = untrackedRows.count ?? 0

      setState({
        loading: false,
        error: null,
        lastRefreshAt,
        matviewAgeMin,
        mvSum,
        canonicalQualified,
        drift,
        unknownBookings,
        untrackedTypeforms,
      })
    } catch (e) {
      setState({ loading: false, error: e.message || 'check failed' })
    }
  }, [])

  useEffect(() => {
    check()
    const t = setInterval(check, RECHECK_INTERVAL_MS)
    return () => clearInterval(t)
  }, [check])

  const forceRefresh = async () => {
    setRefreshing(true)
    try {
      // The RPC is throttled to 60s server-side. If a refresh just ran,
      // this returns {skipped: true} and we surface that rather than lie.
      await supabase.rpc('refresh_marketing_trend_mv')
      await check()
    } catch (e) {
      console.warn('refresh_marketing_trend_mv failed:', e.message)
    } finally {
      setRefreshing(false)
    }
  }

  if (state.loading) {
    return (
      <div className="text-[10px] uppercase tracking-wider text-text-400 px-3 py-2 border border-border-default/40">
        Checking data health…
      </div>
    )
  }
  if (state.error) {
    return (
      <div className="text-[10px] uppercase tracking-wider text-red-400 px-3 py-2 border border-red-400/40">
        Data health check failed: {state.error}
      </div>
    )
  }

  // Severity rollup — surfaced colour + summary text reflect the worst signal.
  const severity =
    state.drift !== 0 || state.matviewAgeMin > STALE_AGE_MINUTES
      ? 'red'
      : state.matviewAgeMin > HEALTHY_AGE_MINUTES || state.unknownBookings > 0 || state.untrackedTypeforms > 0
      ? 'amber'
      : 'green'

  const summary = (() => {
    const parts = []
    if (state.drift !== 0) parts.push(`Tile drift: matview=${state.mvSum} vs canonical=${state.canonicalQualified} (Δ${state.drift > 0 ? '+' : ''}${state.drift})`)
    if (state.matviewAgeMin > STALE_AGE_MINUTES) parts.push(`Matview ${state.matviewAgeMin}m stale`)
    else if (state.matviewAgeMin > HEALTHY_AGE_MINUTES) parts.push(`Matview ${state.matviewAgeMin}m old`)
    if (state.unknownBookings > 0) parts.push(`${state.unknownBookings} unattributed bookings`)
    if (state.untrackedTypeforms > 0) parts.push(`${state.untrackedTypeforms} untracked typeforms`)
    return parts.length ? parts.join(' · ') : 'Data healthy'
  })()

  const tone = severity === 'red'
    ? { bar: 'border-red-400/60 bg-red-400/5', dot: 'bg-red-400', text: 'text-red-400' }
    : severity === 'amber'
    ? { bar: 'border-yellow-400/60 bg-yellow-400/5', dot: 'bg-yellow-400', text: 'text-yellow-400' }
    : { bar: 'border-success/40 bg-success/5', dot: 'bg-success', text: 'text-success' }

  return (
    <div className={`border ${tone.bar} text-[11px]`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <span className={`inline-block w-2 h-2 rounded-full ${tone.dot}`} />
        <span className={`uppercase tracking-wider font-medium ${tone.text}`}>Data health</span>
        <span className="text-text-secondary flex-1 truncate">{summary}</span>
        <button
          onClick={forceRefresh}
          disabled={refreshing}
          className="text-[10px] uppercase tracking-wider px-2 py-1 border border-border-default hover:border-text-primary hover:text-text-primary transition-colors disabled:opacity-50">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-[10px] uppercase tracking-wider px-2 py-1 border border-border-default hover:border-text-primary hover:text-text-primary transition-colors">
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border-default/40 px-3 py-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px]">
          <Row label="Matview last refresh"
               value={state.lastRefreshAt
                 ? `${state.matviewAgeMin}m ago (${new Date(state.lastRefreshAt).toLocaleTimeString()})`
                 : 'Never refreshed'}
               tone={state.matviewAgeMin > STALE_AGE_MINUTES ? 'red' : state.matviewAgeMin > HEALTHY_AGE_MINUTES ? 'amber' : 'ok'} />
          <Row label="Qualified bookings (7d)"
               value={`matview ${state.mvSum} · canonical ${state.canonicalQualified}`}
               tone={state.drift !== 0 ? 'red' : 'ok'} />
          <Row label="Unattributed bookings (7d)"
               value={state.unknownBookings}
               tone={state.unknownBookings > 0 ? 'amber' : 'ok'} />
          <Row label="Untracked typeforms (7d)"
               value={state.untrackedTypeforms}
               tone={state.untrackedTypeforms > 0 ? 'amber' : 'ok'} />
        </div>
      )}
    </div>
  )
}

function Row({ label, value, tone }) {
  const colour = tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-yellow-400' : 'text-text-secondary'
  return (
    <div>
      <div className="text-text-400 uppercase tracking-wider">{label}</div>
      <div className={`${colour} font-medium tabular-nums`}>{value}</div>
    </div>
  )
}
