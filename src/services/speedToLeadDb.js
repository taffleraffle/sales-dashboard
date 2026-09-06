import { supabase } from '../lib/supabase'
import { dateRangeBoundsET } from '../lib/dateUtils'
import { computeSpeedToLead } from './ghlPipeline'

/*
  Speed to lead from the database, not the GoHighLevel API.

  The Overview used to pull every GHL pipeline through the API and match
  opportunities to WAVV calls in the browser. GHL rate-limits the whole
  account for minutes at a time (429 on every endpoint), and when it does
  the tile sits on "…" forever. Everything needed is already in Supabase:

    lead  = a Typeform opt-in with a phone number (typeform_responses),
            which is also what "leads" means on the cost-per-lead tile
    dial  = wavv_calls, matched on the last 10 digits of the phone

  The rows are mapped onto the shape computeSpeedToLead already expects
  (opportunity.createdAt + contact.phone), so the maths, the per-setter
  buckets and the operating-hours filter are exactly the ones the rest of
  the app uses.
*/

const PAGE = 1000

async function fetchAll(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

const digits = (p) => (p || '').replace(/\D/g, '').slice(-10)

export async function fetchSpeedToLeadFromDb(range, setterSchedules = {}) {
  const { startStr, endStr } = dateRangeBoundsET(range)
  const startIso = `${startStr}T00:00:00-04:00`
  const endIso = `${endStr}T23:59:59-04:00`

  const [responses, calls] = await Promise.all([
    fetchAll(() => supabase
      .from('typeform_responses')
      .select('response_id, submitted_at, first_name, last_name, phone')
      .gte('submitted_at', startIso)
      .lte('submitted_at', endIso)
      .not('phone', 'is', null)
      .order('submitted_at', { ascending: false })),
    fetchAll(() => supabase
      .from('wavv_calls')
      .select('phone_number, started_at, user_id, call_duration')
      .gte('started_at', startIso)
      .order('started_at', { ascending: true })),
  ])

  const opportunities = responses
    .filter(r => digits(r.phone).length === 10)
    .map(r => ({
      id: r.response_id,
      createdAt: r.submitted_at,
      contact: {
        id: r.response_id,
        phone: digits(r.phone),
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
      },
    }))

  if (opportunities.length === 0) return null
  return computeSpeedToLead(opportunities, calls, [], setterSchedules)
}
