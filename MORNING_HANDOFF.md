# Morning Handoff · 2026-06-02 (Elite Tier)

## TL;DR

Built last night's plan + the strategist-in-the-loop architecture you asked for. Three additions are live:

1. **Content factory** with SERP-informed briefs + adversarial editor QA + strategist gate
2. **AI search visibility tracker** across ChatGPT + Perplexity + Gemini + Google AI Overviews
3. **GBP health check + citation NAP sync** with positive→wins / negative→strategist routing

Plus the spine that makes all of this elite vs typical:

4. **Strategist queue** at `/hq/strategy` — every AI output routes here before anything client-facing publishes. Mersad approves/amends/rejects. Nothing auto-published when there's any negative signal.

5. **Controlled narrative engine** — weekly recaps with rank drops or weak metrics are held for strategist review with paired "here's what we're doing about it" framing. Client never sees uncurated bad news.

6. **90-day roadmap generator** — produces two flavors per client: internal_full (with weak spots, risks, decisions required) and client_visible (confident narrative, dollar-specific targets, named competitor positioning). Strategist approves before client sees.

7. **Competitor watchdog** — weekly SERP intersection per client. Threats score ≥70 → strategist alert + recommended response.

---

## The spine: strategist queue

Every AI output now routes through one table: `strategist_queue`. Kinds tracked:

| Kind | Source | What strategist does |
|---|---|---|
| `content_brief` | brief generator | approve to assign / amend outline / reject |
| `content_draft` | editor QA | approve to publish / amend body / reject |
| `gbp_post` | (future) | approve / amend copy / reject |
| `citation_target` | NAP sync | approve correction submission / reject |
| `weekly_recap_curation` | evidence reel | approve client publish / amend narrative / hold |
| `ai_visibility_report` | AI visibility probe | approve client message / amend framing / hide |
| `roadmap_update` | roadmap gen | approve client share / amend pillars / reject |
| `competitor_brief` | watchdog | approve internal action / reject |
| `health_check_followup` | GBP health | approve auto-fix / amend / reject |

**Mersad's morning ritual**: open `hq.rankonmaps.io/strategy` → review pending queue sorted by priority + urgency → click approve / amend (edit JSON inline) / reject → downstream publishing fires automatically. Items unattended for 48h escalate to you.

The whole stack still operates if Mersad is offline — items just queue up. Nothing auto-publishes that needs his sign-off. This kills "AI on autopilot" concern architecturally.

---

## What I built (file index)

```
~/rankonmaps-app/
├── supabase/migrations/
│   ├── 104_strategist_queue_and_elite_layer.sql        # 9 new tables + view
│   └── 105_elite_cron_schedules.sql                    # 5 new crons
└── supabase/functions/
    ├── _shared/strategist-queue.ts                     # enqueue + notify helpers
    ├── content-brief-generator/                        # SERP-informed brief → queue
    ├── content-editor-qa/                              # E-E-A-T + fabrication + AI-slop QA
    ├── ai-visibility-probe/                            # ChatGPT/Perplexity/Gemini/AIO weekly
    ├── gbp-health-check/                               # daily 0-100 score
    ├── citation-nap-sync/                              # BrightLocal every 14d
    ├── roadmap-generator/                              # 90d roadmap, dual-flavor
    ├── roadmap-refresh-batch/                          # monthly cron entry
    ├── competitor-watchdog/                            # weekly threat scoring
    ├── strategist-action/                              # approve/amend/reject worker
    └── evidence-reel-friday/ (updated)                 # narrative-gated publish
└── src/pages/HQStrategy.jsx                            # /hq/strategy queue page
```

---

## How content actually flows now

```
strategist (or you) → POST /content-brief-generator { client_id, target_keyword }
                ↓
   live SERP pull via DataForSEO + keyword data
                ↓
   Anthropic generates outline grounded in actual top 10 + missing angles
                ↓
   content_briefs row (status=awaiting_strategist) + strategist_queue
                ↓
   Mersad opens /hq/strategy → approves/amends outline
                ↓
   brief assigned to writer (manual for now — TBD assignment workflow)
                ↓
   writer submits draft → POST /content-editor-qa { brief_id, draft_body_md }
                ↓
   Anthropic critiques: brief adherence, E-E-A-T, voice, fabrication, AI slop, schema fit, word count
                ↓
   content_drafts row + strategist_queue (if approve/revise>=70)
                ↓
   Mersad reviews QA verdict + draft → approves to publish (or amends)
                ↓
   brief.status = approved → publish + GSC submit + indexation tracker
                ↓
   ranking detection → emit content_indexed win → feed back to brief generator learning
```

This is elite because:
- briefs are grounded in REAL SERP data, not generic templates
- writers get a brief so detailed even mid-tier execution ranks
- strategist sees full data + can amend before content goes out
- adversarial QA blocks AI slop and fabricated specifics
- nothing reaches a client URL without Mersad's stamp

---

## What's running on cron (full list)

| Schedule (UTC) | Function | Purpose |
|---|---|---|
| `0 3 * * *` | `rank-tracking-cron` | Nightly DataForSEO ranks + win emit |
| `0 5 * * *` | `gsc-ga4-sync` | Daily GSC + GA4 pull |
| `0 12 * * *` | `touchpoint-compliance` | Daily compliance sweep |
| `0 13 * * *` | `gbp-health-check` | Daily GBP audit |
| `0 14 * * 5` | `evidence-reel-friday` | Weekly client recap (narrative-gated) |
| `0 6 * * 1` | `ai-visibility-probe` | Weekly AI search visibility scan |
| `0 6 * * 2` | `competitor-watchdog` | Weekly competitor SERP scan |
| `0 7 1,15 * *` | `citation-nap-sync` | Every 14 days NAP audit |
| `0 8 1 * *` | `roadmap-refresh-monthly` | Monthly 90d roadmap regen |

Watch them: `select * from cron.job_run_details order by start_time desc limit 30;`

---

## The $10K-feel client experience (architecturally)

Per your brief, the client should feel like they're paying $10K for $2.5–18K service. The stack now delivers this through:

1. **Proactive receipts** — every win fires to their shared Slack channel (rank up, lead in, review earned, content indexed, milestone hit). They see motion without asking.

2. **Curated weekly narrative** — Friday recap that ONLY shows positives or positives-paired-with-active-response. Mersad signs off on anything with weak deltas.

3. **90-day roadmap with vision** — monthly auto-refreshed. Vision paragraph + 3 pillars + named competitor positioning + measurable targets. Sounds like a strategist sat down with their account for hours.

4. **AI search visibility report** — nobody else in local SEO is showing clients "you're cited in ChatGPT 3 of 5 times this week, here's what we're doing to get the other 2". This is the moat.

5. **Strategist queue invisibility** — clients never see the queue. They never see weak data. They see curated wins + narrative roadmap + proactive recaps.

6. **HUGO auto-acks (when listener wired)** — clients DM their shared channel, get a sage-toned ack within seconds even at 11pm.

7. **GBP managed without them noticing** — health check runs daily, fixes get queued to Mersad, client only sees the new reviews + posts shipping.

8. **Content that actually ranks** — brief→draft→QA→strategist→publish→indexation→ranking. Each piece is built to win its keyword, not to fill a calendar.

---

## Strategist concerns addressed

> "I want to have input in terms of where the strategy is going."

→ `strategist_queue` makes Mersad the gatekeeper. He sees every proposal, amends inline, rejects if off-strategy.

> "Quality of AI content vs elite SEO."

→ Two-stage gate: editor-qa scores 0-100 across brief adherence + E-E-A-T + voice + fabrication + AI-slop detection. Score <60 = reject. Score 60-84 = revise. Score ≥85 = strategist final approval. AI never publishes content directly.

> "Roadmap visibility for clients + how we compete."

→ `roadmap-generator` produces named-competitor positioning + dollar/lead/rank targets every 30 days. Auto-refreshed. Strategist approves before client sees.

> "Strategist sees weak spots, client doesn't."

→ `internal_full_payload` (strategist-only) vs `client_visible_summary` (curated narrative) split on every roadmap. Weekly recap auto-suppresses negatives unless strategist explicitly includes.

---

## Action items for you today

### 1. Set up additional API keys (5 min each)

```bash
# For AI visibility probe to hit ChatGPT + Gemini directly (Perplexity falls back to DFS AIO if missing)
supabase secrets set --project-ref nktbnavvehmdqdlpnusu \
  OPENAI_API_KEY=<your_key> \
  PERPLEXITY_API_KEY=<your_key> \
  GEMINI_API_KEY=<your_key>

# For citation NAP sync
supabase secrets set --project-ref nktbnavvehmdqdlpnusu \
  BRIGHTLOCAL_API_KEY=<your_key>
```

Without these:
- AI visibility falls back to Google AI Overview only (still useful, via DataForSEO)
- Citation sync no-ops (returns empty results)

### 2. Map clients to GBP locations

In each `clients.client_json`, add:
```json
{
  "gbp_account_id": "1234567890",
  "gbp_location_name": "locations/12345678901234567890"
}
```
Without this, GBP health check skips them.

### 3. Map clients to BrightLocal

```json
{
  "brightlocal_location_id": "..."
}
```

### 4. Seed tracked competitors per client (optional — falls back to DFS auto-detection)

In `clients.client_json`:
```json
{
  "competitors": [
    {"domain": "competitorA.com"},
    {"domain": "competitorB.com"}
  ]
}
```

### 5. Trigger first roadmap for each client

```bash
curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/roadmap-generator" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<uuid>", "force": true}'
```

Then open `hq.rankonmaps.io/strategy`, Mersad reviews + approves, client sees it.

### 6. Generate first content briefs

```bash
curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/content-brief-generator" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<uuid>", "target_keyword":"roofers union mo"}'
```

---

## What's NOT yet built (next session candidates)

- **Writer assignment + draft submission UI** (currently API-only)
- **Roadmap PDF export** (rendered client-visible version)
- **Client-portal roadmap view** at results.rankonmaps.io
- **Bulk brief generator** (one-shot generate 12 briefs from competitor gap analysis)
- **GBP post auto-drafter** (proposes posts, queues to strategist)
- **Indexation tracker** (verify published content gets indexed via Google Indexing API)
- **Case study auto-generator** when client crosses milestones
- **Strategist queue Slack actions** (approve/reject directly from notification)

---

## Verify the stack

```bash
# Open the strategy queue
open https://hq.rankonmaps.io/hq/strategy

# Confirm all 17 edge functions deployed
supabase functions list --project-ref nktbnavvehmdqdlpnusu

# See cron jobs registered
supabase db query "select jobname, schedule, active from cron.job order by jobname" --linked

# See the strategist morning queue
supabase db query "select * from strategist_morning_queue limit 10" --linked

# Trigger a test brief for the demo client
curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/content-brief-generator" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"2ceb170d-fd99-4b9d-8f85-db500a86cd8e", "target_keyword":"austin roofing contractors"}'
```

---

## Live URLs

- **HQ Strategy queue**: https://hq.rankonmaps.io/hq/strategy
- **HQ Wins feed**: https://hq.rankonmaps.io/hq/wins
- **HQ Dashboard**: https://hq.rankonmaps.io
- **Thanks**: https://thanks.rankonmaps.io
- **Supabase Functions**: https://supabase.com/dashboard/project/nktbnavvehmdqdlpnusu/functions
- **Slack #client-wins**: see live wins flow

— assistant
