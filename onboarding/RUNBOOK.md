# Ranking Blueprint · Onboarding Runbook

The complete operational SOP from "client signs trial" to "14-day diagnostic delivered". Built so any AM can run it without Daniel in the loop.

**Version:** 1.0  ·  **Owner:** Jonathan + Mersad tandem  ·  **Last updated:** 2026-05-30

---

## The pipeline at a glance

```
01 · TRIGGER             GHL "trial-signed" tag fires
02 · KICKOFF EMAIL       Jonathan      · 24h SLA
03 · ACCESS COLLECTION   Mersad        · 48h SLA
04 · DATA PULL           Mersad        · 24h after access
05 · DISCOVERY CALL      Jonathan      · within 5 days of signup
06 · TRANSCRIPT INGESTION Jonathan     · within 24h of call
07 · DIAGNOSTIC BUILD    Mersad        · within 48h of transcript
08 · STRATEGY DRAFT      Strategist    · within 5 days of diagnostic
09 · INTERNAL REVIEW     Jonathan + Mersad · 24h
10 · CLIENT PUBLISH      Jonathan      · day 14 hard deadline
```

Each step below: **owner · input · action · output · artifact location · escalation trigger.**

---

## 01 · Trigger

**Owner:** GHL automation (no human)
**Input:** New deal closed in pipeline. "Trial-signed" tag applied to contact.
**Action:** GHL workflow fires three things in parallel:
  1. Slack message to `#ops-onboarding` channel: `New trial: [Client Name] · [Domain] · assigned to Jonathan`
  2. New record created in hq.rankonmaps.io under client `[Slug]` with onboarding state = `01_kickoff_pending`
  3. Internal client folder created in Google Drive: `Clients / [Slug] /`
**Output:** Client record exists in portal. Slack notification visible.
**Escalation:** If 4 hours pass with no Slack confirmation, ping `#ops-alerts`.

---

## 02 · Kickoff email

**Owner:** Jonathan
**Input:** Slack notification + client record from step 01.
**Action:**
  1. Open client record in hq.rankonmaps.io → Onboarding tab
  2. Click **Send Kickoff** which fires the templated email containing:
     - Welcome + 14-day expectation framing (no times, work-content only, see [[feedback-no-roadmap-times]])
     - Access request links (GSC delegation, GA4 user grant, GBP manager invite, WP login, GHL access)
     - Calendly link to book the 60-min discovery call with Jonathan
     - Slack channel invite (shared channel naming convention: `rom-[client-slug]`)
  3. Mark step 02 complete in portal
**Output:** Email sent. Client has all next-step CTAs in one place.
**SLA:** 24 hours from trial signing.
**Escalation:** If the access links don't return within 48h, Jonathan personally calls.

---

## 03 · Access collection

**Owner:** Mersad
**Input:** Notification from step 02 + access grants arriving from client.
**Action:**
  1. Verify each credential as it lands. Confirm in portal:
     - GSC: hello@rankonmaps.com added as Owner or Full user
     - GA4: hello@rankonmaps.com added as Editor
     - GBP: rankonmaps Manager invite accepted
     - WordPress: admin account created with role Administrator
     - GHL: sub-account access granted to Mersad
     - WhatConverts: optional v2, skip in v1
     - Cloutly: optional v2, skip in v1
  2. For each missing or broken access, comment in shared Slack with the exact "click here, then this, then this" instruction. Never assume the client knows the path.
  3. Mark step 03 complete only when GSC + GA4 + GBP are all live. WordPress is preferred not required for the diagnostic.
**Output:** All access live.
**SLA:** 48 hours from kickoff email.
**Escalation:** If GSC is not granted within 48h, Jonathan calls the client. GSC is the hard requirement.

---

## 04 · Data pull

**Owner:** Mersad
**Input:** Access live from step 03.
**Action:**
  1. From terminal: `/seo audit [domain] --post-signup --city [city] --service [primary service]`
     - This fires the orchestrator that runs all 5 specialist subagents in parallel (keywords, technical, competitors, content, backlinks) plus AI search citation probe across ChatGPT, Perplexity, Gemini, Claude, AI Overview.
  2. Manual GSC exports (until GSC API integration ships):
     - Performance → Search results → 16 months → export Queries tab
     - Performance → Search results → 16 months → export Pages tab
     - Indexing → Pages → export "Why pages aren't indexed"
     - Performance → filter by primary service term → export
  3. Manual GA4 exports:
     - Reports → Engagement → Pages and screens → last 12 months
     - Reports → Acquisition → Traffic acquisition → last 12 months
     - Reports → Engagement → Conversions → last 12 months
  4. Upload all CSVs + the audit JSON to `Clients / [Slug] / 01-data-pull /`
  5. Upload to portal: file picker on client record auto-parses and populates the diagnostic template
  6. Mark step 04 complete
**Output:** Diagnostic template populated with real data. Visible as `[Slug] / Diagnostic` in portal, status = `draft`.
**SLA:** 24 hours from access live.
**Escalation:** If DataForSEO credit balance is below $20, alert in `#ops-alerts` before running.

---

## 05 · Discovery call

**Owner:** Jonathan
**Input:** Client booked discovery call via Calendly. Diagnostic data pre-pulled from step 04.
**Action:**
  1. **Before the call:** open the diagnostic in portal. Spot the 2-3 most striking findings to surface to the client. This builds credibility in the first 5 minutes.
  2. **Open the questionnaire companion** in portal (the live checklist version of the 80 questions).
  3. **Start Fathom recording.** Confirm consent on tape.
  4. Run the 80-question script verbally. **Do not type during the call.** Tick questions off as covered. Sections annotated `[covered on sales call]` should be skipped unless something changed.
  5. Where the client gives a generic answer, push once: "Tell me more about that specific patient" or "Give me the exact phrase they used".
  6. Close the call by summarising the 3-5 biggest things heard back to them so framing locks before the strategist starts writing.
  7. Mark step 05 complete in portal.
**Output:** Fathom recording with full transcript. Questionnaire checklist showing which questions got real answers.
**SLA:** Within 5 days of trial signup.
**Escalation:** If a section couldn't be covered (client ran out of time), schedule a 15-min follow-up within 48h.

---

## 06 · Transcript ingestion

**Owner:** Jonathan
**Input:** Fathom transcript from step 05.
**Action:**
  1. In Fathom, copy the full transcript (cmd-A, cmd-C from the transcript pane).
  2. In portal, open client → Discovery → paste into the transcript box.
  3. Click **Extract Answers**. The AI runs through the 80 questions and surfaces:
     - Suggested answer extracted from the transcript
     - Citation: which timestamp / speaker
     - Confidence score
  4. Quickly scan the low-confidence answers. Either:
     - Edit the suggested answer with the right phrasing
     - Mark "not answered" if the client genuinely didn't cover it
     - Push back to step 05 if a critical section is missing
  5. Mark step 06 complete.
**Output:** Structured Q&A in portal, every answer cited to transcript.
**SLA:** Within 24 hours of the discovery call.
**Escalation:** If the AI extraction confidence is below 60% across the board, the transcript probably didn't capture cleanly. Re-run Fathom or escalate to Mersad.

---

## 07 · Diagnostic build

**Owner:** Mersad
**Input:** Structured Q&A from step 06 + populated diagnostic from step 04.
**Action:**
  1. Open client → Diagnostic in portal.
  2. The template auto-renders with data from step 04 plus context from step 06.
  3. Mersad reviews each section. Flagged areas that need narrative interpretation get a 1-paragraph human write-up (the "1hr polish" budgeted).
  4. Specific things to add manually:
     - The headline finding (the single biggest "this is what's happening under the hood")
     - The 4 findings cards (what we already spotted)
     - Any client-specific context the data alone can't supply
  5. Mark diagnostic state = `ready-for-strategy` in portal. This auto-pings the content strategist in Slack.
**Output:** Diagnostic snapshot, ready to feed into strategy.
**SLA:** Within 48 hours of transcript ingestion.
**Escalation:** If a critical data point is missing (e.g. GBP Insights API rate-limited), document the gap in portal and proceed without it.

---

## 08 · Strategy draft

**Owner:** Content strategist (external until in-house hire)
**Input:** Sales transcript (Fathom) + discovery transcript (Fathom) + structured Q&A + diagnostic snapshot + raw GSC/GA exports. All five accessible via the client portal.
**Action:**
  1. Strategist receives Slack ping with portal link.
  2. Reviews all five inputs in this order: diagnostic (the data picture) → discovery Q&A (the client's words) → sales transcript (the closing hooks) → raw GSC (the proof) → discovery transcript (full context).
  3. Builds the 14-day diagnostic narrative + 6-month content roadmap in the portal's strategy editor.
  4. Roadmap structure (matches [[feedback-no-roadmap-times]] rule, work-content not weeks):
     - Phase 0 · Critical fixes (must ship before any rewrite begins)
     - Phase 1 · Rewrites (the existing pages that get repositioned)
     - Phase 2 · New builds (the pages that don't exist yet, mapped to discovery answers)
     - Phase 3 · Compounding (links, schema, reviews, citations)
  5. Each page in the roadmap traces back to: a specific query the client could win + a specific patient-need the discovery surfaced.
  6. Mark step 08 complete in portal. Auto-pings Jonathan + Mersad for review.
**Output:** 14-day diagnostic + 6-month roadmap drafted in portal.
**SLA:** Within 5 days of receiving the diagnostic.
**Escalation:** If the strategist can't reconcile something between sales transcript and discovery, ping Jonathan for context.

---

## 09 · Internal review

**Owner:** Jonathan + Mersad
**Input:** Strategy draft from step 08.
**Action:**
  1. Jonathan reviews from the client lens: does it answer what they actually asked for? Does it sound like Stacey (or whoever)? Does it avoid the things they said they don't want? (Stacey: no "physical therapy" framing.)
  2. Mersad reviews from the technical lens: are the page targets winnable? Are the keyword volumes real? Does the schema plan match the page-type inventory?
  3. Comments left inline in portal. Strategist revises. Maximum 2 revision rounds.
  4. Both AMs click **Approve** to advance.
**Output:** Strategy locked for client publish.
**SLA:** 24 hours from strategy draft.
**Escalation:** If Jonathan and Mersad disagree on a fundamental call, ping Daniel. Otherwise Daniel stays out.

---

## 10 · Client publish

**Owner:** Jonathan
**Input:** Approved strategy from step 09.
**Action:**
  1. Click **Publish to client** in portal. This:
     - Moves the diagnostic + roadmap from `internal` to `client-visible`
     - Generates the shareable URL: `results.rankonmaps.io/[client-slug]`
     - Fires templated Slack message to the shared client channel announcing it
  2. Send a personal Slack note in the shared channel highlighting the 1-2 things you want the client to focus on first.
  3. Schedule the presentation call (30 min) within 48h. Jonathan leads, Mersad on standby for technical questions.
  4. Mark step 10 complete. Onboarding state in portal changes to `engagement-active`.
**Output:** Client has access to their 14-day diagnostic + 6-month roadmap. Presentation call booked.
**SLA:** Day 14 hard deadline from trial signup.
**Escalation:** If we slip past day 14, Daniel approves a personal apology + extension framing to the client.

---

## After day 14

The onboarding pipeline ends here. The engagement-active state hands off to the standard delivery cycle (separate runbook). For continuity:

- The diagnostic + roadmap stays the source of truth for the strategy work
- The structured Q&A stays the source of truth for content voice + positioning
- Both auto-sync into the recurring monthly client report (see [[feedback-controlled-narrative]] for which deltas the client sees)

---

## File and link locations (canonical)

| Artifact | Location |
|----------|----------|
| Sales call recording | Fathom (auto-linked in portal) |
| Discovery call recording | Fathom (auto-linked in portal) |
| GSC + GA exports | `Clients / [Slug] / 01-data-pull /` in ROM Drive |
| Audit JSON | Supabase `audit_data` table, keyed by client_id |
| Q&A structured answers | Supabase `qa_answers` table |
| Diagnostic snapshot | Portal route `/clients/[slug]/diagnostic` |
| Strategy draft | Portal route `/clients/[slug]/strategy` |
| Client-facing publish | `results.rankonmaps.io/[slug]` |
| Internal Slack | `#rom-[client-slug]-internal` |
| Shared Slack | `#rom-[client-slug]` |

---

## Quality bar

Anyone running this runbook should be able to point at the final published diagnostic + roadmap and say:

- Every finding traces back to live GSC/GA data, never to inference
- Every roadmap item traces back to either a query the client could win or a patient-need the discovery surfaced
- The voice matches what the client said on the discovery call, not generic SEO-speak
- The 5 inputs (sales + discovery + Q&A + diagnostic + raw data) are visible and queryable for the strategist months later
- The team can hand off mid-step to a colleague without losing context

If any of these break, the runbook needs an amendment.

---

## Stress-test plan

Before this becomes the locked process, run it manually on the next 2-3 clients. Each one:

1. Run the runbook end-to-end
2. Log every place the SOP missed something or assumed knowledge
3. Update the runbook version (1.1, 1.2, etc) before the next client

Once the runbook is stable (no edits between two consecutive clients), the portal feature build kicks in to encode it.
