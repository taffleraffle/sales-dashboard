// Per-client 90-day roadmap generator
// Input: { client_id, force? } — regenerates monthly by default
// Pulls: extraction artifacts, vertical playbook, competitor briefs, win history,
// rank history, AI visibility reports, GBP health. Generates two flavors:
//   - internal_full_payload: full strategist view with weak spots + risks
//   - client_visible_summary: curated narrative, leads with vision + pillars + measurable targets
// Enqueues to strategist for approval before client publish.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

const ROADMAP_SYSTEM = `You are an elite local SEO strategist building a 90-day roadmap document for a Rank On Maps client. Two audiences:

1. STRATEGIST (Mersad / internal): sees all data including weak spots, risks, hesitations
2. CLIENT (external): sees a confident, narrative-driven roadmap with vision + pillars + measurable targets

Voice rules: no em-dashes, no AI slop, dollar-specific, named entities, lowercase casual OK when relevant. No times/dates/weeks in the client-facing version (we describe by phase, not week). No fabricated specifics.

Return STRICT JSON:
{
  "vision": "1 paragraph — where the client lands in 90 days. Specific dollar/lead/rank numbers.",
  "competitive_positioning": "1 paragraph — how the client takes share from named competitors",
  "three_pillars": [
    {"name": string, "outcome": string, "deliverables": [string]}
  ],
  "phase_plan": [
    {"phase": "Foundations", "goals": [string], "deliverables": [string], "internal_risks": [string]},
    {"phase": "Acceleration", "goals": [string], "deliverables": [string], "internal_risks": [string]},
    {"phase": "Compound", "goals": [string], "deliverables": [string], "internal_risks": [string]}
  ],
  "measurable_targets": [
    {"metric": string, "baseline": string, "target": string, "confidence": "high|med|low"}
  ],
  "internal_full": {
    "weak_spots": [string],
    "needs_from_client": [string],
    "competitor_threats": [string],
    "strategist_decisions_required": [string]
  },
  "client_visible_summary": "3-4 paragraph narrative the client reads. Confident. Specific. Frames challenges as 'levers we're already pulling'."
}

The client-facing summary must NEVER mention internal risks. It MUST mention how we're competing against specific named competitors. It MUST land on dollar/lead/rank outcomes.`;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { client_id, force } = await req.json();
    if (!client_id) return new Response(JSON.stringify({ error: "client_id required" }), { status: 400 });

    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, vertical, primary_city, state_abbr, custom_domain, monthly_fee, tier, client_json, questionnaire, game_plan, contract_start")
      .eq("id", client_id)
      .single();
    if (!client) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

    // Skip if recent roadmap exists (within 25 days) unless force=true
    if (!force) {
      const { data: recent } = await supa
        .from("client_roadmaps")
        .select("id, generated_at")
        .eq("client_id", client_id)
        .gte("generated_at", new Date(Date.now() - 25 * 86400e3).toISOString())
        .maybeSingle();
      if (recent) {
        return new Response(JSON.stringify({ ok: true, message: "recent roadmap exists", roadmap_id: recent.id }), { status: 200 });
      }
    }

    // Pull supporting signal
    const [winsRes, rankRes, gbpRes, aivrRes, compRes] = await Promise.all([
      supa.from("wins").select("kind, headline, created_at").eq("client_id", client_id).gte("created_at", new Date(Date.now() - 90 * 86400e3).toISOString()).order("created_at", { ascending: false }).limit(50),
      supa.from("rank_history").select("position, delta_vs_yesterday, checked_at, tracked_keywords(keyword)").eq("client_id", client_id).gte("checked_at", new Date(Date.now() - 30 * 86400e3).toISOString()).order("checked_at", { ascending: false }).limit(50),
      supa.from("gbp_health_log").select("score, flags, date").eq("client_id", client_id).order("date", { ascending: false }).limit(7),
      supa.from("ai_visibility_reports").select("platform, query, client_cited, week_starting").eq("client_id", client_id).order("week_starting", { ascending: false }).limit(40),
      supa.from("competitor_briefs").select("competitor_domain, movements, threat_score, week_starting").eq("client_id", client_id).order("week_starting", { ascending: false }).limit(10),
    ]);

    const userPrompt = `Client: ${client.business_name} (${client.vertical}) in ${client.primary_city}, ${client.state_abbr}
Tier: ${client.tier || "?"} | Monthly fee: $${client.monthly_fee || "?"}
Contract started: ${client.contract_start || "?"}
Custom domain: ${client.custom_domain || "?"}

Client questionnaire (extracted):
${JSON.stringify(client.questionnaire || {}, null, 2).slice(0, 3000)}

Current game plan:
${JSON.stringify(client.game_plan || {}, null, 2).slice(0, 2000)}

Recent wins (last 90d, ${(winsRes.data || []).length} total):
${(winsRes.data || []).slice(0, 15).map((w) => `- ${w.headline}`).join("\n")}

Rank movements (last 30d, ${(rankRes.data || []).length} snapshots):
${(rankRes.data || []).slice(0, 15).map((r) => `- ${(r.tracked_keywords as { keyword?: string } | null)?.keyword}: position ${r.position} (Δ ${r.delta_vs_yesterday})`).join("\n")}

GBP health (last 7d):
${(gbpRes.data || []).map((g) => `- ${g.date}: score ${g.score}, flags ${(g.flags as string[]).join(",")}`).join("\n")}

AI visibility (last 30d):
${(aivrRes.data || []).slice(0, 10).map((a) => `- ${a.platform}: "${a.query}" → ${a.client_cited ? "CITED" : "not cited"}`).join("\n")}

Competitor briefs (last 10):
${(compRes.data || []).map((c) => `- ${c.competitor_domain}: threat ${c.threat_score}, ${JSON.stringify(c.movements).slice(0, 200)}`).join("\n")}

Build the 90-day roadmap. Return ONLY the JSON.`;

    const aRes = await fetch(ANTHROPIC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 5000,
        system: ROADMAP_SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!aRes.ok) {
      return new Response(JSON.stringify({ error: `Anthropic ${aRes.status}: ${await aRes.text()}` }), { status: 500 });
    }
    const aData = await aRes.json();
    const text = aData.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return new Response(JSON.stringify({ error: "no JSON", raw: text.slice(0, 500) }), { status: 500 });
    const roadmap = JSON.parse(jsonMatch[0]);

    const effective_from = new Date().toISOString().slice(0, 10);
    const effective_to = new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10);

    const { data: row } = await supa
      .from("client_roadmaps")
      .insert({
        client_id,
        effective_from,
        effective_to,
        vision: roadmap.vision,
        competitive_positioning: roadmap.competitive_positioning,
        three_pillars: roadmap.three_pillars,
        phase_plan: roadmap.phase_plan,
        measurable_targets: roadmap.measurable_targets,
        client_visible_summary: roadmap.client_visible_summary,
        internal_full_payload: roadmap.internal_full,
        status: "draft",
      })
      .select("id")
      .single();

    const queue = await enqueueForStrategist({
      client_id,
      kind: "roadmap_update",
      priority: 75,
      proposed_payload: { roadmap_id: row!.id, ...roadmap, effective_from, effective_to },
      source_function: "roadmap-generator",
      source_payload: { client_id },
    });

    await notifyStrategistSlack(
      queue.queue_id,
      `90-day roadmap drafted for *${client.business_name}*. Vision: ${roadmap.vision?.slice(0, 120)}...`,
    );

    return new Response(JSON.stringify({ ok: true, roadmap_id: row!.id, queue_id: queue.queue_id, ...roadmap }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
