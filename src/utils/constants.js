// GHL calendar IDs that represent auto-booked intro calls (not manually set by setters).
// Auto-bookings (cost-per-auto-booking, intro call funnel).
export const INTRO_CALENDARS = [
  '5omixNmtgmGMWQfEL0fs', 'C5NRRAjwsy43nOyU6izQ',
  'GpYh75LaFEJgpHYkZfN9', 'okWMyvLhnJ7sbuvSIzok', 'MvYStrHFsRTpunwTXIqT',
]

// GHL calendar IDs treated as qualified strategy bookings (denominator for show rates,
// CPB, qualified_bookings on the Marketing page). The two Calendly-mirrored calendars
// (round-robin) are not returned by `/calendars/?locationId=` but events are reachable
// via `/calendars/events?userId=…` — they must be tracked here so the strategy-calendar
// filter on `ghl_appointments` actually counts them.
export const STRATEGY_CALL_CALENDARS = [
  '9yoQVPBkNX4tWYmcDkf3', // Remodeling AI - Strategy Call
  'cEyqCFAsPLDkUV8n982h', // RestorationConnect AI - Strategy Call
  'HDsTrgpsFOXw9V4AkZGq', // (FB) RestorationConnect AI - Strategy Call
  'aQsmGwANALCwJBI7G9vT', // PlumberConnect AI - Strategy Call
  'StLqrES6WMO8f3Obdu9d', // PoolConnect AI - Strategy Call
  '3mLE6t6rCKDdIuIfvP9j', // (FB) PoolConnectAI - Strategy Call
  'T5Zif5GjDwulya6novU0', // Opt Digital | Strategy Call (Calendly)
  'gohFzPCilzwBtVfaC6fu', // Opt Digital | Strategy Call - DQ (Calendly)
]

export const ICON = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
}
