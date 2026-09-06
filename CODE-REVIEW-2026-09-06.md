# Code review: 6 September 2026 changes

**Range reviewed:** `e571807..e3eb07f` on master (37 files, +2,875 / -2,918), plus the
fixes in the commit that carries this file.
**Method:** diff read line by line, every metric definition checked against the database
for the 7 Aug to 5 Sep window, RLS policies read, the pages driven in a headless browser
under an anon-level session. The code-review skill's scripts are generic scaffolds and
crashed on a Windows console encoding before analysing anything, so nothing below comes
from them.

---

## Fixed in this commit

| # | File | Defect | Fix |
|---|---|---|---|
| 1 | `components/house/LeaderTable.jsx` | `rowKey` was called with the row only, but the revenue-breakdown modal builds its key with the index (`${date}-${name}-${i}`), so every key ended in `undefined` and two deals on the same day for the same prospect collided. React would warn and could re-use the wrong row on updates. | `rowKey(row, i)` |
| 2 | `services/speedToLeadDb.js` | The ET window edges were hard-coded to `-04:00`. That is EDT; from November to March New York is `-05:00`, so for half the year the speed-to-lead window would start and end an hour early. | `etOffset(dateStr)` derives the offset per date via `Intl`; verified `2026-07-01 -> -04:00`, `2026-01-15 -> -05:00`. |
| 3 | `hooks/useMarketingTracker.js` | Saving a benchmark in the Marketing page's Benchmarks modal updated the table but not the new shared `useBenchmarks` cache, so the Overview, Closers and Setters pages kept the old targets until a full reload. | `updateBenchmark` now calls `invalidateBenchmarks()`. |
| 4 | `pages/SalesOverview.jsx` | `dataReady` required at least one closer *and* one setter to exist. With either list empty the page would sit on the skeleton forever. Pre-existing, but the rebuild kept it. | Gate on the two `useTeamMembers` loading flags instead. |

Build and lint clean after the fixes (remaining lint noise is pre-existing `prop-types`
and unused-variable warnings in files not touched by this work).

---

## Verified correct, worth knowing

**Metric definitions in `useSalesMetrics` match the marketing view exactly.** For the
30-day window the hook's company totals equal the SQL sums to the dollar (spend $26,663,
372 leads, 92 bookings after migration 172, 27 lives, 3 closes, $6,617 cash), and the
rendered tiles match ($72 / $290 / $988 / 29.3% / 11.1% / $8,888 / 0.24x).

**Per-closer rows sum to the company row** for lives, closes, cash and revenue in the
current window (3 closes both ways). Two ways they *can* drift, by design:

- Company closes come from the resolver view which excludes the `Referral` audience;
  per-closer closes are every closed row. A referral close will show on the closer's row
  but not in the Team total. Acceptable, but label it if it starts happening.
- Per-closer bookings come from the calendar via `ghl_appointments.closer_id`. 89 of the
  92 bookings in the window carry a closer; the other 3 are not attributed to anyone, so
  the closer rows sum to 89 against a company 92.

**Migration 172 is safe.** `CREATE OR REPLACE VIEW` keeps the column list identical, so the
five dependent views and the matview rebuilt without touching their definitions. 141 rows
flipped to spam, all of them "…and OPT Digital". Nothing else in the expression changed.

**Data-loading races.** `useSalesMetrics` caches per range for two minutes and guards every
state update with an `alive` flag, so a fast range change cannot write a stale result over
a fresh one. Each of its six queries fails independently and reports into a callout instead
of blanking the page. `useBenchmarks` dedupes concurrent loads with a shared in-flight
promise.

---

## Known limitations, not fixed here

1. **Custom date ranges on the Overview's setter board and dialer totals.** WAVV
   aggregates and `useLeadAttribution` take a day count, so for a custom range that ends
   before today they run from `range.from` to *today*. The unified metrics and the closer
   board honour the exact range; the setter board does not. Fixing it means teaching
   `fetchWavvAggregates` an end date.
2. **Offers come from the typed EOD header.** The per-call `offered` flag is never set by
   the form (0 rows in 30 days), so this is the only source. It is the one number on the
   Closers page that is still self-reported.
3. **Speed to lead cannot be verified in my harness.** `typeform_responses` is correctly
   locked to logged-in users. The SQL behind it was checked (54 of 78 leads match a dial;
   median 20 hours) but the rendered tiles were only seen on your screen.
4. **Team page admin flows are unexercised.** The invite edge function only accepts the
   Render origin and requires an admin session. Add-a-person, Send invite, the four Save
   buttons and Deactivate all need one real click-through.
5. **EOD filing form** got a control-by-control restyle, not a flow rebuild, and was not
   driven end to end for the same reason.

---

## Security

**One real issue, already in the data audit as finding 11:** `team_members` carries an RLS
policy literally named **"Allow all"** (`public ALL`). The Team page hides Save, Invite and
Deactivate from non-admins, but that is UI only; anyone holding the public anon key (it is
in the JavaScript bundle) can update or delete `team_members` rows over REST. Dropping
that policy and keeping `team_members_auth` (authenticated SELECT) plus a service-role
write policy closes it. One migration, waiting on your go-ahead.

Everything else checked clean: no secrets in the diff, the invite function verifies the
caller is an admin server-side, the generator script for migration 172 reads Sentinel's
`.env` from a local path and contains no credentials, and every new query goes through
the Supabase client with the user's JWT.
