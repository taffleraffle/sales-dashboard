// Friday 9am cron — per-client "THIS WEEK WE..." Slack post
// Pulls wins from last 7 days + leads count + new reviews + rank deltas + content shipped
// Posts to each client's shared Slack channel (clients.client_slack_channel_id)
//
// Cron schedule: 'every Friday at 09:00 America/Chicago' (registered in pg_cron)
// Manual trigger:
//   curl -X POST .../evidence-reel-friday -d '{"dry_run": true}'

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost } from "../_shared/slack.ts";

function fmtUSD(n: number | null | undefined): string {
  if (!n) return "$0";
  return `$${Math.round(n).toLocaleString()}`;
}

function startOfWeek(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { dry_run = false } = await req.json().catch(() => ({}));
  const since = startOfWeek();
  const weekKey = since.toISOString().slice(0, 10);

  const { data: clients } = await supa
    .from("clients")
    .select("id, business_name, slug, client_slack_channel_id")
    .eq("status", "active")
    .not("client_slack_channel_id", "is", null);

  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no active clients with channels" }), { status: 200 });
  }

  const out: Array<{ client: string; posted: boolean; reason?: string }> = [];

  for (const client of clients) {
    // Skip if already posted this week
    const { data: existing } = await supa
      .from("evidence_reel_log")
      .select("id")
      .eq("client_id", client.id)
      .eq("week_starting", weekKey)
      .maybeSingle();
    if (existing && !dry_run) {
      out.push({ client: client.business_name, posted: false, reason: "already_posted_this_week" });
      continue;
    }

    // Pull wins
    const { data: wins } = await supa
      .from("wins")
      .select("kind, headline, detail, payload, created_at")
      .eq("client_id", client.id)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false });

    // Pull leads count
    const { count: leadsCount } = await supa
      .from("client_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", client.id)
      .gte("received_at", since.toISOString());

    const { count: quotableCount } = await supa
      .from("client_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", client.id)
      .eq("quotable", true)
      .gte("received_at", since.toISOString());

    // Pull rank movements
    const rankJumps = (wins || []).filter((w) => w.kind === "rank_jump" || w.kind === "serp_feature_won");
    const indexed = (wins || []).filter((w) => w.kind === "content_indexed");
    const newReviews = (wins || []).filter((w) => w.kind === "new_review_5star");

    // Pull GA4 organic last 7
    const { data: ga4 } = await supa
      .from("ga4_metrics_daily")
      .select("organic_sessions, organic_conversions")
      .eq("client_id", client.id)
      .gte("date", weekKey);
    const organicSessions = (ga4 || []).reduce((s, r) => s + (r.organic_sessions || 0), 0);
    const organicConversions = (ga4 || []).reduce((s, r) => s + (r.organic_conversions || 0), 0);

    // Compute sales value
    const { data: leadValue } = await supa
      .from("client_leads")
      .select("sales_value")
      .eq("client_id", client.id)
      .gte("received_at", since.toISOString());
    const totalValue = (leadValue || []).reduce((s, l) => s + (Number(l.sales_value) || 0), 0);

    // If literally nothing happened, skip (don't spam empty recaps)
    const hasContent = (leadsCount || 0) > 0 || rankJumps.length > 0 || indexed.length > 0 || newReviews.length > 0 || organicSessions > 50;
    if (!hasContent) {
      out.push({ client: client.business_name, posted: false, reason: "no_content_to_recap" });
      continue;
    }

    // Build the recap
    const lines: string[] = [];
    lines.push(`*THIS WEEK WE...*`);
    if ((leadsCount || 0) > 0) lines.push(`📞  Captured *${leadsCount}* leads (${quotableCount || 0} quotable)`);
    if (totalValue > 0) lines.push(`💰  Estimated lead value: *${fmtUSD(totalValue)}*`);
    if (organicSessions > 0) lines.push(`🔎  *${organicSessions.toLocaleString()}* organic sessions${organicConversions ? ` · ${organicConversions} conversions` : ""}`);
    if (rankJumps.length > 0) {
      lines.push(`📈  *${rankJumps.length}* keyword rank movements`);
      rankJumps.slice(0, 5).forEach((w) => lines.push(`     · ${w.headline}`));
    }
    if (indexed.length > 0) lines.push(`📝  *${indexed.length}* pages newly indexed`);
    if (newReviews.length > 0) lines.push(`⭐  *${newReviews.length}* new 5★ reviews`);

    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      { type: "context", elements: [
        { type: "mrkdwn", text: `WEEK ENDING ${new Date().toISOString().slice(0,10).toUpperCase()}` },
        { type: "mrkdwn", text: `RANK ON MAPS · WEEKLY RECEIPTS` },
      ]},
    ];

    if (dry_run) {
      out.push({ client: client.business_name, posted: false, reason: "dry_run" });
      continue;
    }

    const post = await slackPost(client.client_slack_channel_id!, blocks, lines.join("\n"));

    await supa.from("evidence_reel_log").upsert({
      client_id: client.id,
      week_starting: weekKey,
      body: lines.join("\n"),
      slack_channel_id: client.client_slack_channel_id,
      slack_message_ts: post.ts,
    }, { onConflict: "client_id,week_starting" });

    out.push({ client: client.business_name, posted: !!post.ok });
  }

  return new Response(JSON.stringify({ ok: true, results: out }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
