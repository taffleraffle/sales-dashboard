/**
 * Compute a "since" date string (YYYY-MM-DD) from a range value.
 * Handles numeric days (7, 30), 'mtd' (month to date), and custom { from, to } objects.
 */
export function sinceDate(range) {
  const now = new Date()
  if (range && typeof range === 'object' && range.from) {
    return range.from
  }
  if (range === 'mtd') {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }
  const days = typeof range === 'number' ? range : 30
  const since = new Date()
  since.setDate(since.getDate() - days)
  return since.toISOString().split('T')[0]
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
