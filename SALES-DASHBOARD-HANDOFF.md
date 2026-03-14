# OPT Digital — Sales Dashboard Handoff

> Comprehensive reference document for building a standalone Sales Dashboard application.
> Covers all existing sales-related functionality across 3 repos: `seo-tracker`, `content-pipeline`, `command-centre`.

---

## Table of Contents

1. [Business Context](#1-business-context)
2. [Current Architecture Overview](#2-current-architecture-overview)
3. [GoHighLevel (GHL) Integration](#3-gohighlevel-ghl-integration)
4. [GHL Pipeline Analytics Engine](#4-ghl-pipeline-analytics-engine)
5. [Wavv Dialer Integration](#5-wavv-dialer-integration)
6. [Speed to Lead Tracking](#6-speed-to-lead-tracking)
7. [Database Models — Sales](#7-database-models--sales)
8. [Sales Service — Commission & Performance](#8-sales-service--commission--performance)
9. [EOD Reports — Closers](#9-eod-reports--closers)
10. [EOD Reports — Setters](#10-eod-reports--setters)
11. [Lead Attribution System](#11-lead-attribution-system)
12. [Marketing Tracker](#12-marketing-tracker)
13. [GHL Webhooks — Auto Client Creation](#13-ghl-webhooks--auto-client-creation)
14. [Fulfillment Pipelines](#14-fulfillment-pipelines)
15. [Command Centre — Lifecycle & Onboarding](#15-command-centre--lifecycle--onboarding)
16. [All API Endpoints](#16-all-api-endpoints)
17. [Frontend Templates & UI](#17-frontend-templates--ui)
18. [Key Constants & IDs](#18-key-constants--ids)
19. [Data Flows](#19-data-flows)
20. [Known Issues & Gotchas](#20-known-issues--gotchas)

---

## 1. Business Context

OPT Digital is an SEO agency that sells via a **trial model**:
1. **Setters** cold-call leads using the **Wavv dialer** (auto-dialer that adds tags to GHL contacts)
2. Leads are either **auto-booked** (via AI intro call calendars) or **manually set** by setters
3. **Closers** take strategy calls, close deals as **14-day trials** ($997 default trial fee)
4. Trials that convert become **ascended** clients with monthly retainers ($1,500–$5,000/mo)
5. Commission is paid on `trial_fee + (monthly_retainer × months_in_ascension)` up to 90 days

### Key Terminology
| Term | Meaning |
|------|---------|
| **NC** | New Call (first-time prospect) |
| **FU** | Follow Up (returning prospect) |
| **EOD** | End of Day report (daily metrics submission) |
| **Set** | A meeting booked by a setter for a closer |
| **Show** | Prospect actually showed up to the call |
| **MC** | Meaningful Conversation (dialer: answered + engaged) |
| **Triage** | Auto-booked leads that go through AI intro call first |
| **Ascension** | Trial client converting to paying monthly retainer |
| **MRR** | Monthly Recurring Revenue (post-90-day ascension) |
| **CPA** | Cost Per Acquisition |
| **ROAS** | Return on Ad Spend |

### Sales Team Roles
- **Sales Setter** (`is_setter=True`, role `sales_setter`) — dials leads, books meetings
- **Sales Closer** (`is_closer=True`, role `sales_closer`) — takes calls, closes deals
- Both tracked via `AccountManager` model with `department='sales'`

---

## 2. Current Architecture Overview

All sales functionality currently lives inside the **SEO Dashboard** (`seo-tracker` repo), a Flask/SQLAlchemy app deployed on Render at `dashboard.optdigital.io`.

### Source Repos
| Repo | What | Sales Relevance |
|------|------|-----------------|
| `seo-tracker` | Main dashboard (Flask + PostgreSQL) | **All** sales code lives here |
| `command-centre` | White Dwarf agent orchestrator (Node.js) | GHL webhook → lifecycle, comms tracking |
| `content-pipeline` | Optimus content bot (Python/Slack) | No sales code |

### Key File Locations (seo-tracker)

```
app/
├── models/
│   ├── sales.py              # All sales models (832 lines)
│   ├── auth.py               # AccountManager (is_closer, is_setter, ghl_user_id)
│   └── integrations.py       # GHL integration account + credentials
├── services/
│   ├── ghl.py                # GHL API client (338 lines)
│   ├── ghl_pipeline.py       # Pipeline analytics engine (935 lines)
│   ├── sales.py              # Commission calcs, dashboard data (400+ lines)
│   └── integration_resolver.py  # GHL credential resolution
├── routes/
│   ├── company.py            # All /sales/* routes (lines 6914–9360)
│   └── webhooks.py           # GHL webhooks (500 lines)
└── templates/company/
    ├── sales_dashboard.html  # Main sales page
    ├── sales_member.html     # Individual member detail
    ├── setter_analytics.html # GHL funnel (3-tab: Funnel, Speed to Lead, Dialer)
    ├── setter_dashboard.html # Individual setter dashboard
    ├── closer_dashboard.html # Individual closer dashboard
    ├── setter_eod_report.html    # Setter EOD form
    └── setter_eod_reports.html   # Setter EOD history
```

---

## 3. GoHighLevel (GHL) Integration

### API Configuration
- **Base URL**: `https://services.leadconnectorhq.com`
- **Auth**: Private Integration Token (PIT) — Bearer token in `Authorization` header
- **Version Header**: `2021-07-28` (with `2021-04-15` fallback for calendar events)
- **Timeout**: 30s per request
- **Credentials stored in**: `IntegrationAccount` model (encrypted), resolved via `IntegrationResolver.get_ghl_credentials()`

### GHL API Client (`app/services/ghl.py`)

```python
class GHLService:
    BASE_URL = 'https://services.leadconnectorhq.com'

    def __init__(self, api_key: str, location_id: str):
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Version': '2021-07-28',
        }

    # Available methods:
    def test_connection() → dict           # Validates API key via calendars fetch
    def get_calendars() → dict             # All calendars for location
    def get_calendar_events(start, end, calendar_id=None) → dict
        # Uses epoch milliseconds for start/end
        # Fallback: tries per-calendar fetch on 422, then version 2021-04-15
    def get_todays_appointments(target_date=None) → list
        # Returns: [{name, contact_id, start_time, status, calendar_id}]
    def search_contacts(query, limit=10) → list
        # POST /contacts/search with GET /contacts/ fallback
        # Returns: [{id, name, email, phone}]
    def get_contact(contact_id) → dict
        # Returns: {id, name, firstName, lastName, email, phone, city, state,
        #           country, companyName, website, tags, source}
    def get_opportunity(opportunity_id) → dict
        # Returns: {id, name, status, monetary_value, pipeline_id,
        #           pipeline_stage_id, stage_name, contact_id, assigned_to, email, phone}
    def get_pipelines() → list
    def search_opportunities(query='', pipeline_id=None, limit=20) → list
        # Returns: [{id, name, pipeline_stage, stage_name, status, monetary_value,
        #            contact_id, email, phone}]
```

### Integration Storage
```python
# models/integrations.py
class IntegrationAccount:
    provider = 'ghl'
    credentials = EncryptedText  # JSON: {"api_key": "...", "location_id": "..."}

class IntegrationResource:
    resource_type = 'ghl_calendar'  # Selectable calendars under GHL account

class IntegrationAssignment:
    # Scope-based: MASTER (global) → AM-level → Client-level override
    scope = 'master' | 'am' | 'client'
```

### AccountManager GHL Fields
```python
# Added via migration 095_add_ghl_integration_columns.py
AccountManager.ghl_user_id = VARCHAR(100)  # Maps GHL assignedTo → dashboard AM
Client.ghl_opportunity_id = VARCHAR(100)   # Dedup key for auto-import
Client.ghl_contact_id = VARCHAR(100)       # Links to GHL contact
```

---

## 4. GHL Pipeline Analytics Engine

### Overview (`app/services/ghl_pipeline.py`)

The analytics engine fetches ALL opportunities from the SCIO pipeline, classifies them by stage, calculates funnel metrics, and returns a comprehensive analytics dict. Results are cached for 15 minutes.

### Pipeline: SCIO PIPELINE (USA)
**Pipeline ID**: `ZN1DW9S9qS540PNAXSxa`

### Stage Map (21 stages, ordered)

```python
STAGES = {
    'fc1096e8-7337-4c1a-8ae6-40efc3502afe': 'New Leads',
    'c2806d47-0ac3-4c9c-af52-63c11a401649': 'Contact 1',
    '0a9807d1-db3a-462a-bb02-4d6590d57094': 'Contact 2',
    'b5766c72-aaa3-499c-99c9-c123fa729080': 'Contact 3',
    'be4d196a-c6e3-4ad5-998d-4532acffafc3': 'Contact 4+',
    'c5ee5195-ac12-4b37-b3fb-2accc6637a87': 'Auto-booked Triage',
    '33c00f0c-0202-4c29-a835-b7b3f2dd491d': 'Triage Confirmed',
    'cb8992ab-3823-49bc-9d87-6f4ec95a9cc8': 'Triage No Shows',
    '0a2ea6d0-6ddf-49ff-972c-45658e8d7e13': 'Set Call',
    'b1e8d20b-0b84-48d8-99bb-376abbe37e4d': '(24 Hour) Set Calls',
    'c2714a28-7b50-4ad0-b6a3-9fbe0c6b80d1': '(Follow Up) Set Call',
    'f9a2aa2d-943b-46c8-ac01-307792d48e49': 'No Show (Confirmed)',
    '67dfa6f8-ebf9-4e97-865f-84330594aaf2': 'No Show (Closer)',
    'f41e5fd6-53cb-4350-b962-2002e715c179': 'Follow Ups',
    'cce108b0-93dc-4914-8549-81c18d1d18fe': 'Nurture',
    'b7dc415a-f0a4-41dd-b113-741929eb517b': 'Closed',
    '0f9d5445-37da-487b-8925-6e0d7d35386b': 'Ascended Trials',
    '1c4b36c7-93dc-432e-95aa-50b979d060e7': 'Unqualified',
    '58d7944e-834a-4b08-851a-faa4e1c3c7a6': 'Not Interested',
    '9835961a-9412-4bc9-9d7a-7a015c8d53a1': 'Not Responsive',
    '8cf99504-d718-4895-9344-8842fd3c4a86': 'Dead Contact',
}
```

### Stage Classifications

```python
CONTACT_STAGES = {'Contact 1', 'Contact 2', 'Contact 3', 'Contact 4+'}
TRIAGE_STAGES = {'Auto-booked Triage', 'Triage Confirmed', 'Triage No Shows'}
SET_CALL_STAGES = {'Set Call', '(24 Hour) Set Calls', '(Follow Up) Set Call'}
POST_SET_CALL_STAGES = {'No Show (Confirmed)', 'No Show (Closer)', 'Follow Ups', 'Nurture', 'Closed', 'Ascended Trials'}
NO_SHOW_STAGES = {'No Show (Confirmed)', 'No Show (Closer)'}
CLOSED_STAGES = {'Closed', 'Ascended Trials'}
```

### Calendar Classifications

```python
INTRO_CALENDARS = {
    '5omixNmtgmGMWQfEL0fs': '(FB) RestorationConnect AI - Introductory Call',
    'C5NRRAjwsy43nOyU6izQ': 'RestorationConnect AI - Introductory Call',
    'GpYh75LaFEJgpHYkZfN9': 'PlumberConnect AI - Introductory Call',
    'MvYStrHFsRTpunwTXIqT': 'Intro Call',
    'okWMyvLhnJ7sbuvSIzok': 'Remodeling AI - Introductory Call',
}

STRATEGY_CALENDARS = {
    '3mLE6t6rCKDdIuIfvP9j': '(FB) PoolConnectAI - Strategy Call',
    '9yoQVPBkNX4tWYmcDkf3': 'Remodeling AI - Strategy Call',
    'HDsTrgpsFOXw9V4AkZGq': '(FB) RestorationConnect AI - Strategy Call',
    'StLqrES6WMO8f3Obdu9d': 'PoolConnect AI - Strategy Call',
    'aQsmGwANALCwJBI7G9vT': 'PlumberConnect AI - Strategy Call',
    'cEyqCFAsPLDkUV8n982h': 'RestorationConnect AI - Strategy Call',
}

REBOOKING_CALENDARS = {
    'woLoGzGKe5fPKZU1jxY7': 'RestorationConnect AI - Rebooking',
}
```

### Auto-Booked vs Manual Classification Logic

A lead is classified as **auto-booked** if it has an intro calendar appointment (checked via `fetch_contact_appointments()`). Otherwise it's **manual** (setter-dialed).

```python
# For each set-call lead:
appts = contact_appts.get(contact_id, [])
has_intro = any(a.get('calendarId') in INTRO_CALENDARS for a in appts)
if has_intro:
    auto_booked += 1
    src_key = 'auto'
else:
    manual_set += 1
    src_key = 'manual'
```

### Analytics Output Structure

The `_run_analysis(days)` method returns this dict:

```python
{
    # Period
    'period_days': int,
    'generated_at': 'ISO datetime',

    # Funnel counts
    'total_opportunities': int,
    'new_leads': int,
    'triage_count': int,          # In triage stages
    'set_calls': int,             # In SET_CALL_STAGES currently
    'set_calls_total': int,       # All that reached set call (including post-set)
    'set_calls_24hr': int,
    'set_calls_followup': int,
    'closed_count': int,
    'ascended_count': int,
    'no_show_count': int,
    'follow_up': int,
    'nurture': int,

    # Appointment counts
    'total_intro_calls': int,
    'total_strategy_calls': int,
    'total_rebooking_calls': int,
    'appointments_by_calendar': [{calendar, type, total, confirmed, cancelled, no_show}],
    'strategy_by_status': dict,   # {confirmed: N, cancelled: N, ...}

    # Auto vs Manual
    'auto_booked': int,
    'manual_set': int,
    'source_outcomes': {
        'auto': {
            'total': int, 'shown': int, 'closed': int, 'no_show': int, 'pending': int,
            'resolved': int, 'show_rate': float, 'close_rate': float, 'no_show_rate': float,
            'total_dials': int, 'pickups': int, 'mcs': int, 'leads_with_dials': int,
            'avg_dials': float, 'pickup_rate': float, 'call_to_set': float,
            'mc_rate': float, 'mc_to_set': float,
        },
        'manual': { ... same structure ... },
    },

    # Close/show/no-show rates
    'close_rate_shown': float,    # Closed / Shown (%)
    'close_rate_auto': float,
    'close_rate_manual': float,
    'show_rate': float,           # Shown / Resolved (%)
    'show_rate_auto': float,
    'show_rate_manual': float,
    'no_show_rate': float,
    'no_show_rate_auto': float,
    'no_show_rate_manual': float,

    # Path analysis
    'path_to_set_call': [{'path': str, 'count': int}],

    # Wavv dialer metrics (ALL pipeline contacts)
    'total_dials': int,
    'total_pickups': int,
    'total_mcs': int,
    'total_leads_dialed': int,
    'total_sets_from_dials': int,
    'avg_dials_per_lead': float,
    'overall_pickup_rate': float,
    'overall_lead_to_set': float,
    'overall_call_to_set': float,       # Dials per set (e.g. 15.2)
    'overall_pickup_to_set': float,
    'overall_mc_to_set': float,
    'dials_by_origin': [{                # Per-stage breakdown
        'origin': str,                   # Stage group name
        'leads': int,
        'total_dials': int,
        'pickups': int,
        'mcs': int,
        'sets': int,
        'pickup_rate': float,
        'lead_to_set': float,
        'call_to_set': float,            # Dials per set (inverse)
    }],

    # Speed to Lead
    'speed_to_lead': {
        'total_new_leads': int,
        'worked': int,
        'unworked': int,
        'avg_secs': int,
        'avg_display': str,              # e.g. "2h 15m"
        'median_secs': int,
        'median_display': str,
        'fastest_secs': int,
        'fastest_display': str,
        'slowest_secs': int,
        'slowest_display': str,
        'under_5m': int,
        'under_30m': int,
        'under_1h': int,
        'over_24h': int,
        'pct_under_5m': float,
        'pct_under_1h': float,
        'daily': [{
            'date': 'YYYY-MM-DD',
            'leads_worked': int,
            'avg_secs': int,
            'avg_display': str,
            'fastest_secs': int,
            'fastest_display': str,
            'slowest_secs': int,
            'slowest_display': str,
        }],
        'unworked_leads': [{             # Top 20, sorted by wait_hours desc
            'name': str,
            'wait_hours': float,
            'created': 'YYYY-MM-DD HH:MM',
        }],
    },

    # Stage distribution
    'stage_chart': [{'stage': str, 'count': int}],
    'by_source': [{'source': str, 'count': int}],

    # 24h activity
    'recent_activity': [{
        'name': str,
        'from_stage': str,
        'to_stage': str,
        'changed_at': 'ISO datetime',
    }],  # Most recent 30
}
```

### Async Processing Pattern

GHL analytics takes ~2 minutes (fetches hundreds of opportunities + appointments). Render has a 30s HTTP timeout, so it runs in a background thread:

```python
# API endpoint starts background job
POST /api/setter-analytics?days=30
→ Returns 202 {'status': 'processing'}

# Frontend polls every 3 seconds
GET /api/setter-analytics?days=30
→ Returns 200 {'status': 'processing'} while running
→ Returns 200 {full analytics dict} when done
→ Returns 200 {'status': 'error', 'error': '...'} on failure

# Cache: 15-minute TTL, thread-safe with Lock
```

---

## 5. Wavv Dialer Integration

Wavv is an auto-dialer that adds **tags** to GHL contacts for each dial attempt. There's no direct Wavv API — all data comes from GHL contact tags.

### Tag Classification

```python
# Every dial adds exactly one wavv-* tag
WAVV_DIAL_TAGS = {
    'wavv-no-answer',        # Rang, no pickup
    'wavv-left-voicemail',   # Left VM
    'wavv-bad-number',       # Invalid/disconnected
    'wavv-interested',       # Pickup → interested
    'wavv-appointment-set',  # Pickup → booked meeting
    'wavv-not-interested',   # Pickup → rejected
    'wavv-callback',         # Pickup → call back later
    'wavv-do-not-contact',   # Pickup → DNC
    'wavv-none',             # Uncategorized
}

# Subsets for metrics:
WAVV_PICKUP_TAGS = {'wavv-interested', 'wavv-appointment-set', 'wavv-not-interested',
                    'wavv-callback', 'wavv-do-not-contact'}
WAVV_MC_TAGS = {'wavv-interested', 'wavv-appointment-set', 'wavv-not-interested',
                'wavv-callback'}
WAVV_SET_TAGS = {'wavv-appointment-set'}
```

### How Metrics Are Calculated

```python
def _classify_wavv_tags(tags):
    """Each wavv-* tag = one dial attempt."""
    wavv_tags = [t for t in tags if t in WAVV_DIAL_TAGS]
    return {
        'total_dials': len(wavv_tags),
        'pickups': sum(1 for t in wavv_tags if t in WAVV_PICKUP_TAGS),
        'meaningful_convos': sum(1 for t in wavv_tags if t in WAVV_MC_TAGS),
        'sets': sum(1 for t in wavv_tags if t in WAVV_SET_TAGS),
    }
```

### Important: Metrics Scan ALL Opportunities

The Wavv metrics iterate over ALL opportunities in the pipeline (not just set-call leads) to get accurate ratios. A contact with `['wavv-no-answer', 'wavv-no-answer', 'wavv-interested', 'wavv-appointment-set']` = 4 dials, 2 pickups, 2 MCs, 1 set.

### Per-Stage Grouping

Contacts are grouped by their **current stage** using `_stage_group()`:

| Stage Group | Stages Included |
|-------------|-----------------|
| New Leads | New Leads only |
| Contact 1–4+ | Individual contact stages |
| Triage | Auto-booked Triage, Triage Confirmed, Triage No Shows |
| Set Call | Set Call, (24 Hour) Set Calls, (Follow Up) Set Call |
| No Show | No Show (Confirmed), No Show (Closer) |
| Closed | Closed, Ascended Trials |
| Unqualified | Unqualified |
| Not Interested | Not Interested |
| Not Responsive | Not Responsive |
| Dead Contact | Dead Contact |

---

## 6. Speed to Lead Tracking

### Measurement Approach

Uses `lastStageChangeAt - createdAt` as a proxy for response time. This measures how long from when a lead enters the pipeline until the first stage change (which typically means someone worked the lead).

```python
NEW_LEADS_STAGE = 'fc1096e8-7337-4c1a-8ae6-40efc3502afe'

for opp in opps:
    created = _parse_dt(opp.get('createdAt'))
    if not created or created < cutoff:
        continue  # Only leads created within the period

    stage_id = opp.get('pipelineStageId', '')
    stage_change = _parse_dt(opp.get('lastStageChangeAt'))

    if stage_id == NEW_LEADS_STAGE:
        # Still in New Leads = UNWORKED
        wait_secs = (now - created).total_seconds()
        stl_unworked.append({...})
    elif stage_change and created:
        # Moved out = WORKED
        response_secs = (stage_change - created).total_seconds()
        stl_times.append(response_secs)
```

### Known Limitations
- If a setter dials but doesn't move the lead to a new stage, it won't register
- Auto-booked leads show very fast "response times" (automation speed, not human)
- No per-setter breakdown (GHL `assignedTo` field is sparsely populated)
- Wavv tags don't have timestamps, so can't measure "time to first dial" directly

### Duration Formatting

```python
def _fmt_duration(secs):
    if secs < 60:      return f'{int(secs)}s'
    elif secs < 3600:  return f'{int(secs // 60)}m'
    elif secs < 86400: return f'{h}h {m}m'
    else:              return f'{d}d {h}h'
```

---

## 7. Database Models — Sales

### `SalesTrackerEntry` — Daily Marketing Funnel Metrics
Imported from CSV (V6 Master Sales Tracker). One row per day.

```python
class SalesTrackerEntry(db.Model):
    __tablename__ = 'sales_tracker_entry'

    entry_date = Date (unique)
    currency = String(3), default='NZD'

    # Ad Spend & Leads
    total_adspend = Numeric(12,2)
    total_leads = Integer

    # Bookings & Cancellations
    total_qualified_bookings = Integer
    cancelled_dtf = Integer               # Cancelled by OPT ("didn't fit")
    cancelled_by_prospect = Integer

    # Calls
    net_new_calls_calendar = Integer
    net_fu_calls_calendar = Integer
    new_live_calls_taken = Integer
    net_calls_taken = Integer

    # Sales
    offers_made = Integer
    total_closes = Integer

    # Trial Revenue
    trial_cash_collected = Numeric(12,2)
    trial_contracted_revenue = Numeric(12,2)

    # Ascension
    total_ascensions = Integer
    ascend_cash_collected = Numeric(12,2)
    ascend_contracted_revenue = Numeric(12,2)

    # Collections
    ar_collected = Numeric(12,2)
    ar_defaulted = Numeric(12,2)
    num_refunds = Integer
    total_refunds_amount = Numeric(12,2)
```

### `EODReport` — Closer End-of-Day Report

```python
class EODReport(db.Model):
    __tablename__ = 'eod_reports'

    sales_member_id = FK(AccountManager)
    report_date = Date

    # Calls
    nc_booked = Integer           # New calls booked on calendar
    fu_booked = Integer           # Follow-up calls booked
    nc_no_shows = Integer
    fu_no_shows = Integer
    live_nc_calls = Integer       # Actually showed up (new)
    live_fu_calls = Integer       # Actually showed up (follow-up)
    reschedules = Integer

    # Sales
    offers = Integer
    closes = Integer
    deposits = Integer

    # Revenue
    offer1_collected = Numeric(10,2)   # Trial fee collected
    offer1_revenue = Numeric(10,2)     # Trial contracted value
    offer2_collected = Numeric(10,2)   # Second offer (upsell)
    offer2_revenue = Numeric(10,2)
    total_revenue = Numeric(10,2)
    total_cash_collected = Numeric(10,2)
    notes = Text

    # Computed properties:
    total_booked = nc_booked + fu_booked
    total_live_calls = live_nc_calls + live_fu_calls
    total_no_shows = nc_no_shows + fu_no_shows
    show_rate = total_live_calls / total_booked * 100
    offer_rate = offers / total_live_calls * 100
    close_rate = closes / total_live_calls * 100

    # Unique: (sales_member_id, report_date)
```

### `CloserCall` — Individual Call on EOD

```python
class CloserCall(db.Model):
    __tablename__ = 'closer_calls'

    eod_report_id = FK(EODReport)
    call_type = String(20)         # 'new_call' or 'follow_up'
    prospect_name = String(200)
    showed = Boolean (nullable)    # None=pending, True=showed, False=no-show
    outcome = String(20)           # no_show, rescheduled, cancelled, closed, not_closed
    revenue = Numeric(10,2)
    cash_collected = Numeric(10,2)
    setter_lead_id = FK(SetterLead)  # Attribution link
    notes = Text
```

### `SetterEODReport` — Setter End-of-Day Report

```python
class SetterEODReport(db.Model):
    __tablename__ = 'setter_eod_reports'

    setter_id = FK(AccountManager)
    report_date = Date

    # Outbound Activity
    total_leads = Integer          # Leads worked from queue
    outbound_calls = Integer       # Total dials made
    pickups = Integer              # Calls answered
    meaningful_conversations = Integer  # Engaged conversations
    unqualified = Integer          # Leads marked unqualified

    # Sets
    sets = Integer                 # Meetings booked
    reschedules = Integer

    # Self Assessment
    self_rating = Integer          # 1-10 scale
    what_went_well = Text
    what_went_poorly = Text
    overall_performance = Integer
    daily_summary = Text

    # Computed properties:
    leads_to_set_pct = sets / total_leads * 100
    calls_to_set_pct = sets / outbound_calls * 100
    pickups_to_set_pct = sets / pickups * 100
    mcs_to_set_pct = sets / meaningful_conversations * 100

    # Unique: (setter_id, report_date)
```

### `SetterLead` — Lead Attribution

```python
class SetterLead(db.Model):
    __tablename__ = 'setter_leads'

    setter_id = FK(AccountManager)      # Who set the meeting
    closer_id = FK(AccountManager)      # Who handled the close
    lead_name = String(200)
    lead_source = String(200)
    date_set = Date                     # When the meeting was booked
    appointment_date = Date             # When the meeting is scheduled
    status = String(20)                 # VALID_STATUSES below
    revenue_attributed = Numeric(10,2)
    eod_report_id = FK(SetterEODReport)
    closer_eod_report_id = FK(EODReport)
    notes = Text

    VALID_STATUSES = ['set', 'showed', 'no_show', 'rescheduled', 'cancelled', 'closed', 'not_closed']
```

### `SalesCall` — Manually Logged Sales Call

```python
class SalesCall(db.Model):
    __tablename__ = 'sales_calls'

    sales_member_id = FK(AccountManager)
    call_date = Date
    prospect_name = String(200)
    prospect_company = String(200)
    showed = Boolean
    outcome = String(30)    # SalesCallOutcome: no_show, booked_trial, not_interested, follow_up, other
    notes = Text
    client_id = FK(Client)  # If linked to existing client
    created_by_user_id = FK(User)
```

---

## 8. Sales Service — Commission & Performance

### Commission Calculation

```python
class SalesService:
    @staticmethod
    def calculate_commission_basis(client):
        """
        Commission basis = trial_fee + monthly_retainer × ascension_months

        Ascension starts at client.ascended_at
        Ends at: min(90 days after ascended_at, churned_at, today)

        First month: cash = retainer - trial_fee (since trial fee was the first payment)
        Subsequent months: full retainer
        """
        trial_fee = float(client.trial_fee or 0)
        retainer = _monthly_retainer(client)  # Normalized: weekly×4.33, quarterly÷3, annual÷12
        ascension_months = get_ascension_months(client)  # In 30-day months

        if ascension_months <= 0:
            return trial_fee
        first_month = max(retainer - trial_fee, 0)
        remaining = retainer * max(ascension_months - 1, 0)
        return trial_fee + first_month + remaining

    @staticmethod
    def get_member_stats(am, start_date=None, end_date=None):
        """Returns dict with:
        - closer: {total_clients, active_trials, converted, conversion_rate,
                    trial_fees, ascension_revenue, commission_basis, commission_earned}
        - setter: {same structure}
        - call_stats: {total_calls, showed_count, show_rate, booked_count, booking_rate}
        - eod: {nc_booked, fu_booked, total_booked, shows, no_shows, offers, closes,
                deposits, revenue, cash_collected, show_rate, close_rate, offer_rate}
        - setter_eod: {total_leads, outbound_calls, pickups, mcs, sets, reschedules,
                       leads_to_set_pct, calls_to_set_pct, pickup_rate,
                       trials, ascended, set_to_trial_pct, trial_to_ascend_pct}
        - total_commission, ascension_rate, gross/net_trial_rate
        """

    @staticmethod
    def get_sales_dashboard_data(start_date=None, end_date=None):
        """Aggregates all sales-relevant AMs, computes per-member stats + team totals.

        Identifies sales members by:
        - department='sales'
        - role contains 'Sales'/'Closer'/'Setter'
        - is_closer or is_setter flags
        - Has any client attributions, call logs, or EOD reports

        Falls back to all active AMs if no explicit sales members found.
        """
```

---

## 9. EOD Reports — Closers

### Submit/Edit Flow
1. Closer navigates to `/sales/eod-report` (or `/sales/eod-report/<closer_id>`)
2. Fills in daily metrics: calls booked (NC/FU), no-shows, live calls, offers, closes, deposits, revenue
3. Adds individual `CloserCall` entries with prospect name, outcome, revenue
4. Each CloserCall can link to a `SetterLead` for attribution
5. On submit: creates/updates `EODReport` + child `CloserCall` records
6. Auto-calculates show rate, close rate, offer rate

### Viewing & Export
- `/sales/eod-reports` — list view with date filtering
- `/sales/eod-reports/export` — CSV export
- `/sales/eod-history` — historical view

---

## 10. EOD Reports — Setters

### Submit/Edit Flow
1. Setter navigates to `/sales/setter-eod-report`
2. Fills in: total leads, outbound calls, pickups, meaningful conversations, unqualified, sets, reschedules
3. Self-assessment: rating (1-10), what went well, what went poorly, daily summary
4. **GHL Autocomplete**: When entering lead names, searches GHL opportunities for matching contacts
5. On submit: creates/updates `SetterEODReport` record

### Individual Setter Dashboard (`/sales/setter-dashboard/<id>`)
- Conversion gauges: Leads→Set%, Calls→Set%, MCs→Set%
- Attribution: show rate, close rate, revenue attributed via SetterLead records
- Earnings/commission tracking
- Trend charts over time

---

## 11. Lead Attribution System

### Flow
1. Setter books meeting → creates `SetterLead` (status='set')
2. Closer takes the call → links via `CloserCall.setter_lead_id`
3. Outcome updates `SetterLead.status`:
   - `set` → `showed` (prospect showed up)
   - `set` → `no_show` (prospect didn't show)
   - `showed` → `closed` (deal closed, revenue attributed)
   - `showed` → `not_closed` (didn't close)
   - `set` → `rescheduled` or `cancelled`

### Attribution Page (`/sales/lead-attribution`)
- Shows all setter leads with their outcomes
- Update lead status via `/sales/update-lead-status/<lead_id>` (JSON)
- Pending leads for closer: `/sales/pending-leads`

---

## 12. Marketing Tracker

### CSV Import (`/sales/marketing-tracker/import`)
Imports daily rows from the V6 Master Sales Tracker spreadsheet:
- Ad spend, total leads, qualified bookings, cancellations
- New calls, follow-up calls, live calls, offers, closes
- Trial cash collected, contracted revenue
- Ascensions, ascension revenue
- AR collected, defaults, refunds

### EOD Data Aggregation (`/sales/marketing-tracker/eod-data`)
Returns combined closer + setter EOD data for a specific date, merged with marketing tracker entries for the complete daily picture.

### Benchmarks (`/sales/marketing-tracker/benchmarks`)
Save target benchmarks for metrics like CPA, close rate, show rate, etc.

---

## 13. GHL Webhooks — Auto Client Creation

### Appointment Webhook (`POST /webhooks/ghl/appointment`)
- Triggers on calendar event creation/confirmation
- Pushes `call_booked` event to **Hyros** (ad attribution platform)
- Skips cancelled/no-show appointments

### Opportunity Webhook (`POST /webhooks/ghl/opportunity`)
When an opportunity changes stage:

**Close Stage** (stage name contains 'close', 'won', 'sold', 'closed'):
1. Fetches full contact data from GHL API
2. Creates new `Client` record:
   - `status = ClientStatus.TRIAL`
   - `trial_started_at = today`
   - `trial_fee` from monetary value (default $997)
   - Maps country, lead source from GHL contact
   - Generates unique slug
   - Deduplicates by `ghl_opportunity_id` and case-insensitive name
3. Creates `ClientLifecycleEvent` (type=CREATED)
4. Fires `client.created` outbound webhook
5. Assigns AM via `_resolve_am_from_ghl(ghl_user_id)` — matches by `AccountManager.ghl_user_id`

**Ascension Stage** (stage name contains 'ascen'):
1. Finds existing trial client by `ghl_opportunity_id`
2. Sets `status = ASCENDED`, `ascended_at = today`, `trial_outcome = 'converted'`
3. Updates `retainer_price` from monetary value
4. Fires `client.ascended` + `client.status_changed` webhooks

### Lead Source Mapping

```python
def _map_ghl_lead_source(contact_data):
    # Combines contact.source + contact.tags into keywords
    # Maps to LeadSource enum:
    'facebook/meta/fb/instagram' → LeadSource.META_ADS
    'google/adwords/ppc/gads'   → LeadSource.GOOGLE_ADS
    'referral/referred'         → LeadSource.REFERRAL
    'cold_email/outbound email' → LeadSource.COLD_EMAIL
    'cold_call/outbound call'   → LeadSource.COLD_CALL
    'content/organic/seo/blog'  → LeadSource.CONTENT
```

---

## 14. Fulfillment Pipelines

These track post-sale fulfillment (not directly sales, but part of the sales→delivery flow).

### WebsiteRequest — 11-Stage Pipeline
```
KICKOFF → HOMEPAGE_DESIGN → INTERNAL_REVIEW → HOMEPAGE_APPROVAL →
SUBPAGE_DESIGN → DESIGN_LOCK → CONTENT_PREP → DEVELOPMENT →
CONTENT_QA → FINAL_QA → LAUNCHED
```

Fields: `client_id`, `domain`, `url`, `figma_link`, `country`, `designer`, `content_writer`, `content_manager`, `due_date`, `start_date`, `launch_date`, `cost`

Each stage has a timestamp (`kickoff_at`, `homepage_design_at`, etc.) and auto-calculates `stage_progress` (0-100%), `days_to_launch`, `is_overdue`.

### DesignRequest — 4-Stage Pipeline
```
HOME_PAGE → SUB_PAGES → CONTENT → COMPLETED
```

### ContentRequest — 4-Stage Pipeline
```
MAIN_PAGES → SUB_PAGES → REVIEW → COMPLETED
```

---

## 15. Command Centre — Lifecycle & Onboarding

The Command Centre (White Dwarf) handles the **post-close lifecycle automation**.

### GHL Webhook Handler (`server/routes/webhook.js`)
- `POST /api/webhook/ghl` — Receives `opportunity.status_changed` events
- On close stage: creates `content_client` in Supabase, auto-creates lifecycle, dispatches Day 0 deliverables
- Configurable via `GHL_CLOSED_STAGE_NAMES` env var (default: "closed won,won,closed")

### Client Lifecycle (`server/services/lifecycle.js`)
State machine: `closed_won → trial_day_0..14 → month_1/2/3 → ongoing` or `churned`

**Trial Deliverables (Days 0-14):**
| Day | Deliverables |
|-----|-------------|
| 0 | ClickUp project, Slack channels, Google Drive, access requests, rank tracking |
| 1 | AM intro video, OB doc |
| 3 | Onboarding call, project plan, site audit, NAP workbook, competitor research |
| 5 | Design concept, review blast, GMB optimization, GBP thumbnails, content map |
| 7 | Week 1 check-in call |
| 8 | Check-in, progress report |
| 11 | Homepage optimization, content actions |
| 12 | DBA filing, citations round 1 |
| 14 | Ascension deck, ascension call |

### Related Database Tables
- `client_lifecycle` — Stage tracking, trial dates, ascension value
- `client_deliverables` — Per-day task tracking with auto-dispatch
- `client_blockers` — Escalation: 0=none → 1=AM → 2=CSD → 3=Ben
- `client_access` — WordPress, GSC, GBP, GA4 credentials collected
- `client_call_logs` — Structured post-call data

### Communications Tracking
- **OpenPhone webhooks** → call transcription (AssemblyAI) → Claude analysis → action items
- `communications` table: transcript, summary, sentiment, topics, action_items
- `action_items` table: status (open → in_progress → completed), priority, assigned role

---

## 16. All API Endpoints

### Sales Dashboard & Team
| Method | Path | Description |
|--------|------|-------------|
| GET | `/sales` | Main sales dashboard page |
| GET | `/sales/<id>` | Individual member performance |
| GET | `/sales/pipeline-data` | Pipeline time-series data |

### Closer Functions
| Method | Path | Description |
|--------|------|-------------|
| GET | `/sales/closer-stats/<id>` | Closer dashboard metrics (JSON) |
| GET | `/sales/closer-dashboard/<id>` | Closer visual dashboard |
| GET/POST | `/sales/eod-report` | Submit/edit closer EOD |
| GET | `/sales/eod-history` | Historical EOD view |
| GET | `/sales/eod-reports` | List/view EOD reports |
| GET | `/sales/eod-reports/export` | CSV export |

### Setter Functions
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/sales/setter-eod-report` | Submit/edit setter EOD |
| GET | `/sales/setter-eod-reports` | List/view setter EODs |
| GET | `/sales/setter-eod-reports/export` | CSV export |
| GET | `/sales/setter-stats/<id>` | Setter dashboard metrics (JSON) |
| GET | `/sales/setter-dashboard/<id>` | Setter visual dashboard |

### Lead Management
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sales/calls/create` | Create sales call log (JSON) |
| POST | `/sales/calls/<id>/update` | Update sales call (JSON) |
| DELETE | `/sales/calls/<id>/delete` | Delete sales call |
| GET | `/sales/lead-attribution` | Lead attribution page |
| POST | `/sales/update-lead-status/<id>` | Update setter lead status (JSON) |
| GET | `/sales/pending-leads` | Pending leads for closer |

### GHL Integration
| Method | Path | Description |
|--------|------|-------------|
| GET | `/sales/api/ghl-appointments` | Fetch calendar events for date |
| GET | `/sales/api/ghl-opportunities` | Search opportunities by name |
| POST | `/sales/api/ghl-import` | Import opportunity as client |
| GET | `/sales/api/lead-search` | Search SetterLeads + CloserCalls |

### GHL Funnel Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/sales/setter-analytics` | GHL funnel page (3-tab UI) |
| GET | `/api/setter-analytics?days=N` | Analytics API (background processing) |

### Marketing Tracker
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sales/marketing-tracker/import` | CSV import |
| GET | `/sales/marketing-tracker/eod-data` | Aggregated closer+setter EOD for date |
| POST | `/sales/marketing-tracker/entry` | Save single day's metrics |
| POST | `/sales/marketing-tracker/benchmarks` | Save benchmark targets |

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/ghl/appointment` | GHL appointment → Hyros |
| POST | `/webhooks/ghl/opportunity` | GHL stage change → auto-create/ascend client |
| POST | `/webhooks/stripe/payment` | Stripe payment → Hyros |
| GET | `/webhooks/log` | View webhook event log (admin) |

---

## 17. Frontend Templates & UI

### Setter Analytics (3-Tab Layout)

**Tab bar**: Yellow active state, grey inactive, pill-style buttons.

**Tab 1: Funnel**
- KPI cards: Total Sets, Show Rate, Close Rate, No-Show Rate
- Side-by-side comparison: Auto-Booked vs Manual Setter cards
  - Auto-Booked: Show Rate, Close Rate, No-Show Rate (no dial metrics — these leads come from AI triage)
  - Manual Setter: Show Rate, Close Rate, No-Show Rate, Pickup Rate, Calls/Set, MC Rate
- "Where Sets Come From" chart (path_to_set_call)
- Outcomes table
- 24h activity feed

**Tab 2: Speed to Lead**
- Hero cards: Avg Response, Median, Fastest, Slowest
- Distribution cards with progress bars: < 5 min, < 1 hour, Unworked
- Daily Breakdown table
- Unworked Leads panel (sortable by wait time)

**Tab 3: Dialer**
- Hero cards: Total Dials, Pickup Rate, MC Rate, Calls/Set, Lead→Set
- Per-Stage Performance table (dials_by_origin)

### Design System
- Dark mode, constellation theme
- **OPT Yellow** (`#f5c518`) as primary accent
- JetBrains Mono font family
- Bootstrap Icons (`bi-*`)
- CSS variables: `--opt-yellow`, `--opt-yellow-muted`, `--text-400`, etc.
- Card style: `.am-hero-card` with colored left border

---

## 18. Key Constants & IDs

### GHL Pipeline
```
PIPELINE_ID = 'ZN1DW9S9qS540PNAXSxa'  # SCIO PIPELINE (USA)
```

### Client Statuses (Lifecycle)
```python
ClientStatus.TRIAL = 'trial'
ClientStatus.ASCENDED = 'ascended'
ClientStatus.MRR = 'mrr'
ClientStatus.CHURNED = 'churned'
```

### Lead Sources
```python
LeadSource.META_ADS
LeadSource.GOOGLE_ADS
LeadSource.REFERRAL
LeadSource.COLD_EMAIL
LeadSource.COLD_CALL
LeadSource.CONTENT
```

### Sales Call Outcomes
```python
SalesCallOutcome.NO_SHOW = 'no_show'
SalesCallOutcome.BOOKED_TRIAL = 'booked_trial'
SalesCallOutcome.NOT_INTERESTED = 'not_interested'
SalesCallOutcome.FOLLOW_UP = 'follow_up'
SalesCallOutcome.OTHER = 'other'
```

### Setter Lead Statuses
```python
['set', 'showed', 'no_show', 'rescheduled', 'cancelled', 'closed', 'not_closed']
```

---

## 19. Data Flows

### New Lead → Closed Deal → Client
```
1. Lead enters GHL pipeline (New Leads stage)
2. Setter dials via Wavv → tags added to GHL contact
3. Lead moved through Contact 1→2→3→4+ stages
4. Meeting booked → moved to Set Call / (24 Hour) / (Follow Up)
5. OR: AI auto-books → Auto-booked Triage → Triage Confirmed → Set Call
6. Closer takes call:
   a. No show → No Show (Confirmed/Closer) stage
   b. Not interested → Follow Ups / Nurture
   c. Closed → Closed stage → GHL webhook fires
7. GHL webhook → auto-creates Client (trial status) in dashboard
8. Command Centre webhook → creates lifecycle, dispatches Day 0 deliverables
```

### Daily Reporting
```
Closers: Submit EOD → {nc_booked, fu_booked, no_shows, live_calls, offers, closes, revenue}
         + Individual CloserCall entries linked to SetterLeads

Setters: Submit EOD → {total_leads, outbound_calls, pickups, mcs, sets, self_rating}
         + GHL opportunity autocomplete for lead names
```

### Commission Tracking
```
Client trial_fee (on close) + monthly_retainer × months_in_ascension (up to 90 days)
AM.commission_rate (stored as percentage) applied to commission_basis
```

### Marketing Funnel
```
CSV Import → SalesTrackerEntry (daily)
+ Closer EODs → CloserCalls → Revenue
+ Setter EODs → SetterLeads → Attribution
= Complete funnel: Ad Spend → Leads → Bookings → Live Calls → Offers → Closes → Revenue → Ascension
```

---

## 20. Known Issues & Gotchas

1. **GHL API Rate Limiting**: No explicit rate limit handling. The pipeline analytics fetches hundreds of opportunities + appointments sequentially. Currently uses `time.sleep(0.3)` every 10 appointment fetches.

2. **Speed to Lead is a proxy**: `lastStageChangeAt - createdAt` doesn't actually measure time-to-first-dial. It measures time until someone moved the lead to a different pipeline stage.

3. **Per-setter breakdown not available**: GHL's `assignedTo` field is sparsely populated (~50 leads out of hundreds, all same user). Would need Wavv API or manual assignment tracking.

4. **Render 30s HTTP timeout**: Analytics runs in background thread with polling. Cache TTL is 15 minutes.

5. **Calendar event API quirks**: GHL sometimes returns 422 if no `calendarId` is specified. Falls back to per-calendar fetch, then to older API version.

6. **GHL search API inconsistency**: Some tokens need `locationId` (camelCase) instead of `location_id` (snake_case). The client retries with both.

7. **Wavv tags are cumulative**: A contact's tags represent their entire dial history, not just recent dials. No way to filter by date range.

8. **Currency handling**: Trial fees default to USD, but retainers can be in NZD/AUD. `SalesTrackerEntry.currency` defaults to NZD. Currency conversion for display uses `current_app.config` rates.

9. **Commission rate stored as percentage**: `AM.commission_rate = 10` means 10%, divided by 100 in code. Can be confusing.

10. **Webhook event log in app_settings**: Stored as JSONB array in `app_settings` table (key='webhook_log'), keeps 200 most recent events. Not a proper table.

11. **Hyros integration optional**: If `HYROS_API_KEY` not set, appointment webhooks silently skip the Hyros push.

12. **No direct Wavv API integration**: All Wavv data comes from GHL contact tags. If Wavv changes tag format, metrics break.
