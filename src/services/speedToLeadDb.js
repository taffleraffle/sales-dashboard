import { supabase } from '../lib/supabase'
import { dateRangeBoundsET } from '../lib/dateUtils'
import { isAuPhone } from '../lib/region'
import { computeSpeedToLead } from './ghlPipeline'

/*
  Speed to lead from the database, not the GoHighLevel API.

  The Overview used to pull every GHL pipeline through the API and match
  opportunities to WAVV calls in the browser. GHL rate-limits the whole
  account for minutes at a time (429 on every endpoint), and when it does
  the tile sits on "…" forever. Everything needed is already in Supabase:

    lead  = a Typeform opt-in with a phone number (typeform_responses),
            which is also what "leads" means on the cost-per-lead tile,
            plus, for Australia, the Facebook lead-form contacts that land
            in GoHighLevel tagged "fb lead (aus)" (they never fill a Typeform)
    dial  = wavv_calls, matched on the last 10 digits of the phone

  Region (Ben, 14 Sep 2026): this ignored the All / US / AU switch, so on
  AU the tile reported every US lead and none of the lead-form ones. A
  Typeform lead is Australian by its +61 phone or its AU form, the same
  rule as lib_marketing_by_audience_daily; a lead-form contact by its tag.

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
const AU_FORM = /austral|\(au\)|facebook oz|facebook-au|au-tradie/i
const isAuLead = (phone, formName) => isAuPhone(phone) || AU_FORM.test(formName || '')

// UTC offset for America/New_York on a given calendar day ('-04:00' in summer,
// '-05:00' in winter), so the window edges fall on ET midnight all year.
export function etOffset(dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`)
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'GMT-04:00'
  const m = part.match(/([+-])(\d{2}):?(\d{2})/)
  return m ? `${m[1]}${m[2]}:${m[3]}` : '-04:00'
}

export async function fetchSpeedToLeadFromDb(range, setterSchedules = {}, region = 'all') {
  const { startStr, endStr } = dateRangeBoundsET(range)
  const startIso = `${startStr}T00:00:00${etOffset(startStr)}`
  const endIso = `${endStr}T23:59:59${etOffset(endStr)}`

  const [responses, calls, leadFormContacts] = await Promise.all([
    fetchAll(() => supabase
      .from('typeform_responses')
      .select('response_id, submitted_at, first_name, last_name, phone, form_name')
      .gte('submitted_at', startIso)
      .lte('submitted_at', endIso)
      .not('phone', 'is', null)
      .order('submitted_at', { ascending: false })),
    fetchAll(() => supabase
      .from('wavv_calls')
      .select('phone_number, started_at, user_id, call_duration')
      .gte('started_at', startIso)
      .order('started_at', { ascending: true })),
    region === 'us' ? Promise.resolve([]) : fetchAll(() => supabase
      .from('ghl_contacts')
      .select('ghl_contact_id, date_added, first_name, last_name, email, phone')
      .contains('tags', ['fb lead (aus)'])
      .gte('date_added', startIso)
      .lte('date_added', endIso)
      .not('phone', 'is', null)
      .order('date_added', { ascending: false })),
  ])

  // A lead-form contact who also filled a Typeform is already in `responses`
  // (same rule as the leads view: matched on email, any date).
  const seenEmails = new Set()
  const emails = [...new Set(leadFormContacts.map(c => (c.email || '').toLowerCase()).filter(Boolean))]
  if (emails.length) {
    const { data } = await supabase.from('typeform_responses').select('email').in('email', emails)
    for (const t of data || []) seenEmails.add((t.email || '').toLowerCase())
  }

  const toOpp = (id, createdAt, phone, first, last) => ({
    id, createdAt,
    contact: { id, phone: digits(phone), name: [first, last].filter(Boolean).join(' ') || 'Unknown' },
  })
  const opportunities = [
    ...responses
      .filter(r => digits(r.phone).length === 10)
      .filter(r => region === 'all' || (region === 'au') === isAuLead(r.phone, r.form_name))
      .map(r => toOpp(r.response_id, r.submitted_at, r.phone, r.first_name, r.last_name)),
    ...leadFormContacts
      .filter(c => digits(c.phone).length === 10 && !(c.email && seenEmails.has(c.email.toLowerCase())))
      .map(c => toOpp(c.ghl_contact_id, c.date_added, c.phone, c.first_name, c.last_name)),
  ]

  if (opportunities.length === 0) return null
  return computeSpeedToLead(opportunities, calls, [], setterSchedules)
}
