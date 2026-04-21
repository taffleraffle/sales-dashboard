# Sales Dashboard Architecture

## System Overview

The Sales Dashboard is a React SPA that provides OPT Digital's sales team with real-time performance metrics, commission tracking, and pipeline visibility. It connects to multiple external services through a Supabase backend.

## Component Architecture

```
Browser (React SPA)
  |
  +-- Supabase Client (anon key, RLS-enforced)
  |     |
  |     +-- Auth (email/password, invite flow)
  |     +-- Database (PostgreSQL via PostgREST)
  |     +-- Edge Functions (Deno)
  |
  +-- Direct API Calls (client-side, VITE_ keys)
        +-- GoHighLevel API (calendar, pipeline, contacts)
        +-- Fathom API (call transcripts)
        +-- Meta Ads API (ad performance)
        +-- WAVV (dialer data)
        +-- Hyros (attribution)
```

## Data Flow

### Inbound Payments
1. Stripe/Fanbasis send webhooks to Edge Functions
2. Edge Functions verify signatures, extract payment data
3. `matchPayment.ts` auto-matches to clients via email domain + company name
4. Matched payments stored in `payments` table
5. Commission calculation runs against `commission_settings`

### Setter/Closer Metrics
1. Setter data from `setter_leads`, `setter_daily_stats` tables
2. Closer data from `closer_calls`, `closer_eod` tables
3. Show rate calculated from closer EOD daily aggregates (booked/live per date)
4. **WARNING:** `closer_calls.setter_lead_id` is always null — correlation is name+date only

### GHL Integration
1. Pipeline data fetched live from GHL API
2. Calendar/appointments fetched live (the `ghl_appointments` table is stale)
3. Endangered leads detection uses live GHL API, not cached table

## Authentication & Authorization

- Supabase Auth with email/password
- `team_members` table links auth users to profiles
- `role` field: "admin" or "member"
- Admin gates: Settings page, commission admin views, team management
- Non-admins see only their own commission detail page
- Invite flow: admin sends invite -> user sets password on first login

## Database Schema (Key Tables)

- `team_members` — staff profiles, roles, auth linkage
- `closer_calls` — call records from closers
- `closer_eod` — end-of-day closer reports
- `setter_leads` — leads assigned to setters
- `setter_daily_stats` — daily setter KPIs
- `payments` — Stripe/Fanbasis payment records
- `clients` — client records with trial/ascension dates
- `commission_settings` — rate configs per commission type
- `commission_ledger` — calculated commission entries
- `engagement_cadences` — setter bot cadence configs
- `engagement_conversations` — bot conversation logs

## Deployment

- **Frontend:** Render static site, builds with `npm run build`, SPA rewrite rule
- **Edge Functions:** Deployed via `supabase functions deploy`
- **Database:** Supabase managed PostgreSQL (project kjfaqhmllagbxjdxlopm)
