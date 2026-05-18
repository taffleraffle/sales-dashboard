# OPT Creative Performance Analytics — Design Brief

**For:** designer engagement
**Last updated:** 2026-05-18
**Live URL:** https://sales-dashboard-ftct.onrender.com/sales/ads/creative/insights
**Status:** Functional v1 shipped; we want a designer to polish, raise the hierarchy, and solve specific UX gaps listed at the end.

---

## 1. Product vision in one paragraph

A single dashboard where the operator at a paid-ads agency can: (1) see every Meta ad creative they've run with thumbnails, (2) understand which creative variables are driving wins (hook type, mechanism reveal, pain angle, proof character, etc.), (3) generate new ad-script concepts biased toward what's winning, and (4) upload + auto-tag + assign new filmed creatives in bulk. The system sits on top of a paid-ads testing methodology distilled from 22 versions of script-craft iteration. Every ad is classified across 11 dimensions, performance is attributed per ad, winning combinations surface their own pattern, and new scripts are generated biased toward those winners.

This is a tool for an agency operator running ~$15-30k USD/month in Meta spend across restoration + plumbing + home-service verticals, trying to maintain a "winners library" that compounds learning across testing cycles.

---

## 2. Users + jobs-to-be-done

### Primary: Ben (operator / founder)
Reviews live creative performance ~3x/week. Tags newly-shipped ads ~weekly (5-15 new creatives/cycle). Generates new script batches ~every 14 days (10-30 concepts/batch). Reviews attribute pivots to decide where to bias next cycle's testing.

### Secondary: Austin (junior operator)
Films/uploads creatives. Pulls reports for clients. Manually classifies attributes on edge cases.

### Tertiary: VAs / contractors
Bulk upload + tag work. No script generation access.

### Jobs-to-be-done (in operator's words)
1. **"What's actually winning right now?"** → answer in ≤30 seconds
2. **"Why is creative X winning?"** → click → see attributes + performance
3. **"Are EXPLICIT mechanism scripts beating GATED?"** → pivot by attribute
4. **"Give me 15 fresh scripts biased toward what's winning"** → produce in ≤30 seconds
5. **"I just got 5 new creatives back from the editor — tag them all"** → upload + auto-classify in ≤3 minutes total
6. **"This LLM tagged the hook wrong — fix it"** → click row → drawer → edit dropdown → done
7. **"New offer launching for plumbing — set it up"** → create offer with config wizard

---

## 3. Information architecture

The dashboard has a "Creative testing" section with 5 sub-pages under `/sales/ads/creative/`:

```
clips         ⌁  existing — atomic clip files in production tracking
variants      ⌁  existing — spliced combinations being tested
ads           ⌁  existing — live Meta ads with variant linkage
insights      ⌁  NEW — what's winning by attribute (PRIMARY designer focus)
generate      ⌁  NEW — LLM-driven script generator (PRIMARY designer focus)
```

Out-of-section but referenced:
- `/sales/ads/ad/<id>` — single-ad detail page (existing) with transcript, Hyros attribution events, performance graph. Now also has an attribute editor.

The full app shell (top nav, side nav, auth, etc.) is existing and not in scope for this brief — only the two new pages + the modals/drawers that pop from them.

---

## 4. Key user flows (narrative walkthroughs)

### Flow 1: Review what's winning (Insights page)

Operator opens Insights. The headline number is **win rate %** (currently 0.3% — 1 winner of 359 tagged ads). Below it: 4 KPIs (avg CPB on winners, total booked, tag coverage).

The **"Variables pulling ahead"** strip shows, for each of the major attributes, the ONE value with highest win-rate lift vs the overall baseline:
- `hook_type: diagnostic` ↑ +0.8% (1/108 ads, $77 CPB)
- `mechanism_reveal: explicit` ↑ +0.3% (1/233 ads, $77 CPB)
- `pain_angle: capacity_mismatch` ↑ +0.6% (1/147 ads, $81 CPB)

The **"Top performing creatives"** table renders below. Sorted by booked calls. Each row: rank badge, thumbnail (56px), ad name + campaign, attribute pills, booked count, CPB. Top 3 ranks get gold pill badges. Winners get a yellow "Winner" tag in the rightmost column.

Below the table: **win-rate-by-attribute charts** — 6 small-multiples bar charts (Hook type / Mechanism / Message frame / Pain angle / Funnel stage / Format). Each has a dashed reference line at the overall baseline. Bars beating baseline = yellow, below = grey ink. Hover for tooltip with exact numbers.

Top-right of the page: 2 buttons — **Add or link creative** (primary, ink background) and **Tag more ads** (secondary, outlined).

### Flow 2: Fix a misclassification

Operator notices "Hook 5 Body D" ranked #5 but tagged as `outcome` frame when it's actually a `problem` script. They click the table row → right-side drawer slides in with:
- **Sticky header**: thumbnail + ad name + ad_id (mono) + "Open full page →" link + X close
- **Body**: 11-dropdown attribute editor with per-field confidence pills (green = high LLM confidence, red = low). Operator changes `message_frame` dropdown from `outcome` to `problem` → auto-saves on blur
- Closes drawer → Insights table refreshes with the corrected attribute pills

### Flow 3: Add new filmed creatives in bulk

Operator has 5 new MP4s from the editor. Clicks **Add or link creative** (top-right Insights button) → drawer opens with 3 tabs: **Existing draft** / **Paste transcript** / **Upload MP4**. Picks Upload MP4 → drops all 5 files at once → drawer switches to **bulk queue mode**.

For each file, a row appears with:
- Index, filename, file size in MB
- Whisper warning chip if >25MB ("may fail Whisper")
- Auto-suggested Meta ad (via filename ilike fuzzy match), with thumbnail + ad name + campaign — clickable to change
- Status pill: PENDING (grey) → UPLOADING → TRANSCRIBING → TAGGING → DONE (yellow) or ERROR (red)
- Remove button (X) while pending

Operator confirms each pairing is correct (or changes via inline picker), clicks **Run all (5)**.

Files process sequentially (concurrency 1 because Whisper rate-limits + Edge Function timeouts compound under parallel load). ~60-180s per file. Status pills animate per row. Failed files surface the error inline.

Operator closes drawer → Insights → 4 of the 5 new ads appear in the top-creatives table with their LLM-classified tags. The 5th failed Whisper (too large) — operator compresses and retries.

### Flow 4: Generate fresh scripts

Operator goes to Generate. Picks **opt-restoration** offer (chip pill selection). Chooses **30 concepts** (preset button row: 5/10/15/20/30 + custom input). Picks **Diverse batch** mode (default for max variance across attributes).

Clicks **Generate 30 diverse concepts** → ~30 seconds later, 30 script cards appear in a 2-3 column grid. Each card has:
- Frame-colored top stripe (red Problem / amber Circumstance / green Outcome)
- Meta line: "#01 · PROBLEM · sixty_75s"
- Serif title: "Eric's Direct Call Breakthrough"
- Attribute pills: `hook=diagnostic` `mech=explicit` `pain=capacity_mismatch` `proof=eric` `stage=tof`
- Body text (60-90 seconds of script, 150-250 words)
- Copy button per card → copies body to clipboard

Operator clicks Copy on a favorite, pastes into filming notes. Generated scripts also save as drafts (table at bottom of Generate page) so they can be linked to Meta ads later.

### Flow 5: Link a draft to a filmed ad

The operator filmed script #M3 last week. They've shipped the filmed ad to Meta and have the Meta ad_id. They go to Generate → recent drafts table → click **Link to Meta ad** on the M3 row → drawer opens with **Existing draft** tab preselected to M3 → operator searches "scuba" in the Meta ad picker → picks the match → clicks Link.

The script's target attributes (hook_type, mechanism, pain_angle, proof_character, awareness_level, funnel_stage, length_bucket) flow into `creative_attributes` for that Meta ad — no LLM re-classification needed. Status pill on the history row turns yellow (`shipped`).

### Flow 6: Create a new offer (plumbing campaign launch)

On the Generate page, next to the offer chips, there's a "+ New offer" dashed-border button. Operator clicks → centered modal with form:
- **Slug** (auto-kebab from name): `opt-plumbing`
- **Vertical**: plumbing
- **Display name**: "OPT Plumbing (Pipe Flow System)"
- **Mechanism name**: "The Pipe Flow System"
- **Primary audience**: "Plumbing company owners doing $30k+/mo, dependent on HomeAdvisor leads"
- **Default proof characters** (comma-list): "Morgan, Karen"
- **Has dual guarantee** (checkbox + explanation)
- **Brand voice notes** (textarea, Markdown OK)

Operator saves → new offer appears in chip selector → they pick it → generates plumbing-specific scripts using the new offer's mechanism + audience + proof characters baked into the LLM prompt.

---

## 5. Data model (in operator language)

### Offer
The thing OPT sells. Each offer has a vertical (restoration / plumbing / etc), a mechanism name (the branded system, e.g. "The Direct Call Engine"), a primary-audience description, default proof characters (real client names), and a brand-voice note. Used by the script generator to bias output.

### Creative
An ad asset (image or video). Lives in Meta as an `ad_id` (numeric string). Has: thumbnail, ad name, campaign + adset assignment. Has optional transcript (from Whisper, manual paste, or Meta's auto-captions). Has 11 attribute tags.

### Attributes (the 11 dimensions per creative)
1. **hook_type** — Question / Scene / Dollar-pain / Diagnostic / Conditional
2. **message_frame** — Problem / Circumstance / Outcome
3. **mechanism_reveal** — GATED (brand-named) / EXPLICIT (literal deliverable) / HIDDEN (outcome-only)
4. **proof_character** — Eric / Adam / Belinda / Morgan / Karen / Derek / Mike / none (extensible per offer)
5. **pain_angle** — 14 values (phone_not_ringing, agency_burn, tpa_referral_dep, capacity_mismatch, lead_platform, storm_seasonal, scaling_growth, speed_timeline, guarantee_proof, founder_identity, commercial_tier, adjuster_relations, competitor_takeover, last_objection)
6. **funnel_stage** — TOF (cold) / MOF (warm retarget) / BOF (hot retarget) / Cross
7. **awareness_level** — Schwartz's 5 stages (Unaware / Problem-aware / Solution-aware / Product-aware / Most-aware)
8. **length_bucket** — under_60s / 60-75s / 75s+
9. **format** — Talking head / UGC / Comparative / Voiceover
10. **actor** (operator-set) — Ben / Austin / Client / Voiceover-only / Other
11. **vertical** (denormalized from offer) — restoration / plumbing / etc

Plus winner state (manual override + auto-detected via heuristic) and provenance (extracted_at, extracted_by_model, confidence per field).

### Generated Script (draft)
LLM-produced ad-script concept before it becomes a real Meta ad. Has title, frame, body text, target attributes, and a lifecycle: draft → approved → filming → filmed → shipped.

### Performance metrics (joined from existing tables)
- Spend, impressions, clicks (from `ad_daily_stats` synced from Meta Graph API)
- Leads (attributed via `ghl_contacts.last_ad_id`)
- Booked calls (GHL appointments → ad_id)
- Closed deals + revenue + cash collected (closer pipeline)
- Derived: cost per lead, cost per booked, cost per close, close rate

### Winner
A creative meeting the auto-heuristic: **spend ≥ $1,000 AND booked ≥ 2 AND cost-per-booked ≤ $300**. Operator can manually override (force winner or force loser). Effective winner = manual_override ?? auto_detected.

---

## 6. Visual + interaction language (locked tokens)

### Editorial design system
- **Background**: paper cream `#fbfaf6` (page bg), white for elevated cards
- **Ink (primary text + buttons)**: near-black `#0a0a0a`. Ink-3 `#5a5650`, Ink-4 `#88847e` for muted text.
- **Accent**: yellow `#f4e14a` — used SPARINGLY, only for: winners, primary CTAs, active states, podium top-3 ranks, "DONE" status badges
- **Rule (hairline borders)**: warm grey `#e8e3d8`
- **Status colors** (used in charts, frame stripes, status pills): red `#b53e3e`, amber `#e0a93e`, green `#3e8a5e`, purple `#5b3a8f`, teal `#0e7c86`, orange `#b86a0c`

### Typography
- **Display (h1, h2, large numbers)**: Newsreader serif, weight 400. Italic for emphasis (e.g. "What's *winning*.")
- **Body**: Inter sans, weight 400/500/600
- **Labels / metadata / numbers**: JetBrains Mono. Often uppercase with `letter-spacing: 0.12em` for eyebrows.

### Components inventory (existing in codebase)
- **Eyebrow label** — mono, uppercase, 10-11px, letter-spaced. Pairs with serif h1/h2 below: `OPT Sales · Creative *insights*`
- **Chip / pill** — small bordered tag, mono, used for attribute values and status badges
- **Bar chart** (Recharts) — ink bars by default, accent yellow for winning bars
- **Pie / donut** — 8-color palette using ink + accent + status colors
- **Card** — white background, 1px rule border, optional 3px top accent stripe for emphasis
- **Drawer** (right side) — 520-640px wide, paper background, 3px LEFT accent stripe, subtle horizontal drop shadow `boxShadow: '-12px 0 32px rgba(10,10,10,0.15)'`
- **Modal** (centered) — paper background, 1px rule border + 3px TOP accent stripe, drop shadow `boxShadow: '0 24px 60px rgba(10,10,10,0.18)'`. Older modals had `8px 8px 0 var(--accent)` yellow shadow — we've removed this "popup cut-out" treatment.

### Interaction patterns
- **Row hover on tables** → light paper background, `cursor: pointer`
- **Click row** → opens drawer with detail/edit
- **Click CTA buttons** → inline action OR opens drawer/modal
- **Forms** → auto-save on blur (no Save buttons in drawers; only modals have Save buttons)
- **Toast notifications** → existing useToast hook for success/error feedback
- **Step indicator** in bulk upload → pill row with stages lighting up sequentially (active = ink+accent text+pulse, done = accent with checkmark, pending = paper+grey)

---

## 7. Page-by-page design surfaces

### Insights page (highest priority for designer)
**Live URL**: `/sales/ads/creative/insights`
**Status**: functional rebuild shipped, needs visual hierarchy work.

Sections from top to bottom:
1. **Page header** — eyebrow ("OPT Sales · Creative *insights*") + serif h1 ("What's *winning*.") + italic serif tagline explaining what the page shows. Right-aligned: two buttons (Add or link creative primary + Tag more ads secondary).
2. **KPI grid** — 4 tiles in a row: Win rate (intended to be visually dominant), Avg CPB on winners, Total booked, Tag coverage %.
3. **Filter bar** — paper background, contains: date range presets (7d / 30d / 60d / 90d), offer chip toggles, clear button.
4. **"Variables pulling ahead"** — for each attribute, the value with highest win-rate lift. Currently 5-6 cards in a row, each showing attribute label + lift pill (e.g. "+0.8%" in ink/accent) + value (serif 22pt) + win-rate + ads count + avg CPB.
5. **"Top performing creatives"** — table. Columns: rank badge | thumbnail | ad name + campaign | attribute pills | booked | CPB | winner indicator. Rows clickable → opens edit drawer.
6. **"Win rate by attribute"** — 6 small-multiples Recharts bar charts (one per attribute). Each ~330px wide. Has dashed baseline reference line.
7. **Proof character donut** (when data exists, sidecar in the chart grid) — booked-by-proof distribution.

### Generate page
**Live URL**: `/sales/ads/creative/generate`
**Status**: functional, three-step + advanced filters works.

Sections from top to bottom:
1. **Page header** — same eyebrow/serif/tagline pattern as Insights.
2. **Step 01 · Pick an offer** — offer chip selector. Each offer is a chip with a Settings gear icon and a "needs config" amber pill if mechanism/audience is missing. "+ New offer" dashed-border button at the end opens the OfferConfig modal.
3. **Step 02 · How many concepts** — preset buttons (5/10/15/20/30) + custom number input.
4. **Step 03 · Generation mode** — two big mode cards: Diverse batch (default, max variance across attributes) vs Targeted (constrain specific attributes). Targeted mode reveals "Add constraints" expandable with multi-select chip pills per attribute.
5. **Step 04 · Generate** — primary CTA button (yellow accent box-shadow), save-to-drafts checkbox, dual-guarantee notice.
6. **Result panel** (appears after generation) — grid of script cards with frame-color top stripe, serif title, attribute pills, body, copy button.
7. **Recent drafts** table — history with status pills + per-row "Link to Meta ad" button.

### Add or Link Creative drawer (right-side, opens from Insights or Generate)
**Status**: 3-tab drawer just shipped, functional but needs polish.

Tabs: **Existing draft** / **Paste transcript** / **Upload MP4**.

For each tab, the flow surfaces:
- Pick the target (script for existing-draft, Meta ad for paste/upload)
- Provide the content (none for existing-draft, textarea for paste, file dropzone for upload)
- Footer narrates the pending action ("Will paste 200 words → Real: Restoration At A Home")
- Footer "Run" CTA processes the work

Bulk mode (when 2+ files dropped in Upload MP4 tab): drawer renders a queue with per-file rows.

### Creative Edit drawer (right-side, opens from Insights row click)
**Status**: shipped.

Contains:
- Sticky header: thumbnail (56px) + ad name + ad_id (mono, small) + "Open full page →" link + X close
- Body: 11-dropdown attribute editor with confidence pills per field. Auto-saves on blur.
- Includes "Mark winner / Mark loser" toggle for manual override and a Notes textarea.

### Offer Config modal (create / edit offer, opens from Generate)
**Status**: shipped, clean modal styling.

Contains form fields: slug, vertical, display name, mechanism name, primary audience, default proof characters, dual-guarantee checkbox, brand voice notes.

---

## 8. Known design problems (the rough edges we want a designer to solve)

These are areas where I shipped functional-but-rough UX that need a real designer's eye:

1. **Insights page top is dense** — KPIs + filter bar + variables-pulling-ahead all happen above-the-fold. May need progressive disclosure, sticky-anchored navigation, or section grouping.

2. **KPI tiles have equal visual weight** — they're 4 boxes in a row, all similar size. Win rate should probably be 2x size with bigger serif numbers; the others should be supporting metrics.

3. **"Variables pulling ahead" cards are tight 4-up** — would benefit from more breathing room or a different layout pattern (vertical stack? carousel?). The lift pill (`+0.8%`) is the key signal but it's small relative to the attribute label.

4. **Bulk queue rows aren't scannable** — when 10+ files in the queue, finding the one that errored requires reading every row. Status column should be sortable/filterable, or errors should bubble to the top.

5. **"Click to tag →" hint on empty-attribute rows is buried** — operators don't always realize they can click the row. Need a clearer affordance (icon? hover state? edit pencil?).

6. **Modal vs drawer mixing** — OfferConfigModal is a centered modal; AddOrLinkCreative and CreativeEdit are right-side drawers. Inconsistent. Probably all should be drawers OR all centered modals — but which?

7. **The "popup cut-out" critique** — earlier modals used a yellow 8px box-shadow that read as gimmicky. Now using a subtle top-accent border + drop-shadow. Designer should confirm this is the right call, or propose an alternative.

8. **Generator's Mode Cards** — info-dense. The two cards (Diverse vs Targeted) each have ~30 words of explanation. Could be a toggle switch with secondary descriptive text on hover instead of two equal-weight cards.

9. **Date range presets are bare buttons** — `7d / 30d / 60d / 90d`. Could be a segmented control or a date-range picker dropdown with custom-range option.

10. **Small-multiples charts crowd on narrow screens** — 6 charts → 1 column on mobile. Either need a different visualization or a different layout for narrower viewports.

11. **Confidence pills lack labels** — green/yellow/red is meaningless to color-blind users. Should have text labels ("high / med / low / guess") alongside or instead of color.

12. **The "drop file → attach to ad → run" flow in Add Creative is text-only** — currently uses numbered list headers ("Step 01", "Step 02"). Could be a horizontal stepper with visual state.

13. **Empty states need work** — when no winners exist yet, "Current winners (0)" shows italic placeholder text. Same for charts with no data. Designer should design proper empty states with clear next-action copy.

14. **Confidence + winner override discoverability** — the operator-only fields (manual_winner_override, actor) are mixed in with the 9 LLM-extracted fields in the drawer. Grouping them would help.

15. **Script result card visual differentiation** — currently the only visual difference between Problem/Circumstance/Outcome frames is a 3px top stripe color. Could push further (background tint? icon? typography?).

---

## 9. What's NOT in scope

- **Mobile-first** — desktop admin tool. Tablet OK but not mobile-optimized.
- **Multi-user / multi-tenant** — single-operator dashboard (or 2-3 internal team members). No customer-facing UX.
- **Real-time collaboration** — no concurrent-edit indicators or live cursors.
- **Theming** — single light theme. No dark mode.
- **Internationalization** — English only.
- **Onboarding flow** — operator is the founder who built the system. No first-time-user walkthroughs.
- **Notification center** — toast feedback is sufficient.
- **Global search** — only ads-specific search inside drawers.
- **Existing pages** (Clips / Variants / Ads / AdDetail) — these work; not in scope unless integration points need to change.

---

## 10. Tech context (in case it informs design constraints)

- React + Vite SPA, Tailwind CSS available but ads/* pages use inline styles + CSS custom-properties for the editorial token system
- Recharts is the charting library
- Supabase (Postgres + Edge Functions + Storage) is the backend
- Anthropic Claude (Sonnet 4) for attribute extraction + script generation
- OpenAI Whisper for video transcription (has a 25MB API limit per file)
- All data flows through `lib_ad_performance(since, until)` SQL function that joins spend + leads + booked + closes + attributes per ad

---

## 11. Deliverables we'd ideally get from the designer

1. **Insights page redesign** — top-priority visual hierarchy pass + KPI emphasis + variables-pulling-ahead layout
2. **Generate page polish** — step pattern + mode-card alternative + result-card visual differentiation
3. **Drawer pattern lock** — settle modal-vs-drawer for all surfaces + define motion + style spec
4. **Empty states** — proper designs for all "no data yet" surfaces
5. **Bulk queue UX** — scannable row design, status-bubbling-to-top, error-recovery pattern
6. **Confidence + winner-override surfacing** — grouping + visual treatment for operator-only vs LLM-extracted fields

Optional bonus:
- **Component spec page** — codified inventory of buttons, chips, pills, cards, drawers for future contributors
- **Motion / transition spec** — how drawers slide, how status pills animate, how charts load

---

## 12. Files / references the designer can pull screenshots from

Once they have access to the dashboard at https://sales-dashboard-ftct.onrender.com:

- **Insights** — `/sales/ads/creative/insights` (the headline page)
- **Generate** — `/sales/ads/creative/generate`
- **Single ad detail** — `/sales/ads/ad/<any-ad-id>` (older page, shows the embedded attribute editor)
- **Existing pages for context** — `/sales/ads/creative/clips`, `/variants`, `/ads`

Existing visual reference: the OPT editorial design system documented at `C:\Users\Ben\.claude\OPT-DESIGN-SYSTEM.md` — Newsreader serif display, Inter body, JetBrains Mono labels, single yellow accent, paper-cream backgrounds.
