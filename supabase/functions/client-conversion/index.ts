// Handle trial → active conversion (a client signing the full engagement).
// This is the moment where Daniel as closer hands them off to Mersad + Jonathan.
//
// Body: {
//   client_id,
//   to_tier?: 'maps_only' | 'full_stack' | 'custom' | 'retainer_only',  // default 'full_stack'
//   monthly_fee?: number,
//   contract_start?: 'YYYY-MM-DD',  // default today
//   contract_end?: 'YYYY-MM-DD',
//   converted_by?: string,  // who closed the deal (Daniel by default)
//   handoff_brief_id?: uuid,  // if Fathom auto-handoff captured one
//   notes?: string
// }
//
// Side effects:
//   1. status: trial → active
//   2. tier: whatever to_tier they're converting to
//   3. contract_start: today (or provided)
//   4. monthly_fee + contract_end if provided
//   5. Materialize the onboarding touchpoint cadence (from data/touchpoints.json)
//   6. Log conversion event to client_communications (the CRM log)
//   7. Call client-tier-transition for tier-specific side effects (roadmap, briefs, AI visibility)
//   8. Emit "New client signed" win to #client-wins
//   9. Post celebration to client's shared Slack channel
//   10. Notify #strategy-queue with full conversion record

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost } from "../_shared/slack.ts";
import { emitWin } from "../_shared/win-emit.ts";
import { notifyStrategistSlack } from "../_shared/strategist-queue.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json();
    const {
      client_id,
      to_tier = "full_stack",
      monthly_fee,
      contract_start,
      contract_end,
      converted_by = "Daniel Girmay",
      handoff_brief_id,
      notes,
    } = body;
    if (!client_id) return new Response(JSON.stringify({ error: "client_id required" }), { status: 400 });

    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, status, tier, primary_city, custom_domain, client_json, contract_start, monthly_fee, client_slack_channel_id, internal_slack_channel_id, primary_am, secondary_am")
      .eq("id", client_id)
      .single();
    if (!client) return new Response(JSON.stringify({ error: "client not found" }), { status: 404 });

    const fromStatus = client.status;
    const fromTier = client.tier;
    const startDate = contract_start || new Date().toISOString().slice(0, 10);

    if (fromStatus === "active" && fromTier === to_tier && client.contract_start) {
      return new Response(JSON.stringify({ ok: true, message: "already converted", client_id }), { status: 200 });
    }

    const sideEffects: Array<{ kind: string; ok: boolean; detail?: string }> = [];

    // 1+2+3+4. Update client record
    const update: Record<string, unknown> = {
      status: "active",
      tier: to_tier,
      contract_start: startDate,
      updated_at: new Date().toISOString(),
    };
    if (contract_end) update.contract_end = contract_end;
    if (monthly_fee != null) update.monthly_fee = monthly_fee;
    await supa.from("clients").update(update).eq("id", client_id);
    sideEffects.push({ kind: "client_record_updated", ok: true });

    // 5. Materialize onboarding touchpoint cadence
    // touchpoints.json lives in src/data/ but isn't reachable from edge functions.
    // Use the seeded onboarding_playbooks table if present, otherwise insert a minimal default.
    try {
      const { data: existingTouchpoints } = await supa
        .from("client_touchpoints")
        .select("id")
        .eq("client_id", client_id)
        .eq("touchpoint_key", "welcome_kickoff")
        .maybeSingle();

      if (!existingTouchpoints) {
        // Minimal hardcoded default cadence (the engineering team will swap to playbook table later)
        const cadence = [
          { key: "welcome_kickoff", day_offset: 0, channel: "slack", automated: true },
          { key: "kickoff_call_scheduled", day_offset: 1, channel: "email", automated: false },
          { key: "credentials_request", day_offset: 1, channel: "email", automated: true },
          { key: "gbp_audit_complete", day_offset: 3, channel: "slack", automated: false },
          { key: "site_audit_complete", day_offset: 5, channel: "slack", automated: false },
          { key: "first_content_brief_shared", day_offset: 7, channel: "slack", automated: false },
          { key: "first_gbp_post_published", day_offset: 7, channel: "slack", automated: false },
          { key: "week_1_check_in", day_offset: 7, channel: "slack", automated: false },
          { key: "first_indexed_page", day_offset: 10, channel: "slack", automated: true },
          { key: "week_2_check_in", day_offset: 14, channel: "slack", automated: false },
          { key: "first_rank_movement", day_offset: 14, channel: "slack", automated: true },
          { key: "30_day_review_call", day_offset: 30, channel: "call", automated: false },
        ];

        const start = new Date(startDate);
        const rows = cadence.map((t) => {
          const due = new Date(start);
          due.setDate(due.getDate() + t.day_offset);
          return {
            client_id,
            touchpoint_key: t.key,
            channel: t.channel,
            automated: t.automated,
            scheduled_at: due.toISOString(),
            status: "scheduled",
          };
        });

        const { error: tpErr } = await supa.from("client_touchpoints").insert(rows);
        if (tpErr) {
          // Fallback: maybe the table is named 'touchpoints' (per migration 100)
          await supa.from("touchpoints").insert(rows.map((r) => ({
            client_id: r.client_id,
            key: r.touchpoint_key,
            channel: r.channel,
            automated: r.automated,
            due_date: r.scheduled_at.slice(0, 10),
            status: r.status,
          })));
          sideEffects.push({ kind: "touchpoints_materialized", ok: true, detail: `${rows.length} (fallback table)` });
        } else {
          sideEffects.push({ kind: "touchpoints_materialized", ok: true, detail: `${rows.length}` });
        }
      } else {
        sideEffects.push({ kind: "touchpoints_already_exist", ok: true });
      }
    } catch (e) {
      sideEffects.push({ kind: "touchpoints_materialize_failed", ok: false, detail: (e as Error).message });
    }

    // 6. Log to client_communications — the CRM trail
    await supa.from("client_communications").insert({
      client_id,
      channel: "internal",
      direction: "outbound",
      subject: `Conversion: ${fromStatus} → active · ${fromTier || "no tier"} → ${to_tier}`,
      body: [
        `Client converted by ${converted_by}.`,
        `Contract starts: ${startDate}.`,
        monthly_fee ? `Monthly fee logged.` : null,
        handoff_brief_id ? `Handoff brief: ${handoff_brief_id}` : null,
        notes ? `Notes: ${notes}` : null,
      ].filter(Boolean).join("\n"),
      topic_tags: ["conversion", "milestone", "trial_to_active"],
    });
    sideEffects.push({ kind: "communication_logged", ok: true });

    // 7. Call client-tier-transition for the tier-specific side effects
    if (fromTier !== to_tier) {
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/client-tier-transition`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_id, to_tier, reason: "trial conversion", triggered_by: converted_by }),
        });
        const data = await r.json();
        sideEffects.push({ kind: "tier_transition_fired", ok: r.ok, detail: data.error || `${(data.side_effects || []).length} sub-actions` });
      } catch (e) {
        sideEffects.push({ kind: "tier_transition_failed", ok: false, detail: (e as Error).message });
      }
    }

    // 8. Emit "New client signed" win
    await emitWin({
      client_id,
      kind: "new_client_signed",
      headline: `New client signed: ${client.business_name}`,
      detail: `Converted ${fromStatus} → active · ${to_tier} tier. Closed by ${converted_by}.${client.primary_city ? ` Based in ${client.primary_city}.` : ""}`,
      payload: { from_status: fromStatus, to_status: "active", from_tier: fromTier, to_tier, contract_start: startDate, closed_by: converted_by },
      source: "conversion",
    });
    sideEffects.push({ kind: "new_client_signed_win", ok: true });

    // 9. Post celebration to client's shared Slack channel (if mapped)
    if (client.client_slack_channel_id) {
      try {
        const blocks = [
          { type: "section", text: { type: "mrkdwn", text: `:tada: *Welcome aboard, ${client.business_name}.*` } },
          { type: "section", text: { type: "mrkdwn", text: `your full engagement starts today. <@${client.primary_am || ""}> ${client.secondary_am ? `+ <@${client.secondary_am}>` : ""} will be in this channel from here.\n\nfirst 14 days: GBP audit, site audit, first content brief, first GBP post live, kickoff call. you'll see receipts here as each lands.` } },
          { type: "context", elements: [{ type: "mrkdwn", text: `:pin: ROM HQ · contract started ${startDate}` }] },
        ];
        await slackPost(client.client_slack_channel_id, blocks, `Welcome ${client.business_name} — engagement starts today.`);
        sideEffects.push({ kind: "client_slack_welcome", ok: true });
      } catch (e) {
        sideEffects.push({ kind: "client_slack_welcome_failed", ok: false, detail: (e as Error).message });
      }
    }

    // 10. Notify #strategy-queue with full record
    await notifyStrategistSlack({
      queue_id: `conversion-${client_id}`,
      kind_label: "CLIENT CONVERTED",
      emoji: ":handshake:",
      client_name: client.business_name,
      client_location: client.primary_city || undefined,
      urgency: "high",
      rows: [
        { label: "from        ", value: `${fromStatus} · ${fromTier || "no tier"}` },
        { label: "to          ", value: `active · ${to_tier}` },
        { label: "starts      ", value: startDate },
        { label: "closed by   ", value: converted_by },
        { label: "side effects", value: `${sideEffects.length} actions fired` },
        { label: "shared slack", value: client.client_slack_channel_id ? "✓ wired" : "missing" },
      ],
      preview: notes || "Onboarding cadence + roadmap + content briefs + AI visibility baseline + welcome Slack all firing.",
    });

    // Log the lifecycle transition too (re-uses tier_transitions for now; could be split later)
    await supa.from("client_tier_transitions").insert({
      client_id,
      from_tier: fromTier,
      to_tier,
      reason: `conversion · ${fromStatus} → active${notes ? ` · ${notes}` : ""}`,
      triggered_by: converted_by,
      side_effects: sideEffects,
    });

    return new Response(JSON.stringify({
      ok: true,
      client_id,
      from: { status: fromStatus, tier: fromTier },
      to: { status: "active", tier: to_tier },
      contract_start: startDate,
      side_effects: sideEffects,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
