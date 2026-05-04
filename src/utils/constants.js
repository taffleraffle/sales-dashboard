// GHL calendar IDs that represent auto-booked intro calls (not manually set by setters).
// Auto-bookings (cost-per-auto-booking, intro call funnel).
export const INTRO_CALENDARS = [
  '5omixNmtgmGMWQfEL0fs', 'C5NRRAjwsy43nOyU6izQ',
  'GpYh75LaFEJgpHYkZfN9', 'okWMyvLhnJ7sbuvSIzok', 'MvYStrHFsRTpunwTXIqT',
]

// All strategy-call calendars (qualified + DQ together). Used as the
// authoritative "any booking" list — total bookings, all show-rate inputs,
// the GHL appointment sync, etc. The Calendly mirrors are not returned by
// `/calendars/?locationId=` but events are reachable via
// `/calendars/events?userId=…`, so they must be listed here explicitly.
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

// Subset of strategy calendars that route disqualified prospects. Pending
// confirmation from Ben on which of T5Zif vs gohF is actually the DQ flow —
// reverted to the GHL-named DQ calendar for now to match what the calendar
// names suggest. Update once the per-calendar split is confirmed.
export const DQ_BOOKING_CALENDARS = [
  'gohFzPCilzwBtVfaC6fu', // Opt Digital | Strategy Call - DQ (Calendly)
]

// Strategy calendars EXCLUDING the DQ flow. This is the denominator for
// `qualified_bookings` and CPQB on the Marketing page.
export const QUALIFIED_BOOKING_CALENDARS = STRATEGY_CALL_CALENDARS.filter(
  c => !DQ_BOOKING_CALENDARS.includes(c)
)

export const ICON = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
}
