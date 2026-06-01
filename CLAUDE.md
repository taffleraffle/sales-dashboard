# Rank On Maps · Internal Ops App

Internal operator app for Rank On Maps. Centralizes scattered subdomains into one dashboard.

**Deploys to:** `hq.rankonmaps.io`
**Users:** Daniel (founder), Jonathan (US AM), Mersad (EU technical AM)
**Forked from:** `taffleraffle/sales-dashboard` — see `CLAUDE.upstream.md` for friend's original docs.

## Stack

- **Vite + React 18** (JSX, not TS) — base framework
- **Tailwind CSS v4** — utility styling, alongside the ROM design system
- **Supabase** — auth + Postgres + edge functions
- **React Router 7** — routing
- **Recharts** — charts
- **Lucide React** — icons (replace with custom ROM stroke icons later)
- **Render** — deploy target

## Design system rule (non-negotiable)

Every visual must follow `~/rankonmaps-brand/design-system/dashboard.css`.

Import at top of `src/index.css`:

```css
@import url("https://brand.rankonmaps.io/dashboard.css");
/* or local while developing: */
@import url("/Users/danielgirmay/rankonmaps-brand/design-system/dashboard.css");
```

Then on `<body>`: `className="rom"`. Every ROM class becomes available — `rom-kpi`, `rom-table`, `rom-pill--on`, `rom-card`, `rom-sidebar`, `rom-spotlight`, etc.

**Visual specs** (open in browser, match the look):
- `~/.claude/skills/rank-on-maps-dashboard-kit/patterns/ops-dashboard.html` — desktop
- `~/.claude/skills/rank-on-maps-dashboard-kit/patterns/mobile-app.html` — mobile (4 screens)

## Day 1 — Strip + Rebrand

1. **Hide what doesn't apply** (remove from routes, don't delete files yet):
   - `ads/*` (OPT creative testing library)
   - `contracts/*` and `downsells/*`
   - `SetterBot`, `EmailFlows*`, `CommissionPage`, `EODHistory`, `EODReview`
   - Wavv references
2. **Theme swap:**
   - In `src/index.css`, add `@import url(...)` for the design system and `body { @apply rom; }` equivalent
   - Tailwind v4: map theme colors to ROM tokens in `@theme {}` block
   - Replace OPT logo in `src/components/Layout.jsx` with the ROM pin (`~/rankonmaps-brand/logo/logo-mark-ink.svg`)
3. **Rebrand 5 core pages:**
   - `SalesOverview.jsx` → `DailyOps.jsx` (port spotlight + KPI row + heatmap from mockup)
   - `PipelinePerformance.jsx` — restyle, keep funnel logic, sage gradient bars
   - `MarketingPerformance.jsx` — restyle, keep metric calcs
   - `CallData.jsx` — restyle, WhatConverts-compatible
   - `LeadAttribution.jsx` — restyle with AM tandem pattern (`JM · MR`)
4. **Login/auth** — apply sage gradient hero, drop OPT branding

## Day 2 — Wire APIs + ROM views + Deploy

1. **Supabase project** `rankonmaps-app`
   - Migrate schema from `supabase/migrations/` (rename OPT-specific tables)
   - Add Daniel + Jonathan + Mersad as users
2. **Wire APIs** (skip OPT-specific Fanbasis/Stripe/Hyros/Fathom syncs):
   - GoHighLevel — adapt `sync-ghl-contacts` for ROM sub-accounts
   - WhatConverts — new edge function for calls/forms
   - DataForSEO — new edge function for rank/keyword data
3. **Add ROM-specific views** (use mockup as spec):
   - Account Health table
   - Map Pack Rankings
   - Top Suburbs by Calls
   - Portfolio Map (Australia, pins by client)
4. **Deploy to Render** at `hq.rankonmaps.io`

## Project memory

`~/.claude/projects/-Users-danielgirmay/memory/`:
- `project_rankonmaps_app.md` — this project
- `reference_friend_sales_dashboard.md` — upstream repo
- `reference_brand_kit.md` — brand kit
- `feedback_voice_no_ai_slop.md` — voice rules apply to all UI

## Voice rules

- No em-dashes, no emoji, no "Welcome back" greetings
- Sentence case for buttons in JSX (CSS handles uppercasing)
- Numbers always tabular
- Dollar-specific where possible ("+$8,400/mo" not "increased revenue")

## Don't

- Don't keep Wavv references — ROM uses WhatConverts ([[reference_whatconverts]])
- Don't keep OPT commission logic — ROM has 3 users, not a sales team
- Don't introduce a second color outside the ROM palette
- Don't run `gh repo create` — we already forked as `RankOnMaps/rankonmaps-app`
- Don't push secrets — `.env.example` shows shape, real keys go in Render env vars

## Quick start

```bash
cd ~/rankonmaps-app
npm install
cp .env.example .env.local   # fill keys
npm run dev                  # http://localhost:5173
```
