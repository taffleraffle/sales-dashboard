# Sales Dashboard — Claude Code Guide

## Overview
OPT Digital's internal sales performance dashboard. Tracks closer/setter metrics, commissions, marketing performance, setter bot conversations, email flows, and EOD reviews. Authenticated via Supabase Auth with role-based access (admin vs team member).

## Tech Stack
- **Frontend:** React 18 + Vite 5 (JSX, not TypeScript)
- **Styling:** Tailwind CSS v4 (via @tailwindcss/vite plugin)
- **Routing:** react-router-dom v7
- **Charts:** Recharts v3
- **Icons:** lucide-react
- **Backend:** Supabase (project `kjfaqhmllagbxjdxlopm`)
- **Edge Functions:** Deno-based, in `supabase/functions/`
- **Deploy:** Render static site (see `render.yaml`)

## Directory Structure
```
src/
  App.jsx              # Routes + ErrorBoundary + ProtectedRoute
  main.jsx             # Entry point
  index.css            # Tailwind + global styles
  components/          # Shared UI (Layout, KPICard, DataTable, Gauge, modals)
    commission/        # Commission sub-components (ClientsTab, PaymentsTab, etc.)
  contexts/
    AuthContext.jsx     # Supabase Auth, session, profile, role
  hooks/               # Data-fetching hooks (useCloserData, useSetterData, useCommissions, etc.)
  lib/
    supabase.js         # Supabase client init
  pages/               # Route pages (SalesOverview, CloserDetail, SetterBot, etc.)
  services/            # Business logic (commissionCalc, ghlCalendar, fathomSync, wavvService, etc.)
  utils/               # Constants, date utils, metric calculations
supabase/
  functions/           # Deno Edge Functions
    _shared/           # Shared utils (CORS, payment matching)
    stripe-webhook/    # Stripe payment ingestion
    fanbasis-webhook/  # Fanbasis payment ingestion
    sync-fathom/       # Fathom call transcript sync
    sales-chat/        # AI chat for sales intelligence
    calculate-commissions/
    analyze-objections/
    admin-reset-password/
    invite-team-member/
migrations/            # SQL migrations (001-010)
scripts/               # CLI utilities (QA validate, GHL user finder, WAVV CSV import, Meta sync)
```

## Commands
| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Vite dev server (default port 5173) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint |
| `npm run qa` | QA validation script |

## Environment Variables (VITE_ prefix = client-side)
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anonymous key
- `VITE_GHL_API_KEY` — GoHighLevel API key
- `VITE_GHL_LOCATION_ID` — GHL location ID
- `VITE_META_ADS_ACCOUNT_ID` / `VITE_META_ADS_ACCESS_TOKEN` — Meta Ads
- `VITE_HYROS_API_KEY` — Hyros attribution
- `VITE_FATHOM_API_KEY` — Fathom call transcripts
- `VITE_NZD_TO_USD` — Currency conversion rate

Edge Functions use Supabase-managed secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_WEBHOOK_SECRET, GHL_API_KEY, GHL_LOCATION_ID).

## Architecture
- **Auth:** Supabase Auth with team_members table linkage. Admin role gates Settings, Commissions admin views. Non-admins see only their own commission page.
- **Data flow:** Hooks fetch from Supabase tables. Services handle external API calls (GHL, Fathom, WAVV, Meta). Edge Functions process inbound webhooks.
- **Commission system:** Payments from Stripe/Fanbasis webhooks -> auto-match to clients (email domain + company name) -> classify as trial/ascension/recurring -> calculate commission per `commission_settings`.
- **Setter Bot:** Displays engagement agent conversations, lead status, cadence controls.

## Critical Gotchas
1. **closer_calls has ZERO setter_lead_id linkage** — name + date matching is the ONLY way to correlate setter leads to closer outcomes. Do not assume FK joins work.
2. **ghl_appointments table is STALE** — endangered leads must fetch LIVE from GHL API, never trust the Supabase table alone.
3. **INTRO_CALENDARS constant** (`src/utils/constants.js`) — these GHL calendar IDs represent auto-booked intro calls, not setter-set appointments. Filter logic depends on this.
4. **NZD to USD conversion** — payments come in NZD, dashboard displays USD. The `VITE_NZD_TO_USD` rate must be kept current.
5. **RLS + PostgREST visibility** — new tables need explicit GRANT + `NOTIFY pgrst, 'reload schema'` to appear via PostgREST/Supabase client.
6. **No secrets in code** — all API keys live in Render env vars (frontend) or Supabase secrets (Edge Functions). Never commit credentials.

## Routes (Pages)
| Path | Page |
|------|------|
| `/sales` | Sales Overview |
| `/sales/closers` | Closer team overview |
| `/sales/closers/:id` | Individual closer detail |
| `/sales/setters` | Setter team overview |
| `/sales/setters/:id` | Individual setter detail |
| `/sales/setters/:id/kpi-history` | Setter KPI history |
| `/sales/marketing` | Marketing performance |
| `/sales/eod` | EOD review (includes history) |
| `/sales/call-data` | Call data / transcripts |
| `/sales/commissions` | Commission tracker |
| `/sales/commissions/:id` | Individual commission detail |
| `/sales/setter-bot` | Setter bot conversations |
| `/sales/email-flows` | Email flow management |
| `/sales/settings` | Admin settings |

## Related Projects
- **SEO Dashboard** (`C:\Users\Ben\seo-dashboard\`) — main Nexus platform
- **Engagement Agent** (`C:\Users\Ben\engagement-agent\`) — setter bot backend on Render
- **Content Pipeline** (`C:\Users\Ben\content-pipeline\`) — Optimus content engine

## OPT Domain Vocabulary

Ben uses business terms, not React/code terms. When you see one of these words in a request, it means the Supabase entity — NOT a file named after it. Reach for the `mcp__supabase__execute_sql` tool, not Grep/Read.

| Term Ben says | What it means |
|---|---|
| **library** / **the library** | The `lib_creative_library` table at `/sales/ads/creative/library`. Every ad clip + image + edited cut. |
| **hook** (in library context) | A row in `lib_creative_library` with `type='Hook'`. NOT a React hook (useFoo.jsx). |
| **body** | `lib_creative_library` row with `type='Body'`. |
| **joined** | `type='Joined'` — a merged hook+body composite. |
| **full video** | `type='Full Video'` — single-clip script. |
| **testimony** / **testimonial** | `type='Testimony'`. |
| **retargeting** | `type='Retargeting'`. |
| **raw** (creative status) | `lib_creative_library.status='raw'` — needs editing. |
| **edited** (creative status) | `lib_creative_library.status='edited'` — finished cut. |
| **the queue** / **editing queue** | The `lib_editing_queue` view + `lib_editing_tasks` table. |
| **task** | A row in `lib_editing_tasks` — one editor assignment per creative. |
| **editor** | A row in `lib_creative_editors` — Ahmed, Mohamed, Dean, etc. |
| **submission** / **version** | A row in `lib_task_submissions` — versioned uploads (v1/v2/v3) per task. |
| **download link** / **send me the video** | A URL the operator can click that downloads the original file. Use `COALESCE(final_cut_url, drive_url, preview_url)` and append `?download=<filename>` so Supabase serves `Content-Disposition: attachment`. Without the query param the browser opens it in a tab instead of saving. |
| **canonical name** | The auto-generated name like `RAW-ADAM-TPA-SCAM-T01.mp4` in `canonical_name`. Fall back to `name` when null. |
| **creator** / **actor** | `lib_creative_library.creator` — set by the `identify-actor` Edge Function via Claude Vision. |
| **offer** | A row in `offers` linked via `lib_creative_library.offer_slug`. |

**Common request patterns and how to handle them:**

- "Open up library and find me an [edited/raw] [hook/body/joined]" → `SELECT id, COALESCE(canonical_name, name) AS name, COALESCE(final_cut_url, drive_url, preview_url) AS url FROM lib_creative_library WHERE type='Hook' AND status='edited' AND COALESCE(final_cut_url, drive_url, preview_url) IS NOT NULL ORDER BY added_at DESC LIMIT 1` then reply with the URL + `?download=<filename>` appended.
- "Send me a video / send it here" → resolve the URL via the priority above + append the download query param. Paste the URL into the reply.
- "How many [unassigned raws / overdue tasks / pending submissions]" → query the relevant table; don't grep the codebase.
- "Who's working on X" / "what's [editor name] up to" → query `lib_editing_queue` filtered by `editor_name`.

**When to grep / read code instead of Supabase**: only when Ben is asking about the implementation (component names, where logic lives, why something is broken) — NOT when he's asking about content / data.

## MCP Server
Project-scoped Supabase MCP server is wired via `.mcp.json` (gitignored). Requires `SUPABASE_ACCESS_TOKEN` env var set in the parent process. Available tools include `execute_sql`, `list_tables`, `get_logs`, `list_edge_functions`, `get_advisors`. Defaults to read-only — write operations are blocked.
