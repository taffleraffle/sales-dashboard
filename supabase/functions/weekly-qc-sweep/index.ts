// Weekly QC sweep — Sunday 10:00 UTC cron.
// For each active client: pulls latest roadmap, last 5 strategist-bound briefs,
// current ranks from rank_history, asks Claude to audit for drift / stale briefs /
// wasted swings / voice failures. If review needed, queues weekly_recap_curation.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const QC_SYSTEM = `You are a senior SEO strategist auditing a client's last 7 days.

Voice rules: no em-dashes, no AI slop, short sentences, dollar-specific. Lowercase casual is OK.

You receive a client's active roadmap, their last 5 content briefs awaiting or just approved by the strategist, and current Google ranks for their tracked keywords. Audit for:

- drift: briefs that no longer match the roadmap's three_pillars or measurable_targets
- stale briefs: stuck in awaiting_strategist or approved for over 7 days
- wasted swings: briefs targeting keywords where current rank is already top 3, or where the keyword is not in the roadmap pillars at all
- voice failures: briefs whose tone_notes or outline contain em-dashes, AI slop phrases ("dive deep", "in today's fast-paced", "unlock", "elevate", "robust solution", "leverage"), or generic filler

Return STRICT JSON:
{
  "needs_review": true,
  "flags": [
    {
      "category": "drift|stale|wasted_swing|voice",
      "severity": "low|med|high",
      "brief_id": "uuid or null",
      "headline": "one line summary",
      "detail": "specific finding referencing the data"
    }
  ],
  "summary": "2-3 sentence recap of the week for the strategist",
  "recommended_action": "what the strategist should do this week"
}

If nothing meaningful is wrong, return needs_review: false with empty flags and a brief summary.`;

interface RoadmapRow {
  id: string;
  generated_at: string;
  three_pillars: unknown;
  phase_plan: unknown;
  measurable_targets: unknown;
  status: string;
  vision: string | null;
}

interface BriefRow {
  id: string;
  target_keyword: string;
  search_intent: string | null;
  search_volume: number | null;
  current_position: number | null;
  target_position: number | null;
  status: string;
  outline: unknown;
  tone_notes: string | null;
  word_count_target: number | null;
  created_at: string;
  writer_assigned: string | null;
}

interface RankSnapshot {
  keyword: string;
  position: number | null;
  url: string | null;
  checked_at: string;
}

async function latestRanksForClient(
  supa: ReturnType<typeof createClient>,
  clientId: string,
): Promise<RankSnapshot[]> {
  // pull all tracked keywords, then latest rank_history row per keyword
  const { data: kws, error: kwErr } = await supa
    .from("tracked_keywords")
    .select("id, keyword")
    .eq("client_id", clientId);
  if (kwErr) throw new Error(`tracked_keywords: ${kwErr.message}`);
  if (!kws || kws.length === 0) return [];

  const snapshots: RankSnapshot[] = [];
  for (const kw of kws as Array<{ id: string; keyword: string }>) {
    const { data: rh, error: rhErr } = await supa
      .from("rank_history")
      .select("position, url, checked_at")
      .eq("tracked_kw_id", kw.id)
      .order("checked_at", { ascending: false })
      .limit(1);
    if (rhErr) {
      console.error(`rank_history fetch failed for ${kw.id}: ${rhErr.message}`);
      continue;
    }
    const row = rh?.[0] as { position: number | null; url: string | null; checked_at: string } | undefined;
    snapshots.push({
      keyword: kw.keyword,
      position: row?.position ?? null,
      url: row?.url ?? null,
      checked_at: row?.checked_at ?? "",
    });
  }
  return snapshots;
}

async function auditClient(
  client: { id: string; business_name: string; vertical: string | null; primary_city: string | null; state_abbr: string | null },
  roadmap: RoadmapRow | null,
  briefs: BriefRow[],
  ranks: RankSnapshot[],
): Promise<{ needs_review: boolean; flags: Array<{ category: string; severity: string; brief_id: string | null; headline: string; detail: string }>; summary: string; recommended_action: string } | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY missing");
    return null;
  }

  const userMsg = `Client: ${client.business_name} (${client.vertical ?? "unknown"}) in ${client.primary_city ?? "?"}, ${client.state_abbr ?? "?"}

ACTIVE ROADMAP:
${roadmap ? JSON.stringify({
    id: roadmap.id,
    generated_at: roadmap.generated_at,
    status: roadmap.status,
    vision: roadmap.vision,
    three_pillars: roadmap.three_pillars,
    phase_plan: roadmap.phase_plan,
    measurable_targets: roadmap.measurable_targets,
  }, null, 2) : "NO ACTIVE ROADMAP"}

LAST 5 BRIEFS (awaiting_strategist | approved):
${briefs.length === 0 ? "none" : briefs.map((b) => JSON.stringify({
    id: b.id,
    target_keyword: b.target_keyword,
    search_intent: b.search_intent,
    search_volume: b.search_volume,
    current_position: b.current_position,
    target_position: b.target_position,
    status: b.status,
    tone_notes: b.tone_notes,
    word_count_target: b.word_count_target,
    created_at: b.created_at,
    writer_assigned: b.writer_assigned,
    outline_preview: Array.isArray(b.outline) ? (b.outline as Array<{ h2?: string }>).slice(0, 3).map((s) => s.h2 ?? "?") : null,
  }, null, 2)).join("\n\n")}

CURRENT RANKS (latest snapshot per tracked keyword):
${ranks.length === 0 ? "no tracked keywords or no rank history" : ranks.map((r) => `${r.keyword} → ${r.position ? `#${r.position}` : "not ranking"} (checked ${r.checked_at?.slice(0, 10) || "?"})`).join("\n")}

Today is ${new Date().toISOString().slice(0, 10)}. Audit and return ONLY the JSON.`;

  const res = await fetch(ANTHROPIC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 3000,
      system: QC_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`anthropic ${res.status}: ${errText.slice(0, 400)}`);
    return null;
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error(`no JSON in audit response: ${text.slice(0, 300)}`);
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error(`audit JSON parse failed: ${(e as Error).message}`);
    return null;
  }
}

async function sweepOneClient(
  supa: ReturnType<typeof createClient>,
  client: { id: string; business_name: string; vertical: string | null; primary_city: string | null; state_abbr: string | null },
): Promise<{ client_id: string; client_name: string; needs_review: boolean; flag_count: number; queue_id?: string; error?: string }> {
  try {
    // 1. most recent roadmap (draft|approved|live)
    const { data: roadmapRows, error: rmErr } = await supa
      .from("client_roadmaps")
      .select("id, generated_at, three_pillars, phase_plan, measurable_targets, status, vision")
      .eq("client_id", client.id)
      .in("status", ["draft", "approved", "live"])
      .order("generated_at", { ascending: false })
      .limit(1);
    if (rmErr) throw new Error(`client_roadmaps: ${rmErr.message}`);
    const roadmap = (roadmapRows?.[0] as RoadmapRow | undefined) ?? null;

    // 2. last 5 briefs awaiting_strategist or approved
    const { data: briefs, error: bErr } = await supa
      .from("content_briefs")
      .select("id, target_keyword, search_intent, search_volume, current_position, target_position, status, outline, tone_notes, word_count_target, created_at, writer_assigned")
      .eq("client_id", client.id)
      .in("status", ["awaiting_strategist", "approved"])
      .order("created_at", { ascending: false })
      .limit(5);
    if (bErr) throw new Error(`content_briefs: ${bErr.message}`);

    // 3. current ranks from rank_history
    const ranks = await latestRanksForClient(supa, client.id);

    // 4. anthropic audit
    const audit = await auditClient(client, roadmap, (briefs as BriefRow[]) ?? [], ranks);
    if (!audit) {
      return { client_id: client.id, client_name: client.business_name, needs_review: false, flag_count: 0, error: "audit_failed" };
    }

    // 5. if needs review, enqueue + notify
    if (audit.needs_review && audit.flags.length > 0) {
      const highCount = audit.flags.filter((f) => f.severity === "high").length;
      const urgency: "low" | "med" | "high" = highCount > 0 ? "high" : audit.flags.length >= 3 ? "med" : "low";

      const queue = await enqueueForStrategist({
        client_id: client.id,
        kind: "weekly_recap_curation",
        priority: 70,
        proposed_payload: {
          week_ending: new Date().toISOString().slice(0, 10),
          summary: audit.summary,
          recommended_action: audit.recommended_action,
          flags: audit.flags,
          roadmap_id: roadmap?.id ?? null,
          brief_count_reviewed: (briefs as BriefRow[])?.length ?? 0,
          rank_snapshot_count: ranks.length,
        },
        source_function: "weekly-qc-sweep",
        source_payload: { swept_at: new Date().toISOString() },
      });

      // slack receipt
      try {
        await notifyStrategistSlack({
          queue_id: queue.queue_id,
          kind_label: "WEEKLY QC",
          emoji: ":mag:",
          client_name: client.business_name,
          client_location: client.primary_city && client.state_abbr ? `${client.primary_city}, ${client.state_abbr}` : undefined,
          urgency,
          rows: [
            { label: "flags raised", value: `${audit.flags.length}` },
            { label: "high sev    ", value: `${highCount}` },
            { label: "briefs review", value: `${(briefs as BriefRow[])?.length ?? 0}` },
            { label: "ranks tracked", value: `${ranks.length}` },
            { label: "roadmap     ", value: roadmap ? `${roadmap.status}` : "MISSING" },
          ],
          preview: `${audit.summary}\n\nnext: ${audit.recommended_action}`,
        });
      } catch (e) {
        console.error(`slack notify failed for ${client.id}: ${(e as Error).message}`);
      }

      return {
        client_id: client.id,
        client_name: client.business_name,
        needs_review: true,
        flag_count: audit.flags.length,
        queue_id: queue.queue_id,
      };
    }

    return { client_id: client.id, client_name: client.business_name, needs_review: false, flag_count: 0 };
  } catch (e) {
    console.error(`sweep failed for ${client.id}: ${(e as Error).message}`);
    return { client_id: client.id, client_name: client.business_name, needs_review: false, flag_count: 0, error: (e as Error).message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    // active clients only — trial + active
    const { data: clients, error: cErr } = await supa
      .from("clients")
      .select("id, business_name, vertical, primary_city, state_abbr")
      .in("status", ["trial", "active"]);
    if (cErr) throw new Error(`clients: ${cErr.message}`);

    const list = (clients as Array<{ id: string; business_name: string; vertical: string | null; primary_city: string | null; state_abbr: string | null }>) ?? [];

    const results: Array<{ client_id: string; client_name: string; needs_review: boolean; flag_count: number; queue_id?: string; error?: string }> = [];
    // sequential to stay polite to anthropic + avoid burst-rate trip
    for (const c of list) {
      const r = await sweepOneClient(supa, c);
      results.push(r);
    }

    const flagsRaised = results.filter((r) => r.needs_review).length;

    return new Response(
      JSON.stringify({
        ok: true,
        swept_at: new Date().toISOString(),
        clients_swept: results.length,
        flags_raised: flagsRaised,
        per_client_breakdown: results,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
});
