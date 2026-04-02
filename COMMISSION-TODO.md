# Commission Tracker — Outstanding Work

## Critical Fixes

### 1. Client Editing UX Overhaul
- **Current**: Inline row editing changes row sizing, cramped inputs, bad save/cancel icons
- **Fix**: Replace with a slide-out panel or modal when clicking edit — full-width form fields, proper labels, Save/Cancel buttons at the bottom
- **Include**: All client fields (name, company, email, phone, closer, setter, stage, monthly amount, trial amount, billing day, next billing date, payment count, notes)

### 2. Payment Unmatch / Re-match
- **Current**: Once a payment is matched, there's no way to unmatch or change the match
- **Fix**: Add an "unmatch" button (X icon) next to matched client name on payments tab
- **Fix**: Show "Manually Edited" tag on payments that were manually matched/unmatched
- **Fix**: Allow re-matching to a different client via the same dropdown

### 3. Country Column
- **Current**: Country emoji crammed next to client name
- **Fix**: Separate "Country" column with flag emoji + country name (e.g. 🇺🇸 US, 🇳🇿 NZ, 🇦🇺 AU)
- **Derive from**: Phone prefix (+1 = US, +64 = NZ, +61 = AU, +44 = UK) or email TLD

### 4. Commission Rates Not Set
- **Ben's rate is 0%** — needs to be set in Settings tab (member ID: 1cfdcf02)
- 35 of 60 matched payments have clients with no closer/setter assigned — need to assign via client edit

### 5. Click Responsiveness / Loading States
- **Current**: Clicking buttons (delete, save, sync) has no instant feedback — feels broken
- **Fix**: Every button click should immediately show a loading state (spinner, opacity change, disabled state)
- **Fix**: Optimistic UI where possible — show change immediately, revert on error

---

## UX Improvements

### 6. Consistent Input Styling
- All inputs: `rounded-xl`, yellow focus glow, consistent padding
- All selects: custom chevron, matching dark theme
- Date pickers: dark color-scheme, matching border/focus styles
- Number inputs: allow clearing to empty (no snap-to-zero)

### 7. Smooth Animations
- Expand/collapse (Add Client, Add Payment forms): slide in/out with `max-height` transition
- Row delete: fade out animation before removal
- Tab switching: smooth content transition
- Modal/panel open: slide from right with backdrop

### 8. Hover Effects
- KPI cards: subtle neon yellow glow ring on hover ✅ Done
- Table rows: yellow tint on hover ✅ Done
- Client names: highlight yellow on hover ✅ Done
- Buttons: consistent hover transitions

### 9. Capitalization Consistency
- Table headers: UPPERCASE, 10px, tracking-wider
- Form labels: UPPERCASE, 10px, font-medium
- Values: normal case
- Status badges: capitalize

---

## Features

### 10. Bulk Client Import Improvements
- Excel template download ✅ Done
- CSV preview before import ✅ Done
- Date format auto-conversion (DD/MM/YYYY → YYYY-MM-DD) ✅ Done
- **TODO**: Pull clients from GHL pipelines (closed deals)
- **TODO**: Detect and skip duplicate imports (by email)

### 11. Payment Blacklist
- "Rank On Maps" payments filtered from display ✅ Done
- **TODO**: Admin-configurable blacklist (not hardcoded)

### 12. Transaction History Per Client
- Transaction count column ✅ Done
- **TODO**: Click to see full payment history for that client
- **TODO**: Show payment timeline (trial → month 1 → month 2 → month 3)

### 13. Commission Forecasting
- Forecast column on client table ✅ Done
- **TODO**: Monthly forecast chart showing expected vs actual commission
- **TODO**: Upcoming payments calendar (based on billing_day + next_billing_date)

### 14. Non-Admin View
- Non-admin users see only their own commission detail ✅ Done
- **TODO**: Verify setter/closer can't access other members' data via URL manipulation

---

## Integration

### 15. Stripe Webhook ✅ Live
- Endpoint: `https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/stripe-webhook`
- Events: checkout.session.completed, invoice.payment_succeeded, charge.succeeded
- Auto-matches by email → phone → name → GHL lookup
- USD conversion for NZD/AUD/GBP

### 16. Fanbasis Webhook ✅ Live
- Endpoint: `https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/fanbasis-webhook`
- Subscription ID: 23434
- Events: payment.succeeded, subscription.created/renewed/completed, product.purchased
- Parses buyer.email, buyer.name, total_price, application_fee_amount

### 17. Stripe Sync (Pull Historical) ✅ Live
- Edge Function: sync-stripe-payments
- Pulls last 90 days, expands customer object for real names
- Deduplicates by charge ID

### 18. Auto Commission Calculation ✅ Live
- Runs on page load via useEffect
- Only processes payments without existing commission entries
- Respects 0-3 month commission window from trial_start_date

---

## Database Schema

### Tables
- `clients` — name, email, phone, company, closer_id, setter_id, stage, billing_day, next_billing_date, payment_count, monthly/trial amounts
- `payments` — source (stripe/fanbasis/manual), amount/fee/net, customer info, matched boolean, client_id FK
- `commission_settings` — per-member: pay_type (base/ramp), base_salary, ramp_amount, commission_rate
- `commission_ledger` — per-payment commission entries: member_id, payment_id, client_id, period, type, amount, rate, status

### Migrations
- 007_commission_tracker.sql — core tables
- 008_commission_ramp.sql — pay_type + ramp_amount
- 009_client_billing.sql — billing_day, next_billing_date, payment_count, payment_number

---

## Tech Debt
- Commission calculation runs client-side (should be server-side Edge Function for reliability)
- Payment matching fuzzy logic sometimes matches wrong client (e.g. "Maia Food" → "alex guerra")
- No audit trail for manual edits (who matched what, when)
- Stripe sync is manual (button click) — could be cron-scheduled
- No duplicate prevention on commission_ledger (same payment could theoretically get double-entered)
