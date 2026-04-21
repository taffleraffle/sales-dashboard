# Sales Dashboard - API Keys Acquisition Guide

This document walks through how to obtain every API key and credential needed to run the Sales Tracker Dashboard. Complete these in order - Supabase and GHL are required, the rest are optional but recommended.

---

## 1. Supabase (REQUIRED)

Supabase provides the database, authentication, and real-time features.

### What you need:
- `VITE_SUPABASE_URL` - Your project's API URL
- `VITE_SUPABASE_ANON_KEY` - Public/anonymous key (safe for frontend)
- `SUPABASE_SERVICE_ROLE_KEY` - Admin key (scripts only, never in frontend)

### How to get them:

1. Go to https://supabase.com and sign up (free tier is sufficient to start)
2. Click **"New Project"**
3. Choose an organization (or create one), name your project, set a database password, choose a region close to your team
4. Wait for the project to provision (~2 minutes)
5. Once ready, go to **Settings > API** (left sidebar > gear icon > API)
6. You'll see:
   - **Project URL** - This is your `VITE_SUPABASE_URL` (e.g. `https://abcdefgh.supabase.co`)
   - **Project API keys**:
     - `anon` / `public` key - This is your `VITE_SUPABASE_ANON_KEY`
     - `service_role` key - This is your `SUPABASE_SERVICE_ROLE_KEY` (click "Reveal" to see it)

**WARNING**: The `service_role` key bypasses Row-Level Security. Never put it in frontend code or `.env` files that get committed. It's only used in the `scripts/setup-auth-users.js` script and should be passed as an environment variable at runtime.

---

## 2. Go High Level / GHL (REQUIRED)

GHL is the CRM that provides pipeline data, opportunity tracking, and calendar appointments.

### What you need:
- `VITE_GHL_API_KEY` - Private Integration Token
- `VITE_GHL_LOCATION_ID` - Your GHL sub-account Location ID

### How to get the Location ID:

1. Log in to your GHL sub-account (the specific location/business)
2. Go to **Settings** (gear icon, bottom-left)
3. Click **"Business Profile"** under the Company section
4. Your **Location ID** is shown on this page (it's a long alphanumeric string)
5. Copy it - this is your `VITE_GHL_LOCATION_ID`

### How to get the API Key (Private Integration Token):

**Option A: Location API Key (simpler, recommended for single-location)**
1. In your GHL sub-account, go to **Settings > Business Profile**
2. Scroll down to find the **API Key** section
3. Copy the Location API key

**Option B: Private Integration (recommended for production)**
1. Go to **Settings > Integrations** in your GHL account
2. Click **"Private Integrations"** tab
3. Click **"Create Private Integration"**
4. Name it (e.g. "Sales Dashboard")
5. Under **Scopes**, enable:
   - `contacts.readonly` - Read contacts and tags
   - `opportunities.readonly` - Read pipeline opportunities
   - `calendars.readonly` - Read calendar events and appointments
   - `locations.readonly` - Read location info
6. Click **"Create"**
7. Copy the generated **API Token** - this is your `VITE_GHL_API_KEY`

### After setup - Map GHL User IDs:

Each team member who appears on GHL calendars has a GHL User ID. You need to map these to `team_members` in Supabase:

1. In GHL, go to **Settings > Team Management**
2. Click on each team member to see their profile
3. Their User ID is in the URL (e.g. `https://app.gohighlevel.com/users/USERID`)
4. Alternatively, run `node scripts/find-ghl-users.mjs` which scans calendar data for user IDs
5. Update Supabase:
   ```sql
   UPDATE team_members SET ghl_user_id = 'their-ghl-user-id' WHERE name = 'TeamMemberName';
   ```

---

## 3. WAVV Dialer (OPTIONAL - Required for setter dial metrics)

WAVV is a power dialer that integrates with GHL. Data enters the dashboard two ways: via GHL contact tags and via direct call records.

### Important: No Trial Currently Set Up

Your team does not currently have an active WAVV account. The dashboard will work without it - setter dial metrics (dials, pickups, meaningful conversations) will simply show zero until WAVV is configured.

### When you're ready to set up WAVV:

#### Step 1: Create a WAVV account
1. Go to https://www.wavv.com and sign up
2. Connect WAVV to your GHL account (WAVV has a native GHL integration)
3. Set up your dialer campaigns and assign setters

#### Step 2: Configure WAVV dispositions to tag GHL contacts
WAVV can apply tags to GHL contacts based on call outcomes. Configure these disposition-to-tag mappings in WAVV:

| WAVV Disposition | GHL Tag to Apply |
|-----------------|-----------------|
| No Answer | `wavv-no-answer` |
| Left Voicemail | `wavv-left-voicemail` |
| Bad Number | `wavv-bad-number` |
| Interested | `wavv-interested` |
| Appointment Set | `wavv-appointment-set` |
| Not Interested | `wavv-not-interested` |
| Callback Requested | `wavv-callback` |
| Do Not Contact | `wavv-do-not-contact` |

If you use different tag names, update the tag sets in `src/services/ghlPipeline.js` (lines 11-24).

#### Step 3: Set up Zapier integration for call records
1. Create a Zapier account (or use Make/n8n)
2. Create a new Zap:
   - **Trigger**: WAVV > "Call Completed"
   - **Action**: Supabase > "Create Row" in `wavv_calls` table
3. Map the fields:
   | WAVV Field | Supabase Column |
   |-----------|----------------|
   | Call ID | `call_id` |
   | Contact Name | `contact_name` |
   | Phone Number | `phone_number` |
   | Started At | `started_at` |
   | Duration (seconds) | `call_duration` |
   | User ID | `user_id` |
   | Team ID | `team_id` |

#### Step 4: Map WAVV user IDs to team members
1. After making some test calls, query: `SELECT DISTINCT user_id FROM wavv_calls;`
2. Match each user_id to a team member
3. Update Supabase:
   ```sql
   UPDATE team_members SET wavv_user_id = 'wavv-user-id' WHERE name = 'SetterName';
   ```

#### Alternative: CSV Import
If you don't want real-time Zapier sync, you can bulk import WAVV call data:
```bash
node scripts/import-wavv-csv.mjs < wavv_export.csv
```

---

## 4. Meta Ads API (OPTIONAL - Required for marketing performance page)

### What you need:
- `VITE_META_ADS_ACCOUNT_ID` - Your ad account ID
- `VITE_META_ADS_ACCESS_TOKEN` - API access token with `ads_read` scope

### How to get the Ad Account ID:

1. Go to https://business.facebook.com
2. Click **Business Settings** (gear icon)
3. Under **Accounts**, click **"Ad Accounts"**
4. Select your ad account
5. The **Ad Account ID** is shown (numeric, e.g. `2823980217854527`)
6. This is your `VITE_META_ADS_ACCOUNT_ID`

### How to get the Access Token:

**Option A: System User Token (recommended for production)**
1. In **Business Settings > Users > System Users**
2. Click **"Add"** to create a system user (or use existing)
3. Set role to **Admin**
4. Click **"Add Assets"** and assign the ad account with full access
5. Click **"Generate New Token"**
6. Select permissions: `ads_read` (minimum required)
7. Set token expiration (recommend "Never" for a dashboard)
8. Copy the token - this is your `VITE_META_ADS_ACCESS_TOKEN`

**Option B: Graph API Explorer (for testing)**
1. Go to https://developers.facebook.com/tools/explorer/
2. Select your app (or create one)
3. Click **"Generate Access Token"**
4. Select `ads_read` permission
5. Copy the token

**Note**: Explorer tokens expire in ~1 hour. For production, use a System User token.

### Token Renewal:
System User tokens with "Never" expiry don't need renewal. If you chose a limited expiry, you'll need to regenerate the token before it expires and update it in both your `.env` and Render environment variables (then redeploy).

---

## 5. Hyros API (OPTIONAL - Required for server-side attribution/ROAS)

Hyros provides server-side tracking that's more accurate than Facebook pixel attribution for high-ticket sales.

### What you need:
- `VITE_HYROS_API_KEY` - Hyros API key

### How to get it:

1. Log in to https://app.hyros.com
2. Go to **Settings** (gear icon)
3. Click **"API"** or **"Integrations"**
4. Generate or copy your API key
5. This is your `VITE_HYROS_API_KEY`

### If you don't use Hyros:
The dashboard will work without it. The Marketing Performance page will show spend and lead data from Meta Ads but won't have server-side revenue attribution or accurate ROAS calculations. You can still manually enter revenue data via the marketing_tracker table.

---

## 6. Fathom API (OPTIONAL - Required for call transcript analysis)

Fathom records and transcribes sales calls, enabling AI-powered objection analysis.

### What you need:
- `VITE_FATHOM_API_KEY` - Fathom API key

### How to get it:

1. Log in to https://app.fathom.video
2. Go to **Settings** (gear icon)
3. Click **"Integrations"** or **"API"**
4. Generate an API key
5. This is your `VITE_FATHOM_API_KEY`

### If you don't use Fathom:
The dashboard will work without it. Closer detail pages won't show call transcripts or AI-generated objection analysis. You can still track closer performance via EOD reports.

---

## Summary: All Credentials

| Variable | Service | Where to Get It | Required? |
|----------|---------|----------------|-----------|
| `VITE_SUPABASE_URL` | Supabase | Dashboard > Settings > API > Project URL | Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase | Dashboard > Settings > API > `anon` key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Dashboard > Settings > API > `service_role` key | Scripts only |
| `VITE_GHL_API_KEY` | Go High Level | Settings > Business Profile > API Key (or Private Integration) | Yes |
| `VITE_GHL_LOCATION_ID` | Go High Level | Settings > Business Profile > Location ID | Yes |
| `VITE_META_ADS_ACCOUNT_ID` | Meta/Facebook | Business Settings > Ad Accounts > Account ID | Optional |
| `VITE_META_ADS_ACCESS_TOKEN` | Meta/Facebook | Business Settings > System Users > Generate Token (ads_read) | Optional |
| `VITE_HYROS_API_KEY` | Hyros | Settings > API | Optional |
| `VITE_FATHOM_API_KEY` | Fathom | Settings > Integrations/API | Optional |
| `VITE_NZD_TO_USD` | N/A | Set manually if not using USD (e.g. `0.60`) | Optional |

---

## Where to Put the Keys

### For local development:
Create a `.env` file in the project root (it's already in `.gitignore`):
```env
VITE_SUPABASE_URL=https://yourproject.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
VITE_GHL_API_KEY=pit-xxxx...
VITE_GHL_LOCATION_ID=abc123...
VITE_META_ADS_ACCOUNT_ID=123456789
VITE_META_ADS_ACCESS_TOKEN=EAAI...
VITE_HYROS_API_KEY=hyros_xxx...
VITE_FATHOM_API_KEY=fathom_xxx...
```

### For production (Render):
1. Go to your Render dashboard
2. Select the Sales Dashboard service
3. Click **"Environment"** tab
4. Add each variable as a key-value pair
5. Click **"Save Changes"** - this triggers a rebuild

**Remember**: These are build-time variables. Every change requires a new build/deploy to take effect.

---

## Security Notes

1. **`VITE_*` variables are public** - They're embedded in the JavaScript bundle served to browsers. This is unavoidable for a static SPA. Do not put secrets that shouldn't be client-visible here.
2. **GHL API key exposure** - The GHL API key is in the browser bundle. Use a Private Integration with minimal scopes (read-only for contacts, opportunities, calendars).
3. **Meta Ads token exposure** - Similarly visible in the bundle. Use a System User with only `ads_read` scope.
4. **Service role key** - NEVER put this in a `VITE_*` variable or commit it. Only use it in scripts run locally.
5. **For higher security** - Consider adding a backend proxy (Express/Node) that holds the API keys server-side and exposes only the data the frontend needs. This would require changing the deployment from a static site to a web service.
