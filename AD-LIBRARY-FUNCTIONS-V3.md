# Ad Library — Function Spec v3

> Stacks on top of [AD-PERFORMANCE-PLAN.md](AD-PERFORMANCE-PLAN.md) (the 5-tab
> shell + 4-dimension variant taxonomy) and
> [`.kb/playbooks/jeremy-haynes-andromeda.md`](.kb/playbooks/jeremy-haynes-andromeda.md)
> (the post-Andromeda creative-volume playbook). Adds two functions Ben asked
> for on 2026-05-10:
>
> 1. **Messaging Isolation** — transcribe every ad video, correlate phrasing
>    with performance, surface "what's actually winning" at the language level.
> 2. **Live Ad Gallery + Analyst Agent** — an internal Meta-Ads-Library-style
>    visual surface where every running ad is browsable with stats overlaid,
>    plus an AI agent that reviews / ranks / explains performance on demand.
>
> **Owner:** Ben · **Drafted:** 2026-05-10 · **Status:** Plan only

---

## 0 · TL;DR

Today the ad library has a 5-tab UI shell (restyled editorial) and a schema
(`public.ads`, `library.{components,variants,performance_daily}`) but no data
flowing in and no opinionated lens on what's *working*. Two functions close
that gap:

- **Function 1** turns every ad we run into a piece of analysable text
  (transcript), then scores phrases/hooks/claims by the performance of the
  ads they appeared in. Output: a ranked phrase library — *"these openings
  win, these closings stall, this CTA outperforms by 32%."* Tied directly
  back to closer-confirmed lead quality, not just CPA.

- **Function 2** is the Meta-Ads-Library-style visual gallery for our own
  ads — clickable cards with autoplay video, live stats overlaid, filter chips
  by spend tier / KPI status / brand / date range. An AI analyst agent sits
  alongside as a chat panel: pre-baked prompts ("Which ads are in KPI for
  booked calls?", "Best-performing hook this week?", "Why is variant X
  winning?") plus open-ended Q&A grounded in the ad-level performance data.

Both functions are independent enough to ship in parallel, but they reinforce
each other: the gallery is where you *see* what's winning, the messaging
isolation is where you *understand* what's winning, and the agent translates
between the two on demand.

---

## 1 · Function 1 — Messaging Isolation from Ad Transcripts

### 1.1 · Why

The Andromeda playbook makes language the targeting signal. One word in a
hook can drag the algorithm into the wrong pocket audience. We currently have
no way to ask "which 3-second-opens are over-indexing on closes?" or "what
phrasing does the bottom-quintile of variants share?". We're flying blind on
the most controllable lever of the whole system.

We *do* have everything needed to fix this:
- Every ad creative is a video with audio.
- Every ad has a Meta-attributed performance row (`public.ad_daily_stats`).
- Every booked call from Meta has a `utm_content = ad_id` we can chain to
  `setter_leads → closer_calls` for lead-quality + close outcomes.

What's missing is **the transcript layer + the correlation engine**.

### 1.2 · Pipeline

```
Meta Graph API
    │
    ├── Video URL (asset)
    │     │
    │     ▼
    │   ① Caption fetch (Meta `/{video_id}` captions endpoint)
    │     │     │
    │     │     └─► if missing → ② Whisper fallback (local or OpenAI)
    │     ▼
    │   library.creative_transcripts
    │     ┌────────────────────────────────────────┐
    │     │ variant_id (FK → library.variants)    │
    │     │ ad_id      (FK → public.ads)          │
    │     │ source     ('meta_caption'/'whisper') │
    │     │ language   ('en')                     │
    │     │ full_text  TEXT                       │
    │     │ segments   JSONB [{t0,t1,text}]       │
    │     │ duration   INT seconds                │
    │     │ created_at, updated_at                │
    │     └────────────────────────────────────────┘
    │
    └── Daily stats → public.ad_daily_stats
                            │
                            ▼ (existing trigger from migration 012)
                     library.performance_daily

    ┌──────────────────────────────────────────────┐
    │ ③ Phrase scoring job (nightly)              │
    │   For each n-gram (1, 2, 3, 5, 8 words):    │
    │   - find every variant whose transcript     │
    │     contains it                             │
    │   - compute weighted perf metric across     │
    │     those variants (composite of CTR,       │
    │     hook%, hold%, CPA, cost-per-booked,     │
    │     close-rate)                             │
    │   - require min-sample threshold (3+ ads,   │
    │     $250+ total spend) to surface           │
    │   - store in library.phrase_performance     │
    └──────────────────────────────────────────────┘
```

### 1.3 · Why captions first, Whisper fallback

Meta provides auto-generated captions for video ads via the Graph API
(`/{video_id}?fields=captions`). They're free, instant, and trained against
ad-platform audio specifically. We use them as the primary source.

Whisper is the fallback for when captions are missing or low-confidence:
- **Local Whisper** (~300MB model, runs on Ben's machine via Python) — free,
  but ties up the local box during transcription.
- **OpenAI/Anthropic transcription API** — paid per-minute. Predictable cost,
  no local resource hit. *Recommended* for production cadence given we'd be
  running this nightly across a growing ad pool.

Either way, transcript output is normalised into the same `segments` JSONB
shape: `[{t0: 0.0, t1: 2.4, text: "What if I told you..."}, ...]`.

### 1.4 · Phrase scoring methodology

#### Composite performance score (per variant)

Single number, 0-100, weighted to OPT's actual revenue model:

```
perf_score(variant) =
    0.25 × ctr_z         (click-through rate, z-scored within brand)
  + 0.20 × hook_rate_z   (3-sec view rate)
  + 0.10 × hold_rate_z   (thruplay rate)
  − 0.20 × cpa_z         (cost per booked call, inverse z)
  − 0.15 × cpl_z         (cost per lead, inverse z)
  + 0.30 × close_rate_z  (closes / clicks, the actual signal)
  + 0.20 × lead_quality_z (closer-marked good-fit %, the bad-pocket guard)
```

Weights are configurable. The `close_rate` and `lead_quality` weights are
intentionally heavy because the Andromeda playbook says favorable CPA on bad
leads is the most common failure mode — we're explicitly counter-weighting
the dashboard's natural CPA bias.

#### Phrase score

For an n-gram **p**, score = weighted mean of `perf_score` across all variants
whose transcript contains **p**, where weight = total spend on that variant.
Phrases below the min-sample threshold (3 variants, $250 total spend) are
hidden as "not enough signal yet."

Result: a ranked phrase list per dimension:

| Phrase | Variants | Total spend | Mean perf | Δ vs library mean |
|---|---|---|---|---|
| "I'm gonna show you" | 8 | $4,210 | 71.2 | +18.4 |
| "exactly how" | 12 | $6,780 | 68.9 | +16.1 |
| "...you know what I mean?" | 4 | $1,820 | 38.4 | -14.3 |
| "stop doing X" | 6 | $3,440 | 31.1 | -21.6 |

#### Time-segmented variants

Same phrase ranking, scoped to **first 3 seconds** of the video (the hook
window) vs **post-3s** (the body window). The Andromeda playbook says the
hook controls pocket retrieval; the body controls conversion. Different
phrases will win in each window, and we want to see both.

### 1.5 · Surface — `/sales/ads/messaging`

A **new tab** on the AdsLayout shell, sitting alongside Hooks/Bodies/Scenes/Creators.

Three sections stacked:

#### § 01 — Top winning phrases
Ranked table, default sort by Δ vs mean. Filterable by:
- window (full video / first 3s / 3-15s / 15s+)
- dimension (any / hook / body / scene / creator — based on the variant's tagged components)
- brand (RemodelingAI / RestorationConnect / etc.)
- date range
- min spend / min sample size
- phrase length (single word / 2-3 word phrase / longer)

Each row drills into a detail view showing: every variant that contains the
phrase, side-by-side stats, the variant's video link.

#### § 02 — Bottom phrases (anti-patterns)
Same table, inverted sort. The "stop saying these" library.

#### § 03 — Phrase clusters (semantic)
Optional Phase-2 section. Use embeddings (OpenAI ada-002 or Anthropic-side
embedding) to cluster similar phrases — "show you exactly how" and "I'm
gonna walk you through" group as one *demonstration-promise* cluster.
Cluster-level stats give us themes, not just literal n-grams.

#### What this means callout
Every section closes with the editorial `.what-it-means` block — an
italic-serif interpretation of what the data says, refreshed nightly. e.g.
*"Hooks that promise demonstration over outcome are outperforming pain-led
hooks by 22% on closed revenue this period. Consider biasing the next
ideation wave toward 'show-you-how' framing."*

The interpretation is generated by the Function-2 agent (see §2.5).

### 1.6 · Operator workflows enabled

- **Pre-launch sanity check.** Before filming a new wave: paste the script
  outlines into a "phrase audit" pane → it flags any phrases in the bottom
  decile of historical performance. Avoid known anti-patterns before you
  spend on filming.

- **Post-launch retro.** A variant is fatiguing — open it, see which of its
  phrases were doing the heavy lifting, write the next 3 variants with
  variations on those phrases.

- **Brand-language style guide.** Export the top-50 phrases per brand as
  a PDF that goes into the creator brief for new shoots.

### 1.7 · Cost & cadence

| Item | Estimate |
|---|---|
| Meta caption fetch | Free (already in our API quota) |
| Whisper fallback (OpenAI API) | ~$0.006 / minute → ~$0.18 per 30s ad. 100 new ads/month = ~$18/month. Trivial. |
| Phrase scoring job | Postgres function, runs in <30s on our dataset size. Nightly. |
| Embedding pass (Phase 2) | OpenAI ada-002 ~$0.0001 / 1k tokens. Whole library < $1 to embed once. |
| **Total run-rate** | **~$20/month** |

### 1.8 · Schema — migration 014

```sql
-- 014_creative_transcripts.sql
CREATE TABLE IF NOT EXISTS library.creative_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID REFERENCES library.variants(id) ON DELETE CASCADE,
  ad_id TEXT REFERENCES public.ads(ad_id) ON DELETE CASCADE,
  meta_video_id TEXT,
  source TEXT CHECK (source IN ('meta_caption', 'whisper_local', 'whisper_api', 'manual')),
  language TEXT DEFAULT 'en',
  full_text TEXT NOT NULL,
  segments JSONB DEFAULT '[]'::jsonb,  -- [{t0, t1, text}, ...]
  duration_sec INT,
  confidence REAL,                      -- caption confidence if available
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (variant_id),
  UNIQUE (ad_id)
);

CREATE INDEX idx_creative_transcripts_text_gin
  ON library.creative_transcripts USING gin (to_tsvector('english', full_text));

-- Phrase scoring output (nightly job result)
CREATE TABLE IF NOT EXISTS library.phrase_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,
  ngram_size INT NOT NULL,
  window TEXT CHECK (window IN ('full', 'hook', 'body')) DEFAULT 'full',
  brand TEXT,                              -- nullable = library-wide
  variants_count INT NOT NULL,
  total_spend NUMERIC(12, 2) NOT NULL,
  mean_perf_score REAL NOT NULL,
  delta_vs_library REAL NOT NULL,
  min_close_rate REAL,
  max_close_rate REAL,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (phrase, window, brand, ngram_size, computed_at)
);

CREATE INDEX idx_phrase_perf_lookup ON library.phrase_performance(window, brand, ngram_size, mean_perf_score DESC);

NOTIFY pgrst, 'reload schema';
```

Plus a public-schema view `lib_creative_transcripts` and `lib_phrase_performance`
mirroring the convention from migration 027 so the frontend can read them.

---

## 2 · Function 2 — Live Ad Gallery + Analyst Agent

### 2.1 · Mental model

The gallery is **Meta's public Ads Library, but for our own running ads,
with our actual performance data overlaid.** Today on Meta's site you can
search any advertiser and see all their active creatives. We get the same
visual surface for ourselves, plus our internal stats, plus close-loop
attribution that Meta's surface doesn't show.

The agent is **an analyst sitting next to that gallery** that can answer the
question every operator asks five times a day: *"What's actually working
right now, and which of these should we kill?"*

### 2.2 · Surface — `/sales/ads/gallery`

A second new tab (alongside Messaging from Function 1, and the existing
five). Layout:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [filter chips: Status · Brand · Spend tier · KPI · Date · Search ──]    │
├─────────────────────────────────────────┬────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  📊 Analyst                    │
│ │ [video]  │ │ [video]  │ │ [video]  │ │                                │
│ │ ▶ hover  │ │ ▶ hover  │ │ ▶ hover  │ │  Quick prompts:                │
│ │ STATS    │ │ STATS    │ │ STATS    │ │  • Which ads are in KPI?       │
│ │ pill row │ │ pill row │ │ pill row │ │  • Top hook this week          │
│ │ V-id     │ │ V-id     │ │ V-id     │ │  • Why is V123 winning?        │
│ └──────────┘ └──────────┘ └──────────┘ │  • Compare top 3 vs bottom 3   │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  • Suggest next test wave      │
│ │   ...    │ │   ...    │ │   ...    │ │                                │
│ └──────────┘ └──────────┘ └──────────┘ │  ┌──────────────────────────┐  │
│                                         │  │ Open chat...             │  │
│                                         │  └──────────────────────────┘  │
└─────────────────────────────────────────┴────────────────────────────────┘
```

The gallery occupies ~70% of the viewport width on desktop, the agent panel
~30%. On mobile the agent panel collapses into a floating button that opens
the same surface as a sheet.

### 2.3 · Card anatomy

Each card is one ad (one row of `public.ads`):

```
┌────────────────────────────────────┐
│                                    │
│  [video thumbnail / poster]        │ ◄── autoplay muted on hover, loops
│  ┌──────────┐                      │     pause on mouse-out, full audio
│  │ ▶ 0:18   │                      │     on click into detail
│  └──────────┘                      │
│                                    │
├────────────────────────────────────┤
│  H4.2_BA-PROOF_S-OFFICE_OSO_v1     │ ◄── variant pill (clickable)
│  ── ── ── ── ── ── ──              │     RemodelingAI ad set
├────────────────────────────────────┤
│  $1,420 spend · 32 leads           │ ◄── headline stats row
│  4 booked · 2 closed · $11.4k rev  │
│  CPL $44 · CPA $355 · ROAS 3.2x    │
├────────────────────────────────────┤
│  [pill: WINNING] [pill: 7 days]    │ ◄── status chips
└────────────────────────────────────┘
```

#### Card states (visual)
- **Winning** → thin accent yellow left-border + `.pill-up`
- **Foundational** → ink left-border + `pill-ink`
- **Bench** → muted, paper-2 background, soft caption "no reach yet"
- **Bad pocket** → down-red left-border + `pill-down` + tooltip explaining
  "favorable CPA but lead quality flagged by sales team"
- **Fatigued** → dashed border + `pill-flat`
- **Concept / In production** → dashed paper-2 placeholder card with
  "Awaiting launch" eyebrow

States are derived nightly from the variant-state machine in
`jeremy-haynes-andromeda.md` §"Missing variant states" — a Postgres function
that reads recent perf + sales-team feedback and updates `library.variants.status`.

### 2.4 · Filter bar

| Filter | Options |
|---|---|
| Status | Running · Paused · Spent · All |
| State (the editorial one) | Winning · Foundational · Bench · Bad pocket · Fatigued · Concept |
| Brand | RemodelingAI · RestorationConnect · PlumberConnect · PoolConnect · OPT Direct · All |
| Spend tier | <$100 · $100-$1k · $1k-$10k · $10k+ |
| KPI status | In KPI · Marginal · Out of KPI · Untested |
| Date range | Standard `DateRangeSelector` reused |
| Search | Free-text against variant_id, ad_name, transcript content |
| Sort | Spend ↓ · CTR ↓ · CPA ↑ · Closes ↓ · Most recent · Most fatigued |

URL search params persist filters for shareable links — e.g. send the team
*"have a look at this filter set"* via Slack.

#### "In KPI" definition
Configurable per brand in Settings (Phase 3). Default v1 thresholds:

| Metric | In KPI | Marginal |
|---|---|---|
| Cost per booked call | < $200 | $200-$300 |
| Cost per closed deal | < $2,500 | $2,500-$4,000 |
| Lead quality % | > 60% closer-approved | 40-60% |

A variant must clear **all three** to be "In KPI." Marginal on any one drops
it to Marginal; failing any one is "Out of KPI."

### 2.5 · The agent

Lives in the right-hand panel. Powered by Anthropic's Claude API (already
the convention — see [`src/services/transcriptChat.js`](src/services/transcriptChat.js)
and `SalesChatWidget.jsx` for the existing pattern).

#### Quick-prompts (one-click)
Hard-coded prompt templates that pre-fill the chat input. Each runs a
deterministic data fetch first, then sends the result + the prompt to
Claude with a system prompt scoped to ad analysis.

| Prompt | Pre-fetch | Output |
|---|---|---|
| Which ads are in KPI for booked calls? | Variants with KPI status = "In KPI", sorted by booked-call volume | Ranked list with one-line rationale per row |
| Best-performing hook this week | Top phrases from `lib_phrase_performance` window=hook, last 7d | Top 5 hooks + the variants using each |
| Why is variant {X} winning? | Variant X's stats + transcript + comparable variants in same brand | 3-paragraph diagnosis: hook signal, body signal, audience pocket signal |
| Compare top 3 vs bottom 3 | Top + bottom variants by perf_score, last 14d | Side-by-side table + 3-bullet pattern summary |
| Suggest next test wave | Top-performing phrase clusters + the audience pockets they're hitting + Daniel's recent transcripts (excluding team meeting + Constantine) | 25-30 concept variants pre-filled with hook/body/scene/creator picks |
| What's fatiguing? | Variants where CPA is climbing >20% over 7d trailing avg | List with fatigue trajectory + suggested replacements |
| Why are these leads disqualifying? | Bad-pocket variants + their transcripts + sample of bad-fit lead names from setter_leads | Pocket-audience analysis + suggested phrase fixes |

#### Open chat
Free-form Q&A. The system prompt grounds the agent in:
- Today's date + active brands
- The `public.ads` + `library.variants` + `library.creative_transcripts` +
  `library.phrase_performance` views (passed as JSON context per query, not
  pre-loaded — RAG-style)
- The Andromeda playbook (truncated key points pasted as system context)
- OPT's KPI thresholds

The agent has **read-only data access** in v1 — it can analyse but not
modify ads. Phase 3 adds tool-use: the agent can pause / kill / duplicate
ads on Ben's confirmation.

#### Agent UX rules
- Streams tokens (existing pattern in `transcriptChat.js`).
- Cites variant IDs as clickable links → opens the gallery filtered to that
  variant.
- Caches expensive analyses with a 5-min TTL keyed on (prompt, filter state)
  so re-asking doesn't re-burn tokens.
- Surfaces token spend in a tiny mono caption at the bottom of the panel —
  Ben said "no swallowing errors", so cost is also visible.

#### Cost budget
| Item | Estimate |
|---|---|
| Quick prompt | ~3-5k tokens in / 1-2k tokens out → $0.04-$0.08 per call |
| Open chat session (5 turns) | ~$0.20-$0.40 |
| Auto-generated `.what-it-means` interpretations (nightly) | ~$0.30/night |
| **Run-rate at 50 prompts/day** | **~$3-5/day, $90-150/month** |

Throttle if you want — but at this volume, latency matters more than cost.

### 2.6 · Ad detail page (`/sales/ads/:meta_ad_id`)

Click any card → full detail page. Already scaffolded in `src/pages/ads/AdDetail.jsx`.
Sections:

1. **Hero** — eyebrow "OPT Sales · Creative library · Ad detail" + serif
   variant name + status pill + brand chip.
2. **Player** — full-width video, native HTML5 player, captions toggleable.
3. **At-a-glance scorecard** — `.simple-scorecard` 3-cell with Spend ·
   Booked calls · Closed revenue. `.what-it-means` callout below
   (auto-generated).
4. **Components** — 4-card row showing the variant's hook / body / scene /
   creator components, each clickable to that component's detail page.
5. **Transcript pane** — full transcript with timestamps. Hover a phrase →
   shows that phrase's library-wide perf score + how this ad compares to
   library average for ads using that phrase. Click → drills into the
   Messaging tab filtered to that phrase.
6. **Performance timeline** — Daily spend / CTR / CPA / booked-calls chart
   from `library.performance_daily`, editorial-rebuilt recharts (single
   accent line, mono axes, "What this means" caption).
7. **Lead-quality breakdown** — small table: leads attributed → showed →
   closed → bad-fit. Powered by `setter_leads` join via `utm_content`.
8. **Linked Meta ads** — every `public.ads` row sharing this variant_id
   (relaunch history).
9. **Notes** — free-text edit field, `library.variants.notes`.

### 2.7 · Live data refresh

Two cadences:

- **Hourly** (existing autoSync) — `metaAdsSync.js` pulls latest stats into
  `public.ad_daily_stats`. Triggers in migration 012 mirror to
  `library.performance_daily`. Variant status function recomputes.
- **Nightly** (new cron) — phrase scoring job (Function 1) + agent's
  auto-generated "what this means" interpretations + materialized view
  refresh.

Manual refresh button on the gallery: forces an immediate Meta sync + view
refresh. Per Ben's memory, this is the explicit "Refresh now" override —
**not** the primary path. Day-one autoSync, never manual-only.

### 2.8 · Error surfacing

Per Ben's "surface errors, never swallow" memory: every step in the pipeline
has a visible failure state.

- **Caption fetch fails** → variant card shows a red `pill-down` "transcript
  pending" + the actual error in a tooltip.
- **Phrase scoring job fails** → visible banner in the Messaging tab.
- **Agent API errors** → red message in the chat panel with raw error text +
  retry button.
- **Sync failure** → existing `SyncStatusIndicator` already covers this.

---

## 3 · How the two functions interlock

The functions are independently shippable but the win comes from their
combination:

```
                  ┌────────────────────────────┐
                  │   Live Ad Gallery (F2)     │
                  │  - browsable card grid     │
                  │  - filters + KPI states    │
                  └─────────────┬──────────────┘
                                │ click into ad detail
                                ▼
                  ┌────────────────────────────┐
                  │   Ad Detail Page           │
                  │  - video + transcript      │
                  │  - phrase hover-stats ◄────┼─── from F1: phrase_performance
                  │  - perf timeline           │
                  └─────────────┬──────────────┘
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │   Analyst Agent (F2)                │
              │   asks "why is this winning?"       │
              │   ↳ pulls F1 phrase data            │
              │   ↳ pulls Daniel's 159 transcripts  │
              │   ↳ pulls perf + lead quality       │
              │   answers in plain English          │
              └─────────────────────────────────────┘
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │   Suggest next test wave            │
              │   (agent quick-prompt)              │
              │   ↳ outputs 25-30 concept variants  │
              │   ↳ pre-filled into library         │
              │   ↳ matches Andromeda playbook      │
              └─────────────────────────────────────┘
```

**End-to-end loop:** Gallery shows what's running → ad detail shows why a
specific one is winning (transcript-grounded) → agent generalises across the
library → agent suggests the next test wave, drawing on Function 1's phrase
scoring + Daniel's prospect call transcripts. That's a creative engine, not
a dashboard.

---

## 4 · Phasing

Stacks on top of the existing v2 plan's Phase 1.5 (5-tab shell) which is
already shipped at the UI level.

### Phase A — Transcript ingestion (1 day)
1. Migration 014 (creative_transcripts table + indexes).
2. `src/services/adTranscriptIngest.js` — Meta caption fetch + Whisper
   fallback, idempotent upsert into `library.creative_transcripts`.
3. Run on every existing + future `public.ads` row via the existing
   autoSync rhythm.

**Ships:** every ad has a transcript. No UI yet.

### Phase B — Phrase scoring (1 day)
1. Postgres function `library.compute_phrase_performance()` — n-gram
   extraction + composite scoring + min-sample filter.
2. Schedule nightly via Supabase pg_cron (or Render cron).
3. View `lib_phrase_performance` exposed to PostgREST.

**Ships:** phrase data is live. No UI yet.

### Phase C — Messaging tab UI (1-2 days)
1. New route `/sales/ads/messaging` + `<AdsMessaging>` page.
2. Three sections: top phrases · bottom phrases · phrase clusters (deferred).
3. Editorial table (mono headers, ink underline, hairlines).
4. `.what-it-means` block at bottom, populated by agent (Phase F).

**Ships:** Function 1 is operator-usable.

### Phase D — Live gallery UI (1-2 days)
1. New route `/sales/ads/gallery` + `<AdsGallery>` page.
2. `<AdCard>` component with hover-autoplay video, stats overlay, state pills.
3. Filter bar with URL persistence.
4. Skeleton loading states matching the Andromeda variant-state colour
   scheme.

**Ships:** the Meta-Ads-Library-style internal surface.

### Phase E — Variant state machine (1 day)
1. Postgres function `library.update_variant_states()` — derives
   winning/foundational/bench/bad_pocket/fatigued/concept from recent perf
   + sales-team feedback.
2. Adds the missing states from the Andromeda playbook to
   `library.variants.status` enum.
3. Runs hourly after autoSync.

**Ships:** the gallery's state pills are accurate, and the testing→scaling
loop in the Andromeda playbook is observable.

### Phase F — Analyst agent (2 days)
1. Edge function or Vercel/Render endpoint for the agent — accepts
   prompt + filter state, fetches grounded data, calls Anthropic, streams
   response.
2. `<AdAnalystPanel>` component — quick-prompts + open chat.
3. Quick-prompt deterministic data fetchers (one per template).
4. Auto-generation of `.what-it-means` callouts (nightly), stored in
   `library.interpretations` table.

**Ships:** the analyst sits next to the gallery and on every page that has
a `.what-it-means` slot.

### Phase G — Phrase-aware ad detail (1 day)
1. Extend existing `AdDetail.jsx` with the transcript pane.
2. Hover a phrase → tooltip showing library-wide perf for that phrase +
   delta vs library mean.
3. Click → drills into Messaging tab filtered to that phrase.

**Ships:** the inline interlock between F1 and F2 — read a transcript and
see what's winning at the language level without leaving the page.

### Phase H — Embedding-based phrase clusters (1 day, deferred)
1. Embed every transcript phrase via OpenAI ada-002 / Anthropic embedding.
2. K-means cluster per dimension, surface clusters as themes in §03 of
   the Messaging tab.
3. Cluster-level perf rollup.

**Ships:** semantic insight, not just literal n-grams.

### Phase I — Agent tool-use (1 day, deferred)
1. Allow the agent to pause / kill / duplicate ads via Meta API on Ben's
   explicit confirmation step.
2. Audit log table `library.agent_actions`.

**Ships:** the agent moves from analyst to operator.

**Total estimate: 8-10 working days end-to-end**, A→G is the MVP at ~6-8 days.

---

## 5 · Open questions

1. **Whisper fallback hosting.** OpenAI API ($) vs local Whisper (free, but
   ties up Ben's box). Recommendation: API for production.

2. **Caption confidence threshold.** At what confidence do we discard Meta
   captions and fall back to Whisper? Default proposal: <0.7 → fall back.

3. **Phrase min-sample threshold.** 3 variants + $250 spend — too tight or
   too loose? Configurable, but what's the default that doesn't hide
   genuine signal?

4. **KPI thresholds — per brand or global?** Different brands have wildly
   different unit economics. Default proposal: per-brand thresholds in a
   `library.brand_kpis` table, configurable from Settings.

5. **Agent system prompt location.** Inline in the codebase (versioned)
   vs Supabase config (editable from dashboard). Recommendation: inline,
   versioned — operator changes go through PR review.

6. **Lead quality signal source.** Closer-marked good-fit % comes from where
   today? `closer_calls.outcome`? `setter_leads.status`? Some pages already
   compute this — need to canonicalise the source-of-truth column before
   the perf_score formula calls it.

7. **Mobile UX.** The gallery is desktop-first (3-column card grid with
   right-rail agent). On phone: agent becomes a sheet, gallery becomes a
   single column. Card video autoplay-on-hover doesn't translate to touch —
   tap-to-expand instead.

8. **Caption/transcript ownership for AI-generated ads.** When a creative
   comes from FORGE (OPT's video AI engine), we may already have the
   script_text in source form — no need to transcribe. Should the schema
   support a `script_text` source path that bypasses caption/Whisper?

---

## 6 · Files to create / modify

### Create (new pages)
- `src/pages/ads/AdsMessaging.jsx`
- `src/pages/ads/AdsGallery.jsx`

### Create (new components)
- `src/components/ads/AdCard.jsx` — gallery card with hover-autoplay
- `src/components/ads/PhraseTable.jsx` — sortable n-gram table
- `src/components/ads/AdAnalystPanel.jsx` — agent chat + quick-prompts
- `src/components/ads/TranscriptPane.jsx` — timestamped transcript with hover-stats
- `src/components/ads/StatePill.jsx` — variant-state visual chip
- `src/components/ads/KPIBadge.jsx` — In KPI / Marginal / Out of KPI badge

### Create (services)
- `src/services/adTranscriptIngest.js` — caption fetch + Whisper fallback
- `src/services/phraseScoring.js` — composite perf_score helpers (frontend-side guard)
- `src/services/adAnalyst.js` — agent endpoint client + quick-prompt definitions

### Create (DB)
- `migrations/014_creative_transcripts.sql`
- `migrations/015_phrase_performance.sql`
- `migrations/016_variant_states.sql`
- `migrations/017_agent_interpretations.sql`

### Modify
- `src/pages/ads/AdsLayout.jsx` — add Messaging + Gallery to primary tabs
- `src/pages/ads/AdDetail.jsx` — add transcript pane, phrase hover-stats,
  perf timeline (recharts editorial)
- `src/services/metaAdsSync.js` — call `adTranscriptIngest` after each sync
- `src/App.jsx` — register new routes

---

## 7 · ELI5

Right now the ad library is an empty filing cabinet — drawers labelled
Hooks, Bodies, Scenes, Creators, but nothing inside, no way to read what's
working, no way to read why.

These two functions fix that.

**Function 1 — Messaging Isolation.** Every video ad gets transcribed
automatically. Then we score every phrase by the performance of the ads it
appeared in — weighted by spend, biased toward closes (not just clicks),
and counter-weighted against bad-pocket leads (favorable CPA on wrong-fit
prospects). Output: a ranked list of *"these phrasings win, these phrasings
stall."* You'll know that "show you exactly how" outperforms "stop doing X"
by 22%, you'll know what closers should listen for, and you'll have an
actual style guide for the next shoot.

**Function 2 — Live Gallery + Analyst.** Imagine Meta's public Ads Library,
but for our own ads, with our actual stats overlaid. Every running ad shows
up as a card with autoplay video, spend, leads, booked calls, closes, and a
state pill (winning / bench / fatigued / bad-pocket). Filter by brand, KPI
status, spend tier, date range. Click any card → full detail with the
transcript, performance timeline, and lead-quality breakdown. Sitting next
to the gallery is an analyst agent — pre-baked questions like *"Which ads
are in KPI for booked calls?"* or *"Why is variant H4.2 winning?"* — plus
open chat. The agent grounds its answers in the actual data, cites variant
IDs as clickable links, and can be asked to *suggest the next 25-30 test
variants* drawing on both the phrase library and Daniel's 159 prospect
calls.

**End state:** Ben opens the Sales Dashboard, clicks Ads, sees a wall of
videos with the winners stamped accent yellow and the losers muted. Asks
the analyst *"what should I run next?"* — gets back 25-30 concept variants
grounded in real prospect language and real ad performance, ready for the
filming queue.

That's the creative engine. It runs forever, gets sharper every day, and
plugs into the team's hiring pace via the 10-30%/day scaling rule from the
Andromeda playbook so we never out-spend our closer capacity.

**Total build: 6-8 working days for the MVP (Phases A through G).**
**Run-rate cost: ~$100-150/month all-in (Whisper + agent).**
