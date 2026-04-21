# Sales Tracker Dashboard - Full Repository Handover

## Overview

This is a real-time sales performance dashboard built for a digital marketing agency running a high-ticket sales operation. It tracks the full pipeline from ad spend through to close, covering setter activity, closer performance, marketing ROAS, and call analytics.

**Tech Stack**: React 18 + Vite + Tailwind CSS v4 (frontend SPA), Supabase (database + auth), Render (static hosting)

**Live URL**: Deployed as a Render static site with SPA rewrite (`/* -> /index.html`)

**Integrations**: Go High Level (CRM/pipeline), WAVV (dialer), Meta Ads (ad spend), Fathom (call recordings), Hyros (attribution)

---

## Repository Structure

```
sales-dashboard/
├── src/
│   ├── main.jsx                          # React entry point
│   ├── App.jsx                           # Router + error boundary + protected routes
│   ├── index.css                         # Tailwind v4 + theme (dark mode, brand colors)
│   ├── contexts/
│   │   └── AuthContext.jsx               # Supabase auth, role management (admin/closer/setter/viewer)
│   ├── components/
│   │   ├── Layout.jsx                    # Sidebar (desktop) + bottom nav (mobile)
│   │   ├── DataTable.jsx                 # Sortable, paginated data table
│   │   ├── KPICard.jsx                   # Metric card with color-coded thresholds
│   │   ├── Gauge.jsx                     # Progress bar gauge component
│   │   ├── DateRangeSelector.jsx         # Date range picker (7d/14d/30d/MTD/custom)
│   │   ├── LeadStatusBadge.jsx           # Status pill (set/showed/closed/no_show)
│   │   ├── SplashScreen.jsx              # Loading animation on app boot
│   │   └── SalesChatWidget.jsx           # AI chat stub (not active)
│   ├── pages/
│   │   ├── SalesOverview.jsx             # Main dashboard: KPIs, funnel, Wavv metrics, activity feed
│   │   ├── CloserOverview.jsx            # All closers: leaderboard, KPI cards, gauges
│   │   ├── CloserDetail.jsx              # Single closer: calendar, transcripts, objections
│   │   ├── SetterOverview.jsx            # All setters: funnel, dials, speed-to-lead
│   │   ├── SetterDetail.jsx              # Single setter: leads set, outcomes, gauges
│   │   ├── EODReview.jsx                 # End-of-day report filing (closer + setter tabs)
│   │   ├── MarketingPerformance.jsx      # Ad spend, CPL, ROAS, campaign breakdown
│   │   ├── MarketingPerformance.v1.jsx   # Legacy version (kept for reference)
│   │   ├── LeadAttribution.jsx           # Lead tracking stub (not fully built)
│   │   ├── LoginPage.jsx                 # Email/password login + forgot password
│   │   ├── SetPasswordPage.jsx           # New user password setup (from invite link)
│   │   └── SettingsPage.jsx              # GHL sync trigger, team config
│   ├── hooks/
│   │   ├── useCloserData.js              # Fetch closer EOD reports from Supabase
│   │   ├── useSetterData.js              # Fetch setter EOD reports from Supabase
│   │   ├── useEOD.js                     # EOD submission logic (upsert by date)
│   │   ├── useFunnelData.js              # GHL pipeline funnel data
│   │   ├── useLeadAttribution.js         # setter_leads queries
│   │   ├── useMarketingData.js           # marketing_daily aggregation
│   │   ├── useMarketingTracker.js        # marketing_tracker table queries
│   │   └── useTeamMembers.js             # Team roster from Supabase
│   ├── services/
│   │   ├── ghlPipeline.js                # GHL API: pipelines, opportunities, stage classification
│   │   ├── ghlCalendar.js                # GHL API: appointment sync to Supabase
│   │   ├── wavvService.js                # WAVV call data aggregation from Supabase
│   │   ├── fathomApi.js                  # Fathom API: call transcripts
│   │   ├── fathomSync.js                 # Sync Fathom transcripts to Supabase
│   │   ├── metaAdsSync.js                # Meta Ads API: campaign spend/leads sync
│   │   ├── hyrosSync.js                  # Hyros API: attribution/revenue sync
│   │   ├── leadReconciliation.js         # Cross-reference setter leads with closer outcomes
│   │   ├── objectionAnalysis.js          # Objection pattern detection from transcripts
│   │   ├── salesIntelligence.js          # AI insights stub (not active)
│   │   └── wavvService.js               # WAVV dialer call data from Supabase
│   ├── lib/
│   │   ├── supabase.js                   # Supabase client initialization
│   │   └── dateUtils.js                  # Date helpers (todayET, sinceDate, formatters)
│   └── utils/
│       └── metricCalculations.js         # Color-coding logic, number formatters
├── supabase/
│   ├── migrations/                       # Database schema (run in order)
│   │   ├── 001_initial_schema.sql        # Core tables + seed data + RLS
│   │   ├── 002_fathom_sync_fixes.sql     # Allow nullable closer_id on transcripts
│   │   ├── 003_ghl_appointments.sql      # GHL appointment cache table
│   │   ├── 004_wavv_calls.sql            # WAVV dialer call data table
│   │   ├── 005_marketing_tracker.sql     # Full-funnel marketing tracker table
│   │   └── 006_wavv_pipeline_stage.sql   # Pipeline stage tracking on wavv_calls
│   └── functions/                        # Supabase Edge Functions (NOT deployed)
│       ├── admin-reset-password/         # Password reset function
│       ├── analyze-objections/           # Claude-powered objection analysis
│       ├── hyros-webhook/                # Hyros webhook receiver
│       ├── invite-team-member/           # Team invite function
│       ├── sales-chat/                   # AI sales coach chat
│       └── sync-fathom/                  # Fathom transcript sync
├── migrations/                           # Additional schema migrations (run after supabase/)
│   ├── 001_add_offered_columns.sql       # offered/offered_finance on closer_calls
│   ├── 002_add_wavv_user_id.sql          # wavv_user_id on team_members
│   ├── 003_add_ascend_cash_to_closer_eod.sql  # ascend_cash/revenue on closer EODs
│   ├── 004_auth_setup.sql                # auth_user_id + user_profiles table
│   ├── 005_add_contacted_to_setter_leads.sql  # contacted flag on setter_leads
│   ├── 006_fix_rls_policies.sql          # Authenticated user RLS for marketing tables
│   ├── 007_link_auth_users.sql           # Link specific auth users to team members
│   ├── 008_add_stl_hours.sql             # Speed-to-lead working hours on team_members
│   └── 009_add_no_shows_to_tracker.sql   # no_shows column on marketing_tracker
├── scripts/
│   ├── setup-auth-users.js               # Create Supabase Auth accounts for team
│   ├── seed-test-data.js                 # Generate fake EOD/lead data for testing
│   ├── import-wavv-csv.mjs              # Bulk import WAVV call data from CSV
│   ├── find-ghl-users.mjs               # Discover GHL user IDs from calendar data
│   ├── sync-meta.mjs                    # Manual Meta Ads API sync trigger
│   └── qa-validate.mjs                  # Data integrity validation checks
├── index.html                            # Vite HTML shell
├── vite.config.js                        # Vite build configuration
├── render.yaml                           # Render deployment config (static site + SPA rewrite)
├── package.json                          # Dependencies and scripts
├── .env.example                          # Environment variable template
└── .gitignore
```

---

## Database Schema

All tables live in Supabase (PostgreSQL). Run migrations in order: `supabase/migrations/001-006`, then `migrations/001-008`.

### Core Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `team_members` | Sales team roster | `name`, `role` (closer/setter), `email`, `ghl_user_id`, `wavv_user_id`, `commission_rate`, `auth_user_id`, `stl_start_hour`, `stl_end_hour` |
| `closer_eod_reports` | Daily closer performance | `closer_id`, `report_date`, `nc_booked`, `fu_booked`, `nc_no_shows`, `fu_no_shows`, `live_nc_calls`, `live_fu_calls`, `offers`, `closes`, `deposits`, `total_revenue`, `total_cash_collected`, `ascend_cash`, `ascend_revenue` |
| `setter_eod_reports` | Daily setter performance | `setter_id`, `report_date`, `total_leads`, `outbound_calls`, `pickups`, `meaningful_conversations`, `sets`, `reschedules`, `self_rating`, `what_went_well`, `what_went_poorly` |
| `closer_calls` | Individual call records (child of closer EOD) | `eod_report_id`, `call_type`, `prospect_name`, `showed`, `outcome`, `revenue`, `cash_collected`, `offered`, `offered_finance` |
| `setter_leads` | Lead attribution backbone | `setter_id`, `closer_id`, `lead_name`, `lead_source`, `date_set`, `appointment_date`, `status` (set/showed/closed/no_show/not_closed/rescheduled), `revenue_attributed`, `contacted` |
| `ghl_appointments` | Cached GHL calendar appointments | `ghl_event_id`, `closer_id`, `contact_name`, `start_time`, `calendar_name`, `appointment_status`, `outcome`, `revenue`, `cash_collected` |
| `wavv_calls` | WAVV dialer call records | `call_id`, `contact_name`, `phone_number`, `started_at`, `call_duration`, `user_id`, `pipeline_stage_at_call`, `current_pipeline_stage` |
| `marketing_daily` | Meta Ads daily spend data | `date`, `campaign_id`, `campaign_name`, `adset_id`, `spend`, `impressions`, `clicks`, `leads`, `cpc`, `cpl`, `ctr` |
| `marketing_tracker` | Full-funnel daily marketing tracker | `date`, `adspend`, `leads`, `qualified_bookings`, `no_shows`, `offers`, `closes`, `trial_cash`, `trial_revenue`, `ascensions`, `ascend_cash`, plus AR/refund fields |
| `attribution_daily` | Hyros revenue attribution | `date`, `campaign_id`, `revenue_attributed`, `conversions`, `roas`, `event_tag` |
| `closer_transcripts` | Fathom call recordings | `closer_id`, `fathom_meeting_id`, `prospect_name`, `meeting_date`, `summary`, `transcript_url`, `objections`, `outcome` |
| `objection_analysis` | AI-analyzed objection patterns | `closer_id`, `period_start`, `period_end`, `objection_category`, `occurrence_count`, `example_quotes`, `win_rate` |
| `sales_benchmarks` | Target KPIs for color-coding | `metric_key`, `target_value`, `direction` (above/below) |
| `marketing_benchmarks` | Marketing target KPIs | `metric`, `value` |
| `user_profiles` | Admin/manager accounts | `auth_user_id`, `display_name`, `role` (admin/manager/viewer), `team_member_id` |

### Default Benchmarks (Seeded)

| Metric | Target | Direction |
|--------|--------|-----------|
| CPL | $250 | Below |
| Lead to Booking % | 40% | Above |
| Show Rate | 70% | Above |
| Offer Rate | 80% | Above |
| Close Rate | 25% | Above |
| CPA | $3,250 | Below |
| ROAS | 2.0x | Above |
| Ascension Rate | 70% | Above |
| Dials per Set | 30 | Below |
| Leads to Set % | 5% | Above |
| MCs to Set % | 40% | Above |

---

## Authentication & Roles

### Auth System
- Supabase Auth (email + password)
- JWT stored in localStorage by Supabase client
- Password reset via Supabase email link (redirects back with `type=recovery` hash)

### Roles
| Role | Access |
|------|--------|
| `admin` | Full access to all team data, settings, GHL sync |
| `manager` | Full read access, can file EODs for any team member |
| `closer` | Own closer data only, file own EODs |
| `setter` | Own setter data only, file own EODs |
| `viewer` | Read-only access |

### User Setup
The `scripts/setup-auth-users.js` script creates auth accounts and links them to `team_members`. You need to:

1. Update the `TEAM_USERS` array with your team's names, roles, and emails
2. Update the `ADMIN_USER` with your admin email
3. Run: `SUPABASE_SERVICE_ROLE_KEY=your_key node scripts/setup-auth-users.js`

---

## Route Map

| Route | Page | Access |
|-------|------|--------|
| `/login` | Login page | Public |
| `/set-password` | Password setup (new users) | Public (with auth token) |
| `/sales` | Sales Overview (main dashboard) | Protected |
| `/sales/closers` | Closer leaderboard + KPIs | Protected |
| `/sales/closers/:id` | Individual closer detail | Protected |
| `/sales/setters` | Setter leaderboard + KPIs | Protected |
| `/sales/setters/:id` | Individual setter detail | Protected |
| `/sales/marketing` | Marketing performance + ROAS | Protected |
| `/sales/eod` | EOD report filing | Protected |
| `/sales/settings` | GHL sync + configuration | Protected (admin) |

---

## Integration Details

### Go High Level (GHL)

**What it does**: Pulls pipeline opportunities and calendar appointments to calculate funnel metrics (new leads, contacting, triage, set calls, no-shows, closed, etc.).

**API Base**: `https://services.leadconnectorhq.com`
**Auth**: Bearer token (Private Integration Token)
**API Version**: `2021-07-28`

**Key endpoints used**:
- `GET /opportunities/pipelines` - list pipelines and stages
- `GET /opportunities/search` - search opportunities (paginated, 100 per page)
- `GET /contacts/` - list contacts (paginated)
- `GET /contacts/{id}/appointments` - contact's appointments

**Hardcoded values you MUST change** (`src/services/ghlPipeline.js`):
- Pipeline stage names are matched by regex pattern (e.g. `/^new.lead/i` for "New Leads"). If your GHL pipeline uses different stage naming, update the `STAGE_BUCKETS` array
- Calendar IDs for intro vs strategy calls are in `src/services/ghlCalendar.js` - you'll need to update these to match your GHL calendars

**WAVV integration via GHL tags**: The dashboard reads WAVV dialer outcomes from GHL contact tags. The tag naming convention is:
- `wavv-no-answer`, `wavv-left-voicemail`, `wavv-bad-number` = Dial
- `wavv-interested`, `wavv-appointment-set`, `wavv-not-interested`, `wavv-callback` = Pickup/MC
- `wavv-appointment-set` = Set

If your WAVV tag naming differs, update the tag sets in `ghlPipeline.js`.

### WAVV Dialer

**What it does**: Tracks dialer call data for setter performance metrics (dials, pickups, meaningful conversations).

**No direct API call** - WAVV data enters the system two ways:
1. **GHL contact tags** (see above) - tags applied by WAVV during dialing sessions
2. **`wavv_calls` Supabase table** - populated via Zapier ("WAVV Call Completed" trigger) or CSV import (`scripts/import-wavv-csv.mjs`)

**Call classification by duration**:
- `> 45 seconds` = pickup (someone answered)
- `>= 60 seconds` = meaningful conversation

**IMPORTANT - No Trial**: Your team does not currently have a WAVV trial set up. The WAVV integration will show empty/zero data until:
1. You set up a WAVV account and configure the Zapier integration to push call data to the `wavv_calls` table, OR
2. You manually import call CSVs using `scripts/import-wavv-csv.mjs`

The dashboard will still function without WAVV data - the setter metrics will just show zeroes for dial-related KPIs.

### Meta Ads API

**What it does**: Syncs daily ad spend, impressions, clicks, and leads per campaign/ad set.

**API**: Facebook Marketing API (Graph API v18.0+)
**Stored in**: `marketing_daily` table

**Sync trigger**: Manual via Settings page or `scripts/sync-meta.mjs`

### Hyros

**What it does**: Server-side attribution - maps revenue back to ad campaigns for accurate ROAS calculation (replaces Facebook pixel attribution).

**API**: `https://api.hyros.com/...`
**Stored in**: `attribution_daily` table

### Fathom

**What it does**: Pulls call recordings and transcripts for closer performance analysis and AI-powered objection detection.

**API**: `https://api.fathom.video/api/...`
**Stored in**: `closer_transcripts` table
**AI analysis**: Transcripts can be analyzed for objection patterns, stored in `objection_analysis` table

---

## Data Flows

### Lead Lifecycle
```
Meta Ads lead form → GHL (New Leads stage) → Setter dials (WAVV) → Set Call booked
→ Closer takes strategy call → Offer → Close → Ascension
```

### EOD Reporting Flow
```
Closer/Setter fills form (EODReview page)
→ Upsert to closer_eod_reports / setter_eod_reports (unique per date + person)
→ Dashboard recalculates KPIs on next fetch
```

### GHL Appointment Sync
```
Settings page: "Sync Appointments" button
→ Scans ALL GHL contacts (paginated, up to 2000)
→ For each contact: fetch appointments in date range
→ Upsert to ghl_appointments table (keyed by ghl_event_id)
→ Closer detail page reads from ghl_appointments
```

---

## Styling & Design

- **Theme**: Pure dark mode (`#0a0a0a` background, `#141414` cards)
- **Accent color**: Neon yellow (`#d4f50c`) - used for success states, buttons, highlights
- **Fonts**: Inter (UI), JetBrains Mono (data/tables)
- **Responsive**: Desktop sidebar + mobile bottom nav (breakpoint: 768px)
- **Color-coded metrics**: Green (on target), orange (within 80%), red (below 80%)

To rebrand: update CSS custom properties in `src/index.css`.

---

## Build & Deploy

### Local Development
```bash
npm install
npm run dev          # Starts Vite dev server (hot reload)
npm run build        # Builds to ./dist
npm run preview      # Preview production build locally
npm run qa           # Run data validation checks
```

### Production Deployment (Render)
```yaml
# render.yaml
type: web
runtime: static
buildCommand: npm install && npm run build
staticPublishPath: ./dist
routes:
  - type: rewrite
    source: /*
    destination: /index.html    # SPA client-side routing
```

All `VITE_*` environment variables are baked into the build at deploy time. To change API keys or config, update the env vars in Render dashboard and trigger a redeploy.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key |
| `VITE_GHL_API_KEY` | Yes | GHL Private Integration Token |
| `VITE_GHL_LOCATION_ID` | Yes | GHL Location ID |
| `VITE_META_ADS_ACCOUNT_ID` | Optional | Meta Ads account ID |
| `VITE_META_ADS_ACCESS_TOKEN` | Optional | Meta Ads API token |
| `VITE_HYROS_API_KEY` | Optional | Hyros API key |
| `VITE_FATHOM_API_KEY` | Optional | Fathom API key |
| `VITE_NZD_TO_USD` | Optional | Currency conversion rate (default: 0.60) |

---

## Known Limitations & Gotchas

1. **VITE_ vars are build-time only** - They're baked into the static JS bundle. Changing them requires a full rebuild/redeploy, not just a server restart.

2. **GHL API is slow** - Full pipeline fetch takes ~2 minutes (paginated, 100 contacts at a time). Appointment sync is similarly slow. The UI shows progress during sync.

3. **WAVV data is not real-time** - Call records enter via Zapier or CSV import, not live API. There may be a lag of minutes to hours.

4. **RLS policies are permissive** - Row-Level Security is enabled on all tables but the policies currently allow all access (`USING (true)`). Before multi-tenant use, implement proper per-user RLS policies.

5. **Edge Functions not deployed** - The `supabase/functions/` directory contains edge function code that was written but never deployed. All processing currently happens client-side.

6. **Timezone handling** - GHL returns times in location timezone (typically US Eastern). The dashboard stores these as plain strings (no `Z` suffix) and uses `todayET()` from `dateUtils.js` for "today" calculations.

7. **No data validation constraints** - The database relies on frontend validation. There are no PostgreSQL CHECK constraints or triggers for data integrity.

8. **Supabase Realtime not used** - Data is fetched via polling (useEffect + setTimeout, 30s-2min intervals), not Supabase Realtime subscriptions.

---

## Scripts Reference

| Script | Command | Purpose |
|--------|---------|---------|
| `setup-auth-users.js` | `SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/setup-auth-users.js` | Create Supabase Auth accounts for team members + admin |
| `seed-test-data.js` | `node scripts/seed-test-data.js` | Populate test data for development |
| `import-wavv-csv.mjs` | `node scripts/import-wavv-csv.mjs < export.csv` | Bulk import WAVV call records from CSV |
| `find-ghl-users.mjs` | `node scripts/find-ghl-users.mjs` | Discover GHL user IDs from calendar data |
| `sync-meta.mjs` | `node scripts/sync-meta.mjs` | Manually sync Meta Ads data |
| `qa-validate.mjs` | `npm run qa` | Run data integrity checks |

---

## What to Change for Your Agency

1. **Team members**: Update `supabase/migrations/001_initial_schema.sql` seed data with your team names/roles
2. **Auth users**: Update `scripts/setup-auth-users.js` with your team emails
3. **GHL pipeline stages**: Update regex patterns in `src/services/ghlPipeline.js` if your stage names differ
4. **GHL calendar IDs**: Update calendar ID mappings in `src/services/ghlCalendar.js`
5. **WAVV tags**: Update tag sets in `src/services/ghlPipeline.js` if your WAVV tag naming differs
6. **Benchmarks**: Update seed values in `supabase/migrations/001_initial_schema.sql` and `005_marketing_tracker.sql`
7. **Branding**: Update CSS custom properties in `src/index.css` (colors, fonts)
8. **Currency**: Set `VITE_NZD_TO_USD` if you operate in a non-USD currency
9. **Auth migration**: Update `migrations/007_link_auth_users.sql` - remove the hardcoded auth_user_id UUIDs (these are specific to the original Supabase project)
10. **GHL user IDs**: Update `supabase/migrations/003_ghl_appointments.sql` - remove the hardcoded Daniel GHL user ID update
