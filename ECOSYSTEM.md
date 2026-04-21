# Sales Dashboard — Ecosystem Map

## This Project
**Sales Dashboard** — OPT Digital's internal sales performance platform.
- **Repo:** `C:\Users\Ben\sales-dashboard\`
- **Live URL:** `https://sales-dashboard-ftct.onrender.com`
- **Supabase:** project `kjfaqhmllagbxjdxlopm`
- **Deploy:** Render static site

## Related Projects

### Engagement Agent (Setter Bot Backend)
- **Repo:** `C:\Users\Ben\engagement-agent\`
- **Live URL:** `https://engagement-agent-ga26.onrender.com`
- **Purpose:** Automated setter bot that handles lead engagement, re-engagement, speed-to-lead
- **Integration:** Setter Bot tab in this dashboard displays conversations from the engagement agent's Supabase tables (same Supabase project)
- **Linq number:** +17372973795

### SEO Dashboard (Nexus)
- **Repo:** `C:\Users\Ben\seo-dashboard\`
- **Purpose:** Main operational platform — Client Brain, content engine, task management, bot registry
- **Shared:** Same Supabase project for some cross-references; team members may overlap

### Content Pipeline (Optimus)
- **Repo:** `C:\Users\Ben\content-pipeline\`
- **Purpose:** Automated SEO content generation engine
- **Relation:** Content output feeds into client metrics visible in SEO dashboard

### Forge
- **Repo:** `C:\Users\Ben\forge\`
- **Purpose:** Ad creative engine, UGC generation, offer research lab
- **Relation:** Marketing creatives may feed into Meta Ads tracked here

## External Services

| Service | Purpose | Auth Method |
|---------|---------|-------------|
| Supabase | Database, Auth, Edge Functions | Anon key (client), Service role key (server) |
| Stripe | Payment processing | Webhook secret |
| Fanbasis | Payment processing | Webhook |
| GoHighLevel | CRM, Calendar, Pipeline | API key + Location ID |
| Fathom | Call transcripts | API key |
| Meta Ads | Ad performance data | Access token + Account ID |
| WAVV | Dialer/call tracking | Via GHL integration |
| Hyros | Lead attribution | API key |
| Render | Hosting (static site) | Git deploy |

## Data Flow Between Systems

```
Stripe/Fanbasis --> [webhooks] --> Supabase Edge Functions --> payments table
GHL CRM ----------> [API calls] --> Dashboard (live fetch, not cached)
Fathom -----------> [API sync] --> closer_calls / transcripts
Engagement Agent -> [shared DB] --> setter bot conversations
Meta Ads ---------> [API sync] --> marketing performance data
```

## Shared Supabase Project (kjfaqhmllagbxjdxlopm)
Both the Sales Dashboard and Engagement Agent share this Supabase project. Tables are namespaced by purpose:
- `team_members`, `closer_*`, `setter_*`, `payments`, `clients`, `commission_*` — Sales Dashboard
- `engagement_*` — Engagement Agent (read by Sales Dashboard's Setter Bot tab)
