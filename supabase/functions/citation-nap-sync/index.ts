// Citation NAP sync via BrightLocal MCP.
// Runs every 14 days. For each active client with a BrightLocal location_id:
//   1. Pull latest Citation Tracker report results via MCP
//   2. Compare exact-match count vs prior audit
//   3. Pull active NAP change alerts via MCP (real-time drift detection)
//   4. Insert citation_audits row + emit citation_built win on positive delta
//   5. Route drift to strategist queue with proposed correction submissions
//
// DBA gate: skip clients where dba_settled_at < 28 days ago (Google trust-reset window 2-6 weeks).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { BrightLocalMCP } from "../_shared/brightlocal-mcp.ts";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { emitWin } from "../_shared/win-emit.ts";

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

  let mcp: BrightLocalMCP;
  try {
    mcp = new BrightLocalMCP();
    await mcp.connect();
  } catch (e) {
    return new Response(JSON.stringify({ error: `MCP connect: ${(e as Error).message}` }), { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ client: string; status: string; exact?: number; drifts?: number; reason?: string }> = [];

  for (const client of clients) {
    const cj = (client.client_json || {}) as { brightlocal_location_id?: number; dba_settled_at?: string };

    // DBA gate — wait 28 days post-rename before any citation work
    if (cj.dba_settled_at) {
      const daysSince = (Date.now() - new Date(cj.dba_settled_at).getTime()) / 86400e3;
      if (daysSince < 28) {
        results.push({ client: client.business_name, status: "skipped_dba_window", reason: `${Math.round(daysSince)}d since DBA, need 28d` });
        continue;
      }
    }

    if (!cj.brightlocal_location_id) {
      results.push({ client: client.business_name, status: "no_bl_location_id" });
      continue;
    }

    try {
      // 1. Find the latest CT report for this location
      const reportsRes = await mcp.getAllCtReports({ location_id: cj.brightlocal_location_id, per_page: 5 });
      if ("error" in reportsRes) {
        results.push({ client: client.business_name, status: "bl_error", reason: reportsRes.error });
        continue;
      }
      const latestReport = (reportsRes.reports || []).find((r) => r.status === "complete");
      if (!latestReport) {
        results.push({ client: client.business_name, status: "no_complete_ct_report" });
        continue;
      }

      // 2. Pull report summary
      const reportDetail = await mcp.getCtReport(latestReport.report_id);
      if ("error" in reportDetail) {
        results.push({ client: client.business_name, status: "bl_error", reason: reportDetail.error });
        continue;
      }

      const exactMatch = reportDetail.exact_match || 0;
      const partialMatch = reportDetail.partial_match || 0;
      const missing = reportDetail.missing || 0;

      // 3. Pull NAP change alerts (real-time drift)
      const alertsRes = await mcp.activeSyncChangeAlerts({ location_id: cj.brightlocal_location_id });
      const alerts = "error" in alertsRes ? [] : (alertsRes.alerts || []);

      // 4. Compare to prior audit
      const { data: prior } = await supa
        .from("citation_audits")
        .select("exact_match, audit_date")
        .eq("client_id", client.id)
        .order("audit_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      const exactDelta = exactMatch - (prior?.exact_match || 0);

      await supa.from("citation_audits").insert({
        client_id: client.id,
        audit_date: today,
        total_listings: exactMatch + partialMatch + missing,
        exact_match: exactMatch,
        partial_match: partialMatch,
        missing_listings: missing,
        drift_detected: alerts,
        brightlocal_report_url: `https://tools.brightlocal.com/seo-tools/citation-tracker/report/${latestReport.report_id}`,
      });

      // 5. Emit win on positive delta
      if (exactDelta > 0) {
        await emitWin({
          client_id: client.id,
          kind: "citation_built",
          headline: `${exactDelta} new exact-match citation${exactDelta > 1 ? "s" : ""}`,
          detail: `Now ${exactMatch} exact-match listings across the citation universe.`,
          payload: { delta: exactDelta, total_exact: exactMatch, bl_report_id: latestReport.report_id },
          source: "brightlocal",
        });
      }

      // 6. Route drift to strategist queue
      if (alerts.length > 0) {
        const queue = await enqueueForStrategist({
          client_id: client.id,
          kind: "citation_target",
          priority: alerts.length >= 5 ? 80 : 60,
          proposed_payload: {
            date: today,
            bl_report_id: latestReport.report_id,
            bl_location_id: cj.brightlocal_location_id,
            alerts: alerts.slice(0, 20),
            summary: `${alerts.length} active NAP drift alert${alerts.length > 1 ? "s" : ""}`,
            recommended_action: "Strategist reviews drifts + queues correction submissions via BrightLocal Citation Builder",
          },
          source_function: "citation-nap-sync",
          source_payload: { client_id: client.id, bl_report_id: latestReport.report_id },
        });
        await notifyStrategistSlack({
          queue_id: queue.queue_id,
          kind_label: "CITATION DRIFT",
          emoji: ":pin:",
          client_name: client.business_name,
          client_location: client.primary_city,
          urgency: alerts.length >= 5 ? "high" : "med",
          rows: [
            { label: "drift alerts ", value: `${alerts.length}` },
            { label: "exact-match  ", value: `${exactMatch}` },
            { label: "partial-match", value: `${partialMatch}` },
            { label: "missing      ", value: `${missing}` },
          ],
          preview: alerts.slice(0, 3).map((a) => `${a.source}: ${a.field} · "${a.old_value}" → "${a.new_value}"`).join("\n"),
        });
      }

      results.push({ client: client.business_name, status: "ok", exact: exactMatch, drifts: alerts.length });
    } catch (e) {
      results.push({ client: client.business_name, status: "exception", reason: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
