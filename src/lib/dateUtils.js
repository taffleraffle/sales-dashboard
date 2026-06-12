/**
 * Compute a "since" date string (YYYY-MM-DD) from a range value.
 * Handles numeric days (7, 30), 'mtd' (month to date), and custom { from, to } objects.
 *
 * Convention: `sinceDate(N)` returns the start of an N-day window ENDING today.
 * "Today" (N=1) returns today's date — not yesterday's. "Last 7d" returns the
 * date 6 days ago, so the inclusive window is 7 days. Previously this was off
 * by one — sinceDate(1) returned yesterday, which made the "Today" preset
 * include 2 days of data.
 *
 * Anchored to ET (the business timezone) so users in non-ET zones see the same
 * window as the data buckets (closer EODs, GHL appointments, ad spend all
 * clock by ET).
 */
export function sinceDate(range) {
  if (range && typeof range === 'object' && range.from) {
    return range.from
  }
  if (range === 'mtd') {
    const today = todayET()
    return today.slice(0, 7) + '-01'
  }
  const days = typeof range === 'number' ? range : 30
  return etDateOffset(-Math.max(0, days - 1))
}

/**
 * Get the range as a numeric days value (for APIs that need a number).
 */
export function rangeToDays(range) {
  if (typeof range === 'number') return range
  // ET-anchored: browser-local Date here made NZ users' windows drift ±1 day
  // from the ET buckets everything else uses.
  if (range === 'mtd') {
    return parseInt(todayET().slice(8, 10), 10)
  }
  if (range && typeof range === 'object' && range.from) {
    const end = range.to || todayET()
    const diff = Math.round((new Date(end + 'T12:00:00') - new Date(range.from + 'T12:00:00')) / 86400000) + 1
    return Math.max(diff, 1)
  }
  return 30
}

/**
 * Format a Date to local YYYY-MM-DD string (avoids timezone issues with toISOString).
 */
export function toLocalDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Get today's date in US Eastern timezone (YYYY-MM-DD).
 * The sales team operates in US Eastern, so "today" should always be ET.
 */
export function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * Resolve any range value to { startStr, endStr } ET-anchored YYYY-MM-DD bounds.
 * Single source of truth shared across MarketingPerformance + AdsPerformance.
 *
 *   - 7 / 30 / 90  → ET today minus N-1 days  → ET today
 *   - 'mtd'        → first-of-this-month     → ET today
 *   - { from, to } → from                    → to (validated)
 *   - { from }     → from                    → ET today
 *
 * Without this helper, the Ads dashboard built UTC bounds (T00:00:00Z) while
 * the Marketing dashboard used ET bounds — windows diverged by 4-12 hours at
 * boundaries and the two dashboards reported different counts for the same
 * selected range. This guarantees they agree.
 */
export function dateRangeBoundsET(range) {
  // Custom { from, to }
  if (range && typeof range === 'object' && range.from) {
    return { startStr: range.from, endStr: range.to || todayET() }
  }
  // MTD
  if (range === 'mtd') {
    const today = todayET()
    return { startStr: today.slice(0, 7) + '-01', endStr: today }
  }
  // Numeric days
  const days = typeof range === 'number' ? range : (parseInt(range, 10) || 30)
  return { startStr: etDateOffset(-Math.max(0, days - 1)), endStr: todayET() }
}

/**
 * Get an ET-anchored date offset N days from today (YYYY-MM-DD).
 * Negative for past, positive for future.
 *
 * Why this exists: filterByDays on the Marketing page used to compute
 * `today - 7d` from the BROWSER'S local timezone, so a user in NZ and a
 * user in ET would see different trailing-7d windows for the same business
 * data. Using ET as the anchor keeps both views aligned with where the data
 * actually lives (closer EODs, GHL appointments, ad spend all bucket by ET).
 */
export function etDateOffset(days = 0) {
  const todayStr = todayET()
  const d = new Date(todayStr + 'T12:00:00') // noon avoids DST shift edge cases
  d.setDate(d.getDate() + days)
  return toLocalDateStr(d)
}
