// One-off generator for supabase/migrations/172_test_bookings_are_spam.sql.
// Pulls the live definition of lib_strategy_booking_resolved and adds the
// test-booking clause to its is_spam expression, nothing else.
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
const def = (await res.json())[0].def
const marker = "b.prospect_name ~ '^[0-9]+$'::text OR"
if (!def.includes(marker)) throw new Error('is_spam expression not found')
if (def.includes('opt digital')) throw new Error('view already patched')
// Function replacer: a string replacement would interpret the $' in the marker
const patched = def.replace(marker, () => "b.contact_name ~* 'opt digital'::text OR " + marker)

const header = `-- 172: test bookings are spam at the source
-- Agency-internal calendar tests are titled "<name> and OPT Digital". The Marketing
-- page filtered them in the browser; the view (and so lib_marketing_by_audience_daily,
-- the Overview and the Closers pages) did not, which is why the Overview said 153
-- qualified bookings for a window where the Marketing tile said 92.
-- Only change: the is_spam expression gains  b.contact_name ~* 'opt digital'.
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
`
writeFileSync('supabase/migrations/172_test_bookings_are_spam.sql', header + patched.trimEnd().replace(/;$/, '') + ';\n')
console.log('written; clause present:', (header + patched).includes("~* 'opt digital'"))
