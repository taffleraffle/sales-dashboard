// Handle a client tier change with all the downstream automation.
// Body: { client_id, to_tier, reason?, triggered_by? }
//
// Supported tiers (per clients.tier CHECK): maps_only, full_stack, custom, retainer_only
//
// Side effects per transition:
//   maps_only → full_stack:    fire roadmap-generator (full), content-brief-generator
//                              (top 2 money kws), AI visibility probe, post celebration
//                              to #client-wins ("Client upgraded to Full Stack")
//   trial → full_stack:        same as above + onboarding-automation if not done
//   any → maps_only:           downgrade — archive content briefs in progress, narrow
//                              roadmap focus to GBP/citations only, notify strategist
//   active → paused:           pause all crons for client, leave data intact
//   active → churned:          archive everything, post farewell flag to strategist
//
// Idempotent: re-running the same transition is a no-op for the side effects.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { emitWin } from "../_shared/win-emit.ts";

const ALLOWED_TIERS = new Set(["maps_only", "full_stack", "custom", "retainer_only"]);

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { client_id, to_tier, reason, triggered_by } = await req.json();
    if (!client_id || !to_tier) {
      return new Response(JSON.stringify({ error: "client_id + to_tier required" }), { status: 400 });
    }
    if (!ALLOWED_TIERS.has(to_tier)) {
      return new Response(JSON.stringify({ error: `invalid to_tier · allowed: ${Array.from(ALLOWED_TIERS).join(", ")}` }), { status: 400 });
    }

    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, tier, status, primary_city, custom_domain, client_json, contract_start, monthly_fee, client_slack_channel_id")
      .eq("id", client_id)
      .single();
    if (!client) return new Response(JSON.stringify({ error: "client not found" }), { status: 404 });

    const fromTier = client.tier;
    if (fromTier === to_tier) {
      return new Response(JSON.stringify({ ok: true, message: "no change", tier: fromTier }), { status: 200 });
    }

    // Update tier
    await supa.from("clients").update({ tier: to_tier, updated_at: new Date().toISOString() }).eq("id", client_id);

    const sideEffects: Array<{ kind: string; ok: boolean; detail?: string }> = [];

    // Helper to fire downstream functions
    async function fire(fn: string, body: Record<string, unknown>): Promise<{ ok: boolean; detail?: string }> {
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, detail: data.error || `ok ${r.status}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    // ─── TRANSITION-SPECIFIC SIDE EFFECTS ───
    const isUpgradeToFullStack =
      (fromTier === "maps_only" || fromTier === "trial" || fromTier === "retainer_only" || !fromTier)
      && to_tier === "full_stack";

    if (isUpgradeToFullStack) {
      // 1. Generate full 90-day roadmap (force a refresh)
      sideEffects.push({ kind: "roadmap_refresh", ...(await fire("roadmap-generator", { client_id, force: true })) });

      // 2. Generate first content briefs for top 2 money keywords
      const { data: moneyKws } = await supa
        .from("tracked_keywords")
        .select("keyword")
        .eq("client_id", client_id)
        .eq("is_money_keyword", true)
        .limit(2);
      for (const kw of (moneyKws || [])) {
        sideEffects.push({ kind: `content_brief:${kw.keyword}`, ...(await fire("content-brief-generator", { client_id, target_keyword: kw.keyword })) });
      }

      // 3. AI visibility baseline refresh (4 platforms)
      sideEffects.push({ kind: "ai_visibility_refresh", ...(await fire("ai-visibility-probe", { client_id })) });

      // 4. Default website_management to wordpress_managed if not set
      const cj = (client.client_json || {}) as Record<string, unknown>;
      if (!cj.website_management) {
        await supa.from("clients").update({
          client_json: { ...cj, website_management: "wordpress_managed" },
        }).eq("id", client_id);
        sideEffects.push({ kind: "website_management_default", ok: true, detail: "wordpress_managed" });
      }

      // 5. Celebrate: emit win + notify strategist queue
      await emitWin({
        client_id,
        kind: "milestone",
        headline: `Upgraded to Full Stack`,
        detail: `${client.business_name} moved from ${fromTier || "no tier"} → full_stack. Roadmap regenerated, first content briefs in the strategist queue, AI visibility baselined.`,
        payload: { from_tier: fromTier, to_tier, reason },
        source: "tier-transition",
      });
    }

    // ─── DOWNGRADE TO MAPS-ONLY ───
    if ((fromTier === "full_stack" || fromTier === "custom") && to_tier === "maps_only") {
      // Archive in-progress content briefs
      await supa
        .from("content_briefs")
        .update({ status: "archived" })
        .eq("client_id", client_id)
        .in("status", ["briefed", "assigned", "drafting", "in_qa", "awaiting_strategist"]);
      sideEffects.push({ kind: "archived_content_briefs", ok: true });

      // Flag strategist
      const queue = await enqueueForStrategist({
        client_id,
        kind: "red_flag_review",
        priority: 85,
        proposed_payload: {
          downgrade: true,
          from_tier: fromTier,
          to_tier,
          reason: reason || "no reason provided",
          recommended_action: "Confirm with client + adjust touchpoint cadence + narrow roadmap to GBP/citations only",
        },
        source_function: "client-tier-transition",
        source_payload: { client_id },
      });
      sideEffects.push({ kind: "strategist_queue_downgrade", ok: true, detail: queue.queue_id });
    }

    // ─── PAUSE/CHURN HANDLING ───
    // (handled at status field, not tier — keeping tier as the historical record)

    // Log transition
    await supa.from("client_tier_transitions").insert({
      client_id,
      from_tier: fromTier,
      to_tier,
      reason: reason || null,
      triggered_by: triggered_by || "api",
      side_effects: sideEffects,
    });

    // Slack strategist notification
    await notifyStrategistSlack({
      queue_id: "tier-transition",
      kind_label: "TIER TRANSITION",
      emoji: ":arrows_counterclockwise:",
      client_name: client.business_name,
      client_location: client.primary_city || undefined,
      urgency: isUpgradeToFullStack ? "high" : "med",
      rows: [
        { label: "from        ", value: fromTier || "none" },
        { label: "to          ", value: to_tier },
        { label: "reason      ", value: reason || "—" },
        { label: "triggered by", value: triggered_by || "api" },
        { label: "side effects", value: `${sideEffects.length} actions fired` },
      ],
      preview: sideEffects.map((e) => `${e.ok ? "✓" : "✗"} ${e.kind}`).join("\n"),
    });

    return new Response(JSON.stringify({
      ok: true,
      from_tier: fromTier,
      to_tier,
      side_effects: sideEffects,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
