// AI search visibility probe — weekly per-client across 5 platforms
// Queries each AI search interface for the client's target queries,
// detects whether the client domain (or brand name) appears in the answer,
// records which competitors get cited instead.
//
// Platforms covered:
//   - ChatGPT (search-enabled via OpenAI-compatible endpoint or web fetch fallback)
//   - Perplexity (API)
//   - Google Gemini (API)
//   - Anthropic Claude (no public search citations — we use as control via web fetch)
//   - Google AI Overviews (via SerpAPI/DataForSEO AIO endpoint)
//
// For platforms without API keys configured, we use DataForSEO's AI Mode/AIO endpoint
// (returns rendered AI answer + cited sources) as the practical substitute.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const DFS = "https://api.dataforseo.com/v3";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

function dfsAuth(): string {
  return "Basic " + btoa(`${Deno.env.get("DATAFORSEO_LOGIN")}:${Deno.env.get("DATAFORSEO_PASSWORD")}`);
}

interface PlatformResult {
  platform: string;
  query: string;
  client_cited: boolean;
  client_excerpt?: string;
  competitors_cited: string[];
  total_citations: number;
  raw: string;
}

function domainFromUrl(u: string): string {
  try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, ""); }
  catch { return u.replace(/^www\./, ""); }
}

async function probeAIOverview(query: string, location: string, clientDomain: string, brand: string): Promise<PlatformResult> {
  const r = await fetch(`${DFS}/serp/google/ai_mode/live/advanced`, {
    method: "POST",
    headers: { "Authorization": dfsAuth(), "Content-Type": "application/json" },
    body: JSON.stringify([{
      keyword: query,
      location_name: location,
      language_name: "English",
    }]),
  });
  const d = await r.json();
  const result = d.tasks?.[0]?.result?.[0];
  const answer = result?.items?.[0]?.text || "";
  const refs: Array<{ url?: string; domain?: string; title?: string }> = result?.items?.[0]?.references || [];
  const cited = refs.map((r) => r.domain || domainFromUrl(r.url || ""));
  const clientCited = cited.some((c) => c === clientDomain) || answer.toLowerCase().includes(brand.toLowerCase());
  return {
    platform: "google_aio",
    query,
    client_cited: clientCited,
    client_excerpt: clientCited ? answer.slice(0, 500) : undefined,
    competitors_cited: cited.filter((c) => c && c !== clientDomain).slice(0, 10),
    total_citations: cited.length,
    raw: answer.slice(0, 2000),
  };
}

async function probePerplexity(query: string, clientDomain: string, brand: string): Promise<PlatformResult> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) {
    return { platform: "perplexity", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: "PERPLEXITY_API_KEY not set" };
  }
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
      return_citations: true,
    }),
  });
  if (!r.ok) {
    return { platform: "perplexity", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: `perplexity ${r.status}` };
  }
  const d = await r.json();
  const answer = d.choices?.[0]?.message?.content || "";
  const citations: string[] = d.citations || [];
  const domains = citations.map(domainFromUrl);
  const clientCited = domains.includes(clientDomain) || answer.toLowerCase().includes(brand.toLowerCase());
  return {
    platform: "perplexity",
    query,
    client_cited: clientCited,
    client_excerpt: clientCited ? answer.slice(0, 500) : undefined,
    competitors_cited: domains.filter((d) => d && d !== clientDomain).slice(0, 10),
    total_citations: domains.length,
    raw: answer.slice(0, 2000),
  };
}

async function probeChatGPT(query: string, clientDomain: string, brand: string): Promise<PlatformResult> {
  // OpenAI Responses API with web_search tool (or fallback to gpt-4o-search)
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    return { platform: "chatgpt", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: "OPENAI_API_KEY not set" };
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-search-preview",
      messages: [{ role: "user", content: query }],
      web_search_options: {},
    }),
  });
  if (!r.ok) {
    return { platform: "chatgpt", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: `chatgpt ${r.status}` };
  }
  const d = await r.json();
  const msg = d.choices?.[0]?.message;
  const answer = msg?.content || "";
  const annotations: Array<{ url_citation?: { url?: string } }> = msg?.annotations || [];
  const domains = annotations.map((a) => domainFromUrl(a.url_citation?.url || "")).filter(Boolean);
  const clientCited = domains.includes(clientDomain) || answer.toLowerCase().includes(brand.toLowerCase());
  return {
    platform: "chatgpt",
    query,
    client_cited: clientCited,
    client_excerpt: clientCited ? answer.slice(0, 500) : undefined,
    competitors_cited: domains.filter((d) => d && d !== clientDomain).slice(0, 10),
    total_citations: domains.length,
    raw: answer.slice(0, 2000),
  };
}

async function probeGemini(query: string, clientDomain: string, brand: string): Promise<PlatformResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    return { platform: "gemini", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: "GEMINI_API_KEY not set" };
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!r.ok) {
    return { platform: "gemini", query, client_cited: false, competitors_cited: [], total_citations: 0, raw: `gemini ${r.status}` };
  }
  const d = await r.json();
  const answer = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const grounding = d.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  // Gemini returns the real domain in web.title and a Vertex AI redirect in web.uri.
  // Prefer title (the actual destination domain) — fall back to uri parse if title missing.
  const domains = grounding
    .map((g: { web?: { uri?: string; title?: string } }) => {
      const titleAsDomain = g.web?.title?.toLowerCase().trim() || "";
      if (titleAsDomain.includes(".")) return titleAsDomain.replace(/^www\./, "");
      return domainFromUrl(g.web?.uri || "");
    })
    .filter(Boolean);
  const clientCited = domains.includes(clientDomain) || answer.toLowerCase().includes(brand.toLowerCase());
  return {
    platform: "gemini",
    query,
    client_cited: clientCited,
    client_excerpt: clientCited ? answer.slice(0, 500) : undefined,
    competitors_cited: domains.filter((d: string) => d && d !== clientDomain).slice(0, 10),
    total_citations: domains.length,
    raw: answer.slice(0, 2000),
  };
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const onlyClient: string | undefined = body.client_id;
    const onlyQueries: string[] | undefined = body.queries;

    let q = supa
      .from("clients")
      .select("id, business_name, primary_city, state_abbr, custom_domain, vertical, client_json")
      .eq("status", "active");
    if (onlyClient) q = q.eq("id", onlyClient);
    const { data: clients } = await q;
    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: "no active clients" }), { status: 200 });
    }

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
    const weekKey = weekStart.toISOString().slice(0, 10);

    const summary: Array<{ client: string; platforms: number; cited: number; total_queries: number }> = [];

    for (const client of clients) {
      const clientDomain = domainFromUrl(client.custom_domain || "");
      const brand = client.business_name;
      const location = `${client.primary_city}, ${client.state_abbr}, United States`;

      // Pull tracked keywords for this client
      const { data: tracked } = await supa
        .from("tracked_keywords")
        .select("keyword")
        .eq("client_id", client.id)
        .eq("is_money_keyword", true)
        .limit(10);
      const queries = onlyQueries || (tracked || []).map((t) => t.keyword);
      if (queries.length === 0) {
        summary.push({ client: brand, platforms: 0, cited: 0, total_queries: 0 });
        continue;
      }

      let citedCount = 0;
      let platformsRun = 0;
      const allResults: PlatformResult[] = [];

      for (const query of queries.slice(0, 5)) {
        const results = await Promise.allSettled([
          probeAIOverview(query, location, clientDomain, brand),
          probePerplexity(query, clientDomain, brand),
          probeChatGPT(query, clientDomain, brand),
          probeGemini(query, clientDomain, brand),
        ]);
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          platformsRun++;
          if (r.value.client_cited) citedCount++;
          allResults.push(r.value);
          await supa.from("ai_visibility_reports").upsert({
            client_id: client.id,
            week_starting: weekKey,
            platform: r.value.platform,
            query,
            client_cited: r.value.client_cited,
            client_citation_excerpt: r.value.client_excerpt,
            competitors_cited: r.value.competitors_cited,
            total_citations: r.value.total_citations,
            raw_response: r.value.raw,
          }, { onConflict: "client_id,week_starting,platform,query" });
        }
      }

      // Build a strategist queue item with summary insights
      const aiSummary = await fetch(ANTHROPIC, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 1500,
          system: `You are an AI search visibility analyst. Given a week of probe data across ChatGPT/Perplexity/Gemini/Google AI Overviews for a local SEO client, write a brief strategic memo. Voice: ROM (no em-dashes, dollar-specific, no slop). Return JSON with: {"verdict": "cited"|"contested"|"absent", "headline": "one-line for client", "internal_insight": "the strategist's true read with competitor names", "recommended_actions": [{"action": string, "why": string, "priority": "high|med|low"}], "client_safe_summary": "what to tell the client, framed positive even if absent"}`,
          messages: [{
            role: "user",
            content: `Client: ${brand} (${client.vertical}) in ${location}\nDomain: ${clientDomain}\n\nPlatform probe results (${allResults.length}):\n${allResults.map((r) => `- ${r.platform} | "${r.query}" → ${r.client_cited ? "CITED" : "absent"} | competitors: ${r.competitors_cited.slice(0, 5).join(", ")}`).join("\n")}\n\nReturn ONLY the JSON memo.`,
          }],
        }),
      }).then((r) => r.json());
      const summaryText = aiSummary.content?.[0]?.text || "";
      const summaryJson = summaryText.match(/\{[\s\S]*\}/);
      const memo = summaryJson ? JSON.parse(summaryJson[0]) : { verdict: "unknown", headline: "AI visibility scan complete", internal_insight: "", recommended_actions: [], client_safe_summary: "" };

      const queue = await enqueueForStrategist({
        client_id: client.id,
        kind: "ai_visibility_report",
        priority: memo.verdict === "absent" ? 80 : 50,
        proposed_payload: {
          week_starting: weekKey,
          memo,
          platforms_probed: platformsRun,
          queries_probed: queries.length,
          times_cited: citedCount,
          raw_results: allResults.slice(0, 20),
        },
        source_function: "ai-visibility-probe",
        source_payload: { week_starting: weekKey },
      });

      const topCompetitorsCited = Array.from(new Set(allResults.flatMap((r) => r.competitors_cited))).slice(0, 3);
      await notifyStrategistSlack({
        queue_id: queue.queue_id,
        kind_label: "AI SEARCH VISIBILITY",
        emoji: ":eyes:",
        client_name: brand,
        client_location: location,
        urgency: memo.verdict === "absent" ? "high" : memo.verdict === "cited" ? "low" : "med",
        rows: [
          { label: "cited         ", value: `${citedCount}/${platformsRun} probes` },
          { label: "verdict       ", value: memo.verdict || "—" },
          { label: "queries probed", value: `${queries.length}` },
          { label: "platforms     ", value: "ChatGPT, Perplexity, Gemini, AIO" },
          { label: "comps cited   ", value: topCompetitorsCited.length ? topCompetitorsCited.join(", ") : "none yet" },
        ],
        preview: memo.headline?.slice(0, 280),
      });

      summary.push({ client: brand, platforms: platformsRun, cited: citedCount, total_queries: queries.length });
    }

    return new Response(JSON.stringify({ ok: true, week: weekKey, summary }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
