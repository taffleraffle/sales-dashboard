# Closers and Setters pages: duplicated and conflicting metrics

**Date:** 6 September 2026
**Pages:** `/sales/closers` (CloserOverview.jsx) and `/sales/setters` (SetterOverview.jsx),
cross-checked against the Overview leaderboards.

Two kinds of problem, and they need different treatment:

- **Same number, shown twice or more.** Harmless to the reader but doubles the page and
  hides the numbers that matter. Cut.
- **Same label, different formula.** This is the dangerous one: the page looks consistent
  and is not. Fix the formula, then cut.

---

## 1. Setters: "Sets" is counted three different ways (CONFLICT, live today)

| Where | Formula | Josh, last 30d |
|---|---|---|
| Overview page, Setter Leaderboard | `setter_eod_reports.sets` (what the setter typed in their EOD) | **42** |
| Setters page, company "Sets" tile | `setter_leads` rows in the window (leads actually logged) | **44** |
| Setters page, per-setter card and Team Total | `max(EOD sets, logged leads)` per setter, summed | **44** |

That is the 42 in your screenshot versus the 44 on the Setters page. Same person, same window,
two numbers on two pages, and a third formula waiting to disagree the day a setter's EOD count
is higher than their logged leads (the `max()` at `SetterOverview.jsx:276` will then pull the
team total above the company tile on the same page).

**Recommendation:** one definition everywhere. Logged leads (`setter_leads`) is the
auditable one, because each row is a named lead you can click into. EOD `sets` is a typed
number. Use `setter_leads` on the Overview leaderboard and drop the `max()`.

## 2. Setters: "MC → Set" gauge is rendered twice (EXACT DUPLICATE)

`SetterOverview.jsx:341` and `:351` both draw a Gauge from `companyRates.mcToSet`. Same
value, same target, two tiles a row apart. Cut one.

## 3. Setters: pickup and show rates appear four times each

| Metric | Appearances on the Setters page |
|---|---|
| Pickup rate | "Pickups" tile subtitle, "Pickup Rate" gauge, per-setter "Pickup %" gauge, comparison-row "Pickup" pill |
| Show rate | "Shows" tile subtitle, "Show Rate" gauge, per-setter "Show Rate" gauge, comparison-row "Show" pill |
| Sets, Dials, Revenue | company tile, per-setter card, comparison row stat block, Team Total stat block |

The company-level ones are the same formula, so no conflict, just repetition.

## 4. Setters: "Individual Performance" and "Setter Comparison" are the same data twice (EXACT DUPLICATE)

Per setter, both sections show Sets, Dials, Revenue, Show, Pickup, Call → Set, MC → Set, from
the same `setterCards` object. The comparison rows add Auto-booking count; the cards add
Close · Booked. Everything else is a repeat. Keep one section.

## 5. Closers: "Individual Performance" and "Closer Comparison" are the same data twice (EXACT DUPLICATE)

Per closer, both show Closes, Revenue, Cash, Show, Close, Offer, from the same `closerStats`
object. The comparison rows additionally show confirmed / unconfirmed show rate. Keep one.

The good news on Closers: every per-closer number comes from a single object, and the
company gauges use the same prospect-level close count as the Closes tile, so there is no
formula conflict on that page. The only cross-page difference is the one already logged in
the data audit (18.2% prospect-level versus your 17.6% locked rule).

## 6. Same word, two meanings: "Close rate" (LABEL CONFLICT)

| Page | "Close rate" means |
|---|---|
| Closers | closed prospects / prospects with a live new call |
| Setters ("Close · Setter-booked") | closed setter leads / setter leads that showed |

Both are legitimate, they are just different questions. The Setters page already qualifies
its label, the pills in the comparison rows do not ("Close"). Worth making the qualifier
consistent so nobody reads the setter figure as the closer figure.

## 7. Latent: per-setter dials versus company dials

Company pickup rate divides WAVV dials for **every** user ID; the Team Total pill divides
only dials from setters who have a `wavv_user_id`. Today every WAVV user ID maps to a
setter (767 of 767 calls in 30 days), so the two agree. Add a dialer account without linking
it on the Team page and they split. The Team page's WAVV pill is now the guard for this.

---

## Proposed layout after the cut

**Setters page:** header, 8 company tiles, ONE row of conversion gauges (Pickup, Show,
Lead → Set, Call → Set, MC → Set, Close · Setter-booked), then ONE per-setter section as
the comparison rows (they are denser and carry the Auto count), with Close · Booked added to
the row so nothing from the cards is lost.

**Closers page:** header, 8 company tiles, the 7 gauges, then ONE per-closer section as the
comparison rows, with the Show / Close / Offer gauges folded into the row as pills (they
already are) and the confirmed/unconfirmed show pills kept.

That removes roughly a third of each page and leaves every number exactly once.

## What I have not changed

Nothing on either page. Items 2, 4 and 5 are pure removals and are safe. Item 1 changes a
number on the Overview (42 becomes 44 for Josh) and is the one to confirm before I touch it.
