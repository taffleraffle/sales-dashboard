// Content brief generator — SERP-informed, vertical-specific, strategist-gated
// Input: { client_id, target_keyword, search_intent? }
// Process:
//   1. Pull live SERP for keyword via DataForSEO (real top 10 + features + competitors)
//   2. Pull keyword data (volume, CPC, difficulty)
//   3. Anthropic: build outline grounded in actual SERP intent + entities + missing angles
//   4. Insert content_briefs row (status=briefed)
//   5. Enqueue to strategist for approval

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const DFS = "https://api.dataforseo.com/v3";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

function dfsAuth(): string {
  return "Basic " + btoa(`${Deno.env.get("DATAFORSEO_LOGIN")}:${Deno.env.get("DATAFORSEO_PASSWORD")}`);
}

const BRIEF_SYSTEM = `You are a senior SEO content strategist for Rank On Maps, a local SEO + GEO agency. You produce briefs that mid-tier writers can execute and that consistently rank in the top 5.

Voice rules: no em-dashes, no AI slop, sentences short and dollar-specific, lowercase casual tone is OK. Match the client vertical.

Return STRICT JSON:
{
  "title": "the H1 / page title (max 60 chars, includes keyword)",
  "meta_description": "150-160 chars, action-led, includes keyword",
  "search_intent": "informational|commercial|transactional|local",
  "target_position": 3,
  "primary_keyword": "the focus keyword",
  "secondary_keywords": ["3-7 closely related terms"],
  "entities_to_cover": ["named entities/concepts the top results all mention"],
  "missing_angles": ["3-5 angles the top 10 do NOT cover well — our edge"],
  "outline": [
    {"h2": "section heading", "intent": "what this section achieves", "word_count": 200, "must_include": ["specific data points/quotes/stats"]}
  ],
  "schema_requirements": ["LocalBusiness", "FAQPage", etc],
  "internal_link_targets": ["suggested anchor + suggested internal page"],
  "external_authority_sources": ["actual authoritative sites to cite"],
  "word_count_target": 1800,
  "tone_notes": "specific to vertical/audience",
  "writer_brief_summary": "2 paragraph elite brief a writer could execute today"
}

The brief must be elite enough that a competent generalist writer produces a top-5 page. No fluff. No filler sections.`;

async function fetchSerp(keyword: string, location: string): Promise<{ items: unknown[]; features: unknown[] }> {
  const r = await fetch(`${DFS}/serp/google/organic/live/advanced`, {
    method: "POST",
    headers: { "Authorization": dfsAuth(), "Content-Type": "application/json" },
    body: JSON.stringify([{
      keyword,
      location_name: location || "United States",
      language_name: "English",
      device: "desktop",
      depth: 20,
    }]),
  });
  const d = await r.json();
  const result = d.tasks?.[0]?.result?.[0];
  return {
    items: (result?.items || []).slice(0, 10),
    features: result?.item_types || [],
  };
}

async function fetchKeywordData(keyword: string): Promise<{ volume?: number; cpc?: number; competition?: number }> {
  const r = await fetch(`${DFS}/keywords_data/google_ads/search_volume/live`, {
    method: "POST",
    headers: { "Authorization": dfsAuth(), "Content-Type": "application/json" },
    body: JSON.stringify([{ keywords: [keyword], location_name: "United States", language_name: "English" }]),
  });
  const d = await r.json();
  const row = d.tasks?.[0]?.result?.[0];
  return { volume: row?.search_volume, cpc: row?.cpc, competition: row?.competition };
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { client_id, target_keyword, search_location } = await req.json();
    if (!client_id || !target_keyword) {
      return new Response(JSON.stringify({ error: "client_id + target_keyword required" }), { status: 400 });
    }

    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, vertical, primary_city, state_abbr, custom_domain, client_json")
      .eq("id", client_id)
      .single();
    if (!client) return new Response(JSON.stringify({ error: "client not found" }), { status: 404 });

    const location = search_location || `${client.primary_city}, ${client.state_abbr}, United States`;

    const [serp, kwData] = await Promise.all([
      fetchSerp(target_keyword, location),
      fetchKeywordData(target_keyword),
    ]);

    const competitorUrls = (serp.items as Array<{ url?: string; title?: string; description?: string; rank_absolute?: number }>)
      .map((i) => ({ rank: i.rank_absolute, title: i.title, description: i.description, url: i.url }));

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
        system: BRIEF_SYSTEM,
        messages: [{
          role: "user",
          content: `Client: ${client.business_name} (${client.vertical}) in ${location}
Target keyword: "${target_keyword}"
Search volume: ${kwData.volume ?? "unknown"} | CPC: $${kwData.cpc ?? "?"} | Competition: ${kwData.competition ?? "?"}

LIVE TOP 10 SERP:
${competitorUrls.map((c) => `${c.rank}. ${c.title}\n   ${c.url}\n   ${c.description?.slice(0,200) || ""}`).join("\n\n")}

SERP features present: ${(serp.features as string[]).join(", ")}

Build the elite brief. Return ONLY the JSON.`,
        }],
      }),
    });
    if (!aRes.ok) {
      return new Response(JSON.stringify({ error: `Anthropic ${aRes.status}: ${await aRes.text()}` }), { status: 500 });
    }
    const aData = await aRes.json();
    const text = aData.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return new Response(JSON.stringify({ error: "no JSON in brief", raw: text.slice(0, 500) }), { status: 500 });
    const brief = JSON.parse(jsonMatch[0]);

    // Find current ranking position if any
    const clientDomain = (client.custom_domain || "").replace(/^www\./, "");
    let currentPosition: number | null = null;
    if (clientDomain) {
      const found = (serp.items as Array<{ domain?: string; rank_absolute?: number }>)
        .find((i) => i.domain?.replace(/^www\./, "") === clientDomain);
      currentPosition = found?.rank_absolute ?? null;
    }

    const { data: briefRow } = await supa
      .from("content_briefs")
      .insert({
        client_id,
        target_keyword,
        search_intent: brief.search_intent,
        search_volume: kwData.volume,
        difficulty: Math.round((kwData.competition ?? 0) * 100),
        current_position: currentPosition,
        target_position: brief.target_position || 3,
        serp_competitors: competitorUrls,
        serp_features: serp.features,
        outline: brief.outline,
        entities: brief.entities_to_cover,
        schema_requirements: brief.schema_requirements,
        internal_links: brief.internal_link_targets,
        word_count_target: brief.word_count_target,
        tone_notes: brief.tone_notes,
        status: "awaiting_strategist",
      })
      .select("id")
      .single();

    const priority = currentPosition && currentPosition <= 20 ? 80 : 60;
    const queue = await enqueueForStrategist({
      client_id,
      kind: "content_brief",
      priority,
      proposed_payload: { brief_id: briefRow!.id, ...brief, current_position: currentPosition, serp_competitors: competitorUrls.slice(0, 5) },
      source_function: "content-brief-generator",
      source_payload: { target_keyword, search_location: location },
    });

    await supa.from("content_briefs").update({ queue_id: queue.queue_id }).eq("id", briefRow!.id);

    await notifyStrategistSlack(queue.queue_id, `New brief for *${client.business_name}*: "${target_keyword}" (vol ${kwData.volume ?? "?"}, current pos ${currentPosition ?? "not ranking"})`);

    return new Response(JSON.stringify({ ok: true, brief_id: briefRow!.id, queue_id: queue.queue_id, ...brief }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
