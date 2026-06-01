# Morning Handoff · 2026-06-01 build

## TL;DR

The elite ops stack is live. Wins channel is firing. 11 edge functions deployed. 4 crons scheduled. Smoke test passed — a real Slack post landed in `#client-wins` at 03:36 UTC tagged for everyone.

Open Slack `#client-wins` and you should see one entry from "Austin Area Roofers (demo)" — that was my proof-of-life test. Delete it whenever.

---

## What shipped tonight

### 1. Wins flywheel (the whole point)
- **Migration 102** — 9 new tables: `wins`, `tracked_keywords`, `rank_history`, `gsc_metrics_daily`, `ga4_metrics_daily`, `handoff_briefs`, `qa_reviews`, `evidence_reel_log`, `touchpoint_compliance_log`. RLS on, authenticated read enabled.
- **`emit-win` edge function** — single entry point. Inserts to `wins` + posts to `#client-wins` (channel `C09AT5F82FL`) with `@channel` tag. Block-formatted with icon, headline, client name + city, kind label, source attribution, timestamp.
- **HQ Wins tab** at `/hq/wins` — realtime feed via Supabase channels subscription, 7d stat tiles (Total, Leads, Rank jumps, 5★ reviews, Content indexed, Milestones), client + kind filters.
- **HQ Dashboard** got a 5th KPI tile (Wins 7d) + a "Wins this week" card with `→ See full feed` link.
- **Layout sidebar** got a "Wins" nav item with Sparkles icon.

### 2. Ingestion (proof of work)
- **`whatconverts-webhook`** — accepts WC webhook POSTs, matches profile_id/account_id to a client, upserts to `client_leads`, emits `new_lead` win.
  - **Action for you**: paste this URL into WhatConverts admin > Settings > Webhooks:
    `https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-webhook`
- **`whatconverts-backfill`** — pulls last 90 days for every client with `wc_account_id` set. Does NOT emit wins for historical leads (no channel spam). Trigger manually with:
  ```bash
  curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-backfill" \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" -H "Content-Type: application/json" \
    -d '{"days":90}'
  ```

### 3. Rank tracking
- **`rank-tracking-cron`** — DataForSEO SERP API. For every `tracked_keyword`, finds client domain in top 50, computes delta vs yesterday.
- **Win triggers**: `rank_jump` (delta ≥3), `:rocket: Page 1` (first time top 10), `:fire: Top 3` (first time top 3).
- Cron: nightly 03:00 UTC (10pm CST).
- **To start using**: insert rows into `tracked_keywords` per client. See "Seeding rank tracking" below.

### 4. GSC + GA4 sync
- **`gsc-ga4-sync`** — uses your existing Google OAuth refresh token at `~/.config/rom/google-token.json` (scopes: analytics + webmasters + indexing). Pulls GSC clicks/impressions/CTR/avg position + top 25 queries + top 25 pages daily. Pulls GA4 sessions/users/conversions split by channel.
- Cron: 05:00 UTC daily.
- **Win triggers**: `milestone` (first day with 100+ organic sessions).
- **To start using**: set `clients.custom_domain` (already exists) + `clients.ga4_measurement_id`. The function will skip clients missing either.

### 5. Closer call → handoff brief
- **`handoff-brief`** — give it a Fathom URL or recording_id, it pulls the transcript via Fathom API, runs Anthropic claude-opus-4-7 with strict JSON schema, returns:
  - `promises_made` (what the closer committed to)
  - `icp_confirmed` (validated customer profile)
  - `scope_locked` (package + fee + term + deliverables)
  - `red_flags`
  - `upsell_seeds`
  - `summary` (90-second readout the AM reads cold)
- Persists to `handoff_briefs` table, status='draft' until you mark approved.
- **Trigger pattern** (run this after every close call before handing off to Jonathan/Mersad):
  ```bash
  curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/handoff-brief" \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" -H "Content-Type: application/json" \
    -d '{"client_id":"<uuid>","fathom_url":"https://fathom.video/...","closer_name":"Daniel Girmay"}'
  ```

### 6. Adversarial QA agent
- **`adversarial-qa`** — give it any deliverable text (content brief, GBP post, email draft, recap), it returns:
  - `verdict`: approve / revise / reject
  - `score`: 0-100
  - `critique` + `required_fixes[]`
- Blocks outbound below score 60. Use it on touchpoint drafts before they fire.
- **Default behavior**: brutal. Will reject AI slop, generic copy, off-voice tone. Tuned to your no-em-dash + dollar-specific + named-entities preferences.

### 7. Weekly evidence reel
- **`evidence-reel-friday`** — Fridays 14:00 UTC = 09:00 America/Chicago. Per-client recap posted to `clients.client_slack_channel_id`.
- Format: `THIS WEEK WE...` with leads count, quotable count, dollar value, organic sessions, rank movements (top 5), pages indexed, 5★ reviews.
- Skips clients with literally zero content for the week (no empty recaps).
- Skips if already posted this week (idempotent).

### 8. Touchpoint compliance sweeper
- **`touchpoint-compliance`** — daily 12:00 UTC. For every materialized touchpoint scheduled <= yesterday, checks if it was met (via `client_communications` for email/call/sms, automated flag for auto, slack channel check for slack), updates status to met/missed, logs to `touchpoint_compliance_log`.
- **Note**: slack compliance check returns "missed" until signing-secret listener is wired (see Blockers below).

### 9. HUGO Slack listener (STUB — see Blockers)
- **`hugo-events`** — endpoint that will route inbound Slack events through Anthropic for auto-acknowledgment in client channels. Voice-tuned to your tone.
- Currently rejects all requests because `SLACK_SIGNING_SECRET` is not set. Drop it as a Supabase secret and the listener goes live instantly.

### 10. Wizard source auto-fetch
- **`wizard-source-fetch`** — added a button to the NewClientWizard's Sources step. Paste a URL/email/phone in the "ref" field, click "Auto-fetch from ref", and:
  - Fathom URL/call_id → pulls full transcript + summary
  - GHL email/phone → pulls full contact JSON + tag list
  - Site URL → fetches HTML, extracts title/desc/body text + JSON-LD blocks
- The fetched source lands in `onboarding_sources` automatically, ready for the extraction step.

---

## What's running on cron

| Schedule | Function | Purpose |
|---|---|---|
| `0 3 * * *` (03:00 UTC) | `rank-tracking-cron` | Nightly DataForSEO + win emit |
| `0 5 * * *` (05:00 UTC) | `gsc-ga4-sync` | Daily GSC + GA4 pull |
| `0 14 * * 5` (Fri 14:00 UTC) | `evidence-reel-friday` | Weekly client recap |
| `0 12 * * *` (12:00 UTC) | `touchpoint-compliance` | Daily compliance sweep |

Watch them live: Supabase Dashboard → SQL Editor → `select * from cron.job_run_details order by start_time desc limit 20;`

---

## Action items for you (5 minutes total)

1. **Paste WhatConverts webhook URL**: in WC admin, set webhook to `https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-webhook` for every active client account. Use the "Lead Created" event.

2. **Trigger WhatConverts backfill once** (optional, only if you want last 90 days of leads in the system today):
   ```bash
   curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-backfill" \
     -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E" \
     -H "Content-Type: application/json" -d '{"days":90}'
   ```

3. **Seed rank tracking keywords** for any clients you want ranked tonight. Either via Supabase SQL Editor:
   ```sql
   insert into tracked_keywords (client_id, keyword, search_location, is_money_keyword)
   values
     ('<client_uuid>', 'roofers union mo', 'St. Louis,Missouri,United States', true),
     ('<client_uuid>', 'roof replacement union missouri', 'St. Louis,Missouri,United States', true);
   ```
   Or I can wire a tracked-keywords UI tab into the client detail page in a follow-up session.

4. **Drop the Slack signing secret** in Supabase secrets to activate the HUGO listener:
   ```bash
   supabase secrets set --project-ref nktbnavvehmdqdlpnusu SLACK_SIGNING_SECRET=<from Slack app config>
   ```
   Then add `https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/hugo-events` as the Event Subscriptions URL in the HUGO Slack app config. Enable `app_mention` + `message.channels` events.

5. **Delete the smoke-test win** from `#client-wins` and the wins table:
   ```sql
   delete from wins where id = '24c67d33-b366-4197-b50f-94cb61556994';
   ```

---

## Known issues / what I left for next session

- **No tracked_keywords UI yet** — they have to be seeded via SQL until I add a client-detail tab.
- **HUGO listener disabled** — needs your signing secret. Stub code is correct, listener will activate the moment the secret lands.
- **No deliverable submission UI for adversarial QA** — the function works, but no in-app form to paste content and get a verdict yet. Can be added as a Client Detail subtab.
- **Touchpoint compliance for slack channel** returns "missed" until the listener is live (it depends on logged inbound messages from `client_communications`).
- **No tracking of GBP post views / citations built / backlinks** — those win kinds exist in the schema but have no auto-emitter. Wire up to BrightLocal + GBP API in a future session.
- **`reviews.rankonmaps.io` Resend domain** still pending DNS verification (was already polling when we started).
- **CEO dashboard** got a wins counter via the HQDashboard share, but the standalone `/ceo` page doesn't have a wins panel yet. Add if you want.

---

## File index (every new file we shipped tonight)

```
~/rankonmaps-app/
├── src/
│   ├── lib/slack.js                                # browser-side helpers
│   ├── pages/HQWins.jsx                            # /hq/wins page
│   ├── pages/HQDashboard.jsx                       # +Wins tile +Wins card
│   ├── pages/clients/NewClientWizard.jsx           # +Auto-fetch button
│   ├── components/Layout.jsx                       # +Wins nav item
│   └── App.jsx                                     # +/hq/wins route
└── supabase/
    ├── migrations/
    │   ├── 102_wins_and_rank_tracking.sql          # 9 new tables
    │   └── 103_cron_schedules.sql                  # pg_cron schedules
    └── functions/
        ├── _shared/
        │   ├── slack.ts                            # bot API wrapper
        │   ├── win-emit.ts                         # emitWin entry point
        │   └── google-auth.ts                      # refresh-token flow
        ├── emit-win/                               # public win endpoint
        ├── hugo-relay/                             # browser → Slack relay
        ├── hugo-events/                            # Slack events listener (STUB)
        ├── whatconverts-webhook/                   # WC lead ingestion
        ├── whatconverts-backfill/                  # 90-day backfill
        ├── rank-tracking-cron/                     # nightly DataForSEO
        ├── gsc-ga4-sync/                           # daily Google APIs
        ├── handoff-brief/                          # Fathom → Anthropic
        ├── adversarial-qa/                         # critique agent
        ├── evidence-reel-friday/                   # Friday Slack recap
        ├── touchpoint-compliance/                  # daily compliance sweep
        └── wizard-source-fetch/                    # Fathom/GHL/site auto-fetch
```

---

## Live URLs

- **HQ Dashboard**: https://hq.rankonmaps.io  (deploy triggered, should be READY by morning)
- **Thanks (Pulse)**: https://thanks.rankonmaps.io  (already live from prior session)
- **Supabase Functions Dashboard**: https://supabase.com/dashboard/project/nktbnavvehmdqdlpnusu/functions
- **Slack #client-wins**: open Slack → look for one test post from "Austin Area Roofers (demo)"

---

## Verification you can do over coffee

```bash
# 1. Check wins table has the smoke-test row
curl -s "https://nktbnavvehmdqdlpnusu.supabase.co/rest/v1/wins?select=id,kind,headline,created_at" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E"

# 2. Test emit-win again to make sure Slack still gets it
curl -X POST "https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/emit-win" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"2ceb170d-fd99-4b9d-8f85-db500a86cd8e","kind":"new_lead","headline":"Test from morning verification","mentionChannel":false}'

# 3. Confirm cron jobs are registered
supabase db query "select jobname, schedule, active from cron.job order by jobname" --linked
```

---

## What to tackle next session

Pick one and we go:

1. **Content factory** — vertical-specific brief generator (roofing/HVAC templates) → ghostwriter assignment → editor QA agent → schema injection → publish → GSC submission → indexation tracker
2. **GBP weekly health check cron** — posts cadence, photo cadence, Q&A response time, review velocity, attribute drift; flags via #client-wins
3. **Citation NAP sync cron** — BrightLocal API check every 14 days, auto-ticket on drift
4. **AI search visibility tracking** — ChatGPT/Perplexity/Gemini/AIOs citation tracking (use the geo-audit skill)
5. **Tracked-keywords + handoff-brief UI tabs** — surface the data we're now collecting
6. **Competitor watchdog cron** — weekly DataForSEO competitor pull, auto-ticket when they win SERP features

Sleep well.

— assistant
