# Ad Performance + Creative Library — Comprehensive Plan (v2)

> Standalone module under `/sales/ads`. Five tabs (Ads · Hooks · Bodies · Scenes · Creators) backed by the existing `library` schema and the OPT-MetaAd-Naming-SOP. Replaces the v1 plan — v1 missed that you already have 027_library_schema.sql with a 4-dimension test taxonomy.

**Owner:** Ben · **Status:** Plan only · **Drafted:** 2026-05-09 · **Supersedes:** v1

---

## 1 · Goal

Restructure the `/sales/ads` route into a five-tab Creative Library that mirrors the OPT-MetaAd-Naming-SOP and the `library` schema. The dashboard becomes the operational surface for:

- **Ads tab** — every Meta ad currently or historically running, with creative previewable, live performance, and which variant it belongs to.
- **Hook library** — every hook component, ranked by weighted performance across every variant it appeared in.
- **Body library** — every body angle (the 7 canonical: PROOF / DATA / STORY / AUTHORITY / TEACHING / OFFER / COMPETITOR), same rollup logic.
- **Scene library** — every visual setup (the 7 canonical: OFFICE / CAR / STUDIO / OUTDOOR / ONSITE / PHONE / WHITEBOARD).
- **Creator library** — every UGC creator + AI / direct-client (OSO / SOFIA / NATALIE / RESTO-AI / CLIENT).

Plus secondary nav for the operational edges: **Variants** · **Orphans** · **Legacy**.

---

## 2 · What's already built (don't rebuild)

**Already shipped:**
- `supabase/migrations/027_library_schema.sql` — `library` schema with `components`, `variants`, `performance_daily`, `legacy_ad_mapping`, `orphan_ads`. Two materialized views: `component_performance`, `cohort_hook_body`. Refresh function. Seeded 19 components (body angles + scenes + creators).
- `migrations/011_ad_performance_phase1.sql` (committed, not applied) — `public.ads`, `public.ad_daily_stats`. Raw Meta layer.
- `src/services/metaAdsSync.js` — `syncMetaAdsAtAdLevel()`. Read-only Meta GET only.
- `src/pages/AdPerformance.jsx` + `AdDetail.jsx` — single-tab v1 UI.
- `OPT-MetaAd-Naming-SOP-v2-2026-05-09.docx` — naming grammar, UTM template, pre-launch checklist.

**Not yet built:**
- The bridge between raw `public.ads` and `library.variants` (parser + linkage + orphan capture).
- The 4 component-library tabs (Hooks / Bodies / Scenes / Creators).
- Component detail pages with weighted rollup from `library.component_performance`.
- Variant detail page.
- Orphan + Legacy operational tabs.
- The tab shell wrapping all of it.

**Action item that's blocking ship:** migration 011 must be pasted into Supabase Studio SQL editor by you. I don't have DB password / `psql` / `supabase` CLI / DDL-capable RPC. Once 011 lands, Phase 1 of v1 is live; everything in this v2 plan stacks on top.

---

## 3 · Architecture

### 3.1 · Route map

```
/sales/ads                           → redirects to /sales/ads/list
/sales/ads/list                      → Ads tab (default)
/sales/ads/hooks                     → Hook library
/sales/ads/bodies                    → Body library
/sales/ads/scenes                    → Scene library
/sales/ads/creators                  → Creator library
/sales/ads/variants                  → Variant index
/sales/ads/variants/:variant_id      → Variant detail (which ads ran it, perf)
/sales/ads/components/:component_id  → Component detail (which variants used it)
/sales/ads/orphans                   → Ads that don't match the naming SOP
/sales/ads/legacy                    → Legacy ad mapping (pre-2026-05-09)
/sales/ads/:meta_ad_id               → Single ad detail (creative + perf timeline)
```

### 3.2 · Data flow

```
Meta Graph API  ── GET only ──>  public.ads + public.ad_daily_stats
                                       ↓ (parser trigger)
                            library.variants.meta_ad_id  (linked) — OR — library.orphan_ads (unlinked)
                                       ↓
                            library.performance_daily (per-variant per-day)
                                       ↓
                       library.component_performance (materialized, weighted)
                                       ↓
                                    UI tabs
```

### 3.3 · UI shell

New `<AdsLayout>` component renders a sticky tab bar at the top of every `/sales/ads/*` route:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ADS  ·  HOOKS  ·  BODIES  ·  SCENES  ·  CREATORS    │ Variants  Orphans  Legacy
│ ───                                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

Primary tabs (5) are larger; secondary nav (3) is smaller text on the right. Each tab keeps its own filter / sort state (URL search params for shareable links).

---

## 4 · Per-tab spec

### 4.1 · Ads tab — `/sales/ads/list`

Card grid of every ad in `public.ads`, joined to its latest stats from `public.ad_daily_stats`, with optional variant link from `library.variants` (when parser matched).

Each card shows:
- Creative thumbnail (hover-to-play for video).
- Ad name (truncated) + status pill.
- Variant pill (e.g. `H4.2_BA-PROOF_S-OFFICE_OSO_v1`) → click goes to variant detail.
- Five primary stats: Spend · CTR · Hook · CPA · Status.
- Tag row showing the four component IDs as small chips: `H4.2 · BA-PROOF · S-OFFICE · OSO`.

Filters: Active / Paused / Spent / All · search · sort by spend / CTR / CPA / newest.

Empty state when no ads synced: "No ads synced yet" + Sync button.

### 4.2 · Hook library — `/sales/ads/hooks`

Table of every hook from `library.components` WHERE `type='hook'`, joined to the materialized `library.component_performance` view for weighted rollup metrics.

Columns:

| Hook ID | Label | Status | Variants | Live | Spend | Hook% | Hold% | CTR | CPA | Best variant |
|---------|-------|--------|----------|------|-------|-------|-------|-----|-----|--------------|

Sort by any column. Click row → component detail. Status filter (concept / in_production / ready / retired).

"Add hook" button (top right) — opens modal that inserts a new row into `library.components` with `type='hook'`, prefilled with required fields (component_id, label, script_text, duration_sec, status='concept'). Phase 3 of this plan adds upload of the hook video asset to Supabase Storage.

### 4.3 · Body library — `/sales/ads/bodies`

Identical structure to Hook library, filtered to `type='body_angle'`. Already seeded with 7 canonical angles, so empty state is rare.

### 4.4 · Scene library — `/sales/ads/scenes`

Identical structure, filtered to `type='scene'`. 7 canonical scenes seeded.

### 4.5 · Creator library — `/sales/ads/creators`

Identical structure, filtered to `type='creator'`. Adds a "creator" specific column: number of variants per status (planned / live / killed / winner). 5 canonical creators seeded.

### 4.6 · Component detail — `/sales/ads/components/:component_id`

Drill-in for any single component (hook / body angle / scene / creator).

Sections:
1. **Header** — component_id · label · type pill · status pill · description.
2. **Asset preview** — if hook (script_text + reference video), if body_angle (description), if scene (description + sample reference shot), if creator (avatar + bio).
3. **Weighted rollup tile row** — Spend · Hook% · Hold% · CTR · CPL · CPA · Cost-per-close. Pulled from `library.component_performance`.
4. **Variants table** — every `library.variants` row that references this component, with status, spend, key rates. Click → variant detail.
5. **Cohort matrix (hooks + bodies only)** — when component is a hook or body_angle, show the `library.cohort_hook_body` slice for this component crossed against the other dimension.
6. **Notes** — free text edit field for post-mortem learnings.

### 4.7 · Variant detail — `/sales/ads/variants/:variant_id`

Shows one variant (one specific 4-tuple at one iteration). Sections:

1. **Header** — variant_id, status pill, launched_at, retired_at if applicable.
2. **Component breakdown** — 4 cards, one per dimension, each showing the component_id + label.
3. **Asset preview** — the spliced final asset (video).
4. **Linked Meta ads** — every `public.ads` row where `variant_id = this`. Usually one, but can be multiple if relaunched.
5. **Performance timeline** — daily spend / CTR / CPA chart from `library.performance_daily`.
6. **Notes**.

### 4.8 · Orphan tab — `/sales/ads/orphans`

Lists every row in `library.orphan_ads`. Operator workflow:
- For each orphan row, three buttons: **Map to existing variant** (search/dropdown into `library.variants`), **Create new variant** (open variant-create modal pre-filled with parsed components if any), **Mark ignored** (set `resolved=true` with notes='ignored').
- Filter by first_seen / last_seen.
- Bulk-resolve action for low-spend orphans.

### 4.9 · Legacy tab — `/sales/ads/legacy`

Lists `library.legacy_ad_mapping`. Same map/edit workflow as orphans. Marker: "60-day cutoff" — after 2026-07-08, all unmapped legacy ads get auto-archived from the dashboard's active set per the SOP.

---

## 5 · Data model changes

### 5.1 · Migration 011 — already written, needs apply

`public.ads` + `public.ad_daily_stats`. Pasted in Supabase Studio SQL editor.

### 5.2 · Migration 012 — bridge to library

```sql
-- 012_ad_variant_link.sql
-- Bridges public.ads (raw Meta sync) to library.variants (the SOP-driven library).

-- 1. Add variant_id FK on public.ads
ALTER TABLE public.ads
  ADD COLUMN IF NOT EXISTS variant_id TEXT REFERENCES library.variants(variant_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_match_status TEXT
    CHECK (variant_match_status IN ('matched', 'orphan', 'legacy', 'unparsed', 'pending'))
    DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_ads_variant_id ON public.ads(variant_id);
CREATE INDEX IF NOT EXISTS idx_ads_variant_match_status ON public.ads(variant_match_status);

-- 2. Parse function — regex-extract variant_id from Meta ad name
CREATE OR REPLACE FUNCTION library.parse_variant_id(ad_name TEXT)
RETURNS TEXT AS $$
DECLARE
  result TEXT;
BEGIN
  -- Format: [...] | [...] | [variant_id] | [iteration]
  -- variant_id pattern: H{n}.{m}?_BA-{TYPE}_S-{TYPE}_{CREATOR}_v{n}
  SELECT (regexp_match(ad_name,
    'H\d+(?:\.\d+)?_BA-[A-Z]+_S-[A-Z\-]+_[A-Z\-]+(?:_v\d+)?'
  ))[1] INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. Trigger — on insert/update of public.ads, attempt to link to a variant
CREATE OR REPLACE FUNCTION public.link_ad_to_variant()
RETURNS TRIGGER AS $$
DECLARE
  parsed TEXT;
  matched_variant TEXT;
  legacy_match TEXT;
BEGIN
  parsed := library.parse_variant_id(NEW.ad_name);

  IF parsed IS NULL THEN
    -- Check legacy mapping first
    SELECT lm.variant_id::text INTO legacy_match
    FROM library.legacy_ad_mapping lm
    WHERE lm.meta_ad_id = NEW.ad_id;

    IF legacy_match IS NOT NULL THEN
      NEW.variant_id := (SELECT variant_id FROM library.variants WHERE id::text = legacy_match);
      NEW.variant_match_status := 'legacy';
    ELSE
      NEW.variant_match_status := 'unparsed';
      INSERT INTO library.orphan_ads (meta_ad_id, meta_ad_name, parser_attempted)
      VALUES (NEW.ad_id, NEW.ad_name, 'no SOP match in name')
      ON CONFLICT (meta_ad_id) DO UPDATE SET
        last_seen = NOW(),
        meta_ad_name = EXCLUDED.meta_ad_name;
    END IF;
  ELSE
    -- Parsed successfully — does the variant exist in library?
    SELECT v.variant_id INTO matched_variant
    FROM library.variants v
    WHERE v.variant_id = parsed;

    IF matched_variant IS NOT NULL THEN
      NEW.variant_id := matched_variant;
      NEW.variant_match_status := 'matched';
      -- Backfill library.variants.meta_ad_id if blank
      UPDATE library.variants
      SET meta_ad_id = NEW.ad_id, meta_ad_name = NEW.ad_name
      WHERE variant_id = matched_variant AND meta_ad_id IS NULL;
    ELSE
      NEW.variant_match_status := 'orphan';
      INSERT INTO library.orphan_ads (meta_ad_id, meta_ad_name, parser_attempted)
      VALUES (NEW.ad_id, NEW.ad_name, parsed)
      ON CONFLICT (meta_ad_id) DO UPDATE SET
        last_seen = NOW(),
        parser_attempted = parsed;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ads_link_to_variant
  BEFORE INSERT OR UPDATE OF ad_name ON public.ads
  FOR EACH ROW EXECUTE FUNCTION public.link_ad_to_variant();

-- 4. Trigger — when ad_daily_stats inserts, mirror to library.performance_daily
CREATE OR REPLACE FUNCTION public.mirror_stats_to_library()
RETURNS TRIGGER AS $$
DECLARE
  v_uuid UUID;
BEGIN
  SELECT v.id INTO v_uuid
  FROM library.variants v
  JOIN public.ads a ON a.variant_id = v.variant_id
  WHERE a.ad_id = NEW.ad_id;

  IF v_uuid IS NULL THEN
    RETURN NEW; -- ad not linked to a variant yet, skip mirror
  END IF;

  INSERT INTO library.performance_daily (
    variant_id, date, spend, impressions, reach, clicks, link_clicks,
    three_sec_views, thruplays, source, pulled_at
  ) VALUES (
    v_uuid, NEW.date, NEW.spend, NEW.impressions, NEW.reach,
    NEW.clicks, NEW.unique_clicks, NEW.video_3s_views, NEW.video_thruplays,
    'meta', NOW()
  )
  ON CONFLICT (variant_id, date) DO UPDATE SET
    spend = EXCLUDED.spend,
    impressions = EXCLUDED.impressions,
    reach = EXCLUDED.reach,
    clicks = EXCLUDED.clicks,
    link_clicks = EXCLUDED.link_clicks,
    three_sec_views = EXCLUDED.three_sec_views,
    thruplays = EXCLUDED.thruplays,
    pulled_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ad_daily_stats_mirror
  AFTER INSERT OR UPDATE ON public.ad_daily_stats
  FOR EACH ROW EXECUTE FUNCTION public.mirror_stats_to_library();

NOTIFY pgrst, 'reload schema';
```

### 5.3 · No new tables needed beyond 011 + 012

The `library` schema already has everything else. We're connecting, not adding.

---

## 6 · Sync changes

After every `syncMetaAdsAtAdLevel()` run, call `library.refresh_materialized_views()` so `component_performance` and `cohort_hook_body` reflect the new daily numbers.

```js
// In src/services/metaAdsSync.js, end of syncMetaAdsAtAdLevel
await supabase.rpc('refresh_materialized_views', {}, { head: false }).catch(e =>
  console.warn('[ad sync] materialized view refresh failed:', e.message)
)
```

The trigger in 012 handles the linking automatically — sync only needs to upsert into `public.ads` and `public.ad_daily_stats` as it already does.

---

## 7 · Files to create / modify

### Create (new pages)
- `src/pages/ads/AdsLayout.jsx` — tab shell wrapper
- `src/pages/ads/AdsList.jsx` — Ads tab (rename of AdPerformance.jsx, plus variant pill)
- `src/pages/ads/AdsHooks.jsx`
- `src/pages/ads/AdsBodies.jsx`
- `src/pages/ads/AdsScenes.jsx`
- `src/pages/ads/AdsCreators.jsx`
- `src/pages/ads/ComponentDetail.jsx`
- `src/pages/ads/VariantDetail.jsx`
- `src/pages/ads/AdsOrphans.jsx`
- `src/pages/ads/AdsLegacy.jsx`

### Create (shared components)
- `src/components/ads/ComponentTable.jsx` — used by all 4 library tabs
- `src/components/ads/ComponentCard.jsx` — used in detail pages
- `src/components/ads/VariantPill.jsx` — used everywhere
- `src/components/ads/AddComponentModal.jsx` — used by library tabs

### Modify
- `src/pages/AdPerformance.jsx` → moved to `src/pages/ads/AdsList.jsx` (and trimmed)
- `src/pages/AdDetail.jsx` → kept, but move under `src/pages/ads/AdDetail.jsx`
- `src/App.jsx` — add new routes (replace single `/sales/ads` with the route tree above)
- `src/components/Layout.jsx` — already has Ads nav entry, no change
- `src/services/metaAdsSync.js` — add materialized view refresh

### Create (DB)
- `migrations/012_ad_variant_link.sql`

---

## 8 · Phased rollout (revised)

Each phase is independently shippable. Numbers continue from v1.

### Phase 1.5 — 5-tab shell + read-only library tabs (1-2 days)
*Pre-req: migration 011 applied to Supabase.*
1. Apply migration 012 (bridge tables — applied in same paste).
2. Build `AdsLayout` + 5 tab pages reading from existing `library.components` + `library.component_performance`.
3. Move existing `AdPerformance.jsx` → `AdsList.jsx`, add variant pill.
4. Build `ComponentDetail`, `VariantDetail`, `AdsOrphans`, `AdsLegacy` as read-only.

**Ships:** the comprehensive 5-tab UI you asked for, hydrated by whatever's already in the library schema today (the 7 body angles + 7 scenes + 5 creators that were seeded). Hook tab is empty until you start adding hooks. Component detail pages show real weighted performance once any ads are linked.

### Phase 2 — Variant linking + parser (0.5 day)
1. Migration 012's parser runs automatically on every existing + new `public.ads` row.
2. Backfill: trigger fires on every existing row by running `UPDATE public.ads SET ad_name = ad_name`.
3. Anything not matched lands in orphan_ads — the operator works through them in the Orphans tab.

**Ships:** automatic linking of conformant ads to variants. Materialized views populate.

### Phase 3 — Component + variant authoring (1-2 days)
1. `AddComponentModal` — opens from any library tab, inserts into `library.components`.
2. `AddVariantModal` — opens from variant tab, inserts into `library.variants` (with 4 component dropdowns).
3. Asset upload to Supabase Storage `creative_components/` bucket.
4. Edit / archive flows.

**Ships:** full create/edit on both libraries from the UI. The launcher's pre-launch checklist becomes "is the variant in the Library? if not, add it now and then launch in Meta."

### Phase 4 — Funnel attribution (1-2 days, depends on UTM)
1. Verify Meta URL parameters template carries `utm_content={{ad.id}}`.
2. Add `utm_*` columns to `setter_leads`, backfill from GHL.
3. Build `library.attribution` view: variant → leads → bookings → closes → revenue.
4. Wire revenue tiles into Variant Detail and Component Detail.

**Ships:** the actual point — "this hook drove $X in closed revenue across 12 ads."

### Phase 5 — Cohort + funnel analytics (1 day)
1. Cohort matrix UI (hook × body) — already have `library.cohort_hook_body` materialized view.
2. Top-of-tab funnel sparkline: which components are trending up over the last 14 days.

**Ships:** the at-a-glance "what's working right now" view that sits above each library tab.

---

## 9 · Open questions

1. **Hook video assets — where do they live?** Are existing hooks already filmed but not in Supabase Storage, or does each hook component need a re-upload? Affects Phase 3 scope.
2. **Variant auto-create on orphan resolution?** When operator marks an orphan as "create new variant", the modal pre-fills components from the parsed variant_id. Should non-conformant orphans also be allowed to become variants (bypassing the SOP), or strictly orphan?
3. **Meta sync cadence** — current plan is hourly via existing `autoSync`. Confirm that's OK, or do you want a different cadence for ad-level sync (which is heavier than current adset-level)?
4. **Mobile UX for the 5-tab shell** — desktop has space for all 5 + secondary nav. On mobile, do tabs become a horizontal scroll, a dropdown, or a separate menu?
5. **Performance refresh** — `refresh_materialized_views()` is concurrent so it won't block reads, but on a large dataset it can take 30+ seconds. Worth running async in a background job rather than after every sync?

---

## 10 · ELI5

Right now, you have one page (`/sales/ads`) that shows every Meta ad in a single grid. Useful, but flat — no structure, no library, no rollup of "which hooks are winning."

The new build adds five tabs across the top of that page. Same URL prefix, just five views:

- **Ads** — what you have today, polished, with variant tags so you can see at a glance "this ad uses hook H4.2 and body PROOF."
- **Hooks** — every hook in your library, ranked by how it actually performs across every ad it's in. Click in to see the hook script, every variant that used it, weighted CTR + hook rate + CPA.
- **Bodies** — same thing for body angles. The 7 you defined (PROOF / DATA / STORY / etc.) each get a row.
- **Scenes** — same for visual setups.
- **Creators** — same for OSO / SOFIA / NATALIE / RESTO-AI / CLIENT.

Underneath, two automatic things happen:
1. Every Meta ad name gets parsed for its `H4.2_BA-PROOF_S-OFFICE_OSO_v1` variant ID. If it matches a variant in your library, the ad joins the variant's record. If it doesn't, it goes into the Orphans tab so you can map it manually or ignore it.
2. Every daily stat from a linked ad flows into `library.performance_daily`, which feeds the rollup tables you see on each library tab. So the numbers update as ads run, and the materialized views get refreshed after each sync.

Phase 3 lets the team add new hooks and variants from the dashboard (no SQL needed). Phase 4 connects ads to closed revenue via UTMs. Phase 5 adds the hook×body cohort matrix you already have a materialized view for.

**Total v2 estimate: 4-7 working days** end-to-end, in independently shippable chunks. Phase 1.5 (the 5-tab UI you asked for, read-only) is 1-2 days and can ship by tomorrow once migration 011 is applied.
