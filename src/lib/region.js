import { useSyncExternalStore } from 'react'

/*
  Region filter: All / United States / Australia. One setting for the whole
  dashboard, kept in localStorage, read by useSalesMetrics (Overview, Closers,
  Setters, Marketing confirmation tiles) and by the Marketing page's audience
  filter.

  A region is a grouping of audiences: Australia is the "Australia" audience,
  United States is every other audience including Unknown. The audience itself
  is resolved at source (calendar, form, campaign, ad, +61 phone) by the views
  in migration 174, so the dashboard never guesses.
*/

export const REGIONS = [
  { value: 'all', label: 'All', short: 'All' },
  { value: 'us', label: 'United States', short: 'US' },
  { value: 'au', label: 'Australia', short: 'AU' },
]
export const AU_AUDIENCE = 'Australia'
const KEY = 'opt.sales.region'

let current = 'all'
try { const v = localStorage.getItem(KEY); if (v && REGIONS.some(r => r.value === v)) current = v } catch { /* no storage */ }
const listeners = new Set()

export function getRegion() { return current }
export function setRegion(value) {
  if (!REGIONS.some(r => r.value === value) || value === current) return
  current = value
  try { localStorage.setItem(KEY, value) } catch { /* no storage */ }
  listeners.forEach(fn => fn())
}
export function useRegion() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn) }, getRegion, () => 'all')
}
export function regionLabel(value) { return (REGIONS.find(r => r.value === value) || REGIONS[0]).label }

/* Does an audience display name belong to the region? */
export function audienceInRegion(audience, region) {
  if (!region || region === 'all') return true
  const isAu = (audience || 'Unknown') === AU_AUDIENCE
  return region === 'au' ? isAu : !isAu
}

/* An Australian phone is +61 followed by nine digits (eleven digits starting
   61) or a local 04 mobile as WAVV sometimes stores it. Length matters: WAVV
   stores US numbers as ten bare digits, so a Reading PA number (610...) or a
   Nashville one (615...) also "starts with 61" and was being counted as an
   Australian dial (Ben, 14 Sep 2026). One rule for dials, leads and setter
   leads, so the regions cannot drift. */
export function isAuPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  return (d.length === 11 && d.startsWith('61')) || /^04\d{8}$/.test(d)
}

/* The Australian strategy call is one Calendly event type; the same table also
   holds the US "Strategy Call - IF" bookings. Same rule as
   lib_strategy_booking_resolved (migration 175). */
export const CALENDLY_AUS_EVENT_TYPE = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'
export function isAuCalendlyBooking(b) {
  return b?.event_type_uri === CALENDLY_AUS_EVENT_TYPE || /\(aus\)|australia/i.test(b?.event_name || '')
}

/* Setter-logged leads carry no resolved audience. Australian if the source
   or any UTM names an AU funnel, or the phone is +61. */
const AU_HINT = /austral|tradie|facebook[- ]?oz|facebook-au|au-tradie|\bau\b|\(au\)/i
export function setterLeadInRegion(lead, region) {
  if (!region || region === 'all') return true
  const text = [lead?.lead_source, lead?.utm_source, lead?.utm_campaign, lead?.utm_content, lead?.notes].filter(Boolean).join(' ')
  const isAu = AU_HINT.test(text) || isAuPhone(lead?.phone || lead?.lead_phone)
  return region === 'au' ? isAu : !isAu
}
