# Jeremy Haynes — Post-Andromeda Meta Ads Playbook

**Source:** 3 YouTube videos by Jeremy Haynes, channel oriented around scaling
high-ticket coaching/agency offers to "million-dollar months."
Synthesised 2026-05-10. Raw cleaned transcripts in `../transcripts/`.

| | Title | Recorded | Length | Views |
|---|---|---|---|---|
| 1 | [The BEST Ad Creative Testing Strategy For 2026 (Post-Andromeda)](../transcripts/NKOHsR9nVEM.en.txt) | 2025-12-24 | 15m 42s | 7.7k |
| 2 | [Aggressive Ad Strategies To Scale The F*ck Out Of Your Offer](../transcripts/NRgDr0aBCUo.en.txt) | 2025-08-02 | 28m 15s | 3.8k |
| 3 | [The NEW Way To Scale Ads with Meta's Andromeda Update](../transcripts/Rim2s-WFwYg.en.txt) | 2025-10-29 | 12m 26s | 12.9k |

---

## What Andromeda is, and why old best-practices are dead

Meta's **Andromeda** is the 2024-25 ranking-model upgrade to the ads delivery
system. Rolled out Nov-Dec 2024 → Apr 2025 → Jul 2025; by late 2025 most ad
accounts are on it. Underneath, it's still Meta's 2023 Lattis "retrieval +
ranking" architecture — but Andromeda widens the **retrieval** funnel
dramatically. The model now intakes far more creative inputs and whittles them
down to a few thousand candidate ads, then ranks them per-impression for
match-fit against the user.

**The single most important consequence:** targeting is now controlled by
**messaging**, not by ad-set targeting fields. Ad-set targeting is treated as
suggestive. Every word, image and frame in a creative becomes part of the
audience signal. Mention "JK Rowling" and you'll start reaching authors —
even if no targeting field said "writers." This is referred to as the
**pocket audience** effect.

Pocket audiences are smaller and more numerous than the audiences the older
algo found. They also exhaust faster — what used to be a months-long winner
now burns out in days to weeks. Account fragmentation actively hurts you;
the algo punishes audience overlap from duplicated ad sets.

**Old beliefs that are now harmful:**
- "Every creative deserves distribution" → no, 1-3 of 25-30 will get all the reach. That's by design.
- "Different hook on the same body is a test" → no, Andromeda needs *fully unique* creatives end-to-end.
- "Split targeting into ad-sets" → no, stack everything into one big ad set; targeting is messaging.
- "Run a few ads and scale them" → no, run 25-30 and let Andromeda pick winners.

---

## Campaign structure (post-Andromeda)

### 1 · Campaign types — usually just one

| Type | Use | Notes |
|---|---|---|
| **Cold** | Default. All real volume here. | Three ad sets: broad / interest stack / lookalike stack. |
| **Warm** | Optional, low budget. | Only if warm audience size is big enough to deserve spend. |

Use **ABO** (ad-set budget) over CBO so you can control distribution between
the three cold ad sets. Don't fragment beyond that.

### 2 · Ad-set anatomy (cold campaign)

Three ad sets, each containing the **same** 25-30 ads:

| Ad set | Targeting | What goes in it |
|---|---|---|
| **Broad** | No targeting fields | Same 25-30 ads |
| **Interest stack** | Every relevant interest, behavior, demographic — in ONE ad set | Same 25-30 ads |
| **Lookalike stack** | A pile of 1% lookalike audiences in ONE ad set: highest-value-customers, all-customers, leads-who-showed, qualified-bookings | Same 25-30 ads |

> "Stack" = throw it all into one ad set. Do **not** split interests into
> separate ad sets. Targeting fields are only suggestive now.

### 3 · Switch off Advantage+ creative junk

Disable nearly everything Meta wants to "auto-enhance":
- ❌ Sitelinks
- ❌ Most AI Advantage creative options
- ✅ "Highlight a positive comment" — fine to keep on

### 4 · Asset count per ad set

- **25–30 unique full creatives** (each is a complete video/image, not a hook swap)
- **5 headlines** — same 5 attached to all 25-30 ads. Written broad enough to fit any of them.
- **5 body copy variations** — same logic.

> Goal: 25 different *reasons to buy*, each filmed end-to-end as its own creative.
> Not 25 hooks bolted onto the same body.

---

## The testing → scaling loop

This is the meat of video 1. Concrete state machine:

```
Launch ad set with 25-30 unique creatives (test budget)
        │
        ▼
1-3 creatives get all the reach.   ←─── This is the system working as designed.
27-29 spend pennies; they sit on the bench.
        │
        ├── Sales team: "These leads are the right type" ──► SCALE the ad set
        │                                                       │
        │                                                       ▼
        │                                              Push spend until ceiling.
        │                                              Pull back to ceiling.
        │                                              This ad set becomes "FOUNDATIONAL."
        │                                                       │
        │                                                       ▼
        │                                          DUPLICATE the ad set:
        │                                            • keep the 27-29 benched creatives
        │                                            • REMOVE the 1-3 winners (they're now scaling foundationally)
        │                                            • ADD 1-3 brand-new creatives
        │                                          → Put on test budget. Loop again.
        │
        └── Sales team: "These leads suck" ──► The 1-3 are actually losers (bad pocket).
                                                Kill the ad set.
                                                Duplicate it the same way (bench creatives + 1-3 new),
                                                run again. Avoid the messaging that won this round.
```

### Key beliefs to internalise
- Ads with no reach are **not waste**. They're a creative bench you redeploy when winners fatigue.
- "This worked" ≠ "this brought right buyers." A favorable CPA can still be losing if leads are bad-fit. Sales team feedback is the deciding signal, not the dashboard.
- A foundational ad set has a real spend ceiling. Push above it and CPA inflates while result volume drops. Identify the ceiling, then live at it.
- You always want extra creatives waiting on the side. Filming-and-launching takes too long to be reactive — you need a queue.

---

## Pocket audiences + messaging diversification

### How pockets work
Imagine your addressable market as land. Each creative drills a well into a
**pocket** of likely-buyers. Andromeda is great at finding tiny pockets per
creative — but each pocket has finite oil. Two consequences:

1. **More pockets are reachable** than ever (good — niche messaging now scales).
2. **Each pocket runs out faster** (bad — winners fatigue in days/weeks, not months).

When a winner starts attracting wrong-fit leads, the pocket is exhausted.
Time to relaunch with new test creatives.

### Messaging structure for an audience pocket

For each demographic you can convert, articulate from three perspectives. List
as many as you can:

| Axis | Definition | Example |
|---|---|---|
| **Problems** | What's actively painful, broken, embarrassing for them right now | "I'm getting leads but none of them close" |
| **Circumstances** | The specific situation/context they're sitting in | "We just hit $40k/mo and need to break the ceiling" |
| **Outcomes** | The state they want to be in | "Predictable $200k months without me on every call" |

Run the cross-product → that's your raw material for 25-30 unique creatives
per pocket. A common LLM-assisted workflow:

1. Upload **call transcripts** (real prospect language) to a credit-based LLM
   (not flat-rate ChatGPT — credit LLMs read the full transcripts without
   guard-rail abbreviation; agent-mode lets them research live context).
2. Have the LLM extract problems × circumstances × outcomes per audience
   pocket from the transcripts.
3. Have it generate 25-30 ad concepts grounded in real prospect quotes.
4. Film them. Launch as a wave.

> Sensitivity warning: Andromeda is so word-sensitive that mentioning one
> famous author's name in a copywriting ad (referenced "JK Rowling") drew a
> pocket of *authors* into the funnel — completely off-target. Audit script
> language for unintended pocket signals before shipping.

---

## Three explicit scaling strategies

| Strategy | Risk | When to use | Mechanic |
|---|---|---|---|
| **Surfing** | High | Holiday/finite windows, no closer dependency, known historical ceiling | Start at $1k/day → check after 8h. If CPA holds, jump 3x. Wait 3h, jump 2x. Wait 3h, jump 2x. Wait 3h, jump 3x. Went $1k → $36k/day in one day. **Set automated CPA cap** ($70 in his example) before sleeping. **Never use this with sales-team-dependent funnels** (you'll outpace closer capacity). |
| **Cost-per-X** | Medium | Math-driven incremental punch-up | "If current CPA = $100 and I want 10 more leads, add $1k/day." Wait **2-3 days** for new CPA + AOV to stabilise before doing it again. Less abrupt than surfing. |
| **10-30%/day** | Low (the standard) | Anything sales-team-dependent. The default for OPT-style call funnels. | Increase ad-set budget by 10-30% per day. Compounds fast — $1k → $10k+ inside 30 days. Sometimes wait 48-72h between bumps. |

### Why this matters for OPT specifically
OPT is a sales-team-dependent business. Every booked call needs a closer.
**Surfing and cost-per-X are not appropriate** here — they'll outpace closer
capacity inside a day and spike no-show rates / bookings-not-attended.

→ The strategy for OPT's growth is **10-30%/day**, paced against:
- closer capacity ceiling (calls/day the team can hold)
- hiring lead time (3-4 weeks to onboard new closers/setters before scaling further)

When you scale ads, you must *concurrently* scale the team. "Marketing knobs"
(ad spend) move faster than "people" (hiring) — Jeremy quotes Josh Troy on
this. The 10-30% pace is what gives the people side time to keep up.

---

## What this changes for the OPT ad library build

The existing v2 plan in [AD-PERFORMANCE-PLAN.md](../../AD-PERFORMANCE-PLAN.md)
is structurally right — five tabs, four-dimension variants, public.ads ↔
library.variants linking. But the playbook above means the library needs
additional **process states** and a **transcript-driven authoring loop** the
plan didn't fully scope:

### Missing variant states
The current `library.variants.status` is `concept | in_production | ready | retired`.
Andromeda-aware states the team actually operates with:

| State | Meaning | Emerges from |
|---|---|---|
| `concept` | Ideated from transcript-mining or strategy session | LLM-generated angle from prospect quote |
| `in_production` | Filmed/edited, not yet launched | Asset upload in Storage |
| `bench` | Launched in an ad set but didn't get reach. Ready to redeploy. | Andromeda picked 1-3 others over it |
| `winning` | One of 1-3 in an ad set getting all the reach + good-fit leads | Daily perf + sales-team sign-off |
| `foundational` | Scaling at-or-near ceiling within a foundational ad set | Hit ceiling, was duplicated out |
| `bad_pocket` | Got reach, but brought wrong-fit leads | Sales-team rejection feedback |
| `fatigued` | Was a winner, now CPA inflating + lead quality dropping | Pocket exhausted |
| `retired` | Permanently archived | Manual |

### Missing feedback signal
The library needs a **per-variant lead-quality signal**, not just CPA.
Andromeda makes "favorable CPA, bad leads" the most common failure mode.
The signal already exists in our data: `setter_leads.status` = `closed` /
`no_show` / `not_closed` / `cancelled`, joined by `utm_content = ad.id` →
`ad.variant_id`. That's the missing arrow on the architecture diagram in
the v2 plan.

### Missing authoring loop
Phase 3 of the v2 plan adds an `AddVariantModal`. The Andromeda playbook
upgrades that to: **transcript-mining concept generator** that:
1. Pulls all `closer_transcripts` for a chosen audience pocket / brand
2. Excludes team meetings + Constantine @ scaleclients.io (per Ben 2026-05-10)
3. Sends them to a credit-based LLM with a prompt structured around
   `problems × circumstances × outcomes`
4. Outputs 25-30 concept variants — each pre-filling a 4-dimension component
   pick + a script_text drawn from real prospect quotes
5. Operator reviews, accepts to `concept` status, films, ships

### Missing scaling-readiness gate
`/sales/ads/variants/:id` should surface:
- Current closer capacity vs current bookings/day
- Hiring lead time before next capacity step
- Recommendation: stay / 10-30% bump / hold

…so the operator never accidentally surfs a call funnel.

---

## TL;DR — the four moves

1. **Stop fragmenting the ad account.** One cold campaign, three stacked ad sets, 25-30 unique creatives per ad set, ABO budgets, kill Advantage+ junk except positive-comment highlighting.
2. **Treat the bench as inventory, not waste.** The 27-29 ads that didn't get reach are next month's launches. Always have ads queued.
3. **Read closer feedback as the ground truth.** A "winning" CPA on bad-fit leads is a `bad_pocket`, not a winner. The variant kill criterion is sales-team rejection, not the dashboard.
4. **Mine transcripts for variant concepts.** 159 of Daniel's prospect calls are the raw material. Problems × circumstances × outcomes → 25-30 unique creative ideas per audience pocket. Feed those into the existing 4-dimension library.
