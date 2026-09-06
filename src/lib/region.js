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

/* Setter-logged leads carry no resolved audience. Australian if the source
   or any UTM names an AU funnel, or the phone is +61. */
const AU_HINT = /austral|tradie|facebook[- ]?oz|facebook-au|au-tradie|\bau\b|\(au\)/i
export function setterLeadInRegion(lead, region) {
  if (!region || region === 'all') return true
  const text = [lead?.lead_source, lead?.utm_source, lead?.utm_campaign, lead?.utm_content, lead?.notes].filter(Boolean).join(' ')
  const phone = String(lead?.phone || lead?.lead_phone || '').replace(/\D/g, '')
  const isAu = AU_HINT.test(text) || /^61/.test(phone)
  return region === 'au' ? isAu : !isAu
}
