// One-off generator for supabase/migrations/176_au_lead_form_leads.sql.
// Australian leads arrive as Facebook Lead Ads (tag "fb lead (aus)" in
// GoHighLevel), not through Typeform, so the daily marketing view never saw
// them. This adds those contacts to the leads bucket as audience Australia,
// by the New York date they were added. Contacts that also submitted a
// Typeform are excluded to avoid double counting.
import { readFileSync, writeFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('C:/Users/Ben/sentinel/.env', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const res = await fetch('https://api.supabase.com/v1/projects/kjfaqhmllagbxjdxlopm/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: "select pg_get_viewdef('public.lib_marketing_by_audience_daily'::regclass, true) as def", read_only: true }),
})
const j = await res.json()
if (!Array.isArray(j)) throw new Error(JSON.stringify(j))
let def = j[0].def.trimEnd().replace(/;$/, '')
if (def.includes('fb lead (aus)')) throw new Error('view already patched')

const startMarker = '), leads_d AS ('
const endMarker = '), qual_bookings_d AS ('
const a = def.indexOf(startMarker), b = def.indexOf(endMarker)
if (a < 0 || b < 0 || b < a) throw new Error('leads_d CTE not found')
const original = def.slice(a + startMarker.length, b)   // the SELECT body of leads_d

const replacement = `), leads_typeform AS (${original}), leads_ghl_au AS (
         SELECT (c.date_added AT TIME ZONE 'America/New_York'::text)::date AS date,
            'Australia'::text AS audience,
            count(*) AS leads,
            count(*) AS qualified_leads
           FROM ghl_contacts c
          WHERE c.tags::text ~~* '%fb lead (aus)%'::text
            AND c.date_added IS NOT NULL
            AND NOT (c.email IS NOT NULL AND EXISTS ( SELECT 1 FROM typeform_responses tr WHERE lower(tr.email) = lower(c.email)))
          GROUP BY ((c.date_added AT TIME ZONE 'America/New_York'::text)::date)
        ), leads_d AS (
         SELECT u.date, u.audience, sum(u.leads)::bigint AS leads, sum(u.qualified_leads)::bigint AS qualified_leads
           FROM ( SELECT leads_typeform.date, leads_typeform.audience, leads_typeform.leads, leads_typeform.qualified_leads FROM leads_typeform
                  UNION ALL
                  SELECT leads_ghl_au.date, leads_ghl_au.audience, leads_ghl_au.leads, leads_ghl_au.qualified_leads FROM leads_ghl_au) u
          GROUP BY u.date, u.audience
        `
def = def.slice(0, a) + replacement + def.slice(b)

const sql = `-- 176: Australian Facebook lead-form leads count as leads (Ben, 6 Sep 2026)
-- AU leads come in as Facebook Lead Ads and land in GoHighLevel tagged "fb lead (aus)";
-- they never touch Typeform, so the daily marketing view (and every CPL on the
-- dashboard) missed them. They now join the leads bucket as audience Australia by
-- the New York date they were added. Contacts with a Typeform response are skipped.
CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
${def};
`
writeFileSync('supabase/migrations/176_au_lead_form_leads.sql', sql)
console.log('written 176_au_lead_form_leads.sql; bytes:', sql.length)
