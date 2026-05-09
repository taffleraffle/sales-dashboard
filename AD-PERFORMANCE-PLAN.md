# Ad Performance + Creative Library — Plan

> A standalone module inside the sales dashboard. Tracks every Meta ad currently running (and historically run), breaks each one down into its component parts (Hook · Body · Callout), and rolls performance up to both the ad and the component library so we can see which hooks / bodies / callouts are actually winning.

**Owner:** Ben · **Status:** Plan only — not built · **Drafted:** 2026-05-09

---

## 1 · Goal

Build one place inside the sales dashboard where the team can:

1. **See every ad running on Meta right now** with live spend, impressions, CTR, CPM, hook rate, hold rate, results, CPA — pulled from the Meta Ads API.
2. **Decompose each ad into its component parts** — Hook, Body, Callout — and store those components in a tagged library.
3. **Roll component-level performance up across every ad they appeared in** so we can answer "which hooks have the lowest CPA across the last 90 days?" without a spreadsheet.
4. **Attribute downstream funnel events** (lead → qualified booking → live call → close) back to the originating ad and component, using the existing `setter_leads` / `ghl_appointments` / `marketing_tracker` data.
5. **Upload new creatives** (file + metadata) into the component library so they're catalogued before they go live, and so newly-launched ads pick up component tags automatically when they sync from Meta.

---

## 2 · Mental model

```
Component Library (the building blocks)
  ├── Hooks           ── short opening attention grabbers (image / video / text)
  ├── Bodies          ── middle of the ad — value prop, demo, social proof
  └── Callouts        ── closing CTA (image / overlay / closing line)
                  ↓
              Each Meta ad references 1 hook + 1 body + 1 callout
                  ↓
Meta Ad (the assembled creative running on Meta)
  ├── meta_ad_id, name, campaign, adset, status
  ├── creative asset (image_url / video_url / thumbnail)
  ├── headline, primary_text, description, cta
  └── component_tags: [hook_id, body_id, callout_id]
                  ↓
              Daily insights pulled from Meta API
                  ↓
Performance (rolled up two ways)
  ├── Per-ad     ── spend, impressions, CTR, CPM, hook rate, hold rate, results, CPA
  └── Per-component ── same metrics aggregated across every ad that used that hook
```

---

## 3 · What exists today vs what's missing

| Capability | Today | New work |
|---|---|---|
| Meta API auth + credentials | ✓ in `.env` (`VITE_META_ADS_ACCESS_TOKEN`) | — |
| Adset-level daily spend sync | ✓ [src/services/metaAdsSync.js](src/services/metaAdsSync.js) → `marketing_daily` | — |
| Aggregated adspend on Marketing page | ✓ [src/hooks/useMarketingTracker.js](src/hooks/useMarketingTracker.js) | — |
| **Ad-level (per-creative) sync** | ✗ | NEW — different Meta endpoint, new table |
| **Creative asset metadata** (URL, copy, CTA) | ✗ | NEW — pulled from `/{ad_id}?fields=creative{...}` |
| **Component library** (Hooks / Bodies / Callouts) | ✗ | NEW — Supabase tables + UI |
| **Component tagging on ads** | ✗ | NEW — join table |
| **Component-level performance rollup** | ✗ | NEW — view + UI |
| **Funnel attribution per ad** | partial — `setter_leads.lead_source` exists but not joined to ad_id | NEW — UTM/`adset_id` capture into `setter_leads`, query layer |
| **Creative upload UI** | ✗ | NEW |
| **Standalone Ad Performance page** | ✗ — currently squeezed into Marketing page | NEW |

---

## 4 · Data model

Five new Supabase tables. All in `public`. RLS policies mirror existing patterns (authenticated read, service-role write for sync jobs).

### 4.1 · `creative_components`
The library. One row per Hook / Body / Callout.

```sql
create table creative_components (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('hook', 'body', 'callout')),
  name            text not null,                          -- short label, e.g. "Pattern interrupt — yelling owner"
  description     text,                                   -- longer notes
  asset_url       text,                                   -- image / video URL (Supabase storage)
  thumbnail_url   text,
  copy_text       text,                                   -- the spoken/written line
  duration_seconds numeric,                               -- video components only
  tags            text[] default '{}',                    -- e.g. ['urgency', 'pain', 'humor']
  created_by      uuid references auth.users(id),
  created_at      timestamptz default now(),
  archived_at     timestamptz,                            -- soft-delete
  notes           text                                    -- post-mortem after ad ran
);
create index on creative_components (type) where archived_at is null;
create index on creative_components using gin (tags);
```

### 4.2 · `meta_ads`
One row per ad ID from Meta. Catalog only — performance lives in `meta_ad_daily_stats`.

```sql
create table meta_ads (
  ad_id           text primary key,                       -- Meta ad ID
  ad_name         text,
  campaign_id     text,
  campaign_name   text,
  adset_id        text,
  adset_name      text,
  status          text,                                   -- ACTIVE / PAUSED / DELETED
  effective_status text,                                  -- finer-grained status from Meta
  creative_id     text,                                   -- Meta creative ID
  asset_type      text check (asset_type in ('image', 'video', 'carousel')),
  asset_url       text,                                   -- video_id resolved to source URL or image
  thumbnail_url   text,
  headline        text,
  primary_text    text,
  description     text,
  cta_type        text,                                   -- LEARN_MORE, SHOP_NOW, etc.
  destination_url text,                                   -- where the ad sends users
  first_seen_at   timestamptz default now(),
  last_synced_at  timestamptz default now(),
  archived_at     timestamptz                             -- when status became DELETED
);
create index on meta_ads (status) where archived_at is null;
create index on meta_ads (campaign_id, adset_id);
```

### 4.3 · `meta_ad_components`
Join table. An ad can carry exactly one of each role; one component can appear in many ads.

```sql
create table meta_ad_components (
  ad_id          text references meta_ads(ad_id) on delete cascade,
  component_id   uuid references creative_components(id) on delete cascade,
  role           text not null check (role in ('hook', 'body', 'callout')),
  assigned_at    timestamptz default now(),
  assigned_by    uuid references auth.users(id),
  primary key (ad_id, role)                               -- one hook per ad, etc.
);
create index on meta_ad_components (component_id);
```

### 4.4 · `meta_ad_daily_stats`
Per-ad daily insights. Replaces what `marketing_daily` does at adset level, but at ad granularity.

```sql
create table meta_ad_daily_stats (
  ad_id            text references meta_ads(ad_id) on delete cascade,
  date             date not null,
  spend            numeric(12, 2) default 0,              -- in account currency (NZD); convert at read time
  impressions      integer default 0,
  reach            integer default 0,
  frequency        numeric(6, 2) default 0,
  clicks           integer default 0,
  unique_clicks    integer default 0,
  ctr              numeric(6, 4),                         -- pct
  cpc              numeric(10, 4),
  cpm              numeric(10, 4),
  video_3s_views   integer default 0,                     -- "thumbstop"
  video_thruplays  integer default 0,                     -- 15s or 95% complete
  video_avg_time_watched numeric(8, 2),
  results          integer default 0,                     -- conversion events from Meta
  cost_per_result  numeric(10, 4),
  raw_payload      jsonb,                                 -- full Meta response, for forensic reads
  synced_at        timestamptz default now(),
  primary key (ad_id, date)
);
create index on meta_ad_daily_stats (date);
```

### 4.5 · `meta_ad_attribution` (view, not table)
A SQL view that joins `setter_leads` ↔ `meta_ads` via `adset_id` (today) and `ad_id` (once we capture it via UTM). Returns leads → bookings → closes attributable to each ad.

```sql
create view meta_ad_attribution as
select
  m.ad_id,
  m.ad_name,
  count(distinct sl.id) filter (where sl.id is not null) as leads,
  count(distinct sl.id) filter (where sl.appointment_date is not null) as qualified_bookings,
  count(distinct sl.id) filter (where sl.status in ('show', 'showed', 'live', 'closed', 'not_closed', 'ascended')) as live_calls,
  count(distinct sl.id) filter (where sl.status = 'closed') as closes,
  coalesce(sum(sl.revenue_attributed), 0) as revenue_attributed
from meta_ads m
left join setter_leads sl on sl.utm_content = m.ad_id  -- after UTM capture is added
group by m.ad_id, m.ad_name;
```

---

## 5 · Meta Ads API integration

### 5.1 · New sync function — `syncMetaAdsAtAdLevel(days)`
Lives next to existing `syncMetaAds()` in [src/services/metaAdsSync.js](src/services/metaAdsSync.js). Two endpoints per run:

**A. Insights at ad level**
```
GET /act_{ACCOUNT_ID}/insights
  ?level=ad
  &fields=ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,
          spend,impressions,reach,frequency,clicks,unique_clicks,ctr,cpc,cpm,
          actions,cost_per_action_type,
          video_3_sec_watched_actions,video_thruplay_watched_actions,
          video_avg_time_watched_actions
  &time_range={since,until}
  &time_increment=1
  &limit=500
```
→ Upserts into `meta_ad_daily_stats` keyed on `(ad_id, date)`.

**B. Ad metadata + creative**
```
GET /{ad_id}
  ?fields=name,status,effective_status,creative{
    id, image_url, video_id, thumbnail_url,
    body, title, description,
    object_story_spec{video_data{call_to_action,video_id,image_url,message,title}},
    object_story_spec{link_data{call_to_action,image_hash,link,message,name,description}}
  }
```
→ Upserts into `meta_ads`. Resolves video_id → source URL via `/{video_id}?fields=source` if needed.

### 5.2 · Sync cadence
- Hourly background sync (extend the existing `autoSync` service).
- Manual "Refresh Ads" button on the new page for on-demand pulls.
- Per-ad metadata only re-fetched when `effective_status` changes or weekly, whichever is sooner — creative metadata rarely changes after ad goes live.

### 5.3 · UTM capture (for attribution)
Add `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` columns to `setter_leads`. Backfill from GHL contact custom fields where available. New leads pick up UTMs from the original landing page URL — Meta passes `utm_content={{ad.id}}` automatically when the URL parameters are configured at the account level.

**Action item:** verify the Meta account's URL parameters template includes `utm_content={{ad.id}}` before relying on this for attribution.

---

## 6 · Attribution model

Three layers, in order of preference. Use the most specific data available; fall back when missing:

1. **Per-ad (best)** — `setter_leads.utm_content = meta_ads.ad_id`. Direct match.
2. **Per-adset (today)** — `setter_leads.utm_term = meta_ads.adset_id` (already in some leads). Aggregate across all ads in that adset.
3. **Time-window (fallback)** — leads with no UTM but `created_at` falling on a date when only one ad ran for that audience get attributed proportionally.

The component-level rollup uses the same join, then groups by `meta_ad_components.component_id` rather than `ad_id`. A hook used in 5 ads gets its leads / closes summed across all 5.

---

## 7 · UI · pages

New top-level nav entry: **Ads** (sits between "Marketing" and "Sales" in [src/components/Layout.jsx](src/components/Layout.jsx)).

### 7.1 · `/ads` — Active ads dashboard
Default landing. Editorial layout per OPT design system.

- Filter row: status (Active / Paused / All), date range, campaign, adset, asset type (image / video).
- Grid of ad cards. Each card:
  - 16:9 thumbnail (poster frame for video, full image for static)
  - Ad name · status pill · "Last 7d" sparkline of spend
  - Three component pills: HOOK · BODY · CALLOUT (filled if tagged, "+ Tag" if not)
  - Stat row: Spend · CTR · Hook rate · Results · CPA
  - Click → ad detail page
- Sort options: highest spend, best CTR, lowest CPA, newest, oldest.

### 7.2 · `/ads/[id]` — Single ad detail
- Full creative preview (video player or full image).
- Component assignment block — three slots, each clickable to assign from library or create new.
- Performance over time: line chart of spend / CTR / CPA over the ad's lifetime.
- Funnel attribution (from `meta_ad_attribution` view): leads → qualified bookings → live calls → closes → revenue.
- Notes field for post-run learnings.

### 7.3 · `/ads/library` — Component library
Three tabs: HOOKS · BODIES · CALLOUTS. Each tab is a sortable table:

| Component | Type | Times Used | Total Spend | Avg CTR | Avg CPA | Best Ad | Created | Status |
|---|---|---|---|---|---|---|---|---|
| (preview) | hook | 12 ads | $3,420 | 2.4% | $42 | "Ad name" | 2026-04-12 | Active |

Click row → component detail with every ad it appeared in, charted side-by-side. Upload button at top opens upload modal (see 7.5).

### 7.4 · `/ads/library/[component_id]` — Component detail
- Asset preview (video or image).
- All ads using this component, grid view.
- Performance rollup: weighted average CTR, total spend, total results, blended CPA.
- Notes (e.g. "burns out after $2k spend" — manual annotations).

### 7.5 · Upload modal
Triggered from library page or ad detail's "+ Tag" pills.

- Drop zone for file (image up to 30 MB, video up to 100 MB).
- Type selector: Hook / Body / Callout.
- Name + description fields.
- Tags (free-text chips).
- Copy text field (the spoken/written line).
- "Save to library" → uploads to Supabase Storage bucket `creative_components/`, inserts row.
- Optionally: "Save and assign to ad X" if launched from an ad detail page.

### 7.6 · Editorial style notes
Per [OPT-DESIGN-SYSTEM.md](C:/Users/Ben/.claude/OPT-DESIGN-SYSTEM.md):
- Newsreader serif for page titles, Inter body, JetBrains Mono for stat labels.
- Single yellow accent `#f4e14a` for active filters and CTA buttons.
- Eyebrow labels (`HOOK · BODY · CALLOUT`) in JetBrains Mono uppercase.
- Bootstrap Icons for iconography (no emojis).
- "What this means" callouts under headline metrics where the math isn't obvious.

---

## 8 · Phased rollout

### Phase 1 — Read-only ad performance (1-2 days)
1. Migration: `meta_ads`, `meta_ad_daily_stats` tables + RLS.
2. Extend `metaAdsSync.js` with `syncMetaAdsAtAdLevel`.
3. New page `/ads` showing all ads with stats — no component library yet.
4. Single ad detail page with creative preview + performance chart.

**Ships:** ability to see every ad and its performance, without component tagging.

### Phase 2 — Component library + tagging (1-2 days)
5. Migration: `creative_components`, `meta_ad_components` tables.
6. Library page `/ads/library` — read-only at first.
7. Component assignment UI on ad detail page.
8. Component detail page with rollup stats.

**Ships:** team can categorize existing ads' components and start seeing rollup data.

### Phase 3 — Upload + creative management (1 day)
9. Supabase Storage bucket setup.
10. Upload modal.
11. Soft-delete / archive flows for components and ads.

**Ships:** new creatives get into the library before they go live.

### Phase 4 — Funnel attribution (1-2 days, depends on UTM verification)
12. Verify Meta URL parameters template.
13. Add `utm_*` columns to `setter_leads`, backfill from GHL.
14. Build `meta_ad_attribution` view.
15. Wire attribution numbers into ad detail and component detail pages.

**Ships:** "this hook drove $X in closed revenue across 12 ads" — the actual point of the whole thing.

---

## 9 · Open questions for Ben

1. **Asset hosting.** Supabase Storage (cheap, integrated, but slow for large videos) or S3 / Cloudflare R2 (faster, more setup)?
2. **Component upload — push to Meta?** Phase 3 lets you upload to the library. Should it also push the asset to Meta as a draft creative ready to launch, or stays local-only and you manually upload to Ads Manager?
3. **FORGE integration.** FORGE generates ad creatives. Should completed FORGE generations auto-populate the component library, or only manual uploads? (Suggest manual for v1, auto in a v2.)
4. **Multi-platform.** Plan above is Meta-only. TikTok / Google / YouTube use the same component model — worth designing the schema to be platform-agnostic now (`platform` column on `meta_ads` → rename to `ads`)?
5. **Component types.** Hook / Body / Callout fits video ads cleanly. For static image ads — does "Hook = main image, Body = headline copy, Callout = button text" hold, or do statics get their own taxonomy?
6. **Permissions.** Anyone with dashboard access can tag components and edit ads, or restrict tagging to a subset (you, marketing lead)?
7. **Historical backfill.** Phase 1 sync starts from "now". Pull last 90 days of ad insights on first run, or just go forward?

---

## 10 · ELI5

You're building one page where every Facebook ad lives, with the actual creative shown next to its numbers. Each ad is broken into three Lego pieces — the hook (the first 3 seconds), the body (the middle pitch), and the callout (the close). Those pieces live in a separate library, each one knowing how many ads it's been in and how it's doing on average.

Two questions this answers that nothing else in the dashboard does:
- **Which specific ad is making us money right now?** — Ad page tells you, including the actual visual you can re-watch.
- **Which hook style works best across all our ads?** — Library tells you, by averaging the hook's performance everywhere it's been used.

Phase 1 ships the visual ad list. Phase 2 adds the Lego library. Phase 3 lets you upload new pieces. Phase 4 connects ads to actual closed deals so you stop optimizing for clicks and start optimizing for revenue.

Total build estimate: **5-7 working days** end-to-end, assuming no surprises with Meta's video URL resolution or UTM template gaps. Each phase is independently shippable.
