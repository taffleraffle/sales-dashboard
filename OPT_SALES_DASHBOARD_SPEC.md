# OPT Digital — Unified Sales Dashboard: Full Build Specification

> **What this document is:** The single source of truth for building the OPT Digital Sales Dashboard as a new module within the existing Command Centre architecture. Contains everything a developer or AI coding agent needs: business context, sales process, existing code/data model, what to build, how to split the work, and every question that needs answering.
>
> **Who this is for:** Ben Hobbs (business owner, has all system access) and Will (collaborator). You're splitting the work 50/50 across non-overlapping chunks to ship in 48 hours.
>
> **How to use this:** Read sections 1–8 for context. Section 9 is what we're building. Section 10 is the database schema. Section 11 is UI/UX. Section 12 is the chunk-by-chunk build plan with clear ownership assignments. Section 13 is questions only Ben can answer — resolve these before starting.

---

## Table of Contents

1. [Business Context](#1-business-context)
2. [The Sales Funnel — End to End](#2-the-sales-funnel--end-to-end)
3. [The Sales Team & Roles](#3-the-sales-team--roles)
4. [The Offer & Pricing Structure](#4-the-offer--pricing-structure)
5. [Current Tech Stack & Integrations](#5-current-tech-stack--integrations)
6. [Existing Codebase — What's Already Built](#6-existing-codebase--whats-already-built)
7. [Key Metrics & Benchmark Targets](#7-key-metrics--benchmark-targets)
8. [Known Issues & Pain Points](#8-known-issues--pain-points)
9. [What We're Building — The Five Sections](#9-what-were-building--the-five-sections)
10. [Data Model & Schema](#10-data-model--schema)
11. [UI/UX Requirements & Design System](#11-uiux-requirements--design-system)
12. [Build Plan — Chunked for Parallel Work (48 Hours)](#12-build-plan--chunked-for-parallel-work-48-hours)
13. [Questions for Ben — Must Resolve Before Building](#13-questions-for-ben--must-resolve-before-building)
14. [Appendix A: Existing Database Models (Reference)](#appendix-a-existing-database-models-reference)
15. [Appendix B: Existing API Endpoints (Reference)](#appendix-b-existing-api-endpoints-reference)
16. [Appendix C: GHL Pipeline Stage Map & IDs](#appendix-c-ghl-pipeline-stage-map--ids)

---

## 1. Business Context

**OPT Digital** (optdigital.io) is a New Zealand-based local SEO and digital marketing agency serving tradespeople and restoration companies across Australia, New Zealand, and the United States.

**Revenue model:** Short paid trials (2 weeks, ~$997 USD) that convert to monthly retainers ($3,000/mo USD) with no long-term contracts. Some clients pay in full (PIF) via Fanbasis financing (~$8,000 for 3 months upfront).

**Current scale (early 2026):**
- Monthly revenue: ~$85K–$117K NZD, trending upward
- ~25+ active client accounts
- LTV:CAC ratio: ~10:1 ($29,000 NZD LTV, ~$2,910 NZD CAC)
- Currently loss-making but improving month-over-month (Jan -27% net → Feb -17% net)
- Target margins: 80% gross, 50% net

**Why this dashboard matters:** The single biggest lever for the business is trial volume — the team is built for 5–6 trials/week but running at 2–3. Ad performance degraded (CPL $40→$120, lead-to-booking 40%→17%). This dashboard gives end-to-end visibility from ad dollar spent to cash collected, attributed to the individual who generated it.

---

## 2. The Sales Funnel — End to End

```
┌─────────────────────────────────────────────────────────────────┐
│                     ACQUISITION FUNNEL                          │
│                                                                 │
│  Facebook/Meta Ads                                              │
│       ↓                                                         │
│  Lead Form (landing page)                                       │
│       ↓                                                         │
│  VSL Thank You Page (video plays while they wait)               │
│       ↓                                                         │
│  ┌─────────────┐         ┌──────────────────┐                   │
│  │  AI Triage   │   OR   │  Setter Cold Call │                   │
│  │ (auto-book)  │         │  (manual dial)    │                   │
│  └──────┬──────┘         └────────┬─────────┘                   │
│         └──────────┬──────────────┘                              │
│                    ↓                                             │
│  Closer Strategy Call (45–90 min consultative audit)            │
│       ↓                                                         │
│  Trial Close ($997 USD, 2-week diagnostic)                      │
│       ↓                                                         │
│  Ascension ($3,000/mo retainer, months 0–3)                     │
│       ↓                                                         │
│  MRR (month 3+, stable recurring, no sales commission)          │
└─────────────────────────────────────────────────────────────────┘
```

### Stage-by-Stage Detail

**Stage 1 — Lead Generation (Marketing)**
- Traffic: Meta (Facebook/Instagram) ads, managed by Kyryl via Next Wave
- Leads fill form on landing page → auto-created in GoHighLevel (GHL) CRM
- Enter SCIO Pipeline at "New Leads" stage
- Ad spend: historically ~$6K–$7K/week

**Stage 2 — Lead Working (Setters)**
- Two paths:
  - **Auto-booked (AI Triage):** Lead books intro call via AI calendar → flows through Auto-booked Triage → Triage Confirmed → Set Call stages
  - **Manual (Setter-dialed):** Setters use Wavv auto-dialer → tags added to GHL contact per dial attempt → leads progress through Contact 1→2→3→4+ stages
- Speed-to-lead target: < 5 minutes from lead creation to first contact
- Qualified leads booked onto closer's calendar → moved to "Set Call" stage
- Setter submits daily EOD: leads worked, outbound calls, pickups, MCs, sets, reschedules

**Stage 3 — Strategy Call (Closer)**
- 45–90 min consultative call with live SEO audit (screen-shared)
- Outcomes:
  - Showed + Closed → $997 payment → "Closed" stage → webhook → client auto-created
  - Showed + Not Closed → "Follow Ups" / "Nurture"
  - No Show → "No Show (Confirmed/Closer)"
  - Rescheduled → stays in Set Call stages
- Closer submits daily EOD: calls booked, no-shows, live calls, offers, closes, revenue

**Stage 4 — Trial (2 Weeks)**
- $997 USD diagnostic. Deliverables: GMB setup, review blast, backlinks, content map, homepage concept
- Austin (Client Success Director) runs ascension call at day 14
- Target conversion: ~70%

**Stage 5 — Ascension (Months 0–3)**
- $3,000/mo retainer. Most expensive fulfillment stage. Some clients PIF via Fanbasis (~$8K upfront)
- Sales commission still paid

**Stage 6 — MRR (Month 3+)**
- Same $3,000/mo. Costs stabilize, no sales commission. Healthy margin stage.

### Two Lead Paths — Important for Data

Dashboard must distinguish **auto-booked** (AI triage) vs **manual** (setter-dialed) leads:
- Auto-booked: No dial metrics. Track show rate, close rate, no-show rate only.
- Manual: Full dial funnel (dials → pickups → MCs → sets) PLUS show/close/no-show rates.
- Classification: check if contact has an appointment on an intro calendar (auto) vs none (manual).

---

## 3. The Sales Team & Roles

### Current Active Team

| Name | Role | DB Flags | Notes |
|------|------|----------|-------|
| Daniel Gomez | Closer | `is_closer=True` | Primary closer. Strong on audits, weaker on closing. |
| Josh Stolz | Setter | `is_setter=True` | Good conversion once connected. Low pickup rates. |
| Leandre | Setter | `is_setter=True` | Inconsistent. Zero-set days. Needs coaching. |
| Austin Parker | Client Success Director | `department='sales'` | 23+ accounts. Onboarding + ascension calls. |
| Valeria Perez | Account Manager | `department='sales'` | Client management support. |

### DB Identification

Sales team stored in `AccountManager` model:
- `department = 'sales'`
- `is_closer = True` / `is_setter = True`
- `role` containing 'Sales', 'Closer', or 'Setter'
- `ghl_user_id` — maps GHL assignedTo → this person
- `commission_rate` — percentage (e.g., 10 = 10%)

### Commission

```
commission_basis = trial_fee + (retainer × months_in_ascension up to 90 days)
commission_earned = commission_basis × (commission_rate / 100)
```

---

## 4. The Offer & Pricing Structure

| Stage | Default Price | Currency | Method | Notes |
|-------|--------------|----------|--------|-------|
| Trial | $997 | USD | Stripe/Fanbasis | 2-week diagnostic. Sometimes $1,400. Variable input. |
| Ascension | $3,000/mo | USD | Stripe/Fanbasis | Range $1,500–$5,000 per client. |
| PIF | ~$8,000 | USD | Fanbasis | 3 months upfront (discounted from $9K). Fanbasis pays OPT immediately. |
| MRR | $3,000/mo | USD | Stripe/Fanbasis | No sales commission after 90 days. |

Currency: Trial fees USD. Retainers can be USD/NZD/AUD. Dashboard must handle multi-currency.

---

## 5. Current Tech Stack & Integrations

| System | Purpose | Sales Data Flow |
|--------|---------|----------------|
| GoHighLevel (GHL) | CRM, pipeline, calendars | Leads, opportunities, stages, appointments, tags |
| Wavv | Auto-dialer for setters | Tags on GHL contacts (no direct API) |
| Stripe | Payments (transitioning) | Trial + retainer. ~7.6% effective rate. |
| Fanbasis | Payments + BNPL | Replacing Stripe. 3.5% fees. PIF financing. |
| HYROS | Server-side ad attribution | Qualified/unqualified signals from GHL → Meta CAPI. $300/mo. |
| Meta Ads | Paid acquisition | FB/IG ads. Managed by Kyryl. |

### GHL API

```
Base URL: https://services.leadconnectorhq.com
Auth: Bearer token (Private Integration Token)
Version: 2021-07-28 (fallback 2021-04-15 for calendar events)
Pipeline ID: ZN1DW9S9qS540PNAXSxa (SCIO PIPELINE USA)
Rate limits: No explicit handling. 0.3s sleep every 10 fetches.
```

### Wavv Tags (via GHL contacts)

Each dial adds one `wavv-*` tag. Tags are cumulative with no timestamps.

```
Pickups: wavv-interested, wavv-appointment-set, wavv-not-interested, wavv-callback, wavv-do-not-contact
MCs: wavv-interested, wavv-appointment-set, wavv-not-interested, wavv-callback
Sets: wavv-appointment-set
```

### Source Repos

| Repo | Stack | Sales Relevance |
|------|-------|-----------------|
| `seo-tracker` | Flask + PostgreSQL | ALL existing sales code |
| `command-centre` | Node.js + Supabase | GHL webhooks, lifecycle, comms tracking |
| `content-pipeline` | Python + Slack | No sales code |

**New sales dashboard** = React module integrating into Command Centre architecture.

---

## 6. Existing Codebase — What's Already Built

### 6.1 GHL Pipeline Analytics Engine (`ghl_pipeline.py`, 935 lines)

Fetches ALL opportunities from SCIO pipeline, classifies by stage, calculates funnel metrics. Cached 15 min. Runs in background thread (~2 min execution).

Output includes: funnel counts, auto-booked vs manual breakdown with separate show/close/no-show rates, Wavv dialer metrics, speed-to-lead stats, per-stage dial performance, path analysis, 24h activity feed.

Async pattern: POST starts job → frontend polls GET every 3s → returns data when done.

### 6.2 Closer EOD + CloserCalls

`EODReport`: daily metrics (calls booked NC/FU, no-shows, live calls, offers, closes, revenue).
`CloserCall`: individual call entries linked to EOD, with `setter_lead_id` for attribution.

### 6.3 Setter EOD + SetterLeads

`SetterEODReport`: daily activity (leads, calls, pickups, MCs, sets) + self-assessment.
`SetterLead`: per-lead attribution linking setter → closer → outcome → revenue.

### 6.4 Marketing Tracker

`SalesTrackerEntry`: daily rows from CSV import. Full funnel from adspend through to all-cash ROAS.

### 6.5 GHL Webhooks

Appointment → HYROS push. Opportunity stage change → auto-create client (on close) or ascend (on ascension stage).

### 6.6 Setter Analytics UI (3-Tab)

Tab 1 Funnel: KPIs, auto vs manual comparison, path analysis, activity feed.
Tab 2 Speed to Lead: Avg/median/fastest/slowest, distribution, daily breakdown, unworked leads.
Tab 3 Dialer: Dials, pickup rate, MC rate, calls/set, per-stage breakdown.

---

## 7. Key Metrics & Benchmark Targets

### Marketing Funnel

| Metric | Target | Direction | Formula |
|--------|--------|-----------|---------|
| CPL | < $250 | below | adspend / leads |
| Lead→Booking % | > 40% | above | bookings / leads |
| Cost/Booking | < $200 | below | adspend / bookings |
| Cancel DTF % | < 10% | below | cancelled_dtf / bookings |
| Cancel by Prospect % | < 20% | below | cancelled_prospect / bookings |
| Show Rate (NEW) | > 70% | above | live_nc / nc_booked |
| Show Rate (NET) | > 70% | above | net_calls / total_booked |
| Cost/Live Call | < $435 | below | adspend / live_calls |
| Offer Rate | > 80% | above | offers / live_calls |
| Close Rate | > 25% | above | closes / live_calls |
| CPA Trial | < $3,250 | below | adspend / closes |
| Trial UF Cash % | > 40% | above | trial_cash / trial_contracted |
| Trial FE ROAS | > 2.0x | above | trial_cash / adspend |
| Ascend Rate | > 50% | above | ascensions / closes |
| CPA Ascend | < $2,000 | below | adspend / ascensions |
| Revenue ROAS | > 3.5x | above | contracted_rev / adspend |
| All Cash ROAS | > 5.0x | above | all_cash / adspend |

### Setter

| Metric | Target | Formula |
|--------|--------|---------|
| Leads→Set % | > 5% | sets / leads |
| Dials→Set % | > 3% | sets / calls |
| MCs→Set % | > 40% | sets / MCs |
| Speed to Lead | < 5 min | time to first contact |
| Daily Sets | > 1.5 | avg sets/day |

### Closer

| Metric | Target | Formula |
|--------|--------|---------|
| Show Rate | > 70% | live / booked |
| Offer Rate | > 80% | offers / live |
| Close Rate | > 25% | closes / live |
| Ascension Rate | > 70% | ascended / trials |
| PIF Rate | track | pif_count / total_closes |
| Avg Deal Size | track | total_revenue / closes |

---

## 8. Known Issues & Pain Points

1. **Ad performance crisis:** CPL $40→$120, lead-to-booking 40%→17%. HYROS purchased to fix pixel optimization.
2. **Speed-to-lead is a proxy:** Uses GHL stage change time, not actual first-dial time. Auto-booked leads inflate stats.
3. **Per-setter GHL attribution is weak:** `assignedTo` sparsely populated. Best source is manual SetterLead records.
4. **GHL API is slow:** Full analytics ~2 min. Must run async with polling.
5. **Wavv tags are cumulative:** No timestamps, no date filtering.
6. **Currency mix:** USD trials, variable retainer currencies. Need conversion handling.
7. **Contact rate collapse:** Setters at ~50% potential. Possible spam flagging, lead quality, staleness issues.

---

## 9. What We're Building — The Five Sections

### Architecture

- **Frontend:** React + Vite, standalone app (NOT in Command Centre)
- **Database:** New Supabase instance (fresh start, direct JS client)
- **Styling:** Tailwind, dark navy, JetBrains Mono, OPT Yellow (#f5c518)
- **Charts:** Recharts
- **Data:** All API-driven. Meta Ads API + Hyros API + GHL Pipeline + Fathom API + Wavv tags. Auto-generated EODs where possible, manual review/confirm.
- **Time views:** Daily, 7-day, 30-day, MTD, custom range

### Section 1: Overview / Command View (`/sales`)

KPI cards (traffic-light vs benchmarks): Ad Spend, CPL, CPC, ROAS, CPA, Show Rate, Close Rate, Ascension Rate, PIF Count + PIF Rate, Active Trials.

**Full funnel visualization with conversion % at every step:**
```
Leads → % → Bookings → % → Shows → % → Offers → % → Closes → % → Ascensions
  |              |            |            |            |              |
 (from Meta)  (auto+manual)  (show rate)  (offer rate) (close rate)  (ascend rate)
```

How many leads does it take for a close? How many calls? Show the ratios.

**Auto-booking vs Manual comparison:** CPA, show rate, close rate side-by-side for auto-booked leads vs manually set leads.

Team quick-view cards: per-closer close rate, per-setter sets/day, with trend arrows.

Global date range selector with presets (Today, 7d, 30d, MTD, Custom).

### Section 2: Marketing Performance (`/sales/marketing`)

**All data pulled automatically from Meta Ads API + Hyros:**
- **Ad spend** — total + per campaign/ad set (from Meta)
- **CPL** — cost per lead (Meta spend / Meta leads)
- **CPC** — cost per click (from Meta)
- **ROAS** — return on ad spend (Hyros attributed revenue / Meta spend)
- **CPA** — cost per acquisition, broken down: auto-booking CPA vs manual set CPA
- **Auto-booking vs manual:** show rate and close rate for auto-booked leads vs manually set
- **Full funnel %:** What % of leads become bookings? What % of bookings show? What % of shows close? How many leads per close? How many calls per close?
- Trend charts: spend, CPL, ROAS over time
- Campaign/ad set drill-down

### Section 3: Closer Performance (`/sales/closers`, `/sales/closers/:id`)

**Overview:** Card per closer with period stats and gauges.

**Individual closer dashboard:**
- **Ascension rate** — what % of their trials ascend to monthly retainer
- **PIF rate** — how many Pay-in-Full deals, PIF count, PIF % of total closes
- **Show/Close rate gauges**
- Revenue cards (cash collected, PIF split, avg deal size)
- **Fathom call transcripts** — automatically pulled via Fathom API, matched to the closer's strategy calls by the prospect's email on the GHL calendar booking
- **Most common objections** — Claude analysis of Fathom transcripts per closer, surfacing recurring objection themes (e.g. "price too high", "need to think about it", "already working with someone")
- Attribution table (which setter's leads they close best)
- Daily trend, call log

**Fathom Integration:**
- Fathom API: `https://api.fathom.ai/external/v1/meetings` (already integrated in Command Centre)
- Auth: `X-Api-Key` header, env var `FATHOM_API_KEY`
- Match closer's calls by: GHL calendar event email → Fathom meeting invitee email
- Pull: transcript summary, action items, recording URL
- Objection analysis: batch transcripts through Claude API to extract and categorize objections per closer

### Section 4: Setter Performance (`/sales/setters`, `/sales/setters/:id`)

**Company-level metrics (overview page):**
- **Total dials** — from Wavv tags across all pipeline contacts
- **Total leads called** — unique contacts dialed
- **Meaningful conversations (MCs)** — wavv-interested + wavv-appointment-set + wavv-not-interested + wavv-callback
- **Sets** — meetings booked (wavv-appointment-set + GHL stage moves to Set Call)
- **Conversion rate** — sets / leads called, sets / total dials, MCs / dials

**Individual setter dashboard:**
- Same metrics as above but filtered to their assigned leads
- **Show rate per setter** — what % of THIS setter's booked meetings actually showed up
- **Auto-bookings vs manual sets** — how many of their leads were auto-booked (AI triage) vs manually set by the setter
- Conversion gauges (leads→set, dials→set, MCs→set)
- Attribution: close rate on their sets, revenue attributed
- Comparison vs other setters

### Section 5: EOD Reports — Auto-Generated, Manual Review (`/sales/eod`)

**Goal: Auto-generate EOD reports from API data. Closers/setters review and confirm, not fill from scratch.**

**Auto-generated Closer EOD:**
- Pull GHL calendar events for the day → count booked calls (NC/FU), shows, no-shows
- Pull Fathom transcripts for completed calls → match to calendar events
- Pre-fill: calls booked, live calls taken, no-shows, outcomes (from GHL opportunity stage changes)
- Closer reviews, adjusts if needed, adds notes, hits confirm
- Revenue/close data from GHL opportunity monetary values

**Auto-generated Setter EOD:**
- Pull Wavv dial data from GHL contact tags (new tags added today — compare tag count snapshots)
- Pre-fill: total dials, pickups, MCs, sets
- Pull GHL pipeline moves for leads they worked
- Setter reviews, adjusts if needed, adds self-assessment, hits confirm

**Attribution manager:** filterable table of all SetterLeads, inline status updates, summary stats.

---

## 10. Data Model & Schema

### Tables (Supabase/PostgreSQL)

#### `marketing_daily` — Auto-synced from Meta Ads API
```sql
CREATE TABLE marketing_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  campaign_id VARCHAR(100),
  campaign_name VARCHAR(300),
  adset_id VARCHAR(100),
  adset_name VARCHAR(300),
  spend NUMERIC(12,2) DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  leads INTEGER DEFAULT 0,
  cpc NUMERIC(10,4),
  cpl NUMERIC(10,4),
  ctr NUMERIC(8,4),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(date, campaign_id, adset_id)
);
```

#### `attribution_daily` — Auto-synced from Hyros API
```sql
CREATE TABLE attribution_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  campaign_id VARCHAR(100),
  campaign_name VARCHAR(300),
  revenue_attributed NUMERIC(12,2) DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  roas NUMERIC(10,4),
  event_tag VARCHAR(100),           -- 'call_booked', 'deal_closed', 'ascended'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(date, campaign_id, event_tag)
);
```

#### `closer_transcripts` — Auto-pulled from Fathom API
```sql
CREATE TABLE closer_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL,
  fathom_meeting_id VARCHAR(200) UNIQUE,
  prospect_name VARCHAR(200),
  prospect_email VARCHAR(200),
  meeting_date DATE,
  duration_seconds INTEGER,
  summary TEXT,                     -- Fathom auto-summary
  transcript_url VARCHAR(500),      -- Link to Fathom recording
  objections JSONB,                 -- Claude-extracted: [{category, quote, severity}]
  outcome VARCHAR(30),              -- closed, not_closed, no_show, follow_up
  revenue NUMERIC(10,2),
  ghl_calendar_event_id VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### `objection_analysis` — Claude-analyzed objection patterns per closer
```sql
CREATE TABLE objection_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  objection_category VARCHAR(200),  -- e.g. 'price', 'timing', 'competitor', 'trust'
  occurrence_count INTEGER DEFAULT 0,
  example_quotes JSONB,             -- Top 3 verbatim quotes
  win_rate NUMERIC(6,2),            -- % of times closer overcame this objection
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(closer_id, period_start, period_end, objection_category)
);
```

#### `closer_eod_reports`
```sql
CREATE TABLE closer_eod_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closer_id UUID NOT NULL,
  report_date DATE NOT NULL,
  nc_booked INTEGER DEFAULT 0,
  fu_booked INTEGER DEFAULT 0,
  nc_no_shows INTEGER DEFAULT 0,
  fu_no_shows INTEGER DEFAULT 0,
  live_nc_calls INTEGER DEFAULT 0,
  live_fu_calls INTEGER DEFAULT 0,
  reschedules INTEGER DEFAULT 0,
  offers INTEGER DEFAULT 0,
  closes INTEGER DEFAULT 0,
  deposits INTEGER DEFAULT 0,
  offer1_collected NUMERIC(10,2) DEFAULT 0,
  offer1_revenue NUMERIC(10,2) DEFAULT 0,
  offer2_collected NUMERIC(10,2) DEFAULT 0,
  offer2_revenue NUMERIC(10,2) DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  total_cash_collected NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(closer_id, report_date)
);
```

#### `closer_calls`
```sql
CREATE TABLE closer_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  eod_report_id UUID NOT NULL REFERENCES closer_eod_reports(id) ON DELETE CASCADE,
  call_type VARCHAR(20),
  prospect_name VARCHAR(200),
  showed BOOLEAN,
  outcome VARCHAR(20),
  revenue NUMERIC(10,2),
  cash_collected NUMERIC(10,2),
  setter_lead_id UUID REFERENCES setter_leads(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### `setter_eod_reports`
```sql
CREATE TABLE setter_eod_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_id UUID NOT NULL,
  report_date DATE NOT NULL,
  total_leads INTEGER DEFAULT 0,
  outbound_calls INTEGER DEFAULT 0,
  pickups INTEGER DEFAULT 0,
  meaningful_conversations INTEGER DEFAULT 0,
  unqualified INTEGER DEFAULT 0,
  sets INTEGER DEFAULT 0,
  reschedules INTEGER DEFAULT 0,
  self_rating INTEGER,
  what_went_well TEXT,
  what_went_poorly TEXT,
  overall_performance INTEGER,
  daily_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(setter_id, report_date)
);
```

#### `setter_leads` — The attribution backbone
```sql
CREATE TABLE setter_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_id UUID NOT NULL,
  closer_id UUID,
  lead_name VARCHAR(200) NOT NULL,
  lead_source VARCHAR(200),
  date_set DATE NOT NULL,
  appointment_date DATE,
  status VARCHAR(20) DEFAULT 'set',
  revenue_attributed NUMERIC(10,2),
  eod_report_id UUID REFERENCES setter_eod_reports(id),
  closer_eod_report_id UUID REFERENCES closer_eod_reports(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- Valid statuses: set, showed, no_show, rescheduled, cancelled, closed, not_closed
```

#### `sales_benchmarks`
```sql
CREATE TABLE sales_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key VARCHAR(100) NOT NULL UNIQUE,
  target_value NUMERIC(12,4) NOT NULL,
  direction VARCHAR(10) NOT NULL, -- 'above' or 'below'
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 11. UI/UX Requirements & Design System

### Design Tokens

```css
--bg-primary: #0a0e27;
--bg-card: #111638;
--bg-card-hover: #161b45;
--border-default: #1e2452;
--opt-yellow: #f5c518;
--opt-yellow-muted: rgba(245, 197, 24, 0.15);
--text-primary: #e2e8f0;
--text-secondary: #94a3b8;
--text-400: #64748b;
--green: #22c55e;
--amber: #f59e0b;
--red: #ef4444;
font-family: 'JetBrains Mono', monospace;
```

### Traffic Light Logic
```javascript
function getColor(value, target, direction) {
  if (direction === 'above') {
    if (value >= target) return 'green';
    if (value >= target * 0.8) return 'amber';
    return 'red';
  } else { // 'below'
    if (value <= target) return 'green';
    if (value <= target * 1.2) return 'amber';
    return 'red';
  }
}
```

### Component Patterns
- **KPI Card:** Small uppercase grey label → large bold number → subtitle with trend arrow
- **Gauge:** Semi-circular with target line
- **Charts:** Recharts, dark theme, OPT Yellow primary series
- **Tables:** Dark rows, subtle hover, sortable, alternating backgrounds
- **Date Selector:** Pill presets (Today, 7d, 30d, MTD) + custom picker
- **Tab Bar:** Yellow active, grey inactive, pill-style

### Mobile
EOD forms must be fully mobile-friendly (closers/setters submit from phone). Single-column on mobile, large touch targets.

---

## 12. Build Plan — Chunked for Parallel Work (48 Hours)

### Who's Who

| Person | Name | Role | Claude Instance |
|--------|------|------|-----------------|
| **Will** | Will (collaborator) | Person A — Marketing + Overview | Will's Claude |
| **Ben** | Ben Hobbs (owner) | Person B — Closers + Setters + EOD + Attribution | Ben's Claude |

---

### Shared Setup — WILL does this first (~1 Hour)

Will handles the initial project scaffolding since he's building the data layer (CSV import) that seeds everything. Ben can start immediately after Will pushes the setup commit.

1. Init React + Vite project
2. Tailwind CSS with design tokens (Section 11)
3. Supabase client utility (`src/lib/supabase.js`)
4. React Router with route structure
5. Shared components: KPICard, Gauge, DateRangeSelector, DataTable, getColor()
6. SQL migrations for all tables (Section 10) — run in Supabase SQL Editor
7. Push to GitHub on `main` branch

**Routes:**
```
/sales                    → Overview
/sales/marketing          → Marketing Performance
/sales/closers            → Closer Overview
/sales/closers/:id        → Individual Closer
/sales/setters            → Setter Overview
/sales/setters/:id        → Individual Setter
/sales/eod/closer         → Closer EOD Form
/sales/eod/setter         → Setter EOD Form
/sales/attribution        → Lead Attribution Manager
/sales/settings           → API Keys & Sync Config
```

**After setup:** Will pushes to `main`, Ben pulls, both branch off for their chunks.

---

### CHUNK 1 — WILL: Marketing + Overview (API-Driven, No Manual Entry)

**Branch:** `feature/marketing-overview`

**Philosophy: No manual data entry.** All marketing data is pulled automatically from APIs. No CSV uploads. The dashboard refreshes itself.

**Will builds:** Overview page, Marketing Performance page, Meta Ads API integration, Hyros API integration (pull side), metric calculations, benchmarks, settings page.

**Will's files (no overlap with Ben):**
```
src/pages/SalesOverview.jsx
src/pages/MarketingPerformance.jsx
src/pages/SettingsPage.jsx              # API key config, test connection, manual sync
src/hooks/useMarketingData.js
src/hooks/useBenchmarks.js
src/services/metaAdsApi.js              # Meta Marketing API client
src/services/hyrosApi.js                # Hyros reporting/pull API client
src/utils/metricCalculations.js
```

#### Data Sources

**1. Meta Ads API** — daily ad performance (automated pull):
- Ad spend (total + per campaign/ad set)
- Impressions, clicks, CTR
- Leads (form submissions)
- CPL, CPC
- Campaign/ad set breakdown
- API: `https://graph.facebook.com/v21.0/act_{ad_account_id}/insights`
- Auth: System User token (long-lived)
- Env vars: `META_ADS_ACCESS_TOKEN`, `META_ADS_ACCOUNT_ID`

**2. Hyros API** — revenue attribution (automated pull):
- Revenue attributed per ad/campaign (which spend drove which sales)
- ROAS per campaign/ad set
- Conversion funnel: lead → call_booked → deal_closed → ascended
- API: `https://api.hyros.com/v1/api`
- Auth: `API-Key` header
- Env var: `HYROS_API_KEY` (already exists)
- NOTE: The existing Flask app only PUSHES events to Hyros. Will needs to build the PULL/reporting side.

**3. GHL Pipeline Analytics** — funnel/dialer/speed-to-lead:
- Consumed from existing Flask endpoint: `GET dashboard.optdigital.io/api/setter-analytics?days=N`
- Cross-origin — needs CORS headers on Flask app (see Integration section)
- NOT rebuilt — reused as-is

#### Data Flow
```
Meta Ads API  →  Daily auto-sync  →  Supabase `marketing_daily`    →  Dashboard
Hyros API     →  Daily auto-sync  →  Supabase `attribution_daily`  →  Dashboard
GHL Analytics →  On-demand poll   →  Proxied from Flask app         →  Dashboard
```

#### Sync Strategy
- Supabase Edge Function or cron syncs Meta + Hyros data daily (midnight UTC)
- "Refresh Now" button on Settings page for manual sync
- Dashboard reads from Supabase cache — instant loads, no waiting for API calls
- Date range queries hit cached tables, not APIs directly

**Task order:**
1. Meta Ads API service — auth, fetch daily insights, campaign breakdown, store in Supabase
2. Hyros API service — auth, fetch attribution/revenue reporting data, store in Supabase
3. Supabase tables: `marketing_daily` (spend/leads/impressions), `attribution_daily` (revenue/ROAS per campaign)
4. Settings page — API key config, test connection buttons, manual sync trigger, last-synced timestamp
5. metricCalculations.js — derived formulas (ROAS, CPA, CPL trends) + getColor() + trend calcs
6. Benchmarks hook — fetch/seed/update sales_benchmarks table
7. Overview page — KPI cards, funnel viz, team quick-view, date selector
8. Marketing page — spend vs revenue charts, campaign breakdown, ROAS trends, CPL trends, Meta Ads drill-down

**Zero dependencies on Ben's chunk.**

---

### CHUNK 2 — BEN: Closers + Setters + EOD + Attribution + Fathom

**Branch:** `feature/closers-setters-eod`

**Ben builds:** Closer pages (with Fathom transcripts + objection analysis), setter pages, auto-generated EOD forms, lead attribution manager.

**Ben's files (no overlap with Will):**
```
src/pages/CloserOverview.jsx
src/pages/CloserDetail.jsx              # Includes transcript feed + objections panel
src/pages/SetterOverview.jsx
src/pages/SetterDetail.jsx
src/pages/EODReview.jsx                 # Auto-generated EOD, review + confirm
src/pages/LeadAttribution.jsx
src/hooks/useCloserData.js
src/hooks/useSetterData.js
src/hooks/useFathomTranscripts.js       # Pull + match Fathom recordings to closers
src/hooks/useLeadAttribution.js
src/services/fathomApi.js               # Fathom API client
src/services/ghlCalendarApi.js          # GHL calendar events for EOD auto-gen
src/components/TranscriptCard.jsx       # Fathom transcript summary card
src/components/ObjectionChart.jsx       # Most common objections visualization
src/components/LeadStatusBadge.jsx
src/components/EODAutoFill.jsx          # Auto-populated EOD with edit/confirm
```

**Task order:**
1. Fathom API service — fetch meetings, match to closers via GHL calendar booking email
2. GHL calendar service — fetch daily events for auto-EOD generation
3. Auto-EOD review page — pre-filled from GHL + Wavv data, closer/setter reviews and confirms
4. Closer Overview — cards with ascension rate, PIF rate, close rate per closer
5. Closer Detail — gauges, Fathom transcript feed, objection analysis (Claude), PIF count, revenue
6. Setter Overview — company-level: total dials, leads called, MCs, sets, conversion rates
7. Setter Detail — individual: same metrics, show rate per setter, auto-bookings vs manual sets
8. Lead Attribution — filterable table, inline status updates, summary stats
9. Objection analysis — batch Fathom transcripts through Claude API, categorize per closer, store results

**Closer-specific metrics:**
- Ascension rate (trials → monthly retainer)
- PIF rate (pay-in-full count and % of closes)
- Most common objections from Fathom transcripts (Claude-analyzed)
- Show rate, close rate, avg deal size

**Setter-specific metrics:**
- Total dials, total leads called, MCs, sets (from Wavv tags via GHL)
- Conversion rate at company level AND per individual setter
- Show rate per setter (what % of THIS setter's sets showed)
- Auto-bookings vs manual sets per setter

**Fathom → Closer matching logic:**
1. Pull GHL calendar events for strategy calendars (closer calls)
2. Each event has contact email from the booking
3. Pull Fathom meetings via API
4. Match by: invitee email on Fathom meeting = contact email on GHL booking
5. Map to closer by: GHL event `assignedTo` → closer's `ghl_user_id`

**Auto-EOD logic:**
- Closer: GHL calendar events → count booked/showed/no-show + Fathom transcripts for outcomes
- Setter: Wavv tag diff (today's new tags vs yesterday's snapshot) → dials/pickups/MCs/sets
- Both: pre-fill the form, let the person review, edit if needed, hit confirm
- Fallback: if API data is incomplete, show empty fields for manual entry

**Only dependency:** Import `getColor()` from Will's metricCalculations.js. If Will hasn't pushed yet, stub it locally.

---

### Integration — BOTH (Final ~6 Hours)

Both merge their feature branches into `main` via PRs, then collaborate on:

1. Wire Overview funnel to actual API data (Meta → GHL → closer outcomes)
2. Test full flow: API sync → auto-EOD → review/confirm → attribution → dashboards
3. Verify traffic lights against benchmarks
4. Mobile test EOD review forms
5. Test Fathom transcript matching accuracy
6. Fix styling inconsistencies
7. Add CORS headers to Flask app (`dashboard.optdigital.io`) for `/api/setter-analytics` cross-origin calls

### Workflow Reminder
```bash
# Will does setup first:
git clone https://github.com/taffleraffle/sales-dashboard.git
# ... scaffold, push to main ...

# Ben pulls, then branches:
git pull origin main
git checkout -b feature/closers-setters-eod

# Will branches:
git checkout -b feature/marketing-overview

# When done, open PRs to main
```

---

## 13. Questions for Ben — RESOLVED

### Critical (Blocks Setup)

**Q1: Team members table.** `account_managers` table in seo-tracker PostgreSQL. All fields exist (`is_closer`, `is_setter`, `department`, `ghl_user_id`, `commission_rate`). Just need core function — no need to replicate the full model.

**Q2: Architecture.** Built as a separate GitHub repo (`taffleraffle/sales-dashboard`). Will merge into the main codebase later. Hosted on **Render** as its own service. **Standalone React+Vite app** — NOT embedded in Command Centre (which is Node.js/Express server-rendered, not React).

**Q3: Auth system.** TBD based on Render deployment. EOD forms need user context for who's submitting.

**Q4: Existing team records.** Yes — Daniel, Josh, Leandre, Austin, Valeria are all already in the DB.

### Important (Blocks Specific Features)

**Q5: GHL API access.** Proxy through backend — keep PIT key server-side.

**Q6: Speed-to-lead data source.** Use the **Wavv API via webhook** for actual first-dial timestamps. The current Flask app uses GHL `lastStageChangeAt - createdAt` as a proxy, which is inaccurate (measures stage change, not actual dial time). Wavv webhooks provide real dial event timestamps — use those instead.

**Q7: CSV format.** See **Appendix E** for actual sample rows from the V6 Master Sales Tracker, including exact column headers, date format (DD/MM/YYYY), and data patterns.

**Q8: Historical data.** **Start fresh — no historical backfill.** Fresh Supabase instance, clean slate. No need to import old Flask/PostgreSQL data.

**Q9: Database.** **New Supabase instance** (fresh start). Do NOT build a Flask API layer — connect directly to Supabase from the React app using the Supabase JS client. GHL analytics stays in the existing Flask app and is consumed via the existing `/api/setter-analytics` endpoint.

### Nice-to-Have

**Q10:** Submit = final. No approval workflow needed.

**Q11:** TBD — not blocking.

**Q12:** Keep GHL pipeline analytics in the Flask app. The new sales dashboard can call the existing `/api/setter-analytics` endpoint for funnel/dialer/speed-to-lead data rather than rebuilding the 935-line analytics engine. **CORS headers will need to be added to the Flask app** for cross-origin requests from the React dashboard.

**Q13:** Full transparency — everyone sees everything. Small team.

---

## Appendix A: GHL Pipeline Stage Map

```
Stage ID                                    Name                    Group
──────────────────────────────────────────────────────────────────────────
fc1096e8-7337-4c1a-8ae6-40efc3502afe       New Leads               NEW
c2806d47-0ac3-4c9c-af52-63c11a401649       Contact 1               CONTACT
0a9807d1-db3a-462a-bb02-4d6590d57094       Contact 2               CONTACT
b5766c72-aaa3-499c-99c9-c123fa729080       Contact 3               CONTACT
be4d196a-c6e3-4ad5-998d-4532acffafc3       Contact 4+              CONTACT
c5ee5195-ac12-4b37-b3fb-2accc6637a87       Auto-booked Triage      TRIAGE
33c00f0c-0202-4c29-a835-b7b3f2dd491d       Triage Confirmed        TRIAGE
cb8992ab-3823-49bc-9d87-6f4ec95a9cc8       Triage No Shows         TRIAGE
0a2ea6d0-6ddf-49ff-972c-45658e8d7e13       Set Call                SET_CALL
b1e8d20b-0b84-48d8-99bb-376abbe37e4d       (24 Hour) Set Calls     SET_CALL
c2714a28-7b50-4ad0-b6a3-9fbe0c6b80d1       (Follow Up) Set Call    SET_CALL
f9a2aa2d-943b-46c8-ac01-307792d48e49       No Show (Confirmed)     NO_SHOW
67dfa6f8-ebf9-4e97-865f-84330594aaf2       No Show (Closer)        NO_SHOW
f41e5fd6-53cb-4350-b962-2002e715c179       Follow Ups              NURTURE
cce108b0-93dc-4914-8549-81c18d1d18fe       Nurture                 NURTURE
b7dc415a-f0a4-41dd-b113-741929eb517b       Closed                  CLOSED
0f9d5445-37da-487b-8925-6e0d7d35386b       Ascended Trials         CLOSED
1c4b36c7-93dc-432e-95aa-50b979d060e7       Unqualified             OUT
58d7944e-834a-4b08-851a-faa4e1c3c7a6       Not Interested          OUT
9835961a-9412-4bc9-9d7a-7a015c8d53a1       Not Responsive          OUT
8cf99504-d718-4895-9344-8842fd3c4a86       Dead Contact            OUT
```

## Appendix B: Calendar IDs

**Intro (AI auto-booking):**
```
5omixNmtgmGMWQfEL0fs  (FB) RestorationConnect AI - Introductory Call
C5NRRAjwsy43nOyU6izQ  RestorationConnect AI - Introductory Call
GpYh75LaFEJgpHYkZfN9  PlumberConnect AI - Introductory Call
MvYStrHFsRTpunwTXIqT  Intro Call
okWMyvLhnJ7sbuvSIzok  Remodeling AI - Introductory Call
```

**Strategy (closer calls):**
```
3mLE6t6rCKDdIuIfvP9j  (FB) PoolConnectAI - Strategy Call
9yoQVPBkNX4tWYmcDkf3  Remodeling AI - Strategy Call
HDsTrgpsFOXw9V4AkZGq  (FB) RestorationConnect AI - Strategy Call
StLqrES6WMO8f3Obdu9d  PoolConnect AI - Strategy Call
aQsmGwANALCwJBI7G9vT  PlumberConnect AI - Strategy Call
cEyqCFAsPLDkUV8n982h  RestorationConnect AI - Strategy Call
```

**Rebooking:**
```
woLoGzGKe5fPKZU1jxY7  RestorationConnect AI - Rebooking
```

## Appendix C: Wavv Tag Reference

```
TAG                       COUNTS AS
─────────────────────────────────────
wavv-no-answer            dial
wavv-left-voicemail       dial
wavv-bad-number           dial
wavv-interested           dial + pickup + MC
wavv-appointment-set      dial + pickup + MC + SET
wavv-not-interested       dial + pickup + MC
wavv-callback             dial + pickup + MC
wavv-do-not-contact       dial + pickup
wavv-none                 dial
```

## Appendix D: Existing API Endpoints (Flask App Reference)

### Sales Dashboard
```
GET  /sales                          Main dashboard
GET  /sales/<id>                     Individual member
GET  /sales/pipeline-data            Pipeline time-series
```

### Closer
```
GET  /sales/closer-stats/<id>        JSON metrics
GET  /sales/closer-dashboard/<id>    Visual dashboard
GET/POST /sales/eod-report           Submit/edit EOD
GET  /sales/eod-reports              List + export
```

### Setter
```
GET/POST /sales/setter-eod-report    Submit/edit EOD
GET  /sales/setter-eod-reports       List + export
GET  /sales/setter-stats/<id>        JSON metrics
GET  /sales/setter-dashboard/<id>    Visual dashboard
```

### Lead Attribution
```
GET  /sales/lead-attribution         Attribution page
POST /sales/update-lead-status/<id>  Update status
GET  /sales/pending-leads            Pending for closer
```

### GHL Integration
```
GET  /sales/api/ghl-appointments     Calendar events
GET  /sales/api/ghl-opportunities    Search opportunities
POST /sales/api/ghl-import           Import as client
GET  /api/setter-analytics?days=N    Pipeline analytics (background)
```

### Marketing Tracker
```
POST /sales/marketing-tracker/import     CSV import
GET  /sales/marketing-tracker/eod-data   Aggregated daily
POST /sales/marketing-tracker/entry      Save day metrics
POST /sales/marketing-tracker/benchmarks Save targets
```

### Webhooks
```
POST /webhooks/ghl/appointment       GHL → HYROS
POST /webhooks/ghl/opportunity       GHL → auto-create client
POST /webhooks/stripe/payment        Stripe → HYROS
```

## Appendix E: CSV Sample Data (V6 Master Sales Tracker)

The Marketing Tracker CSV import uses the V6 Master Sales Tracker format. Below are actual sample rows showing the exact column structure and data patterns.

### Column Headers
```
Date,Ad Spend,Revenue,Profit/Loss,ROI,Total Leads (Excl. Junk),Junk Leads,Total Leads (Incl. Junk),CPL (Excl. Junk),% Leads Booked,Leads Booked,Shows,Show Rate,Cost per show,Trials Set From Show,Close Rate From Show,Revenue Per Show,Sets from Leads,Set Rate,CPA,LTV,Bookings (auto),Bookings (manual),No-Show Rate,Answer Rate
```

### Row Types

**Period summary rows** (aggregated, identified by labels like "4 Days", "7 Days", "30 Days", "MTD"):
```
4 Days,$1599.61,$5985.00,$4385.39,274.2%,42,0,42,$38.09,28.6%,12,9,75.0%,$177.73,4,44.4%,$665.00,4,9.5%,$399.90,$5985.00,6,6,25.0%,
7 Days,$3089.54,$5985.00,$2895.46,93.7%,73,0,73,$42.32,23.3%,17,13,76.5%,$237.66,4,30.8%,$460.38,4,5.5%,$772.39,$5985.00,7,10,23.5%,
30 Days,$10621.37,$17955.00,$7333.63,69.0%,308,1,309,$34.49,22.7%,70,47,67.1%,$226.01,12,25.5%,$382.02,12,3.9%,$885.11,$17955.00,30,40,32.9%,
MTD,$10621.37,$17955.00,$7333.63,69.0%,308,1,309,$34.49,22.7%,70,47,67.1%,$226.01,12,25.5%,$382.02,12,3.9%,$885.11,$17955.00,30,40,32.9%,
```

**Daily rows** (date format DD/MM/YYYY):
```
10/03/2026,$478.46,$0.00,"($478.46)",-100.0%,13,0,13,$36.80,23.1%,3,3,100.0%,$159.49,0,0.0%,$0.00,0,0.0%,#DIV/0!,$0.00,2,1,0.0%,
09/03/2026,$0.00,$0.00,$0.00,#DIV/0!,0,0,0,#DIV/0!,#DIV/0!,0,0,#DIV/0!,#DIV/0!,0,#DIV/0!,#DIV/0!,0,#DIV/0!,#DIV/0!,$0.00,0,0,#DIV/0!,
08/03/2026,$501.25,$0.00,"($501.25)",-100.0%,8,0,8,$62.66,37.5%,3,2,66.7%,$250.63,0,0.0%,$0.00,0,0.0%,#DIV/0!,$0.00,1,2,33.3%,
07/03/2026,$619.90,$5985.00,$5365.10,865.5%,21,0,21,$29.52,28.6%,6,4,66.7%,$154.98,4,100.0%,$1496.25,4,19.0%,$154.98,$5985.00,3,3,33.3%,
```

### Parsing Notes
- **Dollar signs**: `$1599.61` — strip `$` and commas before parsing as float
- **Percentages**: `274.2%` — strip `%` and divide by 100
- **Negative values in parens**: `"($478.46)"` — standard accounting notation, treat as negative
- **`#DIV/0!`**: Division by zero from the spreadsheet — treat as `null`/`0`
- **Empty cells**: Trailing commas indicate empty values — treat as `null`/`0`
- **Date column**: DD/MM/YYYY format for daily rows; text labels ("4 Days", "MTD") for summary rows
- **Summary vs daily detection**: If `Date` column doesn't match DD/MM/YYYY pattern, it's a summary row — may want to skip or handle separately

---

*End of specification. When in doubt, ask Ben.*
