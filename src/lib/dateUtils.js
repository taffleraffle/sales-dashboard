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
  if (range === 'mtd') {
    const now = new Date()
    return now.getDate()
  }
  if (range && typeof range === 'object' && range.from) {
    const diff = Math.ceil((new Date() - new Date(range.from)) / 86400000)
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
