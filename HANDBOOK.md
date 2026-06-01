# RankOnMaps Sales Dashboard Handbook

How to use the granular call tracking system. Built for closers, setters, managers.

---

## What we track and why

Every sales call generates two kinds of data:
1. **The outcome**: closed, follow-up, no-close, no-show
2. **The why**: confirmation method, decision-maker, offer mix, objection, follow-up reason, etc.

The "why" is what lets us dissect problems. If show rate drops, we need to know whether it's setter quality (text-only confirms) or buyer trust (no-shows after real conversations). If close rate drops, we need to know if it's price objections, trust issues, or wrong-fit prospects.

All of this also flows back into GoHighLevel so you can build workflows on the data.

---

## After every call: what to fill in

You'll see these fields appear on the EOD page or Quick Backfill, depending on the outcome.

### Always
| Field | What it means | Example |
|---|---|---|
| **Outcome** | Closed / Follow-up Booked / Not Closed / No Show / Rescheduled / Cancelled | "Follow-up Booked" |
| **Confirm method** | How was this prospect confirmed for the call? | Call / Auto-text / Unconfirmed / None |
| **Pre-call video watch %** | If you sent a Loom/video, what % did they watch? | 75 |

**Confirm method values:**
- **Call**: Setter had a real phone conversation. Active confirmation.
- **Auto-text**: Prospect replied to an automated text only. Passive.
- **Unconfirmed**: Setter tried to reach them, never connected.
- **None**: No confirmation attempt was made.

### If the call happened (Closed / Follow-up / Not Closed)
| Field | What | Example |
|---|---|---|
| **Decision-maker present** | Was the actual buyer on the call? | Yes / No |
| **Offers pitched** | Multi-select: what did you actually offer? | Full-stack / Maps-only / Trial / Ascension. Pick multiple if you pitched several. |
| **Downsell occurred** | Auto-checked when you pick both Full-stack + Maps-only. Confirm if accurate. | ✓ |

### If Follow-up Booked
| Field | What | Example |
|---|---|---|
| **Follow-up reason** | Why are we rebooking? | Logistics / Think about it / Partner / Proof |
| **Timeframe (days)** | How many days until next call? | 3 |
| **Why so far out?** | **Required** when > 4 days. | "Prospect traveling next week" |

### If Not Closed
| Field | What | Example |
|---|---|---|
| **Objection** | Main reason they didn't close | Price / Trust / Timing / Fit / DM-missing |
| **Next state** | Where do they go now? | Follow-up / Long-term nurture / Dead |

### Auto-computed
| Field | What |
|---|---|
| **Reason alignment** | Compares the first call's follow-up reason vs the second call's objection. Misaligned = the original objection was probably a smokescreen. Coaching signal. |

---

## What flows back to GoHighLevel

For every saved call, three things happen in GHL automatically:

**1. The appointment status updates**
- Closed / Follow-up / Not Closed → `showed`
- No Show → `noshow`
- Rescheduled / Cancelled → `cancelled`

**2. Tags get added to the contact** (only tags that trigger workflows)
- `outcome:closed` / `outcome:follow-up` / `outcome:no-close` / `outcome:no-show`
- `next-state:follow-up` / `next-state:nurture` / `next-state:dead`
- `decision-maker:no` (when DM was missing: triggers rebook workflow)
- `noshow:after-call-confirm` (no-show after a real call confirm: setter coaching signal)

**3. 23 custom fields on the contact get populated** with the full snapshot:
- `ROM Last Outcome`, `ROM Last Call Date`, `ROM Last Objection`, `ROM Last Objection Date`
- `ROM Objection History` (appends each new objection with date: so you see the full progression)
- `ROM Offers Pitched (Last Call)`, `ROM Offers Pitched History` (same: appending log)
- `ROM Last Follow-up Reason`, `ROM Last Follow-up Booked Date`, `ROM Last Follow-up Timeframe Days`
- `ROM Next State`, `ROM Last Confirm Method`, `ROM Decision-Maker Present (Last)`
- `ROM Pre-call Video Watch %`, `ROM Reason Alignment (Last)`
- `ROM Last Closer Assigned`, `ROM Last Setter Assigned`
- `ROM Last Fathom Recording URL`
- Cumulative: `ROM Total Calls`, `ROM Total Revenue Attributed`, `ROM Total Cash Collected`

You can build GHL workflows that segment off any of this. Examples:
- "Email me when a contact has `next-state:dead` and `ROM Total Revenue Attributed > 5000`" → high-value lost leads worth a final outreach
- "Drop into nurture sequence when `outcome:follow-up` AND `reason-alignment:misaligned`" → suspected smokescreen leads need a different cadence

---

## How to use AI pre-fill

Once a Fathom transcript syncs for a call, the AI (Claude) reads it and pre-fills the granular fields for you. You'll see:

- A purple dot next to each field that AI suggested
- Hovering shows the transcript quote that justifies the suggestion
- **Always review**: AI is a helper, not the source of truth. If something's wrong, change it. Your override gets tagged (`ai-prefill:closer-overrode`) so we can tune AI accuracy.
- If you accept all suggestions, it tags `ai-prefill:closer-confirmed`.

If the AI didn't run (no Fathom transcript yet), the fields stay blank and you fill them manually.

---

## Setter-specific (for Jonathan, Mersad, Fiyin, etc.)

You don't fill in the closer call form, but your work shapes these fields:

- **Confirm method** comes from your setter activity. If you have a real phone conversation, the closer marks `call`. If the prospect only replies to the auto-text, it's `auto-text`. If you never reach them, it's `unconfirmed`.
- **`noshow:after-call-confirm` tag** is a coaching signal: it means you had a real conversation but the prospect didn't show. Pattern of these = something in your conversation isn't securing the show.
- **Pre-call video send + tracking**: if a Loom/video is sent, you're responsible for nudging the prospect and tracking the watch %. The closer records the final %.

---

## Quick Backfill workflow

For catching up on past days:

1. Go to **/sales/eod/backfill**
2. Pick yourself (closer)
3. Pick days back (7 / 14 / 21 / 30)
4. Click **Pull from GHL** if you don't see your appointments
5. For each appointment:
   - Click the outcome button
   - Fill the granular fields that appear
   - For Closed: enter Revenue + Cash
6. Click **Save all**: writes all rows + pushes to GHL in one shot

Saves are idempotent: you can re-save the same day without creating duplicates.

---

## What's the threshold for "watched the video"?

Currently set in `rom_call_thresholds` table:
- `loom_watched_min_pct: 75`: 75%+ counts as "watched"
- `loom_partial_min_pct: 25`: 25–74% counts as "partial"
- Below 25% counts as "not watched"

Daniel can adjust these without redeploying: they're config values.

---

## Common questions

**Q: What if I don't know the answer to a field?**
A: Leave it blank. The system won't push null fields to GHL. Better to skip than guess wrong: wrong data is worse than no data.

**Q: What's the difference between `unconfirmed` and `none`?**
A: `unconfirmed` = setter tried to reach the prospect but couldn't. `none` = no attempt was made to confirm.

**Q: A call had multiple objections: which do I pick?**
A: Pick the **main** one. The one that actually killed the deal. If you can't pick one, the prospect probably wasn't qualified: pick `fit`.

**Q: I marked Closed but the deal fell through later. How do I update?**
A: Edit the original closer_call row in Quick Backfill: set outcome back to Not Closed + add the new objection. The GHL custom fields will update too.

**Q: Why are some calls showing "reason-alignment: misaligned"?**
A: It means the prospect said one thing on the first call (e.g. "let me think about it") and a different thing on the second call (e.g. "price is too high"). Likely the first-call objection was a smokescreen. Use this as a closer coaching signal: listen back to both Fathom recordings.

---

## Offer stack: what each one actually includes

This is what closers should be able to explain in detail when a prospect asks "what do I get for that money?". Pull from this section on every call.

### Get Found Engine: Top 3 Maps + Authority Website (Full Stack)

The flagship full-stack engagement. Two pieces: Google Business Profile authority work, plus website work that supports the authority signal.

**Pricing:**
- US: $18,000 USD baseline (PIF $25K for 12M, financing variants up to $30K)
- AU: A$12K (12 Week) / A$20K (6 Month) / A$30K (12 Month)
- US payment terms: 50% upfront, 50% at month 3 (standard for Full Stack)
- AU: PIF, 2-pay, or 3-pay (closer negotiates cadence on the call)

**Available terms:** 12 Week, 6 Month, 12 Month. Each available as PIF, split-pay, or financing (US only via Fanbasis Clarity Pay / Credit Key).

#### Google Business Profile (GBP) deliverables

| Workstream | What we do | Frequency |
|---|---|---|
| GBP optimization | Full audit, category fix, services, products, attributes, hours, Q&A | Initial + ongoing |
| GBP posts | [TBC: confirm count/month] | [TBC: cadence] |
| GBP photos | [TBC: quantity, sourcing, geotagging strategy] | Monthly |
| Citation building | Tier-1 directory submissions. 30+ directory standard. NAP consistency enforced. | Monthly |
| Citation cleanup | Duplicate removal, NAP audit, conflicting listings reconciliation | Initial + audit |
| Review automation | Cloutly setup, review request flows, response monitoring | Setup + ongoing |
| Geo content (suburb pages) | [TBC: confirm count/month] suburb pages targeting Top 10 service keywords | Monthly |
| Schema markup | LocalBusiness + niche-specific (Physician/MedicalProcedure for medical, etc.) | Initial |
| Backlinks | Brand authority campaigns: Reddit, niche directories, local media, healthcare directories. [TBC: confirm volume/tier] | Monthly |
| Reporting | Live dashboard at results.rankonmaps.io | Live |
| Bi-weekly strategy call | Mersad + Jonathan tandem, ~30 min | Every 2 weeks |
| Monthly review | Full audit + delta report. Full Stack only. | Monthly |
| Quarterly business review | Full pull-up. Full Stack only. | Quarterly |

#### Website deliverables (Full Stack only)

| Workstream | What we do | Notes |
|---|---|---|
| Website audit | Technical, content, conversion audit | Initial |
| Website revamp OR new build | Built on conversion-optimized framework. Mobile-first, sub-2s load. | Decided after audit |
| Service landing pages | One per service silo | Initial |
| On-page SEO | Title tags, meta, H1s, internal linking, image alt | Initial + ongoing |
| Conversion optimization | Hero, CTAs, forms, click-to-call, sticky bar | Initial + iteration |
| Speed optimization | Core Web Vitals targets met | Ongoing |
| Form / call tracking | WhatConverts setup: DNI, call recording, GA4 offline conversion uploads | Initial |
| Schema markup | Organization, Service, FAQ, Review, niche-specific | Initial |
| Booking integration | Online booking embedded | Initial (if applicable) |
| Inquiry forms | HIPAA-compliant where required (medical) | Initial |
| Blog / content | [TBC: confirm count/month + topic mix] | Monthly |

#### Outcome promise

**90-day promise has been RETRACTED as of 2026-05-20.** Do not reference the old "free until day 91" guarantee in client docs.

Current language: 90-day window with eligibility requirements. Eligibility includes:
- Doing Business As (DBA) registered
- 10+ photos uploaded per month
- 2+ reviews collected per week
- 5-day response time on all client-side asks

If client meets eligibility + positive movement is shown but the target ranking isn't hit: **+30 days of additional service at no charge.**

No unconditional "Top 3 or money back" guarantees. Closers should NOT promise unconditional outcomes.

#### What the client provides

- GBP manager access (we request via hello@rankonmaps.io email)
- GA4 viewer + admin access
- Google Search Console access
- Website CMS access (if Full Stack)
- Domain + hosting credentials (if doing build)
- Brand assets: logo, photos, brand guide
- Customer list for review requests (no SMS without consent)
- Any existing analytics, prior SEO work, current Google Ads

#### Cadence

| Touchpoint | Who attends | Frequency | Duration |
|---|---|---|---|
| Kickoff call | Jonathan + Mersad + client | Day 2-3 post close | ~60 min |
| Status updates in shared Slack | Jonathan posts | Weekly | Async |
| Bi-weekly strategy call | Mersad + Jonathan + client | Every 2 weeks | ~30 min |
| Monthly review | Jonathan + client | Monthly | ~30 min |
| Quarterly business review | Mersad + Jonathan + Daniel + client | Quarterly | ~60 min |

---

### Maps Only

Lower-ticket entry. GBP authority work without website rebuild. Used when the prospect's website is fine but their map pack ranking isn't.

**Pricing:**
- US: $2,500 USD (per project_rankonmaps_offers)
- AU: A$3,500 AUD ("AU Maps Only PIF" in payment_link_catalog)
- Paid in full upfront

**Term:** 3 months (sometimes called the Trial tier internally)

| Included | Notes |
|---|---|
| GBP optimization | Categories, services, attributes, hours, products, photos audit |
| GBP posts | [TBC: confirm count/month with Daniel] |
| Citation building | Local directory submissions, NAP consistency (30+ directories standard per Valencia proposal) |
| Citation cleanup | Duplicate removal, NAP audit across existing directories |
| Local links | Local backlink acquisition (the AU offer specifically emphasizes this) |
| Review automation | Cloutly setup + flows |
| Schema markup | LocalBusiness, niche-specific (e.g. Physician for medical) |
| Reporting | Live dashboard access at results.rankonmaps.io, monthly progress report |
| Onboarding | Complete within 14 days of close |

**NOT included in Maps Only:**

- Website build or revamp
- On-page SEO, conversion optimization
- Bi-weekly strategy calls (Maps Only gets email + monthly only)
- Full geo content / suburb page production
- Quarterly business reviews
- Google Ads management

---

### Ascension

The upsell from Maps Only into Full Stack mid-engagement.

[TBC: what's the trigger to pitch ascension, what's the price delta, what does the client unlock by ascending]

---

### Onboarding (first 14 days, all tiers)

| Day | What happens | Owner |
|---|---|---|
| Day 0 (close) | Welcome message in shared Slack within 60 min | Client AM (Jonathan) |
| Day 0 | Internal Slack channel created | Technical AM (Mersad) |
| Day 1 | Access request sent: GBP manager, GA4, GSC, website CMS | Mersad |
| Day 1-2 | Ranking Blueprint audit generated on results.rankonmaps.io | Automated |
| Day 2-3 | Kickoff call (~60 min): goals, deliverables, cadence, expectations | Jonathan + Mersad |
| Day 3-14 | First wave of deliverables begins (GBP audit, citation push, website audit) | Mersad's team |

---

## Where to ask questions

If something isn't tracking right, check `contact_attempts` and `closer_calls` in Supabase first. If the data's there but the dashboard isn't showing it, ping Daniel. If the data's not there, check the GHL workflow / Wavv Zap / Linq webhook is still active.
