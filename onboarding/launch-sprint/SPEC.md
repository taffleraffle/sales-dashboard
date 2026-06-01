# Launch Sprint · Spec

The first 14 days as the client experiences them. Same materials for trial and full-commit signups, with framing tuned to the entry path.

**Version:** 1.0
**Owner:** Jonathan + Mersad tandem
**Pairs with:** [RUNBOOK](../RUNBOOK.md), [discovery-call SOP](../sops/sop-jonathan-discovery-call.md)

---

## What it is

The Launch Sprint is the 14-day window from "client signs trial" or "client signs full retainer" to "Ranking Blueprint delivered". It is named, scoped, and timed so the client knows exactly what's happening, when, and what they get out of it.

**Tagline:** Your Launch Sprint produces your Ranking Blueprint.

**Why named:** signals intensity, has a finite shape (14 days), implies forward motion. Pairs cleanly with "Ranking Blueprint" as the deliverable artifact.

---

## What the client experiences (touchpoint map)

| When | What client sees | Channel | Owner |
|------|------------------|---------|-------|
| Day 0 | Welcome email + portal opens at `results.rankonmaps.io/[slug]` + access request checklist | Email + portal | Jonathan |
| Day 0-3 | Reminder cadence if credentials aren't connected. Portal shows live status. | Email + portal | Jonathan (auto-trigger) |
| Day 4-5 | Pre-call brief sent 24h before discovery call. Tells client exactly what to prep. | Email | Jonathan |
| Day 4-5 | Discovery call (60 min, recorded) | Zoom + Fathom | Jonathan |
| Day 7 | Mid-sprint "what we found this week" Slack note. 2-3 striking findings, no full reveal. | Shared Slack | Mersad |
| Day 14 | Ranking Blueprint published to portal + delivery email + presentation call booking | Portal + email | Jonathan |
| Day 14-16 | 30-min presentation call walking through the diagnostic + roadmap | Zoom | Jonathan |

---

## The 7 assets (Stream C deliverables)

### C1 · Welcome email · trial variant
**Trigger:** GHL "trial-signed" tag fires.
**From:** jonathan@rankonmaps.io
**Subject:** Welcome to your Launch Sprint, [first name]
**Framing angle:** "Prove value in 14 days. No commitment beyond what we both already agreed."
**Contents:**
- Welcome + named warm-up
- What Launch Sprint is (1 paragraph, plain English)
- The 3 things we need from you to start (GSC, GA4, GBP access)
- Link to portal landing at `results.rankonmaps.io/[slug]`
- Booking link for the discovery call (Calendly)
- Slack channel invite link
- Signed off by Jonathan with photo, full name, role

### C2 · Welcome email · full-commit variant
**Trigger:** GHL "full-retainer-signed" tag fires.
**From:** jonathan@rankonmaps.io
**Subject:** Welcome to Rank On Maps, [first name]. Here's your Launch Sprint.
**Framing angle:** "This is the foundation for our 6 months together. Day 14 is when execution begins."
**Contents:**
- Same structure as C1
- Reference to the signed agreement and what month one looks like beyond day 14
- Sets expectation that the Ranking Blueprint becomes the canonical strategy doc for the engagement
- Same CTAs: portal link, Calendly, Slack invite

### C3 · Day 0 portal landing
**URL:** `results.rankonmaps.io/[slug]`
**Build:** React route inside hq.rankonmaps.io results domain. Read-only for client, editable by AMs.
**Contents:**
- Client name + their domain at top (branded, Ranking Blueprint header)
- 10-step pipeline tracker showing current state visually (which steps are done, in-progress, pending)
- Access checklist (live state of GSC, GA4, GBP, WP connection)
- Embedded Calendly for discovery call booking
- Slack channel link
- "What happens in your Launch Sprint" 5-line summary
- Day 14 countdown
- Brand-consistent (sage Forest, Inter Tight, JetBrains Mono receipts, paper background)

### C4 · Access request checklist
**Lives:** embedded in C3 portal landing.
**Per-credential block:** what we need (GSC, GA4, GBP, WP, GHL), why we need it (one sentence), exact click-by-click instructions, current status (pending / received / verified), the email to grant access to (hello@rankonmaps.com).
**Live state:** updates as Mersad verifies each access in step 03 of runbook.

### C5 · Pre-call brief
**Trigger:** 24h before the booked discovery call.
**From:** jonathan@rankonmaps.io
**Subject:** Tomorrow's discovery call · what to expect
**Contents:**
- One-line framing of the call's purpose
- Length (60 min) and format (recorded)
- The 11 sections we'll cover (high level only, not the 80 questions)
- What we recommend they have in front of them (CRM access if pulling patient data, a list of their top 3 competitors by name, optional but useful)
- Reassurance that they don't need to prep anything formal
- The Zoom link

### C6 · Day 7 mid-sprint Slack note
**Trigger:** Mersad fires manually on day 7 (templated).
**Channel:** Shared client Slack `rom-[client-slug]`
**Template:**
- "Hey [first name], quick mid-sprint check-in from our end."
- "Here are 2-3 things we've already spotted in [client] under the hood while we build out your Ranking Blueprint:"
- 2-3 bullet findings (genuinely interesting, not just data dumps)
- "Full diagnostic still landing day 14 as planned. Any questions in the meantime drop them here."
- Signed Mersad
**Rule:** never reveal the full diagnostic. The 2-3 bullets are appetisers chosen to build confidence without spoiling the day-14 reveal.

### C7 · Day 14 delivery email + presentation deck
**Trigger:** Jonathan clicks "Publish to client" in portal (runbook step 10).
**Email subject:** Your Ranking Blueprint is live, [first name]
**Email contents:**
- Brief framing: this is what we found, this is what we recommend, here's the link
- Direct link to `results.rankonmaps.io/[slug]/blueprint`
- Calendly link for the 30-min presentation call
- One-sentence emotional close (matches the closing summary from the discovery call)
**Presentation deck:** auto-generated from the published Ranking Blueprint, used by Jonathan during the 30-min walkthrough call. Same branding as the portal page, distilled into a screen-share format.

---

## Brand standards across all 7 assets

- **Voice:** direct, warm, declarative. No em-dashes. No semicolons. No AI flourishes. Lowercase mirror where the client is casual.
- **Type:** Inter Tight 900 for headlines, JetBrains Mono for receipts and labels, NO Fraunces (Direction D rule).
- **Color:** Sage Forest #1F4D3C as the only anchor. Page #F1EFE9, Paper #FAF8F2, Tone #D9D4C5. 60/25/10/5 ratio.
- **Receipts:** every doc gets a FIG number + UPDATED timestamp in the top right corner.
- **No fabricated specifics.** If we don't have it, use [TBC] not invented placeholders ([feedback-no-fake-specifics-in-client-demos](../../../.claude/projects/-Users-danielgirmay/memory/feedback_no_fake_specifics_in_client_demos.md)).
- **No times in roadmaps.** Phases describe work content, never weeks ([feedback-no-roadmap-times](../../../.claude/projects/-Users-danielgirmay/memory/feedback_no_roadmap_times.md)).
- **Controlled narrative.** Negative deltas curated by AM before client sees them ([feedback-controlled-narrative](../../../.claude/projects/-Users-danielgirmay/memory/feedback_controlled_narrative.md)).

---

## Trial vs full-commit · what differs

Only the framing layer changes. Same materials, same touchpoints, same SLAs.

| Layer | Trial framing | Full-commit framing |
|-------|---------------|----------------------|
| Welcome email | "Prove value in 14 days" | "Foundation for our 6 months together" |
| Day 14 delivery email | "Here's what we'd do if we keep going" | "Here's the canonical strategy for the engagement" |
| Presentation call close | "Want to convert to full retainer?" | "Let's pick the first month's priorities" |
| Portal experience | Identical | Identical |
| Discovery call | Identical | Identical |
| Mid-sprint Slack note | Identical | Identical |

Most clients never notice the framing difference. The Launch Sprint itself feels the same whether you converted from trial or skipped straight to full.

---

## What the AM never says

- "Site sweep" — old name, replaced by Launch Sprint + Ranking Blueprint
- "Audit" in client-facing materials — use "Ranking Blueprint" or "diagnostic"
- "We'll get back to you" — be specific about when and what
- "SEO" as the main framing — use "AI search + Maps" as the primary frame, SEO is a subset
- Pricing on indexable surfaces — gated everywhere ([feedback-rom-pricing-gated](../../../.claude/projects/-Users-danielgirmay/memory/feedback_rom_pricing_gated.md))
- 90-day promise — retracted ([project-rom-90-day-promise](../../../.claude/projects/-Users-danielgirmay/memory/project_rom_90_day_promise.md))

---

## SLAs · hard deadlines

| Asset | Triggered by | Delivered by | Hard deadline |
|-------|--------------|--------------|----------------|
| C1/C2 welcome email | GHL signing tag | within 24h of signing | day 0 + 1 |
| C3 portal landing | C1/C2 send | within 24h of signing | day 0 + 1 |
| C5 pre-call brief | Calendly booking | 24h before call | T-24h |
| C6 mid-sprint Slack | Mersad manual | day 7 by 5pm client local | day 7 |
| C7 delivery email | Jonathan publish | day 14 by 5pm client local | day 14 |

Slipping any of these triggers an internal flag in `#ops-alerts`.

---

## When to amend this spec

Any time we learn something on a real Launch Sprint that contradicts what's written here. Stress-test on the next 2-3 clients before locking the portal feature build against this spec.

---

## File locations

| Asset | Path |
|-------|------|
| C1 welcome email (trial) | `emails/welcome-trial.md` |
| C2 welcome email (full) | `emails/welcome-full.md` |
| C3 portal landing | hq.rankonmaps.io React route (to build) |
| C4 access checklist | embedded in C3 |
| C5 pre-call brief | `emails/pre-call-brief.md` (to write) |
| C6 mid-sprint Slack | `emails/day-7-mid-sprint.md` (to write) |
| C7 delivery email | `emails/day-14-delivery.md` (to write) |
| C7 presentation deck | auto-generated from portal blueprint |
