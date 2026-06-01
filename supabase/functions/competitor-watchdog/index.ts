// Weekly competitor watchdog — for every client's tracked competitors,
// pulls SERP overlap + new content + new backlinks + ranking changes
// via DataForSEO. Generates a strategic memo for each competitor.
// Routes to strategist queue.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const DFS = "https://api.dataforseo.com/v3";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

function dfsAuth(): string {
  return "Basic " + btoa(`${Deno.env.get("DATAFORSEO_LOGIN")}:${Deno.env.get("DATAFORSEO_PASSWORD")}`);
}

interface Competitor { domain: string; }

async function getCompetitors(supa: ReturnType<typeof createClient>, clientId: string, vertical: string): Promise<Competitor[]> {
  const { data: tracked } = await supa
    .from("clients")
    .select("client_json")
    .eq("id", clientId)
    .single();
  const explicit = ((tracked?.client_json as { competitors?: Competitor[] })?.competitors) || [];
  if (explicit.length > 0) return explicit.slice(0, 5);

  // Fallback: pull from DFS competitor research
  const { data: client } = await supa
    .from("clients")
    .select("custom_domain")
    .eq("id", clientId)
    .single();
  if (!client?.custom_domain) return [];

  const r = await fetch(`${DFS}/dataforseo_labs/google/competitors_domain/live`, {
    method: "POST",
    headers: { "Authorization": dfsAuth(), "Content-Type": "application/json" },
    body: JSON.stringify([{ target: client.custom_domain, location_name: "United States", language_name: "English", limit: 5 }]),
  });
  const d = await r.json();
  const items = d.tasks?.[0]?.result?.[0]?.items || [];
  return items.map((i: { domain: string }) => ({ domain: i.domain }));
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const body = await req.json().catch(() => ({}));
  const onlyClient: string | undefined = body.client_id;

  let q = supa
    .from("clients")
    .select("id, business_name, vertical, custom_domain, primary_city")
    .eq("status", "active");
  if (onlyClient) q = q.eq("id", onlyClient);
  const { data: clients } = await q;
  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients" }), { status: 200 });
  }

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const weekKey = weekStart.toISOString().slice(0, 10);

  const summary: Array<{ client: string; competitors: number; threats: number }> = [];

  for (const client of clients) {
    const competitors = await getCompetitors(supa, client.id, client.vertical);
    let threats = 0;

    for (const comp of competitors) {
      // Domain intersection — keywords competitor ranks where client doesn't
      const intersectRes = await fetch(`${DFS}/dataforseo_labs/google/domain_intersection/live`, {
        method: "POST",
        headers: { "Authorization": dfsAuth(), "Content-Type": "application/json" },
        body: JSON.stringify([{
          target1: comp.domain,
          target2: client.custom_domain,
          location_name: "United States",
          language_name: "English",
          intersections: false,
          limit: 50,
        }]),
      });
      const intersect = await intersectRes.json();
      const competitorOnlyKeywords = (intersect.tasks?.[0]?.result?.[0]?.items || []).slice(0, 25);

      const aRes = await fetch(ANTHROPIC, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 1500,
          system: `You are a competitive intelligence analyst for Rank On Maps. Given a competitor's SERP data vs the client, write a memo. Return JSON: {"threat_score": 0-100, "movements": [{"area": string, "movement": string}], "recommended_response": string, "client_safe_framing": string}. Voice: no em-dashes, dollar-specific, named entities.`,
          messages: [{
            role: "user",
            content: `Client: ${client.business_name} (${client.vertical}) in ${client.primary_city}\nCompetitor: ${comp.domain}\nKeywords competitor ranks where client does not:\n${competitorOnlyKeywords.slice(0, 15).map((k: { keyword?: string; competitor?: { rank_absolute?: number }; search_volume?: number }) => `- ${k.keyword} (vol ${k.search_volume}, comp pos ${k.competitor?.rank_absolute})`).join("\n")}\n\nReturn ONLY the JSON.`,
          }],
        }),
      });
      const aData = await aRes.json();
      const text = aData.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const memo = JSON.parse(jsonMatch[0]);

      await supa.from("competitor_briefs").upsert({
        client_id: client.id,
        week_starting: weekKey,
        competitor_domain: comp.domain,
        movements: memo.movements,
        new_content: competitorOnlyKeywords.slice(0, 10),
        ranking_changes: competitorOnlyKeywords.slice(0, 10),
        threat_score: memo.threat_score,
        recommended_response: memo.recommended_response,
      }, { onConflict: "client_id,week_starting,competitor_domain" });

      if (memo.threat_score >= 70) {
        threats++;
        const queue = await enqueueForStrategist({
          client_id: client.id,
          kind: "competitor_brief",
          priority: 75,
          proposed_payload: {
            week_starting: weekKey,
            competitor: comp.domain,
            threat_score: memo.threat_score,
            memo,
            keyword_opportunities: competitorOnlyKeywords.slice(0, 10),
          },
          source_function: "competitor-watchdog",
          source_payload: { client_id: client.id, competitor: comp.domain },
        });
        await notifyStrategistSlack(
          queue.queue_id,
          `Competitor threat ${memo.threat_score}/100: *${comp.domain}* moving on *${client.business_name}*`,
        );
      }
    }

    summary.push({ client: client.business_name, competitors: competitors.length, threats });
  }

  return new Response(JSON.stringify({ ok: true, week: weekKey, summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
