// Strategist queue action endpoint
// Body: { queue_id, action: 'approve'|'amend'|'reject', overrides?, notes?, strategist_id? }
// On approve: marks status, dispatches downstream publish (content, gbp post, roadmap publish, etc)
// On amend: stores final_payload with overrides + marks amended
// On reject: marks rejected with reason

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { queue_id, action, overrides, notes, strategist_id, strategist_name } = await req.json();
    if (!queue_id || !action) {
      return new Response(JSON.stringify({ error: "queue_id + action required" }), { status: 400, headers: CORS });
    }

    const { data: item } = await supa.from("strategist_queue").select("*").eq("id", queue_id).single();
    if (!item) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: CORS });

    const finalPayload = action === "amend"
      ? { ...item.proposed_payload, ...(overrides || {}) }
      : item.proposed_payload;

    const newStatus = action === "reject" ? "rejected" : action === "amend" ? "amended" : "approved";

    await supa.from("strategist_queue").update({
      status: newStatus,
      strategist_overrides: overrides || {},
      final_payload: finalPayload,
      strategist_id: strategist_id || null,
      strategist_name: strategist_name || item.strategist_name,
      strategist_notes: notes || null,
      reviewed_at: new Date().toISOString(),
    }).eq("id", queue_id);

    // Downstream side-effects based on kind
    if (newStatus === "approved" || newStatus === "amended") {
      switch (item.kind) {
        case "content_brief": {
          const briefId = (item.proposed_payload as { brief_id?: string }).brief_id;
          if (briefId) {
            await supa.from("content_briefs").update({ status: "approved" }).eq("id", briefId);
          }
          break;
        }
        case "content_draft": {
          const briefId = (item.proposed_payload as { brief_id?: string }).brief_id;
          if (briefId) {
            await supa.from("content_briefs").update({ status: "approved" }).eq("id", briefId);
          }
          break;
        }
        case "roadmap_update": {
          const roadmapId = (item.proposed_payload as { roadmap_id?: string }).roadmap_id;
          if (roadmapId) {
            // Supersede the previous live roadmap
            await supa.from("client_roadmaps")
              .update({ status: "superseded" })
              .eq("client_id", item.client_id)
              .eq("status", "live");
            await supa.from("client_roadmaps").update({
              status: "live",
              approved_by: strategist_name || item.strategist_name,
              approved_at: new Date().toISOString(),
              ...(overrides || {}),
            }).eq("id", roadmapId);
          }
          break;
        }
      }
      await supa.from("strategist_queue").update({ published_at: new Date().toISOString(), status: "published" }).eq("id", queue_id);
    }

    return new Response(JSON.stringify({ ok: true, status: newStatus }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS });
  }
});
