// Auto-draft a case study when a client hits a milestone worth celebrating publicly.
// Pulls: wins history (last 90d), rank movements, AI visibility, leads aggregate,
// content shipped, GBP health journey. Anthropic synthesizes into a markdown case study
// in ROM voice (no AI slop, dollar-specific, named entities).
// Routes to strategist queue. Never auto-publishes — Mersad approves.
//
// Trigger kinds: '4x_roi' | '10x_roi' | 'first_month_10k' | 'monthly_50k_rev' |
//   'monthly_100k_rev' | 'lifetime_100k' | 'page_1_first_money_kw' | 'manual'

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You write case studies for Rank On Maps, a local SEO + GEO agency. These get used by closers in sales conversations + published as marketing.

Voice (non-negotiable):
- No em-dashes. No semicolons. No AI flourishes ("delve", "leverage", "robust", "comprehensive solutions", "moreover").
- Dollar-specific. Named entities preferred over generic nouns.
- 40-60 word direct-answer paragraphs.
- Lead with the result, then the path, then the lever.
- NEVER mention what the client pays Rank On Maps (no monthly_fee, no pricing).
- Multiplier framing OK ("3x return on our service") but never expose the dollar amount they pay.
- No fabricated specifics (no invented addresses, license IDs, named testimonials).
- No "SCIO" references.
- No times in roadmap-like sections (no "in week 2" / "by month 3" / "after 8 weeks").

Return STRICT JSON:
{
  "headline": "max 80 chars · dollar-led or multiplier-led",
  "subhead": "1 sentence · names city + vertical + time horizon",
  "hero_quote": "max 20 words · framed as if from the client. Must be plausible. Mark [TBC] if unverifiable.",
  "body_md": "3-5 short markdown sections: ## The result · ## What was broken · ## What we changed · ## What happened next · ## Where it goes from here. Each section 40-80 words. NO em-dashes.",
  "data_points": [{"label": "string", "value": "string", "movement": "string (e.g. 'up from 0')"}],
  "before_after": {
    "before": {"key_metric": "string", "context": "string"},
    "after": {"key_metric": "string", "context": "string"}
  },
  "pull_quotes": ["1-2 highlight lines for visual emphasis when published"],
  "internal_only_notes": "any caveats Mersad should know before publishing — e.g. data points marked [TBC] need client confirmation"
}`;

interface ClientCtx {
  id: string;
  business_name: string;
  vertical: string;
  primary_city: string | null;
  state_abbr: string | null;
  country: string | null;
  custom_domain: string | null;
  contract_start: string | null;
  client_json: Record<string, unknown> | null;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { client_id, trigger_kind, trigger_payload } = await req.json();
    if (!client_id || !trigger_kind) {
      return new Response(JSON.stringify({ error: "client_id + trigger_kind required" }), { status: 400 });
    }

    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, vertical, primary_city, state_abbr, country, custom_domain, contract_start, client_json")
      .eq("id", client_id)
      .single<ClientCtx>();
    if (!client) return new Response(JSON.stringify({ error: "client not found" }), { status: 404 });

    // Only fire once per client per trigger_kind unless force=true
    const { data: existing } = await supa
      .from("case_studies")
      .select("id")
      .eq("client_id", client_id)
      .eq("trigger_kind", trigger_kind)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ ok: true, message: "case study already exists", existing_id: existing.id }), { status: 200 });
    }

    // Pull supporting data
    const since = client.contract_start || new Date(Date.now() - 90 * 86400e3).toISOString();
    const [winsRes, rankRes, aivisRes, leadsRes, dealsRes] = await Promise.all([
      supa.from("wins").select("kind, headline, detail, created_at").eq("client_id", client_id).gte("created_at", since).order("created_at", { ascending: false }).limit(100),
      supa.from("rank_history").select("position, delta_vs_yesterday, checked_at, tracked_keywords(keyword)").eq("client_id", client_id).order("checked_at", { ascending: false }).limit(50),
      supa.from("ai_visibility_reports").select("platform, query, client_cited, week_starting").eq("client_id", client_id).order("week_starting", { ascending: false }).limit(40),
      supa.from("client_leads").select("id, source, channel, deal_value, converted, created_at").eq("client_id", client_id).gte("created_at", since),
      supa.from("client_leads").select("deal_value, converted_at, source").eq("client_id", client_id).eq("converted", true).gte("converted_at", since),
    ]);

    const leads = leadsRes.data || [];
    const deals = dealsRes.data || [];
    const lifetimeRev = deals.reduce((s, d) => s + (Number(d.deal_value) || 0), 0);
    const daysSinceStart = client.contract_start
      ? Math.floor((Date.now() - new Date(client.contract_start).getTime()) / 86400e3)
      : null;
    const horizonLabel = daysSinceStart != null
      ? (daysSinceStart <= 14 ? "first 14 days" : daysSinceStart <= 30 ? "first month" : daysSinceStart <= 90 ? "first 90 days" : `${daysSinceStart} days`)
      : "the engagement";

    const userPrompt = `CLIENT: ${client.business_name}
VERTICAL: ${client.vertical}
LOCATION: ${client.primary_city}, ${client.state_abbr}, ${client.country}
DOMAIN: ${client.custom_domain}
ENGAGEMENT: ${client.contract_start || "unknown"} (${daysSinceStart != null ? `${daysSinceStart} days ago` : "n/a"})

TRIGGER: ${trigger_kind}
TRIGGER PAYLOAD: ${JSON.stringify(trigger_payload || {})}

== TRACKED RESULTS ==

Cumulative attributable revenue: $${lifetimeRev.toLocaleString()} (${deals.length} closed deals)
Total tracked leads: ${leads.length}
Horizon label: ${horizonLabel}

Recent wins (last ${winsRes.data?.length || 0}):
${(winsRes.data || []).slice(0, 20).map((w) => `- ${w.headline}`).join("\n")}

Rank movements (last ${rankRes.data?.length || 0} snapshots):
${(rankRes.data || []).slice(0, 20).map((r) => {
  const kw = (r.tracked_keywords as { keyword?: string } | null)?.keyword || "?";
  return `- ${kw}: position ${r.position} (Δ ${r.delta_vs_yesterday})`;
}).join("\n")}

AI search visibility (last ${aivisRes.data?.length || 0} probes):
${(aivisRes.data || []).slice(0, 15).map((a) => `- ${a.platform}: "${a.query}" → ${a.client_cited ? "CITED" : "absent"}`).join("\n")}

Build the case study. Return ONLY the JSON.`;

    const aRes = await fetch(ANTHROPIC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!aRes.ok) {
      return new Response(JSON.stringify({ error: `Anthropic ${aRes.status}: ${await aRes.text()}` }), { status: 500 });
    }
    const aData = await aRes.json();
    const text = aData.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return new Response(JSON.stringify({ error: "no JSON in case-study output", raw: text.slice(0, 500) }), { status: 500 });
    }
    const cs = JSON.parse(jsonMatch[0]);

    // Persist
    const { data: row } = await supa
      .from("case_studies")
      .insert({
        client_id,
        trigger_kind,
        trigger_payload: trigger_payload || {},
        headline: cs.headline,
        subhead: cs.subhead,
        hero_quote: cs.hero_quote,
        body_md: cs.body_md,
        data_points: cs.data_points || [],
        before_after: cs.before_after || {},
        pull_quotes: cs.pull_quotes || [],
        status: "awaiting_strategist",
      })
      .select("id")
      .single();

    // Strategist queue + Slack notify
    const queue = await enqueueForStrategist({
      client_id,
      kind: "weekly_recap_curation",
      priority: 80,
      proposed_payload: {
        case_study_id: row!.id,
        trigger_kind,
        headline: cs.headline,
        subhead: cs.subhead,
        hero_quote: cs.hero_quote,
        body_md: cs.body_md,
        data_points: cs.data_points,
        pull_quotes: cs.pull_quotes,
        internal_only_notes: cs.internal_only_notes,
      },
      source_function: "case-study-generator",
      source_payload: { client_id, trigger_kind },
    });

    await notifyStrategistSlack({
      queue_id: queue.queue_id,
      kind_label: "CASE STUDY DRAFT",
      emoji: ":trophy:",
      client_name: client.business_name,
      client_location: [client.primary_city, client.state_abbr, client.country].filter(Boolean).join(", "),
      urgency: "high",
      rows: [
        { label: "trigger     ", value: trigger_kind },
        { label: "horizon     ", value: horizonLabel },
        { label: "revenue     ", value: `$${lifetimeRev.toLocaleString()}` },
        { label: "deals closed", value: `${deals.length}` },
        { label: "data points ", value: `${(cs.data_points || []).length}` },
      ],
      preview: cs.headline,
    });

    return new Response(JSON.stringify({ ok: true, case_study_id: row!.id, queue_id: queue.queue_id, ...cs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
