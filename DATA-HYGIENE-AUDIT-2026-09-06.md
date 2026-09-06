# Sales Dashboard: data hygiene audit

**Date:** 6 September 2026
**Scope:** every page that stays in the sidebar (Overview, Closers, Setters, Setter Bot,
Marketing, Library, Shorts, Ad Library, EOD) plus their detail pages and drilldowns.
**Method:** every metric on those pages was traced back to the query that produces it, then
recomputed directly against Supabase (`kjfaqhmllagbxjdxlopm`) for a fixed window
(August 2026) so the two can be compared. Nothing below is an estimate.

**Nothing in this document has been changed in the product yet.** These are findings for
sign-off. Ordered by how much they move a number you actually look at.

---

## The headline

For **August 2026**, "Qualified Bookings" has three different answers inside the app:

| Where it appears | August 2026 |
|---|---|
| Q.Books tile on the Marketing page | **84** |
| The drilldown you get when you click that tile | **74** |
| Your locked definition (qualified = $30k/m and up) | **80** |

All three read the same booking rows. They disagree because the tile and the drilldown apply
different qualification logic, and neither one uses the $30k bar. Detail in findings 1 and 2.

---

## 1. The qualified-revenue floor is $50k in code. Your rule is $30k. (HIGH)

`src/services/ghlCalendar.js:271`

```js
const QUALIFIED_REVENUE_FLOOR = 50_000
```

The comment dates it to 29 June 2026. On 9 to 10 August you corrected the bar to **$30k/m and
above is qualified**, on the basis that the funnel itself only DQs `$0 - $30,000/m`. The code
was never updated, so every prospect in the `$30k - $50k/m` band is being auto-DQ'd.

The Typeform bands changed underneath it too. The form now emits `$0 - $30,000/m` and
`$30k - $50k/m`, and the `$30k - $50k/m` band has been in continuous use since April:

| Month | responses in `$30k - $50k/m` |
|---|---|
| Apr 2026 | 10 |
| May 2026 | 29 |
| Jun 2026 | 24 |
| Jul 2026 | 19 |
| Aug 2026 | 16 |

**Effect on August, non-deduped booking basis:** 114 qualified at the $50k floor, **128** at
the $30k floor. Qualified bookings are understated by roughly **12%**, and every
cost-per-qualified-booked-call figure is overstated by the same proportion.

**Fix:** one constant. Change `50_000` to `30_000`.

### 1b. A band label parses as thirty dollars

`isDQRevenueTier` reads the lower bound and borrows a `k`/`m` magnitude from the upper bound if
the lower bound has none. The string `$30-$50,000`, which is live in
`lib_booking_resolved_mv`, has no `k` anywhere, so it parses as **30**, not 30,000. That
prospect is DQ'd no matter which floor you set. One August booking is affected. Low volume, but
the parser will keep mis-reading any band written that way.

---

## 2. The Q.Books tile and its own drilldown apply different rules (HIGH)

`lib_booking_resolved_mv.revenue_tier` is **NULL for 344 of 349 bookings** since 1 June.

- The **tile** (`loadBookings`) reads the matview and uses the matview's own `revenue_tier`.
  Because that column is empty, **no revenue DQ is ever applied on the tile path**.
- The **drilldown** (`fetchBookings`) backfills the tier from `typeform_responses` by email,
  then applies the DQ. For August it recovers a tier for **67 of 84** bookings.

So the tile counts almost everything as qualified and the drilldown removes the low bands. That
is the 84 versus 74 gap. It is not a rounding or dedup artefact, it is two different definitions
on the same screen.

**Fix:** do the tier resolution once, in `lib_booking_resolved_mv`, so both paths read a
populated `revenue_tier`. That collapses the tile and the drilldown onto one number and makes
finding 1 a single-place fix rather than a two-place one.

---

## 3. Sales Overview and Marketing build "the last 30 days" differently (HIGH)

There are three competing ways to build a date window in this codebase:

| Method | Anchored to | Used by |
|---|---|---|
| `dateRangeBoundsET()` | ET | `AdsPerformance` only |
| `sinceDate()` | ET | 20 files |
| `new Date().toISOString().split('T')[0]` | **UTC, from the browser clock** | 27 files |

`dateRangeBoundsET` carries a comment describing it as the "single source of truth shared
across MarketingPerformance + AdsPerformance". MarketingPerformance never adopted it.

Concretely, `SalesOverview.jsx:515` builds the start of its cost-per-booked window in UTC and
subtracts a full `days` rather than `days - 1`, while the Marketing page uses an ET window of
exactly `days`:

| Page | Window it actually queries | Qualified bookings |
|---|---|---|
| Sales Overview | 2026-08-06 to 2026-09-05 | **158** |
| Marketing tiles | 2026-08-07 to 2026-09-05 | **153** |

Same label, "last 30 days", 5 bookings apart. Both feed cost-per-booked figures, so those
disagree too.

There is a second edge to this. You work in NZ. Between **noon and 4pm NZ time** the UTC date
is a day ahead of the ET date, so for four hours of every working day the UTC-windowed tiles
and the ET-windowed tiles are reporting genuinely different date ranges.

**Fix:** route every window through `dateRangeBoundsET`, and delete the ad-hoc UTC arithmetic.

---

## 4. EOD header totals disagree with their own call rows (HIGH)

The tiles read the header fields on `closer_eod_reports` (`total_cash_collected`,
`total_revenue`, `closes`). The drilldowns list the `closer_calls` rows underneath. Since
1 June these disagree on **7 reports**:

| Report date | Header cash | Sum of call rows | Gap | Header revenue | Sum of call rows |
|---|---|---|---|---|---|
| 2026-06-04 | 0 | 2,500 | -2,500 | 0 | 7,500 |
| 2026-06-15 | 500 | 3,000 | -2,500 | 9,997 | 17,497 |
| 2026-06-30 | 997 | 9,000 | -8,003 | 9,997 | 18,000 |
| 2026-07-16 | 0 | 3,000 | -3,000 | 0 | 9,000 |
| 2026-07-17 | 0 | 0 | 0 | 0 | 13,200 |
| 2026-08-03 | 0 | 2,000 | -2,000 | 0 | 7,000 |
| 2026-08-10 | 3,497 | 3,617 | -120 | 17,497 | 17,497 |

Total cash understated by the headers: **$18,123**.

For August the tile says **$9,488** collected. Adding up the call rows behind it gives
**$11,608**.

The header fields are hand-entered on the EOD form and are not recomputed when a call row is
added or edited afterwards.

**Fix:** derive the header totals from the call rows instead of storing them separately, or
recompute on save. This one needs a decision from you, because it changes historical numbers.

---

## 5. Three currencies are added together as if they were dollars (MEDIUM)

`payments.currency` holds USD, NZD and AUD. No code anywhere in `useCommissions.js`,
`commissionCalc.js`, `PaymentsTab.jsx`, `ClientsTab.jsx` or `CommissionPage.jsx` references
`currency` at all. Every total is a raw `sum(amount)`.

August 2026:

| Currency | Payments | Amount |
|---|---|---|
| USD | 59 | 91,733.90 |
| AUD | 16 | 47,700.54 |
| NZD | 20 | 10,723.18 |
| **Shown as** | 95 | **150,157.62** |

At roughly 0.65 AUD and 0.56 NZD the true USD figure is about **128,700**. The displayed total
is overstated by about **$21,400**, or 17%.

All-time the mix is 400 USD, 163 NZD, 95 AUD, so this is not a one-off month.

Lower priority only because the Commissions page is already out of the sidebar. It is still
wrong wherever it is read.

---

## 6. PostgREST silently caps every query at 1,000 rows (MEDIUM, latent)

The project's PostgREST `max_rows` is **1000**. A query asking for more does not error, it
just returns 1,000 rows and the page aggregates whatever it got.

Four queries ask for more than the cap:

| Location | Asks for | Table size today |
|---|---|---|
| `MarketingPerformance.jsx:2526` | 5000 | `ghl_appointments`, 2,015 rows total |
| `MarketingPerformance.jsx:4098` | 5000 | `lib_show_by_held_daily`, 327 |
| `MarketingPerformance.jsx:4070` | 2000 | `lib_marketing_by_audience_daily_mv`, 845 |
| `MarketingPerformance.jsx:2605` | 2000 | `clients` with email, 49 |

`ghl_appointments` is already over the cap at 2,015 rows. The query at 2526 is date-bounded so
it currently lands under 1,000, but nothing enforces that.

`wavvService.js` is the one place that does this correctly, paginating with `.range()`.

**Fix:** paginate the four call sites the way `wavvService` already does. This is the failure
mode that produces "the number quietly went down and nobody knows why".

---

## 7. Meta spend is on Auckland days, everything else is on ET days (MEDIUM)

Meta reports the OPT account in NZD and buckets days in **Pacific/Auckland**. So
`ad_daily_stats.date` is an Auckland business day, while every metric it is divided by is
bucketed on ET. At 7-day and shorter windows the spend in the numerator and the bookings in the
denominator are not drawn from the same days.

`metaAdsSync.js:20-23` then builds the `since`/`until` it sends to Meta from
`toISOString()`, which is **UTC**, a third timezone. Because Auckland is ahead of UTC, `until`
is behind the Auckland date for about twelve hours a day, so the current day's spend lags.

The NZD to USD conversion is a fixed `0.56` applied **at sync time** and baked into the stored
row, so a re-sync of an old period rewrites history at whatever the constant is then. That is
survivable while the rate stays 0.56, but it means `ad_daily_stats.spend` is not reproducible
from source.

---

## 8. `ghl_appointments.booked_at` is a text column (MEDIUM)

Not a timestamp. It holds two different formats:

- 1,975 rows as `2026-09-05T14:20:46.000Z`
- 40 rows with a space separator

`SetterOverview.jsx:39` filters it with `.gte('booked_at', '<date> 00:00:00')`, which is a
**lexicographic string comparison**, not a date comparison. It happens to give the right answer
for both formats today, purely because `T` sorts after a space. Any third format, a date with
no time, or an epoch value would be silently dropped from the window with no error.

**Fix:** convert the column to `timestamptz`.

---

## 9. Pages that read `ghl_appointments` count a different thing (LOW, by design but undocumented)

For August: `ghl_appointments` holds **191** appointments, `lib_booking_resolved_mv` holds
**122** held and **135** booked. The gap is real and mostly correct, `ghl_appointments` is
every calendar with no exclusions and no dedup, while the matview is strategy calls with
`booking_excluded` and spam folded in.

Setter Overview narrows it to `INTRO_CALENDARS` so it is measuring auto-booked intro calls, a
genuinely different metric. That is fine. It is not labelled that way on screen, so it reads as
a booking count that disagrees with the Marketing page.

**Fix:** a label, not a code change.

---

## 10. Close rate is very nearly consistent (LOW)

Worth recording because it is the one that turned out fine. August 2026:

| Method | Figure |
|---|---|
| Overview and Closers pages, prospect-level | 6/33 = **18.2%** |
| Your locked rule, EOD closes over `live_nc_calls` | 6/34 = **17.6%** |
| Marketing page, matview closes over live calls | 6/34 = **17.6%** |

Overview and Closers agree with each other, and Marketing agrees with your rule. The 0.6pp gap
is prospect-level dedup: one prospect had two new-call rows in the month, so the prospect view
counts 33 where the EOD count is 34.

If you check the dashboard against a hand calculation you will get 17.6% and the Overview will
say 18.2%. Small, but it is the kind of thing that makes the whole page feel untrustworthy.

**Fix:** either move the Overview onto `live_nc_calls`, or leave it and note the basis on the
tile. Your call.

---

## 11. The public anon key can read team and marketing data (MEDIUM, security)

Found while building the UI test harness: with only the **public anon key** (the one shipped
in the browser bundle, no user login), the following return rows:

- `team_members` (names, emails, GHL and WAVV user IDs)
- `lib_marketing_by_audience_daily_mv` (spend, bookings, closes by day)
- the closer and setter leaderboard sources behind the Overview

The dashboard front end always sends a logged-in user's JWT, so nothing is exposed through
the app itself. But anyone who reads the key out of the JS bundle can query these tables
directly with `curl`. That is the same class of hole closed on the SEO dashboard in
migration 166.

**Fix:** RLS policies on those tables (and the matview's underlying tables) that require
`auth.role() = 'authenticated'`. Worth a pass over every table the front end reads.

---

## Things that are healthy

Checked and found clean, so they can be ruled out:

- **pg_cron is fully green.** All 11 jobs succeeded over the last 48 hours, no failures.
- **The matviews are being refreshed properly.** `refresh_marketing_trend_mv()` rebuilds all
  three (`lib_booking_resolved_mv`, `lib_close_resolved_mv`,
  `lib_marketing_by_audience_daily_mv`) in dependency order every 10 minutes, with a 60 second
  throttle. 288 successful runs in 48 hours.
- **`ghl_appointments` is not stale.** `CLAUDE.md` says it is. It is being written continuously,
  most recently 2026-09-05 14:46 UTC, at 2 to 19 rows a day. That gotcha note is out of date.
- **`wavvService.js` paginates correctly** and is the pattern the other four call sites should
  copy.
- **Booking exclusions are being honoured** on the tile path: `booking_excluded`, `is_spam` and
  the "and OPT Digital" test-name filter all fold in as documented.

---

## Recommended order of work

1. Finding 1, the `$50k` constant. One line, immediately corrects qualified counts and
   cost-per-qualified.
2. Finding 2, populate `revenue_tier` in the matview. Collapses the tile and drilldown onto one
   number.
3. Finding 3, one date-window helper everywhere.
4. Finding 6, paginate the four uncapped queries before a table crosses 1,000.
5. Finding 4, EOD header totals. Needs your decision first, it restates history.
6. Findings 5, 7, 8, 9, 10 as follow-ups.

Findings 1, 2, 3 and 6 are mechanical and low risk. Finding 4 is the only one that changes
numbers you have already reported on.
