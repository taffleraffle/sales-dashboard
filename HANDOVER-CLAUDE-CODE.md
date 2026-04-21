# Sales Tracker Dashboard - Claude Code Setup Guide

This document is for another Claude Code instance to set up this sales dashboard for a new agency. Read this entire document before taking any action.

---

## Project Summary

This is a React 18 + Vite + Tailwind CSS v4 SPA that serves as a sales performance dashboard. It connects to:

- **Supabase** (PostgreSQL database + auth)
- **Go High Level / GHL** (CRM, pipeline, calendar appointments)
- **WAVV** (dialer - call data via Zapier/CSV, tags via GHL contacts)
- **Meta Ads API** (ad spend tracking)
- **Hyros** (server-side attribution)
- **Fathom** (call recordings/transcripts)

The dashboard is deployed as a **Render static site** that auto-deploys on git push.

---

## Step-by-Step Setup

### Phase 1: Supabase Project

1. **Create a new Supabase project** at https://supabase.com/dashboard
2. Once created, note:
   - Project URL (e.g. `https://xxxxx.supabase.co`)
   - Anon/public key (Settings > API > `anon` key)
   - Service role key (Settings > API > `service_role` key) - needed for scripts only, never exposed to frontend
3. **Run all migrations in order** in the Supabase SQL Editor (Settings > SQL Editor > New query):

   Run these first (core schema):
   ```
   supabase/migrations/001_initial_schema.sql
   supabase/migrations/002_fathom_sync_fixes.sql
   supabase/migrations/003_ghl_appointments.sql
   supabase/migrations/004_wavv_calls.sql
   supabase/migrations/005_marketing_tracker.sql
   supabase/migrations/006_wavv_pipeline_stage.sql
   ```

   Then run these (schema extensions):
   ```
   migrations/001_add_offered_columns.sql
   migrations/002_add_wavv_user_id.sql
   migrations/003_add_ascend_cash_to_closer_eod.sql
   migrations/004_auth_setup.sql
   migrations/005_add_contacted_to_setter_leads.sql
   migrations/006_fix_rls_policies.sql
   ```

   Then run:
   ```
   migrations/009_add_no_shows_to_tracker.sql
   ```

   **DO NOT run** `migrations/007_link_auth_users.sql` or `migrations/008_add_stl_hours.sql` yet - these contain hardcoded UUIDs and team names from the original deployment.

4. **Modify the seed data** before running `001_initial_schema.sql`:
   - Replace the `INSERT INTO team_members` with the new agency's team:
     ```sql
     INSERT INTO team_members (name, role) VALUES
       ('YourCloser1', 'closer'),
       ('YourCloser2', 'closer'),
       ('YourSetter1', 'setter'),
       ('YourSetter2', 'setter');
     ```
   - Update the `sales_benchmarks` seed values if the agency has different targets

5. **Remove the hardcoded GHL user ID update** from `supabase/migrations/003_ghl_appointments.sql` (the last line: `UPDATE team_members SET ghl_user_id = 'MhZNmEy4wcv7DyL5PFs2' WHERE name = 'Daniel'`)

### Phase 2: Environment Variables

Create a `.env` file in the project root:

```env
# Supabase (REQUIRED)
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here

# Go High Level (REQUIRED for pipeline/calendar features)
VITE_GHL_API_KEY=your_ghl_private_integration_token
VITE_GHL_LOCATION_ID=your_ghl_location_id

# Meta Ads (OPTIONAL - for marketing performance page)
VITE_META_ADS_ACCOUNT_ID=your_meta_ads_account_id
VITE_META_ADS_ACCESS_TOKEN=your_meta_ads_token

# Hyros (OPTIONAL - for attribution/ROAS)
VITE_HYROS_API_KEY=your_hyros_api_key

# Fathom (OPTIONAL - for call transcripts)
VITE_FATHOM_API_KEY=your_fathom_api_key

# Currency (OPTIONAL - set if not using USD)
VITE_NZD_TO_USD=0.60
```

**CRITICAL**: All `VITE_*` variables are baked into the static build at build time. They are NOT runtime environment variables. Every time you change them, you must rebuild.

### Phase 3: GHL Configuration

This is the most involved step. The dashboard maps GHL pipeline stages to funnel categories using regex patterns.

1. **Open `src/services/ghlPipeline.js`**

2. **Update the `STAGE_BUCKETS` array** (line ~37) to match the new agency's GHL pipeline stage names. The current patterns are:
   ```javascript
   const STAGE_BUCKETS = [
     { key: 'new_leads', label: 'New Leads', pattern: /^new.lead/i },
     { key: 'contacting', label: 'Contacting', pattern: /^contact(ed)?\s*\d|^lead.contact/i },
     { key: 'triage', label: 'Triage', pattern: /triage|auto.booked/i },
     { key: 'set_calls', label: 'Set Calls', pattern: /set.call|proposal/i },
     { key: 'no_shows', label: 'No Shows', pattern: /no.show/i },
     { key: 'follow_ups', label: 'Follow Ups', pattern: /follow.up|nurture/i },
     { key: 'closed', label: 'Closed / Won', pattern: /closed|ascend|won/i },
     { key: 'lost', label: 'Lost / Dead', pattern: /not.interested|unqualified|not.responsive|dead|dud/i },
   ]
   ```
   If their GHL uses similar naming (e.g. "New Leads", "Contact 1", "Set Call"), these patterns will work as-is. Otherwise, update the regex patterns.

3. **Update WAVV tag names** if the new agency uses different WAVV dispositions. The current tag sets (lines 11-24) expect tags like `wavv-no-answer`, `wavv-interested`, `wavv-appointment-set`, etc. If WAVV is not set up yet, this can be deferred.

4. **Open `src/services/ghlCalendar.js`** and note that calendar IDs are not hardcoded in this file - they're fetched dynamically from GHL. However, the classification of "intro" vs "strategy" calendars may need updating if the agency uses different calendar naming.

5. **Map GHL user IDs to team members**: After creating team members in Supabase, the agency needs to map each team member to their GHL user ID. Run:
   ```bash
   node scripts/find-ghl-users.mjs
   ```
   Then update `team_members` in Supabase:
   ```sql
   UPDATE team_members SET ghl_user_id = 'xxx' WHERE name = 'CloserName';
   ```

### Phase 4: WAVV Setup

**IMPORTANT VARIATION**: The new agency does not have a WAVV trial set up yet. This means:

1. The `wavv_calls` table will be empty
2. Setter dial metrics will show zeroes
3. GHL contact tags from WAVV will not exist

**When they do set up WAVV**:
1. Configure a Zapier integration: WAVV "Call Completed" trigger -> Supabase `wavv_calls` table insert
2. Map the Zapier fields to match the `wavv_calls` column names exactly (see `supabase/migrations/004_wavv_calls.sql` for the schema)
3. Set up WAVV dispositions to apply GHL tags matching the patterns in `ghlPipeline.js`
4. Map each setter's WAVV user ID to their `team_members` record:
   ```sql
   UPDATE team_members SET wavv_user_id = 'wavv-user-id-here' WHERE name = 'SetterName';
   ```

**Until WAVV is set up**, the dashboard will still function for:
- GHL pipeline overview
- Closer EOD reports
- Setter EOD reports (manual entry)
- Marketing performance (if Meta Ads is configured)
- Calendar appointments (from GHL)

### Phase 5: Auth Setup

1. **Edit `scripts/setup-auth-users.js`**:
   - Update the `TEAM_USERS` array with the new agency's team:
     ```javascript
     const TEAM_USERS = [
       { name: 'CloserName', role: 'closer', email: 'closer@agency.com' },
       { name: 'SetterName', role: 'setter', email: 'setter@agency.com' },
     ]
     ```
   - Update the `ADMIN_USER`:
     ```javascript
     const ADMIN_USER = {
       name: 'AdminName',
       email: 'admin@agency.com',
       appRole: 'admin',
     }
     ```

2. **Run the setup script**:
   ```bash
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key node scripts/setup-auth-users.js
   ```
   It will prompt for a default password. All users should change their password after first login.

### Phase 6: Speed-to-Lead Hours (Optional)

If the agency wants speed-to-lead tracking per setter's working hours, run a modified version of `migrations/008_add_stl_hours.sql`:

```sql
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS stl_start_hour smallint;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS stl_end_hour smallint;

-- Set each setter's working hours (24-hour format, local time)
UPDATE team_members SET stl_start_hour = 9, stl_end_hour = 17 WHERE name = 'SetterName';
```

### Phase 7: Build & Deploy

#### Local Development
```bash
npm install
npm run dev
```
Open http://localhost:5173

#### Deploy to Render
1. Push the repo to GitHub
2. Create a new **Static Site** on Render:
   - Build command: `npm install && npm run build`
   - Publish directory: `./dist`
3. Add a **Rewrite Rule**: `/* -> /index.html` (for SPA routing)
4. Add all `VITE_*` environment variables in Render's dashboard
5. Deploy

The `render.yaml` file in the repo has this configuration ready. If using Render's Blueprint feature, it will auto-configure from this file.

### Phase 8: Branding (Optional)

To change from the OPT Digital dark theme:

1. Open `src/index.css`
2. Update the CSS custom properties:
   - `--color-opt-yellow: #d4f50c` - change to the agency's accent color
   - Background colors: `#0a0a0a` (page), `#141414` (cards)
   - Font: Inter (UI) and JetBrains Mono (data) - loaded via Google Fonts in `index.html`
3. Update the page title in `index.html` (currently "OPT Sales")
4. Update the splash screen text in `src/components/SplashScreen.jsx`
5. Update the login page branding in `src/pages/LoginPage.jsx`

---

## File-by-File Reference for Customization

### Files that MUST be modified:
| File | What to Change |
|------|---------------|
| `.env` | All API keys and Supabase credentials |
| `supabase/migrations/001_initial_schema.sql` | Team member seed data, benchmark targets |
| `supabase/migrations/003_ghl_appointments.sql` | Remove hardcoded GHL user ID update (last line) |
| `scripts/setup-auth-users.js` | Team emails and admin account |

### Files that SHOULD be reviewed:
| File | Why |
|------|-----|
| `src/services/ghlPipeline.js` | Stage bucket patterns, WAVV tag names |
| `src/services/ghlCalendar.js` | Calendar classification logic |
| `supabase/migrations/005_marketing_tracker.sql` | Marketing benchmark seed values |
| `src/index.css` | Brand colors |
| `index.html` | Page title, font imports |

### Files that work as-is:
Everything else - the components, hooks, pages, utilities, and remaining services are generic and will work without modification once the above configuration is done.

---

## Troubleshooting

### "No data showing on dashboard"
1. Check `.env` has correct Supabase URL and anon key
2. Verify migrations ran successfully (check Supabase Table Editor for tables)
3. Verify team_members table has entries
4. Check browser console for CORS or auth errors

### "GHL sync not working"
1. Verify `VITE_GHL_API_KEY` is a valid Private Integration Token (not a Public API key)
2. Verify `VITE_GHL_LOCATION_ID` matches the GHL sub-account
3. Check browser console - GHL API rate limits at ~100 requests/minute

### "Login not working"
1. Verify auth users were created (Supabase Dashboard > Authentication > Users)
2. Check `user_profiles` table has entries for admin users
3. Check `team_members.auth_user_id` is linked for team member accounts

### "Marketing page empty"
1. Meta Ads sync must be triggered manually (Settings page or `scripts/sync-meta.mjs`)
2. Verify `VITE_META_ADS_ACCOUNT_ID` and `VITE_META_ADS_ACCESS_TOKEN` are set
3. The token needs `ads_read` scope on the correct ad account

### "WAVV metrics showing zero"
1. This is expected if WAVV is not set up yet
2. Once WAVV is configured, data enters via Zapier -> `wavv_calls` table
3. GHL contact tags from WAVV are read during pipeline fetch

---

## Architecture Decisions

- **Why client-side API calls?** This is a static SPA with no backend server. All API calls (GHL, Meta, Fathom, Hyros) happen in the browser. This keeps deployment simple (Render static site) but means API keys are in the JS bundle. For production multi-tenant use, consider adding a backend proxy.

- **Why polling instead of Realtime?** Supabase Realtime was evaluated but polling (30s-2min intervals) was simpler and sufficient for the current use case. Data doesn't change faster than every few minutes.

- **Why permissive RLS?** The current RLS policies allow all access. This was intentional for initial development speed. Before multi-agency deployment, implement proper per-user policies.

- **Why no edge functions deployed?** The edge function code exists in `supabase/functions/` but was never deployed. All processing (transcript sync, objection analysis, etc.) is handled client-side or via external automation.
