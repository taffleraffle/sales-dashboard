// Daily touchpoint compliance sweeper
// For every client + every materialized touchpoint scheduled for yesterday or earlier,
// check if it was "met" (best-effort heuristic):
//   - Slack touchpoint → check for any HUGO message in that client's shared channel on that day
//   - Email touchpoint → check client_communications for outbound email
//   - Call touchpoint  → check client_communications for outbound call
//   - Auto touchpoints → always considered 'met'
// Log status to touchpoint_compliance_log.
// If 'missed', no win emitted (this is for internal HQ flagging, not client-facing).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

serve(async (_req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const today = new Date();
  const cutoff = new Date(today.getTime() - 86400e3); // anything scheduled <= yesterday
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // touchpoints table from migration 100 has: id, client_id, key, due_date, channel, automated, status
  const { data: due } = await supa
    .from("touchpoints")
    .select("id, client_id, key, channel, automated, due_date, status")
    .lte("due_date", cutoffDate)
    .in("status", ["scheduled", "pending"]);

  if (!due || due.length === 0) {
    return new Response(JSON.stringify({ ok: true, swept: 0 }), { status: 200 });
  }

  let met = 0;
  let missed = 0;

  for (const tp of due) {
    let status: "met" | "missed" | "na" = "missed";

    if (tp.automated) {
      status = "met";
    } else if (tp.channel === "slack") {
      // Check shared channel for any HUGO/AM message on tp.due_date
      const { data: client } = await supa
        .from("clients")
        .select("client_slack_channel_id")
        .eq("id", tp.client_id)
        .maybeSingle();
      if (client?.client_slack_channel_id) {
        // We don't have message history yet (signing secret deferred); best effort: assume missed
        status = "missed";
      } else {
        status = "na";
      }
    } else if (tp.channel === "email" || tp.channel === "call" || tp.channel === "sms") {
      const { count } = await supa
        .from("client_communications")
        .select("id", { count: "exact", head: true })
        .eq("client_id", tp.client_id)
        .eq("direction", "outbound")
        .eq("channel", tp.channel)
        .gte("happened_at", `${tp.due_date}T00:00:00Z`)
        .lte("happened_at", `${tp.due_date}T23:59:59Z`);
      status = (count || 0) > 0 ? "met" : "missed";
    }

    await supa.from("touchpoint_compliance_log").insert({
      client_id: tp.client_id,
      touchpoint_key: tp.key,
      scheduled_for: tp.due_date,
      status,
    });

    // Update touchpoint status
    await supa
      .from("touchpoints")
      .update({ status: status === "met" ? "completed" : "missed" })
      .eq("id", tp.id);

    if (status === "met") met++;
    else if (status === "missed") missed++;
  }

  return new Response(JSON.stringify({ ok: true, swept: due.length, met, missed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
