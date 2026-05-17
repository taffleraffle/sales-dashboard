import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

/*
  Single source-of-truth for close-rate / live-NC / closes across pages.

  Why this exists
  ──────────────────────────────────────────────────────────────────────────
  Two places in the app used to display close-rate from different sources:

    • Closer dashboard (CloserOverview)  reads `closer_calls` rows and dedupes
                                          by prospect_name (the call-level
                                          truth — every prospect logged once).
    • Marketing dashboard (MarketingPerformance)  reads the EOD summary integer
                                          counters (`live_nc_calls`, `closes`)
                                          that the closer types into their
                                          end-of-day form.

  Closers' summary counters don't perfectly match their call-row entries
  (a closer types "5 live NCs today" but only adds 4 prospect rows). On
  a 90-day window this drift produced 42% close-rate on the closer dash
  and 27.9% on marketing — both legitimate calculations, different sources.

  Per-call rows are the source of truth (they have prospect names, are
  entered individually, are what CloserDetail / SalesOverview already use).
  This hook exposes that calculation for any page that wants to display
  close-rate so every page agrees.

  Usage
  ──────────────────────────────────────────────────────────────────────────
    const { byRange } = useCloserCallProspectMetrics()
    const { liveProspects, closedProspects, closeRate } = byRange(90)
*/

// Pull a 730-day window once so any consumer can ask for any sub-range
// without re-fetching. Matches the longest preset on the Ads + Marketing
// pages (the "2y" range button = 730 days). Prior 365-day cap silently
// returned zero for any range past one year, which left top tiles
// blank while drilldowns queried the same underlying tables and
// returned real counts — classic top-tile-vs-drilldown drift.
const WINDOW_DAYS = 730

export function useCloserCallProspectMetrics() {
  const [data, setData] = useState({ reports: [], calls: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function fetch() {
      setLoading(true); setError(null)
      try {
        const since = new Date()
        since.setDate(since.getDate() - WINDOW_DAYS)
        const sinceStr = since.toISOString().split('T')[0]

        // is_confirmed=true matches the drilldown (fetchCloses in
        // MarketingPerformance.jsx). Without this filter, calls on
        // unconfirmed EOD reports inflate the tile by 1+ while the
        // drilldown panel hides them — the row-vs-drilldown drift
        // Ben hit on Total Closes (tile=4, panel=3).
        const { data: reports, error: rErr } = await supabase
          .from('closer_eod_reports')
          .select('id, report_date, closer_id')
          .eq('is_confirmed', true)
          .gte('report_date', sinceStr)
        if (rErr) throw new Error(rErr.message)

        const reportIds = (reports || []).map(r => r.id)
        let calls = []
        if (reportIds.length) {
          // Page through to bypass PostgREST's 1000-row default cap.
          const PAGE = 1000
          let offset = 0
          while (true) {
            const { data, error: cErr } = await supabase
              .from('closer_calls')
              .select('eod_report_id, call_type, outcome, prospect_name')
              .in('eod_report_id', reportIds)
              .range(offset, offset + PAGE - 1)
            if (cErr) throw new Error(cErr.message)
            if (!data?.length) break
            calls = calls.concat(data)
            if (data.length < PAGE) break
            offset += PAGE
          }
        }

        if (cancelled) return
        setData({ reports: reports || [], calls })
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetch()
    return () => { cancelled = true }
  }, [])

  // Track the actual fetched window so byRange() can warn when a caller
  // requests data older than what's been loaded.
  const fetchedSinceRef = useMemo(() => {
    const since = new Date()
    since.setDate(since.getDate() - WINDOW_DAYS)
    return since.toISOString().split('T')[0]
  }, [])

  const byRange = useMemo(() => {
    return (daysOrRange = 30) => {
      // Accept either a numeric day count (legacy) OR a { from, to } / 'mtd'
      // range object. Without this, custom date ranges like "Dec 1 → Jan 1"
      // fell through to today-minus-N math, putting the prospect-metrics
      // numerator on a different window than the page's data filter.
      let cutoffStr, untilStr
      if (daysOrRange && typeof daysOrRange === 'object' && daysOrRange.from) {
        cutoffStr = daysOrRange.from
        untilStr  = daysOrRange.to || '9999-12-31'
      } else if (daysOrRange === 'mtd') {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
        cutoffStr = today.slice(0, 7) + '-01'
        untilStr  = today
      } else {
        const days = typeof daysOrRange === 'number' ? daysOrRange : 30
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - days)
        cutoffStr = cutoff.toISOString().split('T')[0]
        untilStr  = '9999-12-31'
      }
      // Out-of-window guard: the hook fetches a fixed WINDOW_DAYS slice once,
      // so any caller asking for data older than that gets a silent 0/0/0.
      // Log a warning and surface the gap on the return value so the page
      // can render a banner instead of pretending the count is real.
      const outOfWindow = cutoffStr < fetchedSinceRef

      // Map report → date so we can filter calls by report-date window
      const reportInRange = new Set()
      for (const r of data.reports) {
        if (r.report_date >= cutoffStr && r.report_date <= untilStr) reportInRange.add(r.id)
      }

      const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
      const liveSet = new Set()
      const closedSet = new Set()
      // Exclusion: "Historical Close YYYY-MM-DD #N" rows are synthetic
      // backfill entries that pre-date per-prospect tracking. Each one is
      // a self-100%-close (1 NC, 1 close, no real prospect) and inflates
      // the overall rate. Both numerator AND denominator skip them.
      const isHistoricalPlaceholder = (raw) => /^historical close\b/i.test((raw || '').trim())

      for (const c of data.calls) {
        if (!reportInRange.has(c.eod_report_id)) continue
        const name = norm(c.prospect_name)
        if (!name) continue
        if (isHistoricalPlaceholder(c.prospect_name)) continue
        const isNew = c.call_type === 'new_call'
        const isFu  = c.call_type === 'follow_up'
        if (isNew && (c.outcome === 'closed' || c.outcome === 'not_closed')) {
          liveSet.add(name)
        }
        if ((isNew || isFu) && c.outcome === 'closed') {
          closedSet.add(name)
        }
      }

      const liveProspects = liveSet.size
      const closedProspects = closedSet.size
      const closeRate = liveProspects > 0
        ? parseFloat(((closedProspects / liveProspects) * 100).toFixed(1))
        : 0

      if (outOfWindow) {
        console.warn(
          `[useCloserCallProspectMetrics] Requested range starts ${cutoffStr} ` +
          `but the hook only fetched data from ${fetchedSinceRef} onward ` +
          `(WINDOW_DAYS=${WINDOW_DAYS}). Counts older than the fetch window are 0 ` +
          `— widen WINDOW_DAYS or scope the consumer's range.`
        )
      }
      return { liveProspects, closedProspects, closeRate, outOfWindow, fetchedSince: fetchedSinceRef }
    }
  }, [data, fetchedSinceRef])

  return { byRange, loading, error }
}
