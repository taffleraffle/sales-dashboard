// BrightLocal AI Brain recommendations — pulls per-location AI-powered insights via MCP.
// Each recommendation is routed to the strategist queue for Mersad to review.
//
// Trigger: monthly cron or on-demand POST { client_id }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { BrightLocalMCP } from "../_shared/brightlocal-mcp.ts";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

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
    .select("id, business_name, primary_city, client_json")
    .eq("status", "active");
  if (onlyClient) q = q.eq("id", onlyClient);
  const { data: clients } = await q;
  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients" }), { status: 200 });
  }

  const mcp = new BrightLocalMCP();
  await mcp.connect();

  const results: Array<{ client: string; recs_queued: number; status: string }> = [];

  for (const client of clients) {
    const cj = (client.client_json || {}) as { brightlocal_location_id?: number };
    if (!cj.brightlocal_location_id) {
      results.push({ client: client.business_name, recs_queued: 0, status: "no_bl_location" });
      continue;
    }

    const brain = await mcp.getBrainRecommendations(cj.brightlocal_location_id);
    if ("error" in brain) {
      results.push({ client: client.business_name, recs_queued: 0, status: brain.error });
      continue;
    }

    const recs = brain.recommendations || [];
    if (recs.length === 0) {
      results.push({ client: client.business_name, recs_queued: 0, status: "no_recs" });
      continue;
    }

    // Group high-priority recs into a single queue item per client
    const highPriority = recs.filter((r) => (r.priority || "").toLowerCase() === "high");
    const medPriority = recs.filter((r) => (r.priority || "").toLowerCase() === "medium");
    const lowPriority = recs.filter((r) => !["high", "medium"].includes((r.priority || "").toLowerCase()));

    const queue = await enqueueForStrategist({
      client_id: client.id,
      kind: "health_check_followup",
      priority: highPriority.length > 0 ? 78 : medPriority.length > 0 ? 60 : 45,
      proposed_payload: {
        source: "brightlocal_brain",
        bl_location_id: cj.brightlocal_location_id,
        total_recs: recs.length,
        high_priority: highPriority,
        med_priority: medPriority,
        low_priority: lowPriority,
        insights: brain.insights || null,
        recommended_action: "Mersad reviews each rec, approves the ones to action, drops the rest",
      },
      source_function: "bl-brain-recommendations",
      source_payload: { client_id: client.id },
    });

    await notifyStrategistSlack({
      queue_id: queue.queue_id,
      kind_label: "BL BRAIN RECS",
      emoji: ":brain:",
      client_name: client.business_name,
      client_location: client.primary_city,
      urgency: highPriority.length > 0 ? "high" : medPriority.length > 0 ? "med" : "low",
      rows: [
        { label: "total recs ", value: `${recs.length}` },
        { label: "high       ", value: `${highPriority.length}` },
        { label: "medium     ", value: `${medPriority.length}` },
        { label: "low        ", value: `${lowPriority.length}` },
      ],
      preview: highPriority.slice(0, 2).map((r) => `${r.title}: ${r.description?.slice(0, 120) || ""}`).join("\n"),
    });

    results.push({ client: client.business_name, recs_queued: recs.length, status: "queued" });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
