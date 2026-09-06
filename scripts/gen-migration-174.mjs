// One-off generator for supabase/migrations/174_region_signals.sql.
// Pulls the live definitions of the three audience resolvers and adds an
// Australian phone-number signal (+61) to each, adds the AU keywords to the
// Australia audience, and creates a confirmation view that carries audience.
// Nothing else in the views changes.
import { readFileSync, writeFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('C:/Users/Ben/sentinel/.env', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
async function viewdef(name) {
  const res = await fetch('https://api.supabase.com/v1/projects/kjfaqhmllagbxjdxlopm/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `select pg_get_viewdef('public.${name}'::regclass, true) as def`, read_only: true }),
  })
  const j = await res.json()
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j))
  return j[0].def
}
const must = (s, marker, label) => { if (!s.includes(marker)) throw new Error(`${label}: marker not found: ${marker.slice(0, 80)}`); return s }
const rep = (s, marker, repl, all = false) => all ? s.split(marker).join(repl) : s.replace(marker, () => repl)

// 1. Lead resolver: phone +61 sits after the manual/ad overrides, before the funnel keyword match
let tf = await viewdef('lib_typeform_audience_resolved')
if (tf.includes('phone_au')) throw new Error('lib_typeform_audience_resolved already patched')
must(tf, 'COALESCE(ro.audience_slug, ao.audience_slug, form_slug.slug', 'tf coalesce')
must(tf, "WHEN form_slug.slug IS NOT NULL THEN 'funnel'::text", 'tf source')
const TF_PHONE = "regexp_replace(COALESCE(tr.phone, ''::text), '\\D'::text, ''::text, 'g'::text) ~ '^61'::text"
tf = rep(tf, 'COALESCE(ro.audience_slug, ao.audience_slug, form_slug.slug',
  `COALESCE(ro.audience_slug, ao.audience_slug, CASE WHEN ${TF_PHONE} THEN 'australia'::text ELSE NULL::text END, form_slug.slug`)
tf = rep(tf, "WHEN form_slug.slug IS NOT NULL THEN 'funnel'::text",
  `WHEN ${TF_PHONE} THEN 'phone_au'::text\n            WHEN form_slug.slug IS NOT NULL THEN 'funnel'::text`)

// 2. Booking resolver: phone +61 after the manual and ad overrides
let bk = await viewdef('lib_strategy_booking_resolved')
if (bk.includes('phone_au')) throw new Error('lib_strategy_booking_resolved already patched')
must(bk, 'COALESCE(bo.audience, audience_display_name(ao.audience_slug), NULLIF(fa.aud', 'bk coalesce')
must(bk, "WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN", 'bk source')
const BK_PHONE = "regexp_replace(COALESCE(b.contact_phone, ''::text), '\\D'::text, ''::text, 'g'::text) ~ '^61'::text"
bk = rep(bk, 'COALESCE(bo.audience, audience_display_name(ao.audience_slug), NULLIF(fa.aud',
  `COALESCE(bo.audience, audience_display_name(ao.audience_slug), CASE WHEN ${BK_PHONE} THEN 'Australia'::text ELSE NULL::text END, NULLIF(fa.aud`)
bk = rep(bk, "WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN",
  `WHEN ${BK_PHONE} THEN 'phone_au'::text\n            WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN`)

// 3. Daily marketing view: leads bucket by phone first (expression appears in SELECT and GROUP BY)
let md = await viewdef('lib_marketing_by_audience_daily')
if (md.includes("'^61'")) throw new Error('lib_marketing_by_audience_daily already patched')
const MD_OLD = "COALESCE(audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text)"
must(md, MD_OLD, 'md leads audience')
const MD_NEW = `COALESCE(CASE WHEN ${TF_PHONE} THEN 'Australia'::text ELSE NULL::text END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text)`
const occurrences = md.split(MD_OLD).length - 1
md = rep(md, MD_OLD, MD_NEW, true)

const strip = s => s.trimEnd().replace(/;$/, '')
const sql = `-- 174: region signals for the Australia launch (Ben, 6 Sep 2026)
-- "Separate Australian leads and US leads": every resolver gains an Australian
-- phone-number signal (+61) so an AU lead, booking or call is tagged Australia
-- even when the form or campaign name gives nothing away. The Australia audience
-- also gains the keywords the AU forms and campaigns actually use. A new
-- confirmation view carries audience so the dashboard's region filter can split
-- confirmed / unconfirmed show rates too.

-- 1. Keywords the AU form ("Facebook Oz (AU)") and campaigns ("... - AU - ...", "TRADIES AU") use
UPDATE public.audience_definitions
   SET keywords = ARRAY['tradies','tradie','australia','australian','(au)',' au ','- au -','au - ','facebook oz','facebook-au','au-tradie']
 WHERE slug = 'australia';

-- 2. Leads: +61 phone => Australia (after manual and ad overrides)
CREATE OR REPLACE VIEW public.lib_typeform_audience_resolved AS
${strip(tf)};

-- 3. Bookings: +61 contact phone => Australia (after manual and ad overrides)
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
${strip(bk)};

-- 4. Daily marketing view: leads with a +61 phone bucket as Australia (${occurrences} occurrences patched)
CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
${strip(md)};

-- 5. Confirmation marks with audience, for the region filter
CREATE OR REPLACE VIEW public.lib_call_confirmation_by_closer_audience AS
 SELECT r.closer_id,
    r.report_date,
    COALESCE(cca.audience, 'Unknown'::text) AS audience,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text) AS confirmed_calls,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text AND ((cc.outcome::text = ANY (ARRAY['closed'::character varying, 'not_closed'::character varying]::text[])) OR cc.showed = true)) AS confirmed_showed,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text AND cc.outcome::text = 'no_show'::text) AS confirmed_noshow,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text) AS unconfirmed_calls,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text AND ((cc.outcome::text = ANY (ARRAY['closed'::character varying, 'not_closed'::character varying]::text[])) OR cc.showed = true)) AS unconfirmed_showed,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text AND cc.outcome::text = 'no_show'::text) AS unconfirmed_noshow
   FROM closer_calls cc
     JOIN closer_eod_reports r ON r.id = cc.eod_report_id
     JOIN ghl_appointments a ON a.ghl_event_id = cc.ghl_event_id
     JOIN booking_call_status cs ON cs.ghl_contact_id = a.ghl_contact_id
     LEFT JOIN lib_closer_call_audience cca ON cca.closer_call_id = cc.id
  WHERE cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''::text
  GROUP BY r.closer_id, r.report_date, COALESCE(cca.audience, 'Unknown'::text);

GRANT SELECT ON public.lib_call_confirmation_by_closer_audience TO anon, authenticated, service_role;
`
writeFileSync('supabase/migrations/174_region_signals.sql', sql)
console.log('written 174_region_signals.sql; md occurrences:', occurrences, '; bytes:', sql.length)
