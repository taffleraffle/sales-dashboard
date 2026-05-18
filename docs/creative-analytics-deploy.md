# Creative Performance Analytics — Deploy & Verification

**Plan:** `C:\Users\Ben\.claude\plans\adaptive-beaming-curry.md`
**Built:** 2026-05-18
**Status:** Code complete, awaiting deploy

## What shipped

### Database (3 migrations)
- `supabase/migrations/058_creative_test_attributes.sql` — `offers`, `creative_attribute_vocab`, `creative_attributes`, `generated_scripts` tables + full vocab seed + RLS + grants
- `supabase/migrations/059_lib_ad_performance_unified.sql` — `lib_ghl_booked_per_ad` view + `lib_ad_performance(since, until)` function + `lib_perf_by_attribute(attr, since, until)` function
- `supabase/migrations/060_creative_attribute_pivots.sql` — `lib_perf_heatmap(attr_a, attr_b, since, until)` + `lib_winning_attributes(since, until)` + `lib_attribute_coverage` view

### Supabase Edge Functions (2)
- `supabase/functions/creative-tag-ad/index.ts` — LLM attribute extraction via Claude tool-use JSON mode. Modes: `one`, `batch`, `missing`.
- `supabase/functions/creative-generate-script/index.ts` — Generic ad-script generator for any offer. Reads offer config + winning patterns, generates N scripts via Claude.

### Client services (2)
- `src/services/creativeTagger.js` — Wraps creative-tag-ad. `tagAd()`, `tagBatch()`, `tagMissing()`, `getAttributeVocab()`, `getAdAttributes()`, `updateAdAttributes()`, `listOffers()`, `getAttributeCoverage()`
- `src/services/scriptGenerator.js` — Wraps creative-generate-script. `generateScripts()`, `listGeneratedScripts()`, `updateGeneratedScript()`, `linkScriptToAd()`

### UI components / pages
- `src/components/ads/CreativeAttributesPanel.jsx` — 11-dropdown tagging panel + Re-extract + Winner override (mounted on `AdDetail.jsx`)
- `src/pages/ads/AdsInsights.jsx` — Insights dashboard at `/sales/ads/creative/insights`. 6 pivot widgets + winners table + "most consistent winning attributes" + coverage pills
- `src/pages/ads/AdsGenerator.jsx` — Script generator at `/sales/ads/creative/generate`. Offer + N concepts + target attributes + history table
- `src/pages/ads/AdsCreativeTestingLayout.jsx` — extended sub-nav with **Insights** and **Generate** tabs
- `src/App.jsx` — routes wired for both new pages
- `src/pages/ads/AdDetail.jsx` — `CreativeAttributesPanel` mounted between stats table and TagVariantModal

### Knowledge base docs
- `c:\Users\Ben\projects\ad-creative-kb\prompts\generate_scripts_generic.md` — system prompt source-of-truth (mirrors Edge Function's `LOCKED_PRINCIPLES` constant)
- `c:\Users\Ben\projects\ad-creative-kb\offers\opt-restoration.md` — canonical offer config for restoration (mechanism, audience anchors, proof characters, banned phrases)

## Deploy sequence

### 1. Apply migrations (Supabase)

```bash
cd c:\Users\Ben\sales-dashboard
supabase db push
```

Verifies:
- `supabase db diff` should return zero diffs after push
- In Supabase Studio SQL editor: `SELECT slug FROM public.offers;` returns 5 rows
- `SELECT COUNT(*) FROM public.creative_attribute_vocab;` returns ~60+ rows (full enum seed)
- `SELECT * FROM public.lib_ad_performance(now()::date - 30, now()::date) LIMIT 1;` returns at least one row OR empty (not an error)
- `SELECT * FROM public.lib_attribute_coverage;` returns 11 rows (one per attribute)

### 2. Deploy Edge Functions

```bash
cd c:\Users\Ben\sales-dashboard
supabase functions deploy creative-tag-ad
supabase functions deploy creative-generate-script
```

Verify secrets are set:
- `ANTHROPIC_API_KEY` — required for both functions
- `ANTHROPIC_MODEL` — optional override (defaults to `claude-sonnet-4-20250514`)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — auto-injected by Supabase

Test the tagger from psql or supabase CLI:
```bash
curl -X POST "$VITE_SUPABASE_URL/functions/v1/creative-tag-ad" \
  -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"missing","limit":1}'
```

Should return `{ ok: true, processed: 1, results: [{ ad_id, ok: true, attributes: {...} }] }`.

### 3. Deploy the frontend

```bash
cd c:\Users\Ben\sales-dashboard
npm run build     # confirm no TypeScript / ESLint errors
# Deploy via Render / Vercel / wherever sales-dashboard-ftct lives
```

Then visit:
- `/sales/ads/creative/insights` — should render with empty pivots (no tagged data yet) + 6 widget shells + coverage pills at 0%
- `/sales/ads/creative/generate` — should render with offers dropdown showing 5 offers
- `/sales/ads/ad/<any_existing_ad_id>` — should render with the new "Tag this creative" panel below the stats table

### 4. Backfill tagging on the existing ad corpus

From the Insights page, click **Tag missing ads** → tags 50 ads at a time.

Or programmatically:
```js
import { tagMissing } from './services/creativeTagger'
await tagMissing(100)  // tag the next 100 ads with no extraction
```

Cost: ~$0.02/ad. 500 ads = $10. Run repeatedly until coverage pills are green.

### 5. (Recommended) Wire autoSync

In `src/services/autoSync.js`, add a step after `syncMetaAdsAtAdLevel` to call `tagMissing(50)` so newly synced ads auto-tag every cycle. **NOT YET DONE** — flagged as Phase 1.5 follow-up.

## Verification checklist

- [ ] Migration 058 applied: `SELECT slug FROM public.offers` returns 5 rows
- [ ] Migration 059 applied: `SELECT * FROM public.lib_ad_performance('2026-04-01', '2026-05-18') LIMIT 1` runs without error
- [ ] Migration 060 applied: `SELECT * FROM public.lib_attribute_coverage` returns 11 rows
- [ ] Edge Function `creative-tag-ad` deployed and reachable
- [ ] Edge Function `creative-generate-script` deployed and reachable
- [ ] Frontend build succeeds (`npm run build`)
- [ ] `/sales/ads/creative/insights` renders without errors
- [ ] `/sales/ads/creative/generate` renders without errors
- [ ] Click "Tag missing ads" on Insights → see at least 1 ad get tagged → coverage pills move from 0%
- [ ] On AdDetail page, the "Tag this creative" panel renders with the 11 dropdowns
- [ ] Mark an ad as winner manually → it appears in the Winners table on /insights
- [ ] On /generate, pick `opt-restoration`, n=3, click Generate → 3 scripts render in the result panel
- [ ] Save-as-drafts checkbox: generated scripts appear in the History table after generate
- [ ] Pivot widgets show data after ≥10 ads are tagged

## Known gaps + Phase 1.5 follow-ups

These are explicitly deferred and not blocking v21 launch:

1. **AutoSync wiring** — `tagMissing()` should run after every `syncMetaAdsAtAdLevel` so new ads auto-tag. Currently manual via Insights page button.
2. **Cross-attribute heatmap component** — `lib_perf_heatmap` RPC exists, no UI yet. Will go on Insights page.
3. **Variant ↔ generated_script linkage** — `linkScriptToAd()` exists in service but no UI to call it. Operator currently has to flip status manually in Supabase Studio when filming completes.
4. **Plumbing offer seed** — Ben deferred. Add when first plumbing campaign launches.
5. **CAPI implementation** — current state is Pixel-only with iOS 14.5+ attribution losses. Phase 4.
6. **Cycle report email** — automated 14-day summary email of winning-variable patterns. Phase 4.
7. **`lib_winning_attributes` per-offer filter** — currently global. When OPT has multiple live offers, this should accept an `offer_slug` filter.

## Architecture decisions reference

See plan file at `C:\Users\Ben\.claude\plans\adaptive-beaming-curry.md` for the locked architecture decisions:
- Tag granularity: ad-level (`ad_id`), not variant-level
- Schema shape: dense columns in `creative_attributes` + controlled vocabulary
- Offers abstraction supports any vertical
- Tagging strictness: permissive (gaps allowed, confidence scores per field)
- Auto-winner heuristic: `spend ≥ $1,000 AND ≥2 booked AND CPB ≤ $300`
- LLM lives in Edge Functions (server-side, ANTHROPIC_API_KEY never browser-exposed)
- Existing `library.components` + `library.variants` untouched (new tag layer is orthogonal)

## Cost model

- Per-ad tagging: ~$0.02 (Sonnet, ~1k input + ~500 output tokens)
- Per script generation: ~$0.05-0.10 (Sonnet, larger output)
- Daily ongoing cost: depends on autoSync cadence × new-ad volume × $0.02. For typical OPT volume (5-15 new ads/day): well under $1/day.
