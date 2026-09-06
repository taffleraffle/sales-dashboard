// One-off generator for supabase/migrations/175_calendly_bookings.sql.
// Creates calendly_bookings (fed by the calendly-booking-slack function),
// backfills the Australian bookings pulled from the Calendly API on 6 Sep 2026,
// and unions the Australian Calendly event into lib_strategy_booking_resolved
// so the dashboard counts them as booked calls. US Calendly bookings are NOT
// unioned: those already reach GoHighLevel and would double count.
import { readFileSync, writeFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('C:/Users/Ben/sentinel/.env', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const res = await fetch('https://api.supabase.com/v1/projects/kjfaqhmllagbxjdxlopm/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: "select pg_get_viewdef('public.lib_strategy_booking_resolved'::regclass, true) as def", read_only: true }),
})
const j = await res.json()
if (!Array.isArray(j)) throw new Error(JSON.stringify(j))
let def = j[0].def.trimEnd().replace(/;$/, '')
if (def.includes('calendly_bookings')) throw new Error('view already unioned')

const AUS_TYPE = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'
const EV = 'Opt Digital | Strategy Call 1 (AUS)'
// From the Calendly API, 6 Sep 2026 (event uuid, name, email, start, created, host, status, utm)
const rows = [
  ['4dc592a2-58f8-4076-9861-edaaddd26905', 'Paul Byers', 'pbyers69@bigpond.com', '2026-09-03T04:00:00Z', '2026-09-02T19:13:33Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
  ['ea38e7b6-f6c5-4942-9550-289f20b02210', 'David Price', 'davidpriceconcrete@gmail.com', '2026-09-04T03:00:00Z', '2026-09-03T04:43:26Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
  ['f38eeb20-80ee-446f-b3f4-070ed7933db0', 'dennis', 'cindypsaila@gmail.com', '2026-09-04T03:00:00Z', '2026-09-03T20:15:30Z', 'daniel@optdigital.io', 'Daniel Gomez De Le Vega', 'active', 'Australia/Sydney', {}],
  ['04ae82bf-d5bb-4072-b438-e87e2a70432e', 'Allan', 'roder@bigpond.com', '2026-09-04T08:00:00Z', '2026-09-02T11:37:30Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
  ['e6dc85b5-499c-496b-9f4b-e4a11d152c82', 'Kamran Khan', 'kamrankhans88@gmail.com', '2026-09-07T03:30:00Z', '2026-09-05T20:17:13Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
  ['6497752a-ac22-49f9-a23a-d6f30235ad89', 'Chad Mckelvey', 'chad@cgfsecurityandelectrical.com.au', '2026-09-07T05:00:00Z', '2026-09-02T21:03:01Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
  ['445879dc-e674-4c95-a5b6-1b36318c5314', 'Johnny T', 'yonatantal17@gmail.com', '2026-09-07T06:00:00Z', '2026-09-02T13:09:45Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', { utm_campaign: 'OPT | GMB - BROAD - LEAD FORM - 2026-09', utm_source: 'facebook', utm_medium: 'Adv +', utm_content: 'TOON-HOME-gmb-onecity', utm_term: '120252064040770530' }],
  ['c9976a1d-ed7f-4fbb-8f49-7d6e149fb949', 'Mark Stachnik', 'mark@carpetcleaning.com.au', '2026-09-08T03:00:00Z', '2026-09-04T09:07:05Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Brisbane', {}],
  ['680f4fb5-cd33-4cd2-93fe-dcb601cd1416', 'Benjamin', 'ben@opt.co.nz', '2026-09-09T04:00:00Z', '2026-09-06T05:55:05Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Pacific/Auckland', { utm_source: 'facebook-au' }],
  ['2aff41f8-98ef-49fb-99a0-30b43b319f6f', 'Diamont', 'ben@opt.co.nz', '2026-09-09T04:30:00Z', '2026-09-06T03:14:13Z', 'ben@opt.co.nz', 'Ben Hobbs', 'canceled', 'Pacific/Auckland', { utm_source: 'facebook-au' }],
  ['0cb34678-3111-4a6d-be0d-94e65e50e437', 'Velle', 'info@marcoplumbing.com.au', '2026-09-09T05:30:00Z', '2026-09-05T06:13:19Z', 'daniel@optdigital.io', 'Daniel Gomez De Le Vega', 'active', 'Australia/Sydney', {}],
  ['87d9ad49-05bc-476c-aa1f-d3e4ce2a7d84', 'Luke Luke', 'luke@nextlevelstrata.com.au', '2026-09-09T06:00:00Z', '2026-09-04T17:43:29Z', 'ben@opt.co.nz', 'Ben Hobbs', 'active', 'Australia/Sydney', {}],
]
const q = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
const values = rows.map(([uuid, name, email, start, created, hostEmail, hostName, status, tz, utm]) => {
  const eventUri = `https://api.calendly.com/scheduled_events/${uuid}`
  return `(${q(eventUri + '#' + email.toLowerCase())}, ${q(eventUri)}, ${q(AUS_TYPE)}, ${q(EV)}, ${q(status)}, ${q(start)}, ${q(created)}, ${q(name)}, ${q(email)}, ${q(tz)}, ${q(utm.utm_source)}, ${q(utm.utm_medium)}, ${q(utm.utm_campaign)}, ${q(utm.utm_content)}, ${q(utm.utm_term)}, ${q(hostEmail)}, ${q(hostName)})`
}).join(',\n  ')

const union = `
UNION ALL
 SELECT md5(cb.invitee_uri)::uuid AS id,
    cb.invitee_uri AS ghl_event_id,
    NULL::text AS ghl_contact_id,
    cb.invitee_email AS contact_email,
    cb.invitee_name AS contact_name,
    ('calendly:'::text || cb.event_type_uri) AS calendar_name,
    (cb.booked_at AT TIME ZONE 'America/New_York'::text)::date AS booked_at,
    (cb.start_time AT TIME ZONE 'America/New_York'::text)::date AS appointment_date,
    'confirmed'::text AS appointment_status,
    NULL::text AS revenue_tier,
    false AS is_dq,
    'Australia'::text AS audience,
    'calendly_aus'::text AS audience_source,
    NULL::text AS resolved_ad_id,
    NULL::text AS resolved_campaign_id,
    NULL::text AS resolved_adset_id,
    NULL::text AS resolved_match_method,
    (cb.invitee_email ~* '@(opt\\.co\\.nz|optdigital\\.io)$'::text OR cb.invitee_name ~* '^(test|diamont)'::text) AS is_spam
   FROM calendly_bookings cb
  WHERE cb.status <> 'canceled'::text
    AND (cb.event_type_uri = '${AUS_TYPE}'::text OR cb.event_name ~* '\\(aus\\)|australia'::text)`

const sql = `-- 175: Australian Calendly bookings count as booked calls (Ben, 6 Sep 2026)
-- The AU funnel books on the Calendly event "Opt Digital | Strategy Call 1 (AUS)".
-- Those bookings never reach GoHighLevel, so the dashboard had zero Australian
-- bookings and no cost per booked call. The calendly-booking-slack function now
-- stores every booking here; the AUS event is unioned into the booking resolver
-- as audience Australia. US Calendly bookings are not unioned (they reach GHL).

CREATE TABLE IF NOT EXISTS public.calendly_bookings (
  invitee_uri      text PRIMARY KEY,
  event_uri        text,
  event_type_uri   text,
  event_name       text,
  status           text NOT NULL DEFAULT 'active',
  start_time       timestamptz,
  end_time         timestamptz,
  booked_at        timestamptz NOT NULL DEFAULT now(),
  invitee_name     text,
  invitee_email    text,
  invitee_phone    text,
  invitee_timezone text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  host_email       text,
  host_name        text,
  reschedule_url   text,
  cancel_url       text,
  raw              jsonb,
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendly_bookings_event_type_idx ON public.calendly_bookings (event_type_uri, booked_at);
ALTER TABLE public.calendly_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendly_bookings_read ON public.calendly_bookings;
CREATE POLICY calendly_bookings_read ON public.calendly_bookings FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.calendly_bookings TO anon, authenticated;
GRANT ALL ON public.calendly_bookings TO service_role;

-- Backfill: every booking on the AUS event as of 6 Sep 2026 (from the Calendly API)
INSERT INTO public.calendly_bookings
  (invitee_uri, event_uri, event_type_uri, event_name, status, start_time, booked_at, invitee_name, invitee_email, invitee_timezone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, host_email, host_name)
VALUES
  ${values}
ON CONFLICT (invitee_uri) DO NOTHING;

-- Union the AUS event into the booking resolver
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
${def}${union};
`
writeFileSync('supabase/migrations/175_calendly_bookings.sql', sql)
console.log('written 175_calendly_bookings.sql; rows:', rows.length, '; bytes:', sql.length)
