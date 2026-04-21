# Sales Dashboard API Reference

## Supabase Edge Functions

All Edge Functions are deployed at:
```
https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/<function-name>
```

### stripe-webhook
**POST** `/functions/v1/stripe-webhook`
- Receives Stripe payment webhooks
- Verifies `stripe-signature` header against `STRIPE_WEBHOOK_SECRET`
- Auto-matches payments to clients via email domain + company name
- Creates commission entries when matched

### fanbasis-webhook
**POST** `/functions/v1/fanbasis-webhook`
- Receives Fanbasis payment notifications
- Same matching logic as Stripe webhook

### sync-fathom
**POST** `/functions/v1/sync-fathom`
- Syncs call transcripts from Fathom API
- Called manually or on schedule

### sync-stripe-payments
**POST** `/functions/v1/sync-stripe-payments`
- Batch sync of Stripe payment history
- Used for backfilling, not real-time

### calculate-commissions
**POST** `/functions/v1/calculate-commissions`
- Recalculates commission ledger entries from payments
- Uses commission_settings rates per type (trial_close, ascension, recurring)

### analyze-objections
**POST** `/functions/v1/analyze-objections`
- AI analysis of call transcript objections
- Returns categorized objection patterns

### sales-chat
**POST** `/functions/v1/sales-chat`
- AI chat endpoint for sales intelligence queries
- Grounded in call data and pipeline context

### admin-reset-password
**POST** `/functions/v1/admin-reset-password`
- Admin-only: resets a team member's password
- Requires admin auth token

### invite-team-member
**POST** `/functions/v1/invite-team-member`
- Admin-only: sends email invite to new team member
- Creates auth user + team_members row

## External APIs (Client-Side)

### GoHighLevel (GHL)
- **Base URL:** `https://services.leadconnectorhq.com`
- **Auth:** `VITE_GHL_API_KEY` as Bearer token
- **Used for:** Calendar events, pipeline stages, contact data, appointments
- **Key files:** `src/services/ghlCalendar.js`, `src/services/ghlPipeline.js`, `src/services/ghlEmailFlows.js`

### Fathom
- **Used for:** Call transcripts and recordings
- **Key file:** `src/services/fathomApi.js`, `src/services/fathomSync.js`

### Meta Ads
- **Used for:** Ad spend, impressions, conversions
- **Key file:** `src/services/metaAdsSync.js`

### WAVV
- **Used for:** Dialer call data (duration, outcome)
- **Key file:** `src/services/wavvService.js`

### Hyros
- **Used for:** Lead attribution tracking
- **Key file:** `src/services/hyrosSync.js`
