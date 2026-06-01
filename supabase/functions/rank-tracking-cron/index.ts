// Nightly rank tracking via DataForSEO SERP API
// - For every tracked_keyword, fetches Google SERP organic + map pack
// - Resolves client domain position
// - Inserts rank_history snapshot with delta_vs_yesterday
// - Emits 'rank_jump' win when client moves +3 or more positions

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { emitWin } from "../_shared/win-emit.ts";

const DFS_BASE = "https://api.dataforseo.com/v3";

function dfsAuth(): string {
  const login = Deno.env.get("DATAFORSEO_LOGIN")!;
  const pw = Deno.env.get("DATAFORSEO_PASSWORD")!;
  return "Basic " + btoa(`${login}:${pw}`);
}

function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

interface SerpItem {
  type: string;
  rank_absolute?: number;
  rank_group?: number;
  domain?: string;
  url?: string;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Optional: scope to one client via body
  const body = await req.json().catch(() => ({}));
  const onlyClientId: string | undefined = body.client_id;

  // Fetch tracked keywords + client domain
  let q = supa
    .from("tracked_keywords")
    .select("id, client_id, keyword, search_location, search_engine, device, clients(custom_domain, business_name)");
  if (onlyClientId) q = q.eq("client_id", onlyClientId);
  const { data: tracked, error } = await q;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!tracked || tracked.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no tracked keywords" }), { status: 200 });
  }

  const results: Array<{ keyword: string; position: number | null; delta: number | null; win?: boolean }> = [];

  // Batch into DataForSEO task_post — up to 100 per request
  const batchSize = 50;
  for (let i = 0; i < tracked.length; i += batchSize) {
    const batch = tracked.slice(i, i + batchSize);
    const tasks = batch.map((kw, idx) => ({
      keyword: kw.keyword,
      location_name: kw.search_location || "United States",
      language_name: "English",
      device: kw.device || "desktop",
      depth: 50,
      tag: `${kw.id}__${idx}`,
    }));

    const liveRes = await fetch(`${DFS_BASE}/serp/google/organic/live/advanced`, {
      method: "POST",
      headers: {
        "Authorization": dfsAuth(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tasks),
    });

    if (!liveRes.ok) {
      console.error("DFS live failed:", liveRes.status, await liveRes.text());
      continue;
    }

    const dfsData = await liveRes.json();
    const taskResults = dfsData.tasks || [];

    for (let t = 0; t < batch.length; t++) {
      const kw = batch[t];
      const taskRes = taskResults[t];
      const items: SerpItem[] = taskRes?.result?.[0]?.items || [];
      const clientDomain = domainFromUrl((kw.clients as { custom_domain?: string } | null)?.custom_domain);

      let position: number | null = null;
      let foundUrl: string | null = null;
      if (clientDomain) {
        for (const item of items) {
          if (item.domain && item.domain.replace(/^www\./, "") === clientDomain) {
            position = item.rank_absolute || item.rank_group || null;
            foundUrl = item.url || null;
            break;
          }
        }
      }

      // Previous position
      const { data: prev } = await supa
        .from("rank_history")
        .select("position")
        .eq("tracked_kw_id", kw.id)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const prevPos = prev?.position ?? null;
      let delta: number | null = null;
      if (prevPos != null && position != null) {
        delta = prevPos - position; // positive = improvement
      }

      await supa.from("rank_history").insert({
        tracked_kw_id: kw.id,
        client_id: kw.client_id,
        position,
        url: foundUrl,
        delta_vs_yesterday: delta,
      });

      let didWin = false;
      if (delta != null && delta >= 3 && position != null) {
        await emitWin({
          client_id: kw.client_id,
          kind: "rank_jump",
          headline: `Rank +${delta}: "${kw.keyword}" → position ${position}`,
          detail: `Was *${prevPos}*, now *${position}* in ${kw.search_location || "US"}.`,
          payload: { keyword: kw.keyword, position, previous: prevPos, delta },
          source: "dataforseo",
        });
        didWin = true;
      }

      // Big-bang win: client landed on page 1 for the first time
      if (position != null && position <= 10 && (prevPos == null || prevPos > 10)) {
        await emitWin({
          client_id: kw.client_id,
          kind: "rank_jump",
          headline: `:rocket: Page 1: "${kw.keyword}" → position ${position}`,
          detail: `First time on page 1${prevPos ? ` (was ${prevPos})` : ""}.`,
          payload: { keyword: kw.keyword, position, previous: prevPos },
          source: "dataforseo",
        });
        didWin = true;
      }

      // Top-3 unlock
      if (position != null && position <= 3 && (prevPos == null || prevPos > 3)) {
        await emitWin({
          client_id: kw.client_id,
          kind: "serp_feature_won",
          headline: `:fire: Top 3: "${kw.keyword}" → position ${position}`,
          detail: `Locked the top 3${prevPos ? ` (was ${prevPos})` : ""}. Map pack territory.`,
          payload: { keyword: kw.keyword, position, previous: prevPos },
          source: "dataforseo",
        });
        didWin = true;
      }

      results.push({ keyword: kw.keyword, position, delta, win: didWin });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    tracked_count: tracked.length,
    wins: results.filter((r) => r.win).length,
    results,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
