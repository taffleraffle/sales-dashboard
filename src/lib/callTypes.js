// Single source of truth for call-type bucketing.
// `closer_calls.call_type` values: 'growth_call' | 'growth_consult' | 'follow_up' | 'ascension' | 'new_call' (legacy)
//
// Buckets are calendar-driven. Mapping below mirrors GHL calendar IDs.
// When a new calendar is added in GHL, add it here in one place and both the migration
// backfill and runtime classification stay consistent.

// Follow-up calendar (Google Maps Launch — round-robin follow-ups)
export const FOLLOW_UP_CALENDARS = [
  'YwlJrWOB0FUSHGpbhTFr',
]

// Implementation / onboarding — post-sale delivery calls with existing clients
export const IMPLEMENTATION_CALENDARS = [
  'hKj0ppMLyJOp77jwxuBb', // 1-on-1 Implementation Call
  'wGuz4kALFLLw8xC1yA0O', // Client Onboarding
]

// Growth Consult calendars — lower-qualified prospects (lower income tier in questionnaire)
export const GROWTH_CONSULT_CALENDARS = [
  'HKY5UE8aZATuOy3yfAhG', // Google Growth Call Consult
  'QiaAhVwTjNKP5K4oRr7g', // Google Growth Call Consult (WFA)
  'a26wfUiGnYdvsrOuP6GY', // Google GROWTH CONSULTS
  'pC3TI6p6C8xDFRta1bPM', // Google Growth Consult — EM
  'lmJmoBxoGbpGYDqtoAtp', // Growth Consults (Set-A) — was previously bucketed as follow_up; corrected
]

// Growth Call calendars — higher-qualified prospects
export const GROWTH_CALL_CALENDARS = [
  'GcacvFI2p1g2kt05ckmk', // Google Growth Call
  '45IIubJ0Y1xHMqg4Fk7o', // Google Growth Call (WFA)
  'FQFCa4m6qxlGfaQTqThv', // Google Growth Call — EM
  'Pis9CDByZOQ5jv6EwziH', // (EM) Google Growth Call
  'oiXtsgrfQ7wnKQY04oSF', // Google GROWTH CALL
  'g6HBEm8qllrt4OgarHiz', // Google Growth Calls
  'yqeyADIZZogXJMvI9ym7', // Google Growth Call (2)
  'iehWeMdgTwGKx6CC19b9', // Google Growth Call (NS)
  'X8iMUtc1s7rXjaTfY4jr', // Google Growth Call (Set)
  'NdkOda4H8mCb4dNL9P6R', // Copy of Google Growth Call (Set)
  'xUL1d7yO3cgWTw3KzIyF', // Google Growth Call (S)
]

// ─── AU region calendars ─────────────────────────────────────────────
// Drop IDs in here once the AU - Growth Call / AU - Growth Consult
// calendars are duplicated in GHL. Any appointment routed to one of these
// auto-stamps region='AU' across closer_calls, payments, contact_attempts.
export const AU_GROWTH_CALL_CALENDARS = [
  'oXGl6b8YJhTSMGRmzUpv', // AU - Growth Call
]
export const AU_GROWTH_CONSULT_CALENDARS = [
  'die2Ij7DBi51QzDvazdV', // AU - Growth Consult
]
export const AU_CALENDARS = [
  ...AU_GROWTH_CALL_CALENDARS,
  ...AU_GROWTH_CONSULT_CALENDARS,
]

// Resolve a calendar identifier (GHL stores the ID in `calendar_name`) to a call_type bucket.
// Returns null if unknown — caller decides the fallback (typically keep existing value).
export function getCallTypeFromCalendar(calendarId) {
  if (!calendarId) return null
  if (FOLLOW_UP_CALENDARS.includes(calendarId)) return 'follow_up'
  if (GROWTH_CONSULT_CALENDARS.includes(calendarId)) return 'growth_consult'
  if (GROWTH_CALL_CALENDARS.includes(calendarId)) return 'growth_call'
  if (AU_GROWTH_CONSULT_CALENDARS.includes(calendarId)) return 'growth_consult'
  if (AU_GROWTH_CALL_CALENDARS.includes(calendarId)) return 'growth_call'
  if (IMPLEMENTATION_CALENDARS.includes(calendarId)) return 'implementation'
  return null
}

// 'AU' if the calendar is in the AU set, else 'US'. US is the legacy default.
export function getRegionFromCalendar(calendarId) {
  if (!calendarId) return 'US'
  return AU_CALENDARS.includes(calendarId) ? 'AU' : 'US'
}

// UI labels per bucket
export const CALL_TYPE_LABEL = {
  growth_call:    'Growth Call',
  growth_consult: 'Growth Consult',
  follow_up:      'Follow-up',
  ascension:      'Ascension',
  implementation: 'Implementation',
  new_call:       'New Call (legacy)',
}

// Buckets we render as separate rows on the dashboard (excludes ascension which is a separate revenue stream)
export const PRIMARY_BUCKETS = ['growth_call', 'growth_consult', 'follow_up']

// "Combined" KPI = Growth Call + Growth Consult only (per Daniel — never combine follow-ups in)
export const COMBINED_BUCKETS = ['growth_call', 'growth_consult']
